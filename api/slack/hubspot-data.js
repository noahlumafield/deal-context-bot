import { batchRead } from "./utils.js";

// ===== Modern CRM v4 Deal Activity Fetching =====
// Uses associations API (v4) + batch read (v3) — same proven pattern as fetchDealNotes.
// Replaces deprecated /engagements/v1/ and non-functional /integrations/v1/ endpoints.

export async function fetchDealEmails(hs, dealId) {
  try {
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/emails`);
    const emailIds = (assoc.data?.results || [])
      .map((r) => r.toObjectId)
      .filter(Boolean)
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, 100);

    if (!emailIds.length) return [];

    const emails = await batchRead(hs, "emails", emailIds, [
      "hs_email_subject",
      "hs_email_direction",
      "hs_email_status",
      "hs_email_text",
      "hs_email_html",
      "hs_timestamp",
      "hs_email_sender_email",
      "hs_email_to_email"
    ]);
    return emails.sort(
      (a, b) =>
        Number(new Date(b.properties?.hs_timestamp || 0)) -
        Number(new Date(a.properties?.hs_timestamp || 0))
    );
  } catch (err) {
    console.error("[fetchDealEmails] error:", err.message, err.response?.status);
    return [];
  }
}

export async function fetchDealCalls(hs, dealId) {
  try {
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/calls`);
    const callIds = (assoc.data?.results || [])
      .map((r) => r.toObjectId)
      .filter(Boolean)
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, 100);

    if (!callIds.length) return [];

    const calls = await batchRead(hs, "calls", callIds, [
      "hs_call_title",
      "hs_call_body",
      "hs_call_summary",
      "hs_call_direction",
      "hs_call_duration",
      "hs_call_disposition",
      "hs_call_status",
      "hs_timestamp"
    ]);
    return calls.sort(
      (a, b) =>
        Number(new Date(b.properties?.hs_timestamp || 0)) -
        Number(new Date(a.properties?.hs_timestamp || 0))
    );
  } catch (err) {
    console.error("[fetchDealCalls] error:", err.message, err.response?.status);
    return [];
  }
}

export async function fetchDealMeetings(hs, dealId) {
  try {
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/meetings`);
    const meetingIds = (assoc.data?.results || [])
      .map((r) => r.toObjectId)
      .filter(Boolean)
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, 100);

    if (!meetingIds.length) return [];

    const meetings = await batchRead(hs, "meetings", meetingIds, [
      "hs_meeting_title",
      "hs_meeting_body",
      "hs_meeting_start_time",
      "hs_meeting_end_time",
      "hs_meeting_outcome",
      "hs_timestamp"
    ]);
    return meetings.sort(
      (a, b) =>
        Number(new Date(b.properties?.hs_timestamp || 0)) -
        Number(new Date(a.properties?.hs_timestamp || 0))
    );
  } catch (err) {
    console.error("[fetchDealMeetings] error:", err.message, err.response?.status);
    return [];
  }
}

export async function fetchDealNotes(hs, dealId) {
  try {
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/notes`);
    const noteIds = (assoc.data?.results || []).map((r) => r.toObjectId).filter(Boolean).sort((a, b) => Number(b) - Number(a)).slice(0, 100);

    if (!noteIds.length) return [];

    const notes = await batchRead(hs, "notes", noteIds, ["hs_note_body", "hs_createdate", "hubspot_owner_id"]);
    return notes.sort(
      (a, b) => Number(new Date(b.properties?.hs_createdate || 0)) - Number(new Date(a.properties?.hs_createdate || 0))
    );
  } catch (err) {
    console.error("Error fetching notes:", err.message);
    return [];
  }
}

export async function fetchDealLineItems(hs, dealId) {
  try {
    const assoc = await hs.get(`/crm/v4/objects/deals/${dealId}/associations/line_items`);
    const lineItemIds = (assoc.data?.results || [])
      .map((r) => r.toObjectId)
      .filter(Boolean)
      .slice(0, 50);

    if (!lineItemIds.length) return [];

    const items = await batchRead(hs, "line_items", lineItemIds, [
      "name",
      "description",
      "quantity",
      "price",
      "amount",
      "hs_product_id",
      "hs_sku",
      "recurringbillingfrequency",
      "hs_term_in_months"
    ]);
    return items;
  } catch (err) {
    console.error("[fetchDealLineItems] error:", err.message, err.response?.status);
    return [];
  }
}

