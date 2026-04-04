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
  daysBetweenISO
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

function buildPromptFromHubSpotData({ dealName, hubspotDealUrl, ownerLine, csmLine, created, closed, cycleDays, contactsLine, companyLine, amount, dealType, dealStage, pipelineName, description, productDescription, isTrial, lineItems, timeline }) {
  const instructions = `
You are writing a deal handoff document for post-sales teams (Deployments, Customer Success, and Training) who are taking over from Sales. The audience has ZERO prior context on this deal — they need to understand who the customer is, what happened during the sales process, and what to watch out for.

Using the HubSpot data below for deal "${dealName}", produce a structured handoff summary.

FORMATTING (Slack mrkdwn — follow exactly):
- Bold with single asterisks: *text* (NOT **text**)
- Bold all names, companies, roles, deal amounts, and product names for readability
- For links, paste the raw URL on its own line — do NOT use markdown link syntax like [text](url)
- Use single asterisks for section headers: *Header*

CRITICAL: Use the structured deal data (amount, deal type, Product field, deal stage) as ground truth for what was sold, the deal structure, and financials. Do NOT infer these details from email or meeting content — emails may discuss multiple products, pricing options, or deal structures that were NOT part of the final deal.
${productDescription ? `\nThe Product field value is "${productDescription}" — use this EXACTLY as written when referring to the product. Do not paraphrase, abbreviate, or split it into separate terms.` : ""}
${isTrial != null ? `This deal ${isTrial === "Yes" ? "IS" : "is NOT"} a trial.` : ""}

Output the following sections in this exact order. Use *Header* for section headers. If data for a section is not available, write "Not found in HubSpot records" under that header — do NOT skip the section.

*Deal Overview*
One concise line with: deal name, company, sales owner, key contacts (name + role), and deal cycle length (${cycleDays != null ? `${cycleDays} days` : "unknown"}). Put the deal link on the next line by itself:
${hubspotDealUrl}

*What Was Sold*
State the product (use the Product field exactly as provided), deal amount, deal type, and whether this is a trial. If line items are available, list them. Do NOT call the product a "scanner" or other generic term — use the exact product name from the Product field.

*Sales Process Summary*
2-4 sentences synthesizing how the deal progressed from first contact to close. What were the key milestones, meetings, or turning points? How did the deal close (e.g., demo-driven, referral, negotiation, quick sign)? Draw from emails, meetings, calls, and notes chronologically.

*Customer Temperament*
1-2 sentences on what the customer is like to work with, inferred from communication patterns. Are they responsive or slow? Detail-oriented or hands-off? Friendly, demanding, or neutral? If unclear from the data, say so rather than guessing.

*Current Status & Most Recent Activity*
What is the latest activity on this deal? What was the most recent conversation about? 1-3 sentences covering where things stand right now.

*Open Items, Holdups & Risks*
Bullet any unresolved items, blockers, concerns, or risks mentioned anywhere in the activity history. If nothing is flagged, write "None identified in HubSpot records."

*Key Technical Details*
Bullet any technical requirements, integration needs, or configuration details mentioned in emails/meetings/notes. Do NOT repeat the product name or trial status here — those belong in "What Was Sold." If no additional technical details, write "None mentioned in HubSpot records."

*Deployment Location*
Where the scanner will be physically installed. Look for: facility name, street address, city/state, building or room name, or any description of the install site mentioned anywhere in emails, calls, meetings, or notes. If the customer mentions their facility, lab, plant, or office location, include it here. If no location is mentioned, write "Not found in HubSpot records."

Rules:
- Be concise but do not omit important details. Aim for completeness over brevity.
- Every claim must come from the data below. Do not invent or assume facts.
- Write in plain language as if briefing a colleague verbally.
- Do not dump raw data or field names. Synthesize and summarize.
- Do not repeat the same information across sections.
- Bold all names, companies, amounts, and product names with *single asterisks*.
- For Deployment Location: scan the FULL activity timeline for any mention of the install site — facility name, address, city/state, building/room. Customers often mention it casually ("we're in our Boston facility", "our Austin plant"). Prioritize the most specific mention found.

HubSpot Deal Data:
- Deal: ${dealName}
- Sales Owner: ${ownerLine}
- CSM: ${csmLine}
- Amount: ${amount || "Not found in HubSpot records"}
- Deal Type: ${dealType || "Not found in HubSpot records"}
- Deal Stage: ${dealStage || "Not found in HubSpot records"}
- Pipeline: ${pipelineName || "Not found in HubSpot records"}
- Created: ${created || "Not found in HubSpot records"}
- Closed: ${closed || "Not found in HubSpot records"}${cycleDays != null ? ` (${cycleDays}-day cycle)` : ""}
- Company: ${companyLine || "Not found in HubSpot records"}
- Contacts: ${contactsLine}
${description ? `- Description: ${description}` : ""}
${productDescription ? `- Product: ${productDescription}` : ""}
${isTrial != null ? `- Trial: ${isTrial}` : ""}
${lineItems ? `- Products/Line Items:\n${lineItems}` : "- Products/Line Items: None found in HubSpot records"}

Activity Timeline (most recent first):
${timeline || "No activity found in HubSpot."}
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
    text: "Generating deal summary... (this may take a moment)"
  });

  waitUntil(
    (async () => {
      try {
        // ── Phase 1: Channel name + HubSpot token (parallel) ──
        const [channelName, accessToken] = await Promise.all([
          getSlackChannelName(channel_id),
          getHubSpotAccessToken()
        ]);

        const dealQuery = channelNameToDealQuery(channelName);
        const hs = hubspotClient(accessToken);

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

        // ── Phase 3: All data fetches in parallel ──
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
        const timeline = formatTimelineForPrompt(emails, calls, meetings, notes, 600, 40);
        const lineItems = formatLineItemsForPrompt(lineItemsRaw);

        const amount = deal.properties?.amount
          ? `${deal.properties.deal_currency_code || "$"}${Number(deal.properties.amount).toLocaleString()}`
          : null;
        const dealType = deal.properties?.dealtype || null;
        const dealStage = deal.properties?.dealstage || null;
        const pipelineName = deal.properties?.pipeline || null;
        const description = deal.properties?.description || null;
        const productLine = deal.properties?.product_line || null;
        const sourceConfig = deal.properties?.source_configuration || null;
        const productDescription = [sourceConfig, productLine].filter(Boolean).join(" ") || null;
        const trialRaw = deal.properties?.is_this_a_trial_ || null;
        const isTrial = trialRaw ? (trialRaw.toLowerCase() === "true" || trialRaw.toLowerCase() === "yes" ? "Yes" : "No") : null;

        const prompt = buildPromptFromHubSpotData({
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
          timeline
        });

        const summaryText = await callOpenAIForQA(prompt);
        await slackPost(channel_id, summaryText);
        await postToResponseUrl(response_url, `Posted deal summary to #${channelName}.`, true);
      } catch (err) {
        console.error("/summary error:", err?.message || err, err?.code);
        let msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || "unknown_error");
        if (err?.code === "ETIMEDOUT" || msg.includes("ETIMEDOUT")) {
          msg = "Redis connection timed out. Check Vercel logs and Redis connectivity.";
        }
        if (response_url) {
          await postToResponseUrl(response_url, `Summary failed: ${msg}`, true);
        } else {
          try {
            await slackPost(channel_id, `Summary failed: ${msg}`);
          } catch (e) {
            console.error("slackPost error:", e.message);
          }
        }
      }
    })()
  );
}
