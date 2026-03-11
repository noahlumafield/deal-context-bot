import { waitUntil } from "@vercel/functions";
import axios from "axios";
import {
  verifySlackRequest,
  readRawBody,
  getSlackChannelName,
  getSlackChannelInfo,
  isPublicChannel,
  getChannelHistory,
  getThreadHistory,
  slackPost,
  getBotUserId,
  extractQuestionFromMention,
  isBotMessage,
  isRocketlaneMessage,
  isRegulatoryFormQuestion,
  findRocketlaneFormMessage,
  getMessagePermalink,
  channelNameToDealQuery,
  storeThreadContext,
  getThreadContext,
  getHubSpotAccessToken,
  hubspotClient,
  findBestDeal,
  getDealAssociations,
  batchRead,
  resolveOwnerName,
  daysBetweenISO,
  getCachedSlackBotToken
} from "./utils.js";
import {
  determineRequiredData,
  fetchDealEmails,
  fetchDealCalls,
  fetchDealMeetings,
  fetchDealNotes,
  fetchDealLineItems,
  formatTimelineForPrompt,
  formatLineItemsForPrompt,
  searchDealsAcrossPortal,
  formatCrossDealResults
} from "./hubspot-data.js";
import { buildQAPrompt, callOpenAIForQA, classifyQuestion } from "./openai-qa.js";

// Vercel Hobby plan has a 10s function timeout. We post a notification if the
// handler is still running after this threshold so the user knows it's working.
const VERCEL_TIMEOUT_WARNING_MS = 8000;

/** Post an error message to Slack using the cached token (no Redis round trip).
 *  Fails silently if no cached token is available. */
async function safeErrorPost(channel_id, text, thread_ts = null) {
  const token = getCachedSlackBotToken();
  if (!token) {
    console.error("[safeErrorPost] no cached token available, cannot post error to Slack");
    return;
  }
  try {
    const payload = { channel: channel_id, text };
    if (thread_ts) payload.thread_ts = thread_ts;
    await axios.post("https://slack.com/api/chat.postMessage", payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });
  } catch (e) {
    console.error("[safeErrorPost] failed:", e?.message);
  }
}

/** Race the handler against a timeout. If the handler takes too long, post a
 *  warning to Slack so the user knows the function is working but hit the
 *  Vercel Hobby plan limit. The handler continues to run — `waitUntil` may
 *  keep it alive — but the user gets feedback either way. */
async function withTimeoutNotification(handlerPromise, channel_id, thread_ts) {
  let finished = false;

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(async () => {
      if (!finished) {
        console.warn("[timeout] handler exceeded %sms, posting warning", VERCEL_TIMEOUT_WARNING_MS);
        await safeErrorPost(
          channel_id,
          "Still working on your request, but it's taking longer than expected. " +
          "If you don't see a response shortly, the Vercel function may have timed out (10s limit on Hobby plan). " +
          "Try again or ask a simpler question.",
          thread_ts
        );
      }
      resolve();
    }, VERCEL_TIMEOUT_WARNING_MS);
  });

  try {
    const result = await Promise.race([
      handlerPromise.then((r) => { finished = true; return r; }),
      timeoutPromise
    ]);
    return result;
  } catch (err) {
    finished = true;
    throw err;
  }
}