export function formatLineItemsForPrompt(lineItems) {
  if (!lineItems || !lineItems.length) return null;
  return lineItems
    .map((item) => {
      const p = item.properties || {};
      const name = p.name || "Unnamed item";
      const qty = p.quantity ? `Qty: ${p.quantity}` : "";
      const price = p.price ? `$${Number(p.price).toLocaleString()}` : "";
      const amount = p.amount ? `$${Number(p.amount).toLocaleString()}` : "";
      const freq = p.recurringbillingfrequency || "";
      const term = p.hs_term_in_months ? `${p.hs_term_in_months}mo term` : "";
      const desc = p.description ? ` — ${p.description.substring(0, 100)}` : "";

      let detail = [qty, price ? `@ ${price}` : "", amount ? `= ${amount}` : ""].filter(Boolean).join(" ");
      if (freq) detail += ` (${freq})`;
      if (term) detail += ` [${term}]`;
      return `  - ${name}${detail ? ` (${detail})` : ""}${desc}`;
    })
    .join("\n");
}

// ===== Cross-Deal Search =====

export async function searchDealsAcrossPortal(hs, keywords, excludeDealId, limit = 20) {
  try {
    // Build filter groups — HubSpot supports up to 3 filterGroups (OR'd together)
    // Search dealname and description for each keyword
    const filterGroups = [];
    for (const keyword of keywords.slice(0, 3)) {
      filterGroups.push({
        filters: [
          { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: keyword }
        ]
      });
    }

    if (!filterGroups.length) return [];

    const resp = await hs.post("/crm/v3/objects/deals/search", {
      filterGroups,
      properties: [
        "dealname", "dealstage", "pipeline", "amount", "dealtype",
        "closedate", "createdate", "description", "hubspot_owner_id", "deal_currency_code"
      ],
      limit
    });

    const results = (resp.data?.results || [])
      .filter((d) => d.id !== excludeDealId);

    return results;
  } catch (err) {
    console.error("[searchDealsAcrossPortal] error:", err.message, err.response?.status);
    return [];
  }
}

export function formatCrossDealResults(deals) {
  if (!deals || !deals.length) return null;
  return deals
    .map((d) => {
      const p = d.properties || {};
      const name = p.dealname || "Unnamed deal";
      const stage = p.dealstage || "unknown stage";
      const amount = p.amount ? `$${Number(p.amount).toLocaleString()}` : "no amount";
      const type = p.dealtype || "";
      const closed = p.closedate ? new Date(p.closedate).toISOString().split("T")[0] : "";
      const desc = p.description ? p.description.substring(0, 150) : "";
      let line = `- ${name} | ${stage} | ${amount}`;
      if (type) line += ` | ${type}`;
      if (closed) line += ` | closed ${closed}`;
      if (desc) line += `\n  ${desc}`;
      return line;
    })
    .join("\n");
}

// ===== Keyword-Based Data Requirements =====

export function determineRequiredData(question, dealData) {
  const q = question.toLowerCase();
  const required = {
    emails: true,     // Always fetch — most commonly asked about
    notes: true,      // Always fetch — most commonly asked about
    calls: false,
    meetings: false,
    contacts: true,
    companies: true
  };

  // Broad triggers for calls and meetings
  const activityTriggers =
    q.includes("call") ||
    q.includes("called") ||
    q.includes("phone") ||
    q.includes("spoke") ||
    q.includes("spoken") ||
    q.includes("conversation") ||
    q.includes("meet") ||
    q.includes("meeting") ||
    q.includes("demo") ||
    q.includes("schedule") ||
    q.includes("calendar") ||
    q.includes("activity") ||
    q.includes("timeline") ||
    q.includes("history") ||
    q.includes("recent") ||
    q.includes("latest") ||
    q.includes("update") ||
    q.includes("status") ||
    q.includes("happen") ||
    q.includes("touch") ||
    q.includes("communicat") ||
    q.includes("engag") ||
    q.includes("interact") ||
    q.includes("outreach") ||
    q.includes("last") ||
    q.includes("summary") ||
    q.includes("overview") ||
    q.includes("what's going on") ||
    q.includes("whats going on");

  if (activityTriggers) {
    required.calls = true;
    required.meetings = true;
  }

  return required;
}

