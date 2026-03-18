import axios from "axios";
import { waitUntil } from "@vercel/functions";
import {
  verifySlackRequest,
  readRawBody,
  getSlackChannelName,
  slackPost,
  channelNameToDealQuery,
  getHubSpotAccessToken,
  hubspotClient,
  findBestDeal,
  getDealAssociations,
  batchRead,
  resolveOwnerName,
  daysBetweenISO,
  getExtendedChannelHistory,
  isBotMessage,
  isRocketlaneMessage
} from "./utils.js";
import {
  fetchDealEmails,
  fetchDealCalls,
  fetchDealMeetings,
  fetchDealNotes,
  fetchDealLineItems,
  formatTimelineForPrompt,
  formatLineItemsForPrompt
} from "./hubspot-data.js";
import { callOpenAIForQA } from "./openai-qa.js";

// Vercel Hobby plan has a 10s function timeout
const VERCEL_TIMEOUT_WARNING_MS = 8000;

async function postToResponseUrl(responseUrl, text, replaceOriginal = false) {
  if (!responseUrl) return;
  try {
    await axios.post(
      responseUrl,
      { text, replace_original: replaceOriginal },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );
  } catch (e) {
    console.error("postToResponseUrl failed:", e.message, e.response?.status);
  }
}

function buildDeploymentPlanPrompt({ dealName, hubspotDealUrl, ownerLine, csmLine, created, closed, cycleDays, contactsLine, companyLine, amount, dealType, dealStage, pipelineName, description, productDescription, isTrial, lineItems, timeline, channelHistoryText }) {
  const instructions = `
You are generating a deployment plan summary for a post-sales team (Deployments, Customer Success, Training). Extract specific deployment details from the HubSpot deal data and Slack channel history below. Be concise — omit filler, avoid restating obvious facts, and do not repeat information across sections.

Deal: "${dealName}"
Deal link: ${hubspotDealUrl}

OUTPUT FORMAT:
Use Slack mrkdwn formatting (*bold* for section headers and field labels). Only include sections where you found actual data — do NOT output sections with "TBD", "Not found", or "Unknown". Omit the section entirely if the data isn't available. Keep each section tight — 1-2 lines per bullet where possible.

*Deployment Plan: ${dealName}*
${hubspotDealUrl}

*Where Things Stand*
2-3 sentences max. What's confirmed, what's proposed, what's still open. Read like a quick briefing.

*What Was Sold*
- *Product:* [use the Product field below as ground truth — e.g. "130kV Neptune"]
- *Deal Type:* [new business / renewal / etc.]${isTrial ? `\n- *Trial:* ${isTrial}` : ""}

*Rigging & Uncrating*
- *Date:* [date]
- *Performed by:* [who — if Lumafield-arranged, note that costs are passed to the customer]
- *Notes:* [crate storage/return decision only if unresolved; omit if nothing outstanding]

*Install Details*
- *Status:* Confirmed / Proposed (pending customer confirmation)
- *Install Date(s):* [date(s)]
- *FSE:* [name]
- *Location:* [facility name + full address — use Rocketlane Facility Info form as primary source]
- *Compute Type:* [Cloud / GovCloud / On Prem / Air Gapped — deduce from emails if not explicit]
- *Calibration:* [Fast Cal/Cal2 or Cal 3 — Cal 3 is for metrology/GD&T; omit if not mentioned]

*Training*
- *Status:* Confirmed / Proposed (pending customer confirmation)
- *Training Date(s):* [date(s)]
- *Enablement Engineer:* [name]
- *Others Attending Onsite:* [only if mentioned]

*Team*
- *Sales Owner:* ${ownerLine}
- *CSM:* [name] — Scoping call: [Scheduled for X / Not yet scheduled]

*Pending & Open Items*
Short bullets only — items explicitly unconfirmed or awaiting action.

*Notable Context*
Only include things that would genuinely surprise or matter to someone walking into this deployment cold — unusual deal circumstances, discrepancies between what was signed and what's now expected, special IT/power/access requirements, or other non-obvious context. Do NOT include: standard facility specs (assume the facility is suitable if we're installing there), forklift/loading dock details (covered in Rigging), or items already listed in Pending & Open Items.

DATA EXTRACTION RULES:
- Read the FULL email timeline — scheduling evolves over 20-30+ emails. The most recent confirmed schedule supersedes earlier proposals.
- Scheduling emails often include a summary bullet list at the end — prioritize these for dates.
- "Proposed" = Lumafield sent proposed dates, customer has not explicitly confirmed. "Confirmed" = customer replied affirmatively or subsequent emails treat dates as set.
- Rigging/uncrating can be Lumafield-arranged, customer's own team, or third-party — only report what emails say. If Lumafield arranges riggers, note that costs are passed to the customer.
- Compute type can often be deduced from email context (GovCloud, on-prem steps, air-gapped requirements, or cloud setup).
- Calibration: Cal 3 is for metrology-level/GD&T/high-precision applications. Fast Cal/Cal2 is standard. Only include if mentioned.
- Forklift/loading dock attestations are only relevant if rigging is unresolved. If professional riggers are already arranged, do NOT flag facility equipment as a concern.
- CSM: Use the HubSpot company record value first. If it shows "Not assigned," search the email timeline for a Lumafield team member who introduces themselves as a Customer Success Manager or CSM, or is introduced as one — they are commonly cc'd or named in scheduling emails.
- Crate storage/return decision is a common open item — flag it only if unresolved.
- IT/network configuration: if the customer has been asked to confirm requirements and hasn't replied, flag as Pending & Open.
- Install address: use the Rocketlane Facility Info form as primary source. If submitted multiple times, use the MOST RECENT (channel history is newest-first).
- Trial status: if the HubSpot deal shows one trial status but emails or Slack suggest the deal is being renegotiated or converted to/from a trial, flag this discrepancy in Notable Context.
- Use BOTH HubSpot emails and Slack channel history as sources.
- CRITICAL: The Product field below is ground truth for what was sold. Do NOT infer product names from email content.
- Do not invent information. Only include details found in the data provided.

HubSpot Deal Data:
- Deal: ${dealName}
- Sales Owner: ${ownerLine}
- CSM: ${csmLine}
- Product: ${productDescription || "See line items below"}
- Trial: ${isTrial || "Not specified"}
- Deal Type: ${dealType || "Not available"}
- Deal Stage: ${dealStage || "Not available"}
- Created: ${created || "Not available"}
- Closed: ${closed || "Not available"}${cycleDays != null ? ` (${cycleDays}-day cycle)` : ""}
- Company: ${companyLine || "Not available"}
- Contacts: ${contactsLine}
${description ? `- Description: ${description}` : ""}
${lineItems ? `- Products/Line Items:\n${lineItems}` : ""}

HubSpot Activity Timeline (most recent first):
${timeline || "No activity found."}

Slack Channel History:
${channelHistoryText || "No channel history available."}
`.trim();

  return instructions;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const rawBody = await readRawBody(req);

  if (!process.env.SLACK_SIGNING_SECRET) {
    return res.status(500).send("Missing SLACK_SIGNING_SECRET");
  }

  if (!verifySlackRequest(req, rawBody)) {
    return res.status(401).send("Invalid signature");
  }

  const payload = Object.fromEntries(new URLSearchParams(rawBody));
  const channel_id = payload.channel_id;
  const response_url = payload.response_url;

  // Respond within 3 seconds or Slack shows "operation_timeout"
  res.status(200).json({
    response_type: "ephemeral",
    text: "Generating deployment plan... (this may take a moment)"
  });

  let planFinished = false;
  const timeoutWarning = setTimeout(async () => {
    if (!planFinished && response_url) {
      console.warn("[/plan] approaching Vercel timeout, posting warning");
      await postToResponseUrl(
        response_url,
        "Still generating the deployment plan, but it's taking longer than expected. " +
        "If you don't see a response shortly, the Vercel function may have timed out (10s limit on Hobby plan). " +
        "Try running /plan again.",
        false
      );
    }
  }, VERCEL_TIMEOUT_WARNING_MS);

  waitUntil(
    (async () => {
      try {
        // ── Phase 1: Channel name + HubSpot token + extended Slack history (parallel) ──
        const [channelName, accessToken, rawChannelHistory] = await Promise.all([
          getSlackChannelName(channel_id),
          getHubSpotAccessToken(),
          getExtendedChannelHistory(channel_id, 200).catch((err) => {
            console.error("[/plan] error fetching extended channel history:", err.message);
            return [];
          })
        ]);

        const dealQuery = channelNameToDealQuery(channelName);
        const hs = hubspotClient(accessToken);

        // Filter channel history: keep Rocketlane bot messages, exclude other bots
        const channelHistory = rawChannelHistory.filter((msg) => {
          if (isBotMessage(msg) && !isRocketlaneMessage(msg)) return false;
          if (msg.subtype && !isBotMessage(msg)) return false;
          return !!msg.text;
        });

        // Format channel history for prompt — extract nested attachment blocks (Rocketlane forms)
        let channelHistoryText = "No channel history available.";
        if (channelHistory.length > 0) {
          channelHistoryText = channelHistory
            .map((msg) => {
              const user = msg.user ? `<@${msg.user}>` : (msg.username || "Bot");
              let text = msg.text || "";
              const ts = msg.ts ? new Date(Number(msg.ts) * 1000).toISOString().split("T")[0] : "";

              if (msg.attachments?.length > 0) {
                const attText = msg.attachments
                  .map((att) => {
                    if (att.text) return att.text;
                    if (att.blocks?.length > 0) {
                      return att.blocks
                        .map((block) => {
                          if (block.elements) {
                            return block.elements
                              .filter((el) => el.type === "mrkdwn" || el.type === "plain_text")
                              .map((el) => el.text)
                              .filter(Boolean)
                              .join("\n");
                          }
                          return block.text?.text || "";
                        })
                        .filter(Boolean)
                        .join("\n");
                    }
                    return att.fallback || "";
                  })
                  .filter(Boolean)
                  .join("\n");
                if (attText) text += "\n" + attText;
              }

              return `[${ts}] ${user}: ${text}`;
            })
            .join("\n");
        }

        // ── Phase 2: Find deal ──
        const deal = await findBestDeal(hs, dealQuery);
        if (!deal) {
          await postToResponseUrl(response_url, `No HubSpot deal found matching "${dealQuery}".`, true);
          return;
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

        // ── Phase 3: All HubSpot data fetches in parallel ──
        const [ownerName, associations, emails, calls, meetings, notes, lineItemsRaw] = await Promise.all([
          resolveOwnerName(hs, ownerId),
          getDealAssociations(hs, dealId),
          fetchDealEmails(hs, dealId),
          fetchDealCalls(hs, dealId),
          fetchDealMeetings(hs, dealId),
          fetchDealNotes(hs, dealId),
          fetchDealLineItems(hs, dealId)
        ]);

        // Phase 3b: Contacts + companies (depends on associations)
        const { contactIds, companyIds } = associations;
        const [contacts, companies] = await Promise.all([
          batchRead(hs, "contacts", contactIds, ["firstname", "lastname", "jobtitle", "email"]),
          batchRead(hs, "companies", companyIds, ["name", "domain", "csm"])
        ]);

        // Resolve CSM from company record (owner ID → name)
        const csmOwnerId = companies.length ? companies[0]?.properties?.csm : null;
        const csmName = csmOwnerId ? await resolveOwnerName(hs, csmOwnerId) : null;
        const csmLine = csmName
          ? `${csmName} (from company record)`
          : "Not assigned in HubSpot";

        const ownerLine = ownerName
          ? `${ownerName} (Sales)`
          : ownerId
            ? `${ownerId} (name not found in HubSpot)`
            : "Not found in HubSpot records";

        const contactsLine = contacts.length
          ? contacts
              .slice(0, 6)
              .map((c) => {
                const p = c.properties || {};
                const nm = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || "Name not found";
                const role = p.jobtitle ? `, ${p.jobtitle}` : "";
                const email = p.email ? ` (${p.email})` : "";
                return `${nm}${role}${email}`;
              })
              .join("; ")
          : "Not found in HubSpot records";

        const companyLine = companies.length
          ? companies
              .slice(0, 2)
              .map((c) => c.properties?.name)
              .filter(Boolean)
              .join("; ")
          : "Not found in HubSpot records";

        // ── Phase 4: Build timeline + prompt + OpenAI ──
        const timeline = formatTimelineForPrompt(emails, calls, meetings, notes, 1500, 60);
        const lineItems = formatLineItemsForPrompt(lineItemsRaw);

        const amount = deal.properties?.amount
          ? `${deal.properties.deal_currency_code || "$"}${Number(deal.properties.amount).toLocaleString()}`
          : null;
        const dealType = deal.properties?.dealtype || null;
        const dealStage = deal.properties?.dealstage || null;
        const pipelineName = deal.properties?.pipeline || null;
        const description = deal.properties?.description || null;

        // Custom deal properties for product and trial status
        const sourceConfig = deal.properties?.source_configuration || null;
        const productLine = deal.properties?.product_line || null;
        const productDescription = [sourceConfig, productLine].filter(Boolean).join(" ") || null;
        const isTrialRaw = deal.properties?.is_this_a_trial_ || null;
        const isTrial = isTrialRaw
          ? (isTrialRaw.toLowerCase().includes("yes") || isTrialRaw === "true" ? "Yes" : "No")
          : null;

        const prompt = buildDeploymentPlanPrompt({
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
          productDescription,
          isTrial,
          lineItems,
          timeline,
          channelHistoryText
        });

        const planText = await callOpenAIForQA(prompt);
        await slackPost(channel_id, planText);
        planFinished = true;
        clearTimeout(timeoutWarning);
        await postToResponseUrl(response_url, `Posted deployment plan to #${channelName}.`, true);
      } catch (err) {
        planFinished = true;
        clearTimeout(timeoutWarning);
        console.error("/plan error:", err?.message || err, err?.code);
        let msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || "unknown_error");
        if (err?.code === "ETIMEDOUT" || msg.includes("ETIMEDOUT")) {
          msg = "Redis connection timed out. Check Vercel logs and Redis connectivity.";
        }
        if (response_url) {
          await postToResponseUrl(response_url, `Deployment plan failed: ${msg}`, true);
        } else {
          try {
            await slackPost(channel_id, `Deployment plan failed: ${msg}`);
          } catch (e) {
            console.error("slackPost error:", e.message);
          }
        }
      }
    })()
  );
}
