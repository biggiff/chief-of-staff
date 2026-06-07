import { config } from "dotenv";
import http from "node:http";
import { exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

config({ path: ".env.local" });

/**
 * One-time Google OAuth consent (loopback flow). Run with:
 *   npm run google:auth
 *
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET already in .env.local.
 * Opens the consent screen, captures the code on http://localhost:4567, exchanges
 * it for a refresh token, and writes GOOGLE_REFRESH_TOKEN back into .env.local.
 */

const PORT = 4567;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.local. Add them first, then re-run."
  );
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  }).toString();

function writeRefreshToken(token: string) {
  const path = ".env.local";
  let contents = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `GOOGLE_REFRESH_TOKEN=${token}`;
  if (/^GOOGLE_REFRESH_TOKEN=.*$/m.test(contents)) {
    contents = contents.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line);
  } else {
    contents += (contents.endsWith("\n") || contents === "" ? "" : "\n") + line + "\n";
  }
  writeFileSync(path, contents);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", REDIRECT);
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No authorization code received.");
    return;
  }
  try {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = (await r.json()) as { refresh_token?: string; error?: string };
    if (j.refresh_token) {
      writeRefreshToken(j.refresh_token);
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<h2>Connected.</h2><p>Refresh token saved to .env.local. You can close this tab.</p>");
      console.log("\n✓ GOOGLE_REFRESH_TOKEN saved to .env.local. Calendar is connected.");
    } else {
      res.writeHead(500).end("No refresh token returned. Check the terminal.");
      console.error("No refresh_token in response:", j);
    }
  } catch (err) {
    res.writeHead(500).end("Token exchange failed. Check the terminal.");
    console.error(err);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 250);
  }
});

server.listen(PORT, () => {
  console.log("\nOpening Google consent in your browser...");
  console.log("If it doesn't open, paste this URL manually:\n");
  console.log(authUrl + "\n");
  exec(`open "${authUrl}"`);
});
