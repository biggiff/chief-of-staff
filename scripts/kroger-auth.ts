import { config } from "dotenv";
import http from "node:http";
import { exec } from "node:child_process";
import { KROGER_AUTHORIZE_URL, KROGER_REDIRECT, exchangeAuthCode } from "../src/lib/integrations/kroger";

config({ path: ".env.local" });

/**
 * One-time Fry's/Kroger authorization (loopback flow). Run with:
 *   npm run kroger:auth
 * Opens the Kroger consent screen, captures the code on localhost:4567/callback,
 * exchanges it, and stores the (rotating) refresh token in app_settings so Scout
 * can add items to her cart. Requires KROGER_CLIENT_ID/SECRET in .env.local.
 */
const PORT = 4567;
const SCOPE = "cart.basic:write";

const clientId = process.env.KROGER_CLIENT_ID;
if (!clientId || !process.env.KROGER_CLIENT_SECRET) {
  console.error("Missing KROGER_CLIENT_ID / KROGER_CLIENT_SECRET in .env.local.");
  process.exit(1);
}

const authUrl =
  `${KROGER_AUTHORIZE_URL}?` +
  new URLSearchParams({ client_id: clientId, redirect_uri: KROGER_REDIRECT, response_type: "code", scope: SCOPE }).toString();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || "/", KROGER_REDIRECT);
  if (!u.pathname.startsWith("/callback")) { res.writeHead(404).end(); return; }
  const code = u.searchParams.get("code");
  if (!code) { res.writeHead(400).end("No authorization code received."); return; }
  const result = await exchangeAuthCode(code).catch((e) => ({ ok: false, error: String(e) }));
  if (result.ok) {
    res.writeHead(200, { "Content-Type": "text/html" }).end("<h2>Fry's connected.</h2><p>You can close this tab.</p>");
    console.log("\n✓ Fry's cart authorized — refresh token saved.");
  } else {
    res.writeHead(500).end("Token exchange failed. Check the terminal.");
    console.error("Exchange failed:", result.error);
  }
  server.close();
  setTimeout(() => process.exit(0), 250);
});

server.listen(PORT, () => {
  console.log("\nOpening Kroger/Fry's consent in your browser...");
  console.log("If it doesn't open, paste this URL manually:\n");
  console.log(authUrl + "\n");
  exec(`open "${authUrl}"`);
});
