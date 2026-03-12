import crypto from "crypto";
import axios from "axios";
import Redis from "ioredis";

const SLACK_TIMEOUT_MS = 8000;
const HUBSPOT_TIMEOUT_MS = 10000;

const redisUrl = process.env.REDIS_URL || process.env.deal_summarizer_bot_REDIS_URL;

// Lazy initialization to avoid module load errors at build time
let redisInstance = null;
export function getRedis() {
  if (!redisUrl) {
    throw new Error("Missing REDIS_URL environment variable");
  }
  // If the cached instance is dead, discard it so we create a fresh one
  if (redisInstance && redisInstance.status === "end") {
    console.warn("[utils Redis] connection was closed, reconnecting...");
    redisInstance = null;
  }
  if (!redisInstance) {
    redisInstance = new Redis(redisUrl, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 500, 2000);
      },
    });
    redisInstance.on("error", (err) => {
      console.error("[utils Redis] connection error:", err.message);
    });
  }
  return redisInstance;
}

// Export redis as a Proxy to forward all method calls (maintains full compatibility)
export const redis = new Proxy({}, {
  get(target, prop) {
    const redis = getRedis();
    const value = redis[prop];
    if (typeof value === 'function') {
      return value.bind(redis);
    }
    return value;
  }
});

// ===== Slack Bot Token (OAuth / token rotation) =====

const SLACK_REFRESH_BUFFER_MS = 60 * 60 * 1000; // refresh 1 hour before expiry
const REDIS_READ_TIMEOUT_MS = 2000; // fail fast from serverless if Redis is unreachable

// In-memory token cache — survives within a single invocation and across
// warm invocations on Vercel. Eliminates repeated Redis reads per request.
let _cachedSlackBotToken = null;
let _cachedSlackBotTokenExpiresAt = 0;
const SLACK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    ),
  ]);
}

/** Returns the cached Slack bot token synchronously, or null if not cached.
 *  Use this in error handlers to avoid a Redis round trip. */
export function getCachedSlackBotToken() {
  const envToken = process.env.SLACK_BOT_TOKEN || null;
  if (envToken) return envToken;
  if (_cachedSlackBotToken && Date.now() < _cachedSlackBotTokenExpiresAt) {
    return _cachedSlackBotToken;
  }
  return null;
}

export async function getSlackBotToken() {
  const envToken = process.env.SLACK_BOT_TOKEN || null;
  // When env token is set, use it directly so we never block on Redis
  if (envToken) {
    console.log("[getSlackBotToken] returning env token");
    return envToken;
  }

  // Check in-memory cache first
  if (_cachedSlackBotToken && Date.now() < _cachedSlackBotTokenExpiresAt) {
    console.log("[getSlackBotToken] returning cached token");
    return _cachedSlackBotToken;
  }

  console.log("[getSlackBotToken] reading from Redis (timeout %sms)...", REDIS_READ_TIMEOUT_MS);
  try {
    const r = getRedis();
    // Batch all 3 reads into a single timeout window
    const [access, refresh, expiresAtMsStr] = await withTimeout(
      Promise.all([
        r.get("slack:access_token"),
        r.get("slack:refresh_token"),
        r.get("slack:expires_at_ms"),
      ]),
      REDIS_READ_TIMEOUT_MS,
      "Redis read timeout (Slack token). Redis may be unreachable from Vercel."
    );
    const expiresAtMs = expiresAtMsStr ? Number(expiresAtMsStr) : 0;

    const now = Date.now();
    if (access && expiresAtMs && now < expiresAtMs - SLACK_REFRESH_BUFFER_MS) {
      _cachedSlackBotToken = access;
      _cachedSlackBotTokenExpiresAt = Date.now() + SLACK_CACHE_TTL_MS;
      return access;
    }

    if (refresh) {
      const clientId = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (clientId && clientSecret) {
        try {
          const resp = await axios.post(
            "https://slack.com/api/oauth.v2.access",
            new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              grant_type: "refresh_token",
              refresh_token: refresh,
            }),
            {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              timeout: SLACK_TIMEOUT_MS,
            }
          );
          if (resp.data?.ok) {
            const newAccess = resp.data.access_token;
            const newRefresh = resp.data.refresh_token;
            const expiresIn = Number(resp.data.expires_in ?? 43200);
            const newExpiresAt = Date.now() + expiresIn * 1000;
            await r.set("slack:access_token", newAccess);
            await r.set("slack:expires_at_ms", String(newExpiresAt));
            if (newRefresh) await r.set("slack:refresh_token", newRefresh);
            _cachedSlackBotToken = newAccess;
            _cachedSlackBotTokenExpiresAt = Date.now() + SLACK_CACHE_TTL_MS;
            return newAccess;
          }
        } catch (err) {
          console.error("Slack token refresh error:", err.message);
        }
      }
    }

    const isExpired = expiresAtMs && now >= expiresAtMs - SLACK_REFRESH_BUFFER_MS;
    if (!access) {
      throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
    }
    if (isExpired) {
      throw new Error(
        "Slack token expired and refresh failed; reinstall the app from Slack app settings (Install App)."
      );
    }
    _cachedSlackBotToken = access;
    _cachedSlackBotTokenExpiresAt = Date.now() + SLACK_CACHE_TTL_MS;
    return access;
  } catch (err) {
    console.error("[getSlackBotToken] Redis error or timeout:", err.message);
    throw err;
  }
}

