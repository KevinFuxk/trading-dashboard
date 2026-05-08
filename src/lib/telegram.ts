/**
 * Telegram MTProto client — listens to public oil/energy channels in real-time.
 *
 * Replaces the RSS-based news feed with curated Telegram channel posts.
 *
 * Auth: requires TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION env vars.
 *       See scripts/telegram-setup.mjs for one-time auth flow.
 *
 * Architecture:
 *   • One singleton client connects on server startup (instrumentation.ts)
 *   • Subscribes to NewMessage events from configured channels
 *   • Filters by oil/Iran/Hormuz keywords
 *   • Pushes new messages into an in-memory ring buffer (last 100)
 *   • SSE stream reads from this buffer; new messages fire a "telegramMessage" event
 */

import type { NewsItem } from "./types";

// ── Configuration: which public channels to monitor ───────────────────────────
// Channels marked `oilNative: true` are 100% oil/energy → no keyword filter.
// Channels marked `oilNative: false` are general newswires → keyword filter applies.
// Add/remove freely. Test usernames at https://t.me/<username> first.
// Only verified-existing public channels. Add more by editing this list.
// To find good channels: search t.me directly, or join Telegram and find them.
export const OIL_CHANNELS: Array<{ username: string; oilNative: boolean }> = [
  // Pure oil/energy channels — keep ALL their posts (they're already filtered)
  { username: "Oilprice_com",       oilNative: true  },
  { username: "EnergyIntelligence", oilNative: true  },
  { username: "OilHub",             oilNative: true  },
  // General newswires — keyword filter applies
  { username: "Bloomberg",          oilNative: false },
  { username: "BBCBreaking",        oilNative: false },
  { username: "TheEconomist",       oilNative: false },
  // Iran-focused
  { username: "IranIntl_En",        oilNative: false },
];

// Don't keep messages older than this — protects against stale prefetch.
// Many oil channels post infrequently (some post once a month or less).
// 90 days lets you see channel activity. Newest items always appear first via the
// timestamp sort in fetchNewsFeed, so old items only fill the bottom.
const MAX_MESSAGE_AGE_MS = 90 * 24 * 3600_000;  // 90 days

// ── Keyword filter: must match at least one to be saved ──────────────────────
const OIL_KEYWORDS = [
  // Oil markets
  "brent", "crude", "wti", "opec", "barrel", "petroleum",
  "oil price", "oil prices", "gasoline", "refinery", "pipeline",
  // Iran / Hormuz / geopolitical
  "iran", "iranian", "tehran", "irgc", "hormuz", "strait",
  "blockade", "tanker", "naval", "navy", "warship",
  // Macro relevance
  "sanctions", "embargo", "supply", "demand", "inventory",
];

const KEYWORD_RE = new RegExp(`\\b(${OIL_KEYWORDS.join("|")})\\b`, "i");

// ── In-memory ring buffer of recent Telegram messages ─────────────────────────
const MAX_BUFFER = 100;
type TelegramMessage = NewsItem & { telegramChannel: string };
type Subscriber = (msg: TelegramMessage) => void;

// State lives on globalThis so it's shared across Next.js module-instance
// boundaries (instrumentation.ts and API route handlers get separate module
// instances under Turbopack — globalThis bridges them).
interface TelegramGlobalState {
  buffer: TelegramMessage[];
  seenIds: Set<string>;
  subscribers: Set<Subscriber>;
  status: "disconnected" | "connecting" | "connected" | "auth-needed" | "error";
  started: boolean;
}

const g = globalThis as unknown as { __tg?: TelegramGlobalState };
if (!g.__tg) {
  g.__tg = {
    buffer: [],
    seenIds: new Set(),
    subscribers: new Set(),
    status: "disconnected",
    started: false,
  };
}
const state = g.__tg;

export function subscribeTelegram(fn: Subscriber): () => void {
  state.subscribers.add(fn);
  return () => { state.subscribers.delete(fn); };
}

