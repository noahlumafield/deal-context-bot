import axios from "axios";
import { getRedis, withTimeout } from "../utils.js";

const SLACK_TIMEOUT_MS = 10000;

async function exchangeCodeForTokens(code, redirectUri) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET");
  }

  const resp = await axios.post(
    "https://slack.com/api/oauth.v2.access",
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: SLACK_TIMEOUT_MS,
    }
  );

  if (!resp.data?.ok) {
    throw new Error(resp.data?.error || "oauth.v2.access failed");
  }

  return resp.data;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { code, error, state } = req.query;

    if (error) {
      return res.status(400).send(`Slack OAuth error: ${error}`);
    }

    if (!code) {
      return res.status(200).json({ status: "ok", endpoint: "slack-oauth-callback" });
    }

    const redirectUri = process.env.SLACK_REDIRECT_URI;
    if (!redirectUri) {
      return res.status(500).send("Missing SLACK_REDIRECT_URI");
    }

    try {
      const data = await exchangeCodeForTokens(code, redirectUri);

      const accessToken = data.access_token;
      const refreshToken = data.refresh_token;
      const expiresIn = Number(data.expires_in ?? 43200);
      const expiresAtMs = Date.now() + expiresIn * 1000;

      const redis = getRedis();
      await withTimeout(
        Promise.all([
          redis.set("slack:access_token", accessToken),
          redis.set("slack:expires_at_ms", String(expiresAtMs)),
          ...(refreshToken ? [redis.set("slack:refresh_token", refreshToken)] : []),
        ]),
        5000,
        "Redis write timeout — could not store Slack tokens. Check Redis connectivity."
      );
    } catch (err) {
      console.error("Slack OAuth token exchange error:", err);
      return res.status(500).send(
        `Token exchange failed: ${err.message || "unknown_error"}`
      );
    }

    return res.status(200).send(`
      <html>
        <body>
          <h1>✅ Slack App Authorized</h1>
          <p>You can close this window. The app is now installed and tokens are stored.</p>
        </body>
      </html>
    `);
  }

  return res.status(405).send("Method Not Allowed");
}
