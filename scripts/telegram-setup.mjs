#!/usr/bin/env node
/**
 * One-time Telegram authentication.
 *
 * Run with:  npm run telegram:setup
 * (which uses Node's built-in --env-file flag to load .env.local)
 *
 * Steps:
 *   1. Ensure TELEGRAM_API_ID + TELEGRAM_API_HASH are in .env.local
 *   2. Run the script — it asks for phone + SMS code interactively
 *   3. Copy the printed TELEGRAM_SESSION="..." line into .env.local
 *   4. Restart `npm run dev`
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";

const apiId = parseInt(process.env.TELEGRAM_API_ID || "", 10);
const apiHash = process.env.TELEGRAM_API_HASH || "";

if (!apiId || !apiHash) {
  console.error("\n❌ Missing TELEGRAM_API_ID or TELEGRAM_API_HASH in .env.local");
  console.error("   Get them at: https://my.telegram.org → API development tools\n");
  process.exit(1);
}

console.log("\n━━━ Telegram one-time auth ━━━");
console.log(`Using api_id=${apiId}\n`);

const session = new StringSession("");
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

await client.start({
  phoneNumber: async () => input.text("📱 Phone number (with country code, e.g. +1...): "),
  password:    async () => input.text("🔐 2FA password (if you have one, otherwise blank): "),
  phoneCode:   async () => input.text("📨 Code from Telegram SMS/app: "),
  onError:     (err) => console.error("Auth error:", err),
});

const sessionString = client.session.save();
console.log("\n✅ Authenticated successfully!\n");
console.log("Add this line to .env.local (keep secret — it's a login credential):\n");
console.log(`TELEGRAM_SESSION="${sessionString}"\n`);
console.log("Then restart the dev server. It will connect headlessly from now on.\n");

await client.disconnect();
process.exit(0);