async function handleAppMention(event) {
  const channel_id = event.channel;
  const user_id = event.user;
  const text = event.text || "";
  const ts = event.ts;
  const thread_ts = event.thread_ts || null;
  console.log("[handleAppMention] channel=%s thread_ts=%s text=%s", channel_id, thread_ts || "(none)", text?.slice(0, 80));

  try {
    // ── Phase 1: Independent setup calls (parallel) ──
    console.log("[handleAppMention] phase 1: bot ID + channel info + HubSpot token...");
    const [botUserId, channelInfo, accessToken] = await Promise.all([
      getBotUserId(),
      getSlackChannelInfo(channel_id),
      getHubSpotAccessToken()
    ]);

    // Extract question from mention
    const question = extractQuestionFromMention(text, botUserId);
    if (!question) {
      await slackPost(channel_id, "I'm here! Ask me a question about this deal.", thread_ts);
      return;
    }

    const isPublic = isPublicChannel(channelInfo);
    const channelName = channelInfo?.name || await getSlackChannelName(channel_id);
    const dealQuery = channelNameToDealQuery(channelName);
    const hs = hubspotClient(accessToken);

    // ── Phase 2: Find deal + fetch channel history + classify question (parallel) ──
    console.log("[handleAppMention] phase 2: find deal + channel history + classify...");
    const phase2 = [
      findBestDeal(hs, dealQuery),
      isPublic
        ? getChannelHistory(channel_id, 100).catch((err) => {
            console.error("Error fetching channel history:", err.message);
            return null;
          })
        : Promise.resolve(null),
      classifyQuestion(question)
    ];
    const [deal, rawChannelHistory, classification] = await Promise.all(phase2);
    console.log("[handleAppMention] classification:", JSON.stringify(classification));

    if (!deal) {
      await slackPost(channel_id, `No HubSpot deal found matching "${dealQuery}".`);
      return;
    }

    // ── Regulatory form shortcut (runs before filtering) ──
    if (isRegulatoryFormQuestion(question) && rawChannelHistory) {
      const formMessage = findRocketlaneFormMessage(rawChannelHistory);
      if (formMessage) {
        const permalink = await getMessagePermalink(channel_id, formMessage.ts);
        let response = "";
        if (formMessage.fileUrl) {
          response = `Here's the EHS & Regulatory Acknowledgement form:\n${formMessage.fileUrl}`;
        }
        if (permalink) {
          response += (response ? "\n\n" : "") + `Original Rocketlane message: ${permalink}`;
        }
        if (!formMessage.fileUrl && !permalink) {
          response = "I found a Rocketlane message about the EHS form in this channel, but couldn't extract the file link. Try scrolling back to find it.";
        }
        await slackPost(channel_id, response, thread_ts);
        return;
      }
      // Not found — fall through to normal Q&A flow
    }

    // Filter channel history: keep Rocketlane bot messages, exclude other bots and DeCo's own messages
    let channelHistory = null;
    if (rawChannelHistory) {
      channelHistory = rawChannelHistory.filter((msg) => {
        if (msg.user === botUserId) return false;
        if (isBotMessage(msg) && !isRocketlaneMessage(msg)) return false;
        if (msg.subtype && !isBotMessage(msg)) return false;
        return !!msg.text;
      });
    }

    const dealId = deal.id;
    const dealName = deal.properties?.dealname || dealQuery;
    const created = deal.properties?.createdate || null;
    const closed = deal.properties?.closedate || null;
    const cycleDays = daysBetweenISO(created, closed);
    const ownerId = deal.properties?.hubspot_owner_id || null;

    const portalId = process.env.HUBSPOT_PORTAL_ID;
    const hubspotDealUrl = portalId
      ? `https://app.hubspot.com/contacts/${portalId}/record/0-3/${dealId}`
      : `(HUBSPOT_PORTAL_ID env var not set — cannot generate deal link)`;

    // Cross-deal search if classifier detected a cross-deal question
    let crossDealResults = null;
    if (classification.scope === "cross-deal" && classification.keywords?.length) {
      console.log("[handleAppMention] cross-deal search with keywords:", classification.keywords);
      const crossDeals = await searchDealsAcrossPortal(hs, classification.keywords, dealId, 20);
      crossDealResults = formatCrossDealResults(crossDeals);
      console.log("[handleAppMention] found %d cross-deal results", crossDeals.length);
    }

    // Determine what HubSpot data to fetch based on question
    const requiredData = determineRequiredData(question, deal);

    // ── Phase 3: All data fetches in parallel ──
    console.log("[handleAppMention] phase 3: fetching deal data in parallel...");
    const phase3 = {
      owner: resolveOwnerName(hs, ownerId),
      associations: getDealAssociations(hs, dealId),
      lineItems: fetchDealLineItems(hs, dealId),
      emails: requiredData.emails ? fetchDealEmails(hs, dealId) : Promise.resolve([]),
      notes: requiredData.notes ? fetchDealNotes(hs, dealId) : Promise.resolve([]),
      calls: requiredData.calls ? fetchDealCalls(hs, dealId) : Promise.resolve([]),
      meetings: requiredData.meetings ? fetchDealMeetings(hs, dealId) : Promise.resolve([]),
      threadContext: thread_ts
        ? getThreadContext(channel_id, thread_ts).then(async (cached) => {
            if (cached) return cached;
            try {
              const msgs = await getThreadHistory(channel_id, thread_ts);
              return msgs?.length ? { messages: msgs } : null;
            } catch (err) {
              console.error("[handleAppMention] error fetching thread history:", err.message);
              return null;
            }
          })
        : Promise.resolve(null)
    };

    const results = await Promise.all(
      Object.values(phase3)
    );
    const keys = Object.keys(phase3);
    const r = {};
    keys.forEach((k, i) => { r[k] = results[i]; });

    // Resolve contacts + companies from associations (fast batch reads)
    const { contactIds, companyIds } = r.associations;
    const [contacts, companies] = await Promise.all([
      batchRead(hs, "contacts", contactIds, ["firstname", "lastname", "jobtitle", "email"]),
      batchRead(hs, "companies", companyIds, ["name", "domain", "csm"])
    ]);

    // Resolve CSM from company record (owner ID → name)
    const csmOwnerId = companies.length ? companies[0]?.properties?.csm : null;
    const csmName = csmOwnerId ? await resolveOwnerName(hs, csmOwnerId) : null;
    const csmLine = csmName
      ? `${csmName} (from company record)`
      : "Not assigned in HubSpot — check emails/Slack for CSM mentions";

    const ownerName = r.owner;
    const ownerLine = ownerName
      ? `${ownerName} (Sales)`
      : ownerId
        ? `${ownerId} (name not found in HubSpot)`
        : "Not observed in HubSpot history";

    const contactsLine = contacts.length
      ? contacts
          .slice(0, 6)
          .map((c) => {
            const p = c.properties || {};
            const nm = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || "Name not observed";
            const role = p.jobtitle ? `, ${p.jobtitle}` : "";
            const email = p.email ? ` (${p.email})` : "";
            return `${nm}${role}${email}`;
          })
          .join("; ")
      : "Not observed in HubSpot history";

    const companyLine = companies.length
      ? companies
          .slice(0, 2)
          .map((c) => c.properties?.name)
          .filter(Boolean)
          .join("; ")
      : "Not observed in HubSpot history";

    // Build unified timeline from all activity types
    const timeline = formatTimelineForPrompt(r.emails, r.calls, r.meetings, r.notes);
    const lineItems = formatLineItemsForPrompt(r.lineItems);

    const amount = deal.properties?.amount
      ? `${deal.properties.deal_currency_code || "$"}${Number(deal.properties.amount).toLocaleString()}`
      : null;
    const dealType = deal.properties?.dealtype || null;
    const dealStage = deal.properties?.dealstage || null;
    const pipelineName = deal.properties?.pipeline || null;
    const description = deal.properties?.description || null;

    // ── Phase 4: OpenAI + post to Slack ──
    const prompt = buildQAPrompt({
      question,
      dealData: { dealId, dealName },
      threadContext: r.threadContext,
      hubspotData: {
        dealName,
        hubspotDealUrl,
        ownerLine,
        csmLine,
        created,
        closed,
        cycleDays,
        contactsLine,
        companyLine,
        amount,
        dealType,
        dealStage,
        pipelineName,
        description,
        lineItems,
        timeline
      },
      channelHistory,
      crossDealResults
    });

    console.log("[handleAppMention] phase 4: calling OpenAI...");
    const answer = await callOpenAIForQA(prompt);
    console.log("[handleAppMention] posting to Slack thread_ts=%s", thread_ts || "(channel)");
    const response = await slackPost(channel_id, answer, thread_ts);

    // Store thread context if we have a thread (mention was in thread or we created one)
    const responseThreadTs = thread_ts || response.ts;
    if (responseThreadTs && response.ts) {
      await storeThreadContext(channel_id, responseThreadTs, [
        { user: user_id, text: question, ts },
        { bot_id: botUserId, text: answer, ts: response.ts }
      ], dealId);
    }
  } catch (err) {
    console.error("Error handling app mention:", err?.message || err, err?.stack);
    await safeErrorPost(channel_id, `Sorry, I encountered an error: ${err.message || "unknown_error"}`, thread_ts);
  }
}