export function getTelegramMessages(): TelegramMessage[] {
  const cutoff = Date.now() - MAX_MESSAGE_AGE_MS;
  return state.buffer
    .filter(m => new Date(m.timestamp).getTime() > cutoff)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function getTelegramStatus(): TelegramGlobalState["status"] {
  return state.status;
}

/**
 * Starts the Telegram client. Call once at server boot.
 * No-ops if env vars missing or client already started.
 */
export async function startTelegramClient(): Promise<void> {
  if (state.started) return;
  state.started = true;

  const apiIdRaw  = process.env.TELEGRAM_API_ID;
  const apiHash   = process.env.TELEGRAM_API_HASH;
  const sessionStr = process.env.TELEGRAM_SESSION;

  if (!apiIdRaw || !apiHash || !sessionStr) {
    state.status = "auth-needed";
    console.warn("[TG] Missing TELEGRAM_API_ID/HASH/SESSION — Telegram disabled.");
    console.warn("[TG] Run `npm run telegram:setup` to authenticate.");
    return;
  }

  const apiId = parseInt(apiIdRaw, 10);
  if (!apiId) {
    state.status = "error";
    console.error("[TG] TELEGRAM_API_ID is not a number");
    return;
  }

  try {
    state.status = "connecting";
    // Dynamic import so this only loads if env is configured
    const { TelegramClient } = await import("telegram");
    const { StringSession }  = await import("telegram/sessions/index.js");
    const { NewMessage }     = await import("telegram/events/index.js");

    const session = new StringSession(sessionStr);
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      // Suppress chatty logs from gramjs
      baseLogger: { warn: ()=>{}, info: ()=>{}, debug: ()=>{}, error: console.error } as never,
    });

    await client.connect();
    if (!(await client.isUserAuthorized())) {
      state.status = "auth-needed";
      console.warn("[TG] Session not authorized — re-run `npm run telegram:setup`");
      return;
    }

    state.status = "connected";
    console.log(`[TG] ✓ Connected as user, listening to ${OIL_CHANNELS.length} channels`);

    // Subscribe to NewMessage events from any of our channels
    client.addEventHandler(async (event: { message: { message?: string; date?: number; id?: number; chatId?: { toString?: () => string } } }) => {
      try {
        const msg = event.message;
        if (!msg?.message) return;

        const text: string = msg.message;

        // Resolve channel info
        const chat = await (event as unknown as { getChat?: () => Promise<{ username?: string; title?: string; id?: { toString?: () => string } }> }).getChat?.();
        const channelUsername = chat?.username || "";
        const channelTitle    = chat?.title || channelUsername || "Telegram";

        // Find channel config in allowlist (case-insensitive)
        const channelCfg = OIL_CHANNELS.find(
          c => c.username.toLowerCase() === channelUsername.toLowerCase()
        );
        if (!channelCfg) return;  // not in our allowlist

        // Native oil channels: keep all messages.
        // General newswires: only keep oil/Iran/Hormuz keyword matches.
        if (!channelCfg.oilNative && !KEYWORD_RE.test(text)) return;

        const id = `tg-${channelUsername}-${msg.id}`;
        if (state.seenIds.has(id)) return;
        state.seenIds.add(id);

        const timestamp = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

        // Build NewsItem
        const tgMsg: TelegramMessage = {
          id,
          title: text.split("\n")[0].slice(0, 200),
          summary: text.slice(0, 400),
          source: channelTitle,
          telegramChannel: channelUsername || channelTitle,
          url: channelUsername ? `https://t.me/${channelUsername}/${msg.id}` : "",
          timestamp,
          category: detectCategory(text),
          isBreaking: detectBreaking(text),
        };

        // Add to buffer (newest at end, drop oldest)
        state.buffer.push(tgMsg);
        while (state.buffer.length > MAX_BUFFER) {
          const removed = state.buffer.shift();
          if (removed) state.seenIds.delete(removed.id);
        }

        console.log(`[TG] 📩 ${channelUsername}: ${text.slice(0, 80).replace(/\n/g, " ")}…`);

        // Notify subscribers
        for (const sub of state.subscribers) {
          try { sub(tgMsg); } catch (err) { console.warn("[TG] subscriber error:", err); }
        }
      } catch (err) {
        console.warn("[TG] event handler error:", err);
      }
    }, new NewMessage({}));

    // Pre-fetch recent history from each channel so we have something to display immediately
    await prefetchChannelHistory(client);
  } catch (err) {
    state.status = "error";
    console.error("[TG] Connection failed:", (err as Error).message);
  }
}

async function prefetchChannelHistory(client: unknown): Promise<void> {
  const c = client as { getMessages?: (entity: string, opts: { limit: number }) => Promise<Array<{ id?: number; date?: number; message?: string }>> };
  let totalKept = 0;
  for (const channel of OIL_CHANNELS) {
    try {
      const msgs = await c.getMessages?.(channel.username, { limit: 30 });
      if (!msgs?.length) {
        console.log(`[TG] @${channel.username}: 0 fetched`);
        continue;
      }
      let kept = 0;
      for (const m of msgs) {
        if (!m.message) continue;
        // Native oil channels: keep all. Newswires: keyword filter.
        if (!channel.oilNative && !KEYWORD_RE.test(m.message)) continue;
        const id = `tg-${channel.username}-${m.id}`;
        if (state.seenIds.has(id)) continue;
        state.seenIds.add(id);
        const ts = m.date ? new Date(m.date * 1000).toISOString() : new Date().toISOString();
        state.buffer.push({
          id,
          title: m.message.split("\n")[0].slice(0, 200),
          summary: m.message.slice(0, 400),
          source: channel.username,
          telegramChannel: channel.username,
          url: `https://t.me/${channel.username}/${m.id}`,
          timestamp: ts,
          category: detectCategory(m.message),
          isBreaking: detectBreaking(m.message),
        });
        kept++;
      }
      totalKept += kept;
      console.log(`[TG] @${channel.username}: ${msgs.length} fetched → ${kept} kept (${channel.oilNative ? "native" : "filtered"})`);
    } catch (err) {
      console.warn(`[TG] Could not prefetch @${channel.username}:`, (err as Error).message);
    }
  }
  console.log(`[TG] Prefetch complete — ${totalKept} messages in buffer`);
}

function detectCategory(text: string): NewsItem["category"] {
  const t = text.toLowerCase();
  if (/hormuz|iran|irgc|tanker|naval|sanction/.test(t)) return "geopolitical";
  if (/opec|cartel|production.cut/.test(t))             return "opec";
  if (/fed|fomc|powell|federal.reserve/.test(t))        return "fed";
  if (/bank.of.england|boe|mpc/.test(t))                return "boe";
  return "oil";
}

function detectBreaking(text: string): boolean {
  return /\b(breaking|urgent|alert|emergency|just in|exclusive|hormuz|blockade|attack|strike|spike|surge|plunge)\b/i.test(text);
}