// ===== Slack Request Verification =====

export function verifySlackRequest(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  const fiveMinutes = 60 * 5;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > fiveMinutes) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const mySig =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
      .update(sigBase, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ===== Slack API Helpers =====

export async function getSlackChannelName(channel_id) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.info", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.info error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.channel?.name || "name_not_found";
}

export async function getSlackChannelInfo(channel_id) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.info", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.info error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.channel;
}

export function isPublicChannel(channelInfo) {
  return channelInfo?.is_channel === true && channelInfo?.is_private === false;
}

export async function getChannelHistory(channel_id, limit = 100) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.history", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id, limit },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.history error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.messages || [];
}

export async function getExtendedChannelHistory(channel_id, targetCount = 200) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  let allMessages = [];
  let cursor = undefined;

  while (allMessages.length < targetCount) {
    const params = { channel: channel_id, limit: Math.min(100, targetCount - allMessages.length) };
    if (cursor) params.cursor = cursor;

    const resp = await axios.get("https://slack.com/api/conversations.history", {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: SLACK_TIMEOUT_MS
    });

    if (!resp.data?.ok) break;
    allMessages = allMessages.concat(resp.data.messages || []);
    cursor = resp.data.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return allMessages;
}

export async function getThreadHistory(channel_id, thread_ts) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const resp = await axios.get("https://slack.com/api/conversations.replies", {
    headers: { Authorization: `Bearer ${token}` },
    params: { channel: channel_id, ts: thread_ts },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack conversations.replies error: ${resp.data?.error || "unknown_error"}`);
  return resp.data.messages || [];
}

export async function slackPost(channel_id, text, thread_ts = null) {
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  const payload = { channel: channel_id, text };
  if (thread_ts) {
    payload.thread_ts = thread_ts;
  }
  const resp = await axios.post("https://slack.com/api/chat.postMessage", payload, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: SLACK_TIMEOUT_MS
  });
  if (!resp.data?.ok) throw new Error(`Slack chat.postMessage error: ${resp.data?.error || "unknown_error"}`);
  return resp.data;
}

export async function getBotUserId() {
  console.log("[getBotUserId] start");
  const token = await getSlackBotToken();
  if (!token) throw new Error("No Slack bot token (install app or set SLACK_BOT_TOKEN)");
  console.log("[getBotUserId] calling auth.test");
  let resp;
  try {
    resp = await axios.get("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000
    });
  } catch (err) {
    const msg = err.response?.data?.error || err.code || err.message;
    console.error("[getBotUserId] auth.test request failed:", msg);
    throw err;
  }
  if (!resp.data?.ok) {
    const errMsg = resp.data?.error || "unknown_error";
    console.error("[getBotUserId] auth.test failed:", errMsg);
    throw new Error(`Slack auth.test error: ${errMsg}`);
  }
  console.log("[getBotUserId] ok, user_id=", resp.data.user_id);
  return resp.data.user_id;
}

export function extractQuestionFromMention(text, botUserId) {
  // Remove @mention and clean up the text
  const mentionPattern = new RegExp(`<@${botUserId}>`, "g");
  let question = text.replace(mentionPattern, "").trim();
  // Remove quotes if present
  question = question.replace(/^["']|["']$/g, "").trim();
  return question;
}

export function isBotMessage(message) {
  return (
    message?.subtype === "bot" ||
    message?.subtype === "bot_message" ||
    message?.bot_id !== undefined
  );
}

export function isRocketlaneMessage(message) {
  if (!isBotMessage(message)) return false;
  const name = (message?.username || message?.bot_profile?.name || "").toLowerCase();
  if (name.includes("rocketlane")) return true;
  // Fallback: check message text for Rocketlane patterns
  const text = (message?.text || "").toLowerCase();
  return (
    text.includes("messaged on the task") ||
    text.includes("submitted a form response") ||
    text.includes("rocketlane")
  );
}

// ===== Regulatory Form Detection =====

const REGULATORY_FORM_PATTERNS = [
  /\behs\b/i,
  /\bregulatory\s*(form|requirement|acknowledgement|doc|document)\b/i,
  /\behs\s*(and\s*)?regulatory/i,
  /\bregulatory\s*acknowledgement/i,
  /\bclient\s*ehs/i,
  /\bpdt\s*acknowledgement/i,
  /\behs.*form/i,
  /\bregulatory.*form/i,
];

export function isRegulatoryFormQuestion(question) {
  return REGULATORY_FORM_PATTERNS.some((pattern) => pattern.test(question || ""));
}

const ROCKETLANE_EHS_PATTERN = /ehs|regulatory.*requirement|regulatory.*acknowledgement/i;
// Priority order: Rocketlane asset URLs, then PDFs, then any URL in the message
const ROCKETLANE_URL_PATTERN = /https?:\/\/assets\.rocketlane\.com\/[^\s>|]+/i;
const PDF_URL_PATTERN = /https?:\/\/[^\s>|]+\.pdf/i;
const ANY_URL_PATTERN = /https?:\/\/[^\s>|]+/i;

function extractUrlFromText(text, patterns) {
  if (!text) return null;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0].replace(/[>|].*$/, "");
  }
  return null;
}

export function findRocketlaneFormMessage(messages) {
  if (!messages || !messages.length) return null;

  const urlPatterns = [ROCKETLANE_URL_PATTERN, PDF_URL_PATTERN];

  for (const msg of messages) {
    if (!isBotMessage(msg)) continue;
    if (!ROCKETLANE_EHS_PATTERN.test(msg.text || "")) continue;

    // Found a candidate — extract the file/asset URL
    let fileUrl = null;

    // Check msg.text for URLs (Slack formats as <url|label> or <url>)
    fileUrl = extractUrlFromText(msg.text || "", urlPatterns);

    // Check attachments
    if (!fileUrl && msg.attachments) {
      for (const att of msg.attachments) {
        // Check direct URL fields first
        const directUrl = att.title_link || att.from_url || att.original_url || att.app_unfurl_url;
        if (directUrl) {
          const match = extractUrlFromText(directUrl, urlPatterns);
          if (match) { fileUrl = match; break; }
        }
        // Check text content
        const attText = [att.text, att.fallback].filter(Boolean).join(" ");
        const match = extractUrlFromText(attText, urlPatterns);
        if (match) { fileUrl = match; break; }
      }
    }

    // Check files
    if (!fileUrl && msg.files) {
      for (const file of msg.files) {
        const fileFields = [file.url_private, file.permalink, file.url_private_download];
        for (const f of fileFields) {
          const match = extractUrlFromText(f, urlPatterns);
          if (match) { fileUrl = match; break; }
        }
        if (fileUrl) break;
      }
    }

    // Fallback: grab any URL from attachments (Rocketlane may use non-standard URL structure)
    if (!fileUrl && msg.attachments) {
      for (const att of msg.attachments) {
        const directUrl = att.title_link || att.from_url || att.original_url || att.app_unfurl_url;
        if (directUrl) { fileUrl = directUrl; break; }
      }
    }

    return { ts: msg.ts, text: msg.text, fileUrl };
  }

  return null;
}

export async function getMessagePermalink(channel_id, message_ts) {
  const token = await getSlackBotToken();
  if (!token) return null;
  try {
    const resp = await axios.get("https://slack.com/api/chat.getPermalink", {
      headers: { Authorization: `Bearer ${token}` },
      params: { channel: channel_id, message_ts },
      timeout: SLACK_TIMEOUT_MS,
    });
    if (resp.data?.ok) return resp.data.permalink;
    console.error("[getMessagePermalink] error:", resp.data?.error);
    return null;
  } catch (err) {
    console.error("[getMessagePermalink] request failed:", err.message);
    return null;
  }
}

// ===== Channel Name to Deal Query =====

export function channelNameToDealQuery(channelName) {
  // reverse the slug: dashes to spaces
  // "conception-case-hillsman-et-al" -> "conception case hillsman et al"
  return (channelName || "").replace(/-/g, " ").trim();
}

// ===== Thread Context Management (Redis) =====

export async function storeThreadContext(channel_id, thread_ts, messages, dealId) {
  const key = `slack:thread:${channel_id}:${thread_ts}`;
  const data = {
    messages,
    dealId,
    lastUpdated: Date.now()
  };
  await redis.set(key, JSON.stringify(data), "EX", 86400); // 24 hour TTL
}

export async function getThreadContext(channel_id, thread_ts) {
  const key = `slack:thread:${channel_id}:${thread_ts}`;
  const data = await redis.get(key);
  if (!data) return null;
  return JSON.parse(data);
}

export async function addMessageToThread(channel_id, thread_ts, message) {
  const context = await getThreadContext(channel_id, thread_ts);
  if (!context) return null;
  context.messages.push(message);
  context.lastUpdated = Date.now();
  const key = `slack:thread:${channel_id}:${thread_ts}`;
  await redis.set(key, JSON.stringify(context), "EX", 86400);
  return context;
}

// ===== HubSpot Helpers =====

export async function hubspotTokenExchange(form) {
  const resp = await axios.post("https://api.hubapi.com/oauth/v1/token", form, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: HUBSPOT_TIMEOUT_MS
  });
  return resp.data;
}

// In-memory cache for HubSpot token (same pattern as Slack)
let _cachedHubSpotToken = null;
let _cachedHubSpotTokenExpiresAt = 0;
const HUBSPOT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getHubSpotAccessToken() {
  // Check in-memory cache first
  if (_cachedHubSpotToken && Date.now() < _cachedHubSpotTokenExpiresAt) {
    console.log("[getHubSpotAccessToken] returning cached token");
    return _cachedHubSpotToken;
  }

  const r = getRedis();
  const [access, refresh, expiresAtMsStr] = await withTimeout(
    Promise.all([
      r.get("hubspot:access_token"),
      r.get("hubspot:refresh_token"),
      r.get("hubspot:expires_at_ms"),
    ]),
    REDIS_READ_TIMEOUT_MS,
    "Redis read timeout (HubSpot token)."
  );
  const expiresAtMs = expiresAtMsStr ? Number(expiresAtMsStr) : 0;

  if (!refresh) throw new Error("HubSpot not connected: missing refresh token in Redis");

  const now = Date.now();
  const bufferMs = 60 * 1000; // refresh 60s early
  if (access && expiresAtMs && now < expiresAtMs - bufferMs) {
    _cachedHubSpotToken = access;
    _cachedHubSpotTokenExpiresAt = Date.now() + HUBSPOT_CACHE_TTL_MS;
    return access;
  }

  // Refresh
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("client_id", process.env.HUBSPOT_CLIENT_ID);
  form.set("client_secret", process.env.HUBSPOT_CLIENT_SECRET);
  form.set("refresh_token", refresh);

  const data = await hubspotTokenExchange(form);
  const newAccess = data.access_token;
  const expiresIn = Number(data.expires_in || 0);
  const newExpiresAt = Date.now() + expiresIn * 1000;

  await r.set("hubspot:access_token", newAccess);
  await r.set("hubspot:expires_at_ms", String(newExpiresAt));

  _cachedHubSpotToken = newAccess;
  _cachedHubSpotTokenExpiresAt = Date.now() + HUBSPOT_CACHE_TTL_MS;
  return newAccess;
}

export function hubspotClient(accessToken) {
  return axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: HUBSPOT_TIMEOUT_MS
  });
}

export async function findBestDeal(hs, dealQuery) {
  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: "dealname", operator: "CONTAINS_TOKEN", value: dealQuery }
        ]
      }
    ],
    properties: ["dealname", "createdate", "closedate", "dealstage", "pipeline", "hubspot_owner_id", "amount", "dealtype", "description", "deal_currency_code", "product_line", "source_configuration", "is_this_a_trial_"],
    limit: 10
  };

  const resp = await hs.post("/crm/v3/objects/deals/search", body);
  const results = resp.data?.results || [];
  if (!results.length) return null;

  results.sort((a, b) => {
    const ac = a.properties?.closedate ? Number(new Date(a.properties.closedate)) : 0;
    const bc = b.properties?.closedate ? Number(new Date(b.properties.closedate)) : 0;
    return bc - ac;
  });

  return results[0];
}

export async function getDealAssociations(hs, dealId) {
  const [contacts, companies] = await Promise.allSettled([
    hs.get(`/crm/v4/objects/deals/${dealId}/associations/contacts`),
    hs.get(`/crm/v4/objects/deals/${dealId}/associations/companies`)
  ]);

  const contactIds =
    contacts.status === "fulfilled"
      ? (contacts.value.data?.results || []).map((r) => r.toObjectId).filter(Boolean)
      : [];

  const companyIds =
    companies.status === "fulfilled"
      ? (companies.value.data?.results || []).map((r) => r.toObjectId).filter(Boolean)
      : [];

  return { contactIds, companyIds };
}

export async function batchRead(hs, objectType, ids, properties) {
  if (!ids.length) return [];
  const resp = await hs.post(`/crm/v3/objects/${objectType}/batch/read`, {
    inputs: ids.slice(0, 100).map((id) => ({ id })),
    properties
  });
  return resp.data?.results || [];
}

export async function resolveOwnerName(hs, ownerId) {
  if (!ownerId) return null;
  try {
    const resp = await hs.get(`/crm/v3/owners/${ownerId}`);
    const o = resp.data;
    const name = [o?.firstName, o?.lastName].filter(Boolean).join(" ").trim();
    return name || null;
  } catch {
    return null;
  }
}

export function daysBetweenISO(a, b) {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (!da || !db) return null;
  const diff = Math.round((db - da) / (1000 * 60 * 60 * 24));
  return diff;
}