export default async function handler(req, res) {
  // Allow GET for health checks and Slack verification during installation
  if (req.method === "GET") {
    return res.status(200).json({ status: "ok", endpoint: "slack-events" });
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const rawBody = await readRawBody(req);

  if (!process.env.SLACK_SIGNING_SECRET) {
    return res.status(500).send("Missing SLACK_SIGNING_SECRET");
  }

  if (!verifySlackRequest(req, rawBody)) {
    return res.status(401).send("Invalid signature");
  }

  try {
    const body = JSON.parse(rawBody);

    // Handle URL verification challenge from Slack
    if (body.type === "url_verification") {
      return res.status(200).json({ challenge: body.challenge });
    }

    // Handle event callbacks
    if (body.type === "event_callback") {
      const event = body.event;
      console.log("[events] received event type=%s channel=%s thread_ts=%s", event?.type, event?.channel, event?.thread_ts ?? "(none)");

      // Handle app_mention events
      if (event.type === "app_mention") {
        // Acknowledge immediately (Slack requires response within 3 seconds)
        res.status(200).send("OK");
        // Process asynchronously — waitUntil keeps the function alive on Vercel
        waitUntil(
          withTimeoutNotification(
            handleAppMention(event),
            event.channel,
            event.thread_ts || null
          ).catch((err) => {
            console.error("Error in async app_mention handler:", err);
          })
        );
        return;
      }

      // Thread replies without @mention are ignored — bot only responds to @mentions.
      // When a user @mentions the bot in a thread, Slack sends both a "message" event
      // and an "app_mention" event. We handle it via app_mention above.
      if (event.type === "message") {
        return res.status(200).send("OK");
      }

      // Unknown event type, just acknowledge
      return res.status(200).send("OK");
    }

    // Unknown body type
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Events handler error:", err);
    return res.status(500).send(`Error: ${err.message || "unknown_error"}`);
  }
}