// ===== Unified Timeline Formatter =====

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function formatTimelineForPrompt(emails, calls, meetings, notes, maxEmailLength = 200, maxItems = 40) {
  const items = [];

  for (const e of (emails || [])) {
    const p = e.properties || {};
    const date = p.hs_timestamp
      ? new Date(p.hs_timestamp).toISOString().split("T")[0]
      : "unknown date";
    const direction = p.hs_email_direction === "INCOMING_EMAIL" ? "Received" : "Sent";
    const subject = p.hs_email_subject || "No subject";
    const from = p.hs_email_sender_email || "";
    const to = p.hs_email_to_email || "";
    const body = (p.hs_email_text || stripHtml(p.hs_email_html) || "").replace(/\s+/g, " ").trim();
    const snippet = body ? `: ${body.substring(0, maxEmailLength)}` : "";
    items.push({
      timestamp: p.hs_timestamp || "0",
      line: `- EMAIL (${direction}) on ${date} — Subject: "${subject}"${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}${snippet}`
    });
  }

  for (const c of (calls || [])) {
    const p = c.properties || {};
    const date = p.hs_timestamp
      ? new Date(p.hs_timestamp).toISOString().split("T")[0]
      : "unknown date";
    const title = p.hs_call_title || "Call";
    const direction = p.hs_call_direction === "INBOUND" ? "Inbound" : "Outbound";
    const duration = p.hs_call_duration
      ? `${Math.round(Number(p.hs_call_duration) / 1000 / 60)}min`
      : "";
    const disposition = p.hs_call_disposition || "";
    const callContent = (p.hs_call_summary || p.hs_call_body || "").replace(/\s+/g, " ").trim();
    const snippet = callContent ? `: ${callContent.substring(0, 1000)}` : "";
    items.push({
      timestamp: p.hs_timestamp || "0",
      line: `- CALL (${direction}) on ${date} — ${title}${duration ? `, ${duration}` : ""}${disposition ? ` [${disposition}]` : ""}${snippet}`
    });
  }

  for (const m of (meetings || [])) {
    const p = m.properties || {};
    const date = p.hs_timestamp
      ? new Date(p.hs_timestamp).toISOString().split("T")[0]
      : "unknown date";
    const title = p.hs_meeting_title || "Meeting";
    const outcome = p.hs_meeting_outcome || "";
    const body = (p.hs_meeting_body || "").replace(/\s+/g, " ").trim();
    const snippet = body ? `: ${stripHtml(body).substring(0, 3000)}` : "";
    items.push({
      timestamp: p.hs_timestamp || "0",
      line: `- MEETING on ${date} — ${title}${outcome ? ` [${outcome}]` : ""}${snippet}`
    });
  }

  for (const n of (notes || [])) {
    const p = n.properties || {};
    const date = p.hs_createdate
      ? new Date(p.hs_createdate).toISOString().split("T")[0]
      : "unknown date";
    const body = stripHtml(p.hs_note_body || "").replace(/\s+/g, " ").trim();
    items.push({
      timestamp: p.hs_createdate || "0",
      line: `- NOTE on ${date}: ${body.substring(0, 3000)}`
    });
  }

  if (!items.length) return "No activity found in HubSpot.";

  // Sort descending by timestamp (most recent first)
  items.sort(
    (a, b) => Number(new Date(b.timestamp)) - Number(new Date(a.timestamp))
  );

  return items.slice(0, maxItems).map((i) => i.line).join("\n");
}
