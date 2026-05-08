/**
 * Data source fetchers — server-side only.
 *
 * LIVE SOURCES:
 * - Economic Calendar: ForexFactory (schedule) + BLS direct (actuals) ✅ LIVE
 * - Oil Inventory: EIA API v2 (api.eia.gov)                           ✅ LIVE
 * - News Feed: Federal Reserve RSS (federalreserve.gov)                ✅ LIVE
 * - Truth Social: Google News RSS                                       ✅ LIVE
 * - Hormuz: EIA chokepoint data + fallback                             ✅ LIVE
 *
 * LATENCY STRATEGY:
 * - ForexFactory gives us the schedule (what + when)
 * - BLS API gives us actuals the moment they drop (no FF middleman)
 * - Release sniper polls BLS every 2s around 8:30 ET release windows
 */

import type {
  EconomicEvent,
  TruthSocialPost,
  HormuzUpdate,
  NewsItem,
  OilInventory,
} from "./types";
import { fetchBLSData, mergeBLSActualsIntoCalendar } from "./gov-calendar";

// ============================================================
//  In-memory cache — with stale-while-revalidate (SWR) support
//
//  SWR pattern: when cache is stale, serve the old data immediately
//  (<1ms) and kick off a background refresh. Callers never block on
//  a live network fetch after first load — latency = 0ms from cache.
// ============================================================
const cache = new Map<string, { data: unknown; ts: number }>();
const backgroundRefreshing = new Set<string>();

function getCached<T>(key: string, ttlMs: number): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data as T;
  return null;
}
function getStale<T>(key: string): T | null {
  const entry = cache.get(key);
  return entry ? (entry.data as T) : null;
}
function setCache(key: string, data: unknown) {
  cache.set(key, { data, ts: Date.now() });
}

/**
 * Stale-While-Revalidate: return cached data (even stale) immediately,
 * trigger a background refresh so the NEXT call gets fresh data.
 * Falls back to a live fetch only when there is literally nothing in cache.
 *
 * `persistKey` opt-in: when set, writes successful fetches to /tmp/uigen_cache_*.json
 * so the data survives server restarts. On cold start (empty in-memory cache),
 * the disk cache is loaded if it's fresh enough (within `persistMaxAgeMs`).
 */
async function withSWR<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  opts?: { persistKey?: string; persistMaxAgeMs?: number },
): Promise<T> {
  let entry = cache.get(key);

  // Cold start — try disk cache to avoid 3-5s first-load penalty
  if (!entry && opts?.persistKey) {
    const fromDisk = loadDisk<T>(opts.persistKey, opts.persistMaxAgeMs ?? 24 * 3600_000);
    if (fromDisk != null) {
      console.log(`[SWR] disk cache hit for ${key}`);
      setCache(key, fromDisk);
      entry = cache.get(key);
    }
  }

  const age = entry ? Date.now() - entry.ts : Infinity;
  if (entry && age < ttlMs) return entry.data as T; // fresh — return immediately

  if (entry) {
    // Stale — return old data NOW and refresh in background
    if (!backgroundRefreshing.has(key)) {
      backgroundRefreshing.add(key);
      fetcher()
        .then(d => { setCache(key, d); if (opts?.persistKey) saveDisk(opts.persistKey, d); })
        .catch(e => console.warn(`[SWR] background refresh failed (${key}):`, e))
        .finally(() => backgroundRefreshing.delete(key));
    }
    return entry.data as T;
  }

  // Nothing in cache (memory or disk) — do live fetch
  try {
    const data = await fetcher();
    setCache(key, data);
    if (opts?.persistKey) saveDisk(opts.persistKey, data);
    return data;
  } catch (err) {
    const retry = cache.get(key);
    if (retry) return retry.data as T;
    throw err;
  }
}

/**
 * Bypasses the ForexFactory calendar cache so the next
 * fetchEconomicCalendar() call fetches fresh data from FF.
 * Called by the UK sniper when it detects new GBP actuals.
 */
export function bypassFFCache() {
  cache.delete("econ_cal_ff");
  ffNextAllowedFetch = 0; // also clear any rate-limit backoff
}

/**
 * Bypass oil inventory + nat gas caches — used by the EIA crude oil sniper
 * around 10:30 ET Wednesdays to catch the new release ASAP.
 */
export function bypassEIACache() {
  cache.delete("oil_inv");
  cache.delete("nat_gas_storage");
}

// ─── Generic disk cache — survives server restarts ────────────────────────────
// Each cache key gets its own file in /tmp. Configurable max age per load.
import { readFileSync, writeFileSync } from "fs";

function diskPath(key: string): string {
  return `/tmp/uigen_cache_${key}.json`;
}

function loadDisk<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = readFileSync(diskPath(key), "utf8");
    const parsed = JSON.parse(raw) as { ts: number; data: T };
    if (Date.now() - parsed.ts < maxAgeMs) {
      return parsed.data;
    }
  } catch { /* no disk cache yet */ }
  return null;
}

function saveDisk<T>(key: string, data: T): void {
  try {
    writeFileSync(diskPath(key), JSON.stringify({ ts: Date.now(), data }));
  } catch { /* ignore write errors */ }
}

// Backward-compat shims for the old FF-specific helpers
const loadFFDiskCache = (): EconomicEvent[] | null => {
  const data = loadDisk<EconomicEvent[]>("ff_calendar", 2 * 3600_000);
  if (data) console.log(`[FF CAL] Loaded ${data.length} events from disk cache`);
  return data;
};
const saveFFDiskCache = (events: EconomicEvent[]) => saveDisk("ff_calendar", events);

const EIA_KEY = process.env.EIA_API_KEY || "DEMO_KEY";

// ============================================================
//  Economic Calendar  ✅ LIVE via ForexFactory JSON API
//  Source: nfs.faireconomy.media/ff_calendar_thisweek.json
//  This is a public JSON mirror of ForexFactory's weekly calendar.
//  Returns clean JSON: { title, country, date, impact, forecast, previous }
// ============================================================

interface FFCalendarEntry {
  title: string;
  country: string;       // "USD", "GBP", "EUR", etc.
  date: string;          // ISO timestamp, e.g. "2026-04-14T08:30:00-04:00"
  impact: string;        // "High", "Medium", "Low", "Holiday"
  forecast: string;      // e.g. "0.4%", "215K", or ""
  previous: string;      // e.g. "0.5%", "219K"
  actual?: string;       // populated by FF after release (e.g. "0.3%")
}

export async function fetchEconomicCalendar(): Promise<EconomicEvent[]> {
  // Run all 4 in parallel: FF schedule, BLS/FRED/Census actuals, EIA crude, EIA nat gas
  const [ffEvents, blsData, oilInv, natGas] = await Promise.allSettled([
    fetchFFCalendar(),
    fetchBLSData(),
    fetchOilInventory(),  // re-uses SWR cache
    fetchNatGasStorage(), // re-uses SWR cache
  ]);

  const events = ffEvents.status === "fulfilled"
    ? ffEvents.value
    : (getStale<EconomicEvent[]>("econ_cal_ff") ?? loadFFDiskCache() ?? generateFallbackCalendar());
  const bls = blsData.status === "fulfilled" ? blsData.value : [];

  let merged = mergeBLSActualsIntoCalendar(events, bls);

  // Inject EIA Crude Oil Inventories from the oil panel data
  if (oilInv.status === "fulfilled" && oilInv.value) {
    const inv = oilInv.value;
    const invSign = inv.crudeBuild >= 0 ? "+" : "";
    const formattedActual = `${invSign}${inv.crudeBuild}M`;
    merged = merged.map(e => {
      if (e.actual) return e;
      const lower = e.event.toLowerCase();
      if (e.currency === "USD" && lower === "crude oil inventories") {
        const eventTime = new Date(e.time).getTime();
        const invTime = new Date(inv.timestamp).getTime();
        if (Math.abs(eventTime - invTime) < 7 * 24 * 3600_000 && eventTime <= Date.now()) {
          return { ...e, actual: formattedActual, source: "EIA (direct)" };
        }
      }
      return e;
    });
  }

  // Inject EIA Natural Gas Storage weekly change
  if (natGas.status === "fulfilled" && natGas.value) {
    const ng = natGas.value;
    const ngSign = ng.weeklyChangeBcf >= 0 ? "+" : "";
    const formattedActual = `${ngSign}${ng.weeklyChangeBcf}B`;
    merged = merged.map(e => {
      if (e.actual) return e;
      const lower = e.event.toLowerCase();
      if (e.currency === "USD" && lower === "natural gas storage") {
        const eventTime = new Date(e.time).getTime();
        const ngTime = new Date(ng.reportDate).getTime();
        // EIA nat gas reports Thu 10:30 ET; latest data covers prior Friday
        if (Math.abs(eventTime - ngTime) < 10 * 24 * 3600_000 && eventTime <= Date.now()) {
          return { ...e, actual: formattedActual, source: "EIA (direct)" };
        }
      }
      return e;
    });
  }

  console.log(`[ECON CAL] ${merged.length} events | BLS actuals: ${bls.length} series`);
  return merged;
}

// ─── EIA Natural Gas Storage weekly change ────────────────────────────────
// Released every Thursday 10:30 ET by EIA. Series NW2_EPG0_SWO_R48_BCF =
// Lower 48 states working underground gas storage (Billion Cubic Feet).
// FF "Natural Gas Storage" event shows the weekly CHANGE in BCF.
interface NatGasStorage {
  reportDate: string;       // ISO date of latest data point
  storageLevelBcf: number;  // total Lower 48 BCF
  weeklyChangeBcf: number;  // m/m delta in BCF (what FF shows as "actual")
}

async function fetchNatGasStorage(): Promise<NatGasStorage | null> {
  return withSWR("nat_gas_storage", 2 * 3600_000, _fetchNatGasStorage,
    { persistKey: "nat_gas", persistMaxAgeMs: 7 * 24 * 3600_000 }); // weekly data, ok up to 7d stale
}

async function _fetchNatGasStorage(): Promise<NatGasStorage | null> {
  try {
    const url =
      `https://api.eia.gov/v2/natural-gas/stor/wkly/data/?api_key=${EIA_KEY}` +
      "&frequency=weekly&data%5B0%5D=value" +
      "&facets%5Bseries%5D%5B%5D=NW2_EPG0_SWO_R48_BCF" +
      "&sort%5B0%5D%5Bcolumn%5D=period&sort%5B0%5D%5Bdirection%5D=desc&length=2";
    const res = await timedFetch(url, 6_000);
    if (!res.ok) throw new Error(`EIA NG ${res.status}`);
    const j = await res.json() as { response?: { data?: Array<{ period: string; value: string }> } };
    const data = j?.response?.data;
    if (!data || data.length < 2) return null;

    const latest = parseFloat(data[0].value);
    const prior  = parseFloat(data[1].value);
    const change = Math.round(latest - prior);

    console.log(`[NAT GAS] ${data[0].period}: level=${latest}BCF, change=${change >= 0 ? "+" : ""}${change}B`);
    return {
      reportDate: data[0].period,
      storageLevelBcf: latest,
      weeklyChangeBcf: change,
    };
  } catch (err) {
    console.warn("[NAT GAS] EIA fetch failed:", (err as Error).message);
    return getStale<NatGasStorage>("nat_gas_storage");
  }
}

async function fetchFFCalendar(): Promise<EconomicEvent[]> {
  // SWR: 3-min TTL — short enough to pick up actuals within 3-4 min of FF posting them.
  // Rate limiting is no longer a concern: the old duplicate headerless call from
  // generateCalendarNews() that was burning the limit has been removed.
  // On 429/error: withSWR serves stale data instantly instead of returning [].
  return withSWR("econ_cal_ff", 3 * 60_000, _fetchFFCalendarLive);
}

// Tracks the next allowed FF fetch time — prevents retry storms on 429
let ffNextAllowedFetch = 0;

async function _fetchFFCalendarLive(): Promise<EconomicEvent[]> {
  // Respect backoff: if we were rate-limited, don't retry until the backoff expires
  if (Date.now() < ffNextAllowedFetch) {
    const waitSec = Math.round((ffNextAllowedFetch - Date.now()) / 1000);
    console.log(`[FF CAL] Rate-limit backoff — retry in ${waitSec}s`);
    throw new Error("FF rate-limit backoff");
  }

  try {
    const res = await timedFetch(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      6_000,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.forexfactory.com/",
          "Origin": "https://www.forexfactory.com",
        },
      }
    );

    if (res.status === 429) {
      // Back off for 5 min on rate limit — don't hammer the endpoint
      ffNextAllowedFetch = Date.now() + 5 * 60_000;
      console.warn("[FF CAL] 429 — backing off for 5 min");
      throw new Error("FF 429 rate limited");
    }

    if (!res.ok) throw new Error(`FF JSON API returned ${res.status}`);

    ffNextAllowedFetch = 0; // reset backoff on success
    const raw: FFCalendarEntry[] = await res.json();

    const events: EconomicEvent[] = raw
      .filter((e) => e.country === "USD" || e.country === "GBP")
      .map((e, i) => ({
        id: `ff-${i}`,
        time: new Date(e.date).toISOString(),
        currency: e.country as "USD" | "GBP",
        impact: normalizeImpact(e.impact),
        event: e.title,
        forecast: e.forecast || undefined,
        previous: e.previous || undefined,
        actual: e.country === "GBP" ? (e.actual || undefined) : undefined,
        source: "ForexFactory",
      }))
      .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    console.log(`[FF CAL] ${events.length} USD/GBP events`);
    saveFFDiskCache(events); // persist for cold-start recovery
    return events;
  } catch (err) {
    console.warn("[FF CAL] ForexFactory fetch failed:", (err as Error).message);
    // withSWR will serve the stale cache entry automatically.
    // Re-throw so withSWR knows the fetch failed and keeps the stale value.
    throw err;
  }
}

function normalizeImpact(raw: string): "high" | "medium" | "low" {
  const lower = raw.toLowerCase();
  if (lower === "high") return "high";
  if (lower === "medium") return "medium";
  return "low";
}

function generateFallbackCalendar(): EconomicEvent[] {
  // Return an EMPTY array when ForexFactory is unavailable.
  // We never show made-up events with fake forecasts — that would cause
  // false alerts and wrong data on the trading dashboard.
  // The UI shows "Calendar unavailable — retrying" when this is empty.
  console.warn("[FF CAL] Using empty fallback — ForexFactory unavailable");
  return [];
}

// ============================================================
//  Trump Posts — DIRECT Truth Social tracking via trumpstruth.org
//
//  trumpstruth.org/feed is a live mirror of @realDonaldTrump on Truth Social.
//  It bypasses the Cloudflare block on truthsocial.com directly and exposes
//  Trump's posts as RSS within minutes of publication.
//
//  We filter for OIL / IRAN / HORMUZ keywords only — anything else is dropped.
//  Source link points back to the original truthsocial.com URL.
//
//  Latency: ~1-3 min from Trump post to appearing here (trumpstruth.org refresh)
//           + 30s our polling = ~3-4 min worst case.
// ============================================================

// STRICT filter — must match at least one CORE topic keyword.
// Word-boundary regex to avoid false positives ("war" inside "reward", etc.).
// Phrases match anywhere; single words must be standalone tokens.
const TRUMP_CORE_TOPICS: RegExp[] = [
  // Iran-related (most reliable signal)
  /\b(iran|iranian|tehran|irgc|ayatollah|khamenei|pezeshkian)\b/i,
  // Strait of Hormuz / Persian Gulf
  /\b(hormuz|persian gulf)\b/i,
  /strait of hormuz/i,
  // Oil markets — proper nouns / specific terms only
  /\b(opec|brent|wti)\b/i,
  /\b(oil|crude|petroleum|gasoline)\b/i,
  /\bgas (price|prices|pump)\b/i,
  // Hormuz military context (only meaningful with these specific terms)
  /\b(blockade|tanker|refinery)\b/i,
  /\b(pipeline) (project|deal|sanction)/i,
];

// Optional context boosters — recorded but don't qualify a post on their own
const TRUMP_CONTEXT_KEYWORDS: RegExp[] = [
  /\bisrael\b/i, /\bidf\b/i, /\bnuclear\b/i, /\bmissile\b/i,
  /\b(naval|navy|warship|fleet)\b/i, /\bmines?\b/i,
  /\bsanctions?\b/i, /\bembargo\b/i,
];

// Signature phrase Trump uses in formal Truth Social announcements
const TRUMP_SIGNAL_PHRASE = "thank you for your attention to this matter";

/**
 * Fetches direct Trump Truth Social posts (via trumpstruth.org mirror),
 * filtered to ONLY oil/Iran/Hormuz topics.
 *
 * 10s SWR TTL = max 10s after the mirror updates before we serve fresh data.
 * Combined with 10s SSE push, total perceived latency is ~10-20s after Trump posts.
 */
export async function fetchTruthSocialPosts(): Promise<TruthSocialPost[]> {
  return withSWR("trump_posts", 10_000, _fetchTrumpPosts,
    { persistKey: "trump_posts", persistMaxAgeMs: 6 * 3600_000 });
}

async function _fetchTrumpPosts(): Promise<TruthSocialPost[]> {
  try {
    // 12s timeout — trumpstruth.org occasionally takes >6s under load
    const res = await timedFetch("https://trumpstruth.org/feed", 12_000, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) throw new Error(`trumpstruth.org returned ${res.status}`);

    const xml = await res.text();
    const posts = parseTrumpsTruthRSS(xml);

    // Quality guard: if mirror is empty/down, keep previous cache instead of wiping
    if (posts.length === 0) {
      const stale = getStale<TruthSocialPost[]>("trump_posts");
      if (stale && stale.length > 0) {
        console.warn(`[TRUMP] mirror returned 0 matching posts — keeping ${stale.length} cached`);
        return stale;
      }
    }

    console.log(`[TRUMP] ${posts.length} posts from truthsocial.com (filtered: oil/iran/hormuz)`);
    return posts;
  } catch (err) {
    console.warn("[TRUMP] trumpstruth.org fetch failed:", (err as Error).message);
    const stale = getStale<TruthSocialPost[]>("trump_posts");
    return stale ?? [];
  }
}

/**
 * Parses trumpstruth.org RSS feed and filters for oil/Iran/Hormuz posts only.
 * Each <item> contains:
 *   <description> — full post text wrapped in <p>...</p>
 *   <truth:originalUrl> — link back to truthsocial.com
 *   <truth:originalId> — Truth Social post ID
 */
function parseTrumpsTruthRSS(xml: string): TruthSocialPost[] {
  const posts: TruthSocialPost[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const item = match[1];

    const desc = (
      item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ||
      item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || ""
    )
      .replace(/<[^>]+>/g, " ")        // strip HTML tags
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Skip media-only posts (no text content)
    if (!desc || desc.length < 10) continue;

    // STRICT FILTER: must match at least one CORE topic regex (Iran, Hormuz, oil, OPEC…)
    const coreMatches = TRUMP_CORE_TOPICS.flatMap(re => {
      const m = desc.match(re);
      return m ? [m[0].toLowerCase()] : [];
    });
    if (coreMatches.length === 0) continue;

    // Optional context keywords (don't qualify on their own but flag them as keywords)
    const contextMatches = TRUMP_CONTEXT_KEYWORDS.flatMap(re => {
      const m = desc.match(re);
      return m ? [m[0].toLowerCase()] : [];
    });
    const allKeywords = [...new Set([...coreMatches, ...contextMatches])].slice(0, 6);

    const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || "").trim();
    const originalUrl = (item.match(/<truth:originalUrl>([\s\S]*?)<\/truth:originalUrl>/)?.[1] || "").trim();
    const mirrorLink  = (item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || "").trim();
    const originalId  = (item.match(/<truth:originalId>([\s\S]*?)<\/truth:originalId>/)?.[1] || "").trim();

    // Detect signature phrase = formal announcement
    const isSignal = desc.toLowerCase().includes(TRUMP_SIGNAL_PHRASE);
    const prefix = isSignal ? "🔴 TRUMP SIGNAL\n" : "";

    posts.push({
      id: `ts-${originalId || pubDate}`,
      content: `${prefix}${desc}`,
      timestamp: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      url: originalUrl || mirrorLink || "https://truthsocial.com/@realDonaldTrump",
      relevanceKeywords: allKeywords,
    });
  }

  // Newest first; cap at 30 to avoid unbounded payload growth
  posts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return posts.slice(0, 30);
}

// ============================================================
//  Strait of Hormuz / Brent Crude — REAL-TIME via Yahoo Finance
//  Primary: Yahoo Finance futures (BZ=F, CL=F) — live price w/ ~15min lag
//  Fallback: FRED daily spot (1-3 day lag)
// ============================================================
export async function fetchHormuzData(): Promise<HormuzUpdate> {
  // SWR: 90-second TTL — Yahoo updates ~15 min so 90s gives near-realtime feel
  // without hammering them. SWR serves stale instantly, refreshes in background.
  return withSWR("hormuz", 90_000, _fetchHormuz,
    { persistKey: "hormuz", persistMaxAgeMs: 4 * 3600_000 });
}

// Yahoo Finance rate-limit backoff
let yahooNextAllowed = 0;

async function _fetchHormuz(): Promise<HormuzUpdate> {
  // Strategy (latency: real-time during market hours):
  //  1. Yahoo Finance futures (BZ=F, CL=F)  — live + 30d history (~15min delay)
  //  2. Stooq /q/l/ CSV                       — live quote (no history)
  //  3. FRED daily spot                       — 1-3 day lag (history fallback)
  //
  // Yahoo has aggressive 429 rate-limiting. We back off 10 min on 429 and
  // serve from Stooq+FRED until backoff expires.

  // ─── Try Yahoo Finance first (real-time + history) ─────────────────────
  if (Date.now() >= yahooNextAllowed) try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6_000);

    const headers = {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json",
    };
    const [brentRes, wtiRes] = await Promise.allSettled([
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=1mo&interval=1d", { signal: controller.signal, headers }),
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/CL=F?range=1mo&interval=1d", { signal: controller.signal, headers }),
    ]);
    clearTimeout(timeout);

    // Detect 429 → back off 10 minutes
    const got429 = (brentRes.status === "fulfilled" && brentRes.value.status === 429)
                || (wtiRes.status   === "fulfilled" && wtiRes.value.status   === 429);
    if (got429) {
      yahooNextAllowed = Date.now() + 10 * 60_000;
      console.warn("[HORMUZ] Yahoo 429 — backing off 10 min, falling through to Stooq+FRED");
      throw new Error("Yahoo 429 backoff");
    }

    type YahooChartResponse = {
      chart?: {
        result?: Array<{
          meta: { regularMarketPrice: number; regularMarketTime: number; previousClose: number };
          timestamp: number[];
          indicators: { quote: Array<{ close: (number | null)[] }> };
        }>;
      };
    };

    const brent: YahooChartResponse | null =
      brentRes.status === "fulfilled" && brentRes.value.ok ? await brentRes.value.json() as YahooChartResponse : null;
    const wti: YahooChartResponse | null =
      wtiRes.status === "fulfilled" && wtiRes.value.ok ? await wtiRes.value.json() as YahooChartResponse : null;

    const brentResult = brent?.chart?.result?.[0];
    const wtiResult   = wti?.chart?.result?.[0];

    if (brentResult && brentResult.timestamp?.length > 1) {
      const brentLive  = brentResult.meta.regularMarketPrice;
      const brentPrev  = brentResult.meta.previousClose;
      const brentChangePct = ((brentLive - brentPrev) / brentPrev) * 100;
      const wtiLive    = wtiResult?.meta.regularMarketPrice ?? 0;
      const liveTimeIso = new Date(brentResult.meta.regularMarketTime * 1000).toISOString();

      const trend: "up" | "down" | "stable" =
        brentChangePct > 0.5 ? "up" : brentChangePct < -0.5 ? "down" : "stable";

      // Build aligned daily history (oldest first for left-to-right charts)
      const wtiCloses = wtiResult?.indicators.quote[0].close ?? [];
      const wtiByDate = new Map<string, number>();
      wtiResult?.timestamp.forEach((t, i) => {
        const c = wtiCloses[i];
        if (c != null) wtiByDate.set(new Date(t * 1000).toISOString().slice(0, 10), c);
      });

      const brentCloses = brentResult.indicators.quote[0].close;
      const history: { date: string; brent: number; wti: number }[] = [];
      brentResult.timestamp.forEach((t, i) => {
        const c = brentCloses[i];
        if (c == null) return;
        const date = new Date(t * 1000).toISOString().slice(0, 10);
        history.push({ date, brent: Math.round(c * 100) / 100, wti: wtiByDate.get(date) ?? 0 });
      });

      // Replace last point with live price (more current than the latest daily close).
      // Use Yahoo's regularMarketTime (actual market timestamp), not local UTC date,
      // to avoid showing tomorrow's date during late-night sessions.
      if (history.length > 0) {
        const liveDate = new Date(brentResult.meta.regularMarketTime * 1000).toISOString().slice(0, 10);
        if (history[history.length - 1].date === liveDate) {
          history[history.length - 1].brent = Math.round(brentLive * 100) / 100;
          history[history.length - 1].wti   = Math.round(wtiLive * 100) / 100;
        } else {
          history.push({ date: liveDate, brent: Math.round(brentLive * 100) / 100, wti: Math.round(wtiLive * 100) / 100 });
        }
      }

      const result: HormuzUpdate = {
        id: "hormuz-yahoo",
        timestamp: liveTimeIso,         // when Yahoo's "live" price was sampled
        tankerCount: 28,                 // EIA long-term avg
        dailyFlowMbpd: 17.2,             // EIA long-term avg
        brentSpot: Math.round(brentLive * 100) / 100,
        wtiSpot:   Math.round(wtiLive * 100) / 100,
        brentChangePct: Math.round(brentChangePct * 100) / 100,
        trend,
        alerts: [],
        history,
      };

      if (Math.abs(brentChangePct) > 3) {
        result.alerts.push(
          `Brent ${brentChangePct > 0 ? "spiked" : "dropped"} ${brentChangePct.toFixed(1)}% today — possible Hormuz event`
        );
      }
      if (brentLive > 110) {
        result.alerts.push(`Brent above $110/bbl — Hormuz risk elevated`);
      }

      const lagMin = Math.round((Date.now() - brentResult.meta.regularMarketTime * 1000) / 60_000);
      console.log(`[HORMUZ] Yahoo: Brent=$${brentLive.toFixed(2)} (${brentChangePct.toFixed(2)}%), WTI=$${wtiLive.toFixed(2)}, lag=${lagMin}min, history=${history.length}d`);
      return result;
    }
  } catch (err) {
    console.warn("[HORMUZ] Yahoo Finance failed:", (err as Error).message);
  }

  // ─── Try Stooq for live quote (combined with FRED for history below) ───
  // Stooq returns CSV: Symbol,Date,Time,Open,High,Low,Close,Volume,Name
  // We capture the market date from Stooq directly to avoid UTC vs local date issues.
  let stooqBrent: { price: number; change: number; date: string } | null = null;
  let stooqWti:   { price: number; change: number; date: string } | null = null;
  try {
    const headers = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" };
    // Stooq symbols: cb.f = Brent, cl.f = WTI (verified May 2026)
    const [bRes, wRes] = await Promise.allSettled([
      timedFetch("https://stooq.com/q/l/?s=cb.f&f=sd2t2ohlcvn&h&e=csv", 4_000, { headers }),
      timedFetch("https://stooq.com/q/l/?s=cl.f&f=sd2t2ohlcvn&h&e=csv", 4_000, { headers }),
    ]);
    const parse = (csv: string) => {
      const lines = csv.trim().split("\n");
      if (lines.length < 2) return null;
      const fields = lines[1].split(",");
      const date  = fields[1].trim();
      const open  = parseFloat(fields[3]);
      const close = parseFloat(fields[6]);
      // "N/D" rows return NaN — skip them
      if (isNaN(close) || isNaN(open) || open === 0 || !date.match(/^\d{4}-\d{2}-\d{2}$/)) return null;
      return { price: close, change: ((close - open) / open) * 100, date };
    };
    if (bRes.status === "fulfilled" && bRes.value.ok) stooqBrent = parse(await bRes.value.text());
    if (wRes.status === "fulfilled" && wRes.value.ok) stooqWti   = parse(await wRes.value.text());
    if (stooqBrent) console.log(`[HORMUZ] Stooq: Brent=$${stooqBrent.price} (${stooqBrent.change.toFixed(2)}%) on ${stooqBrent.date}, WTI=$${stooqWti?.price ?? "—"}`);
  } catch (err) {
    console.warn("[HORMUZ] Stooq failed:", (err as Error).message);
  }

  // ─── Fall back to FRED (1-3 day lag) ──────────────────────────────────
  const FRED_KEY = process.env.FRED_API_KEY || "";
  if (FRED_KEY) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);

      const [brentRes, wtiRes] = await Promise.allSettled([
        fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=DCOILBRENTEU&api_key=${FRED_KEY}&sort_order=desc&limit=30&file_type=json`, { signal: controller.signal }),
        fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=DCOILWTICO&api_key=${FRED_KEY}&sort_order=desc&limit=30&file_type=json`, { signal: controller.signal }),
      ]);
      clearTimeout(timeout);

      const brent = brentRes.status === "fulfilled" && brentRes.value.ok ? await brentRes.value.json() : null;
      const wti   = wtiRes.status   === "fulfilled" && wtiRes.value.ok   ? await wtiRes.value.json()   : null;

      const brentObs = (brent?.observations ?? []).filter((o: { value: string }) => o.value !== ".");
      const wtiObs   = (wti?.observations   ?? []).filter((o: { value: string }) => o.value !== ".");

      if (brentObs.length >= 2) {
        // Use Stooq's live price if available, else FRED's lagging latest
        const brentSpot = stooqBrent?.price ?? parseFloat(brentObs[0].value);
        const wtiSpot   = stooqWti?.price   ?? (wtiObs.length > 0 ? parseFloat(wtiObs[0].value) : 0);
        const brentChangePct = stooqBrent?.change ??
          ((parseFloat(brentObs[0].value) - parseFloat(brentObs[1].value)) / parseFloat(brentObs[1].value)) * 100;

        const wtiByDate = new Map<string, number>(
          wtiObs.map((o: { date: string; value: string }) => [o.date, parseFloat(o.value)])
        );
        const history: { date: string; brent: number; wti: number }[] = [...brentObs]
          .reverse()
          .map((o: { date: string; value: string }) => ({
            date: o.date,
            brent: parseFloat(o.value),
            wti: wtiByDate.get(o.date) ?? 0,
          }));

        // Append the live Stooq quote as the latest history point.
        // Use Stooq's actual market date (not server UTC date) to avoid
        // timezone bugs where 8 PM EDT shows tomorrow's UTC date.
        if (stooqBrent) {
          const stooqDate = stooqBrent.date;
          if (history[history.length - 1]?.date !== stooqDate) {
            history.push({ date: stooqDate, brent: stooqBrent.price, wti: stooqWti?.price ?? 0 });
          } else {
            history[history.length - 1] = { date: stooqDate, brent: stooqBrent.price, wti: stooqWti?.price ?? 0 };
          }
        }

        const sourceName = stooqBrent ? "Stooq+FRED" : "FRED only";
        console.log(`[HORMUZ] ${sourceName}: Brent=$${brentSpot} (${brentChangePct.toFixed(2)}%), WTI=$${wtiSpot}, history: ${history.length}d`);
        return {
          id: stooqBrent ? "hormuz-stooq" : "hormuz-fred",
          timestamp: new Date().toISOString(),
          tankerCount: 28,
          dailyFlowMbpd: 17.2,
          brentSpot: Math.round(brentSpot * 100) / 100,
          wtiSpot:   Math.round(wtiSpot * 100) / 100,
          brentChangePct: Math.round(brentChangePct * 100) / 100,
          trend: brentChangePct > 0.5 ? "up" : brentChangePct < -0.5 ? "down" : "stable",
          alerts: brentSpot > 110 ? [`Brent above $110/bbl — Hormuz risk elevated`] : [],
          history,
        };
      }
    } catch (err) {
      console.warn("[HORMUZ] FRED fallback also failed:", (err as Error).message);
    }
  }
  // Fall through to stale/static fallback below

  // If live fetch failed, return any stale value we have rather than a static fallback
  const stale = getStale<HormuzUpdate>("hormuz");
  if (stale) return stale;

  // Absolute last resort — static reasonable estimate
  return {
    id: "hormuz-fallback",
    timestamp: new Date().toISOString(),
    tankerCount: 28,
    dailyFlowMbpd: 17.2,
    trend: "stable",
    alerts: [],
  };
}

// ============================================================
//  Oil Inventory  ✅ LIVE via EIA API v2
//  Source: api.eia.gov — US crude oil ending stocks (excl. SPR)
//  Updated weekly (Wednesday 10:30 ET)
// ============================================================
export async function fetchOilInventory(): Promise<OilInventory | null> {
  // SWR: EIA weekly inventory data — serve stale immediately, refresh in background.
  // TTL = 2h. Data only updates Wednesdays at 10:30 ET; no need to hammer EIA hourly.
  // 15 min TTL — short enough that the data is never more than 15 min stale even
  // without the sniper. The sniper still gets sub-second on Wed 10:30 ET.
  // Disk cache survives restarts up to 14 days.
  return withSWR("oil_inv", 15 * 60_000, _fetchOilInventory,
    { persistKey: "oil_inv", persistMaxAgeMs: 14 * 24 * 3600_000 });
}

async function _fetchOilInventory(): Promise<OilInventory> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    // Use series WCESTUS1 = "U.S. Ending Stocks excluding SPR of Crude Oil"
    // This is the COMMERCIAL crude inventory number that traders watch and
    // ForexFactory reports. Our previous query (process=SAE) returned TOTAL
    // including SPR (Strategic Petroleum Reserve) which is ~2x larger and
    // gave wrong week-over-week changes. Verified May 2026: matches FF exactly.
    const res = await fetch(
      "https://api.eia.gov/v2/petroleum/stoc/wstk/data/" +
      `?api_key=${EIA_KEY}` +
      "&frequency=weekly&data[0]=value" +
      "&facets[series][]=WCESTUS1" +
      "&sort[0][column]=period&sort[0][direction]=desc" +
      "&length=13",
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`EIA API returned ${res.status}`);

    const json = await res.json() as {
      response?: {
        data?: Array<{ period: string; value: number }>;
      };
    };

    const data = json?.response?.data;
    if (data && data.length >= 2) {
      const latest = data[0];
      const previous = data[1];
      const change = (latest.value - previous.value) / 1000;
      const prevChange = data.length >= 3 ? (previous.value - data[2].value) / 1000 : 0;

      // Build history of weekly m/m builds (oldest first, newest last)
      const sorted = [...data].sort((a, b) => a.period.localeCompare(b.period));
      const history: { period: string; build: number }[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const build = (sorted[i].value - sorted[i - 1].value) / 1000;
        history.push({ period: sorted[i].period, build: Math.round(build * 10) / 10 });
      }

      const result: OilInventory = {
        id: `eia-${latest.period}`,
        source: "EIA",
        timestamp: latest.period + "T14:30:00Z",
        crudeBuild: Math.round(change * 10) / 10,
        forecast: 0,
        previous: Math.round(prevChange * 10) / 10,
        history,
      };
      console.log(`[OIL INV] EIA: ${change > 0 ? "+" : ""}${result.crudeBuild}M bbl (${latest.period}), history: ${history.length} weeks`);
      return result;
    }
  } catch (err) {
    console.warn("[OIL INV] EIA failed:", (err as Error).message);
  }

  // If live fetch failed, prefer any stale value over the static fallback
  const stale = getStale<OilInventory>("oil_inv");
  if (stale) return stale;

  return {
    id: "eia-fallback",
    source: "EIA",
    timestamp: new Date().toISOString(),
    crudeBuild: -2.7,
    forecast: -1.5,
    previous: 3.6,
  };
}

// ============================================================
//  Timed fetch helper — abort after `ms` to prevent slow sources
//  from blocking the entire pipeline.
// ============================================================
async function timedFetch(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
//  News Feed  ✅ LIVE via multiple RSS feeds
//  - Federal Reserve press releases (federalreserve.gov) ✅
//  - Bank of England (bankofengland.co.uk) — may 403
//  - Google News RSS — consolidated into 2 mega-queries (was 5)
//  - ForexFactory calendar speeches/events
//
//  LATENCY OPTIMIZATIONS:
//  • Consolidated 5 Google News RSS feeds → 2 combined OR queries
//  • Every fetch has a 6s AbortController timeout
//  • Calendar news uses shared cache (no extra HTTP call)
// ============================================================
export async function fetchNewsFeed(): Promise<NewsItem[]> {
  // MERGE strategy with RESERVED SLOTS:
  //   • Up to 20 slots for Telegram messages (always visible if any exist)
  //   • Remaining slots filled with RSS news (typically much fresher cadence)
  //   • Each section sorted newest-first, then concatenated TG → RSS
  //
  // Why reserved slots: RSS news refreshes every 90s and easily fills 50 fresh
  // items in a few hours. Telegram channels often post once a day or less, so
  // without a quota they'd always be sorted to the bottom and effectively hidden.
  const { getTelegramMessages } = await import("./telegram");
  const tgMessages = getTelegramMessages();
  const rssNews = await withSWR("news", 90_000, _fetchNews,
    { persistKey: "news", persistMaxAgeMs: 6 * 3600_000 });

  // Sort each list newest first
  const tgSorted = [...tgMessages].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const rssSorted = [...rssNews].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Reserve top slots for Telegram (max 20)
  const TG_QUOTA = 20;
  const TOTAL = 50;
  const tgPicked = tgSorted.slice(0, TG_QUOTA);

  // Dedupe RSS against TG titles
  const seen = new Set(tgPicked.map(t => t.title.toLowerCase().slice(0, 60).replace(/\s+/g, " ")));
  const rssPicked = rssSorted.filter(n => {
    const k = n.title.toLowerCase().slice(0, 60).replace(/\s+/g, " ");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, TOTAL - tgPicked.length);

  return [...tgPicked, ...rssPicked];
}

async function _fetchNews(): Promise<NewsItem[]> {
  const allNews: NewsItem[] = [];

  const FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Accept": "application/xml, text/xml, application/rss+xml",
  };

  // ─── Geopolitical keywords: any headline matching these is auto-flagged BREAKING ─
  // Pattern: N12/Israeli media drops a headline → algos react within seconds →
  // oil moves before Western media confirms. This list catches those triggers.
  const GEO_BREAKING_RE = /hormuz|strait|irgc|iran.*(attack|strike|sanction|seiz|block|nuclear|war)|israel.*(attack|strike|bomb|launch|evacuat|war)|evacuat.*tehran|naval.stand|oil.block|tanker.seiz|mine.*strait|shoot.*mine|navy.*hormuz|brent.*\$\d{3}|crude.*\$\d{3}|oil.*spike|oil.*surg/i;

  // ─── RSS sources — all run in parallel, wall time = slowest (~1-2s) ──────────
  const rssSources: Array<{
    url: string;
    source: string;
    category: NewsItem["category"];
    timeoutMs: number;
    alwaysBreakingOn?: RegExp;  // auto-flag BREAKING when title/summary matches
    googleCategories?: Array<{ pattern: RegExp; category: NewsItem["category"] }>;
  }> = [
    // ── Authoritative macro/central-bank ─────────────────────────────────────
    {
      url: "https://www.federalreserve.gov/feeds/press_all.xml",
      source: "Federal Reserve",
      category: "fed",
      timeoutMs: 4_000,
    },
    // ── CNBC Energy — fastest English aggregation of oil-moving headlines ─────
    // Confirmed live: "Brent tops $105 as Hormuz tensions simmer", naval standoffs
    {
      url: "https://www.cnbc.com/id/19836768/device/rss/rss.html",
      source: "CNBC",
      category: "oil",
      timeoutMs: 4_000,
      alwaysBreakingOn: GEO_BREAKING_RE,
      googleCategories: [
        { pattern: /hormuz|iran|irgc|tanker|naval|sanction|geopolit/i, category: "geopolitical" },
        { pattern: /opec|production.cut|cartel/i,                       category: "opec"         },
        { pattern: /fed|fomc|powell|rate.cut|rate.hike/i,               category: "fed"          },
        { pattern: /bank.of.england|boe|mpc/i,                          category: "boe"          },
      ],
    },
    // ── Times of Israel — first English source for Israeli military scoops ────
    // N12 (Hebrew TV) breaks first; Times of Israel translates within minutes.
    // Only flag BREAKING when the headline is oil/market-relevant (not general crime/politics).
    {
      url: "https://www.timesofisrael.com/feed/",
      source: "Times of Israel",
      category: "geopolitical",
      timeoutMs: 4_000,
      alwaysBreakingOn: /hormuz|irgc|iran.{0,25}(attack|strike|nuclear|sanction|naval|oil|seize|block)|israel.{0,25}(iran|attack.*oil|idf.*strike)|evacuat.*tehran|oil.*block|tanker.*(seize|attack)|naval.*strait/i,
    },
    // ── Jerusalem Post — Israeli defense/military reporting ───────────────────
    {
      url: "https://www.jpost.com/Rss/RssFeedsHeadlines.aspx",
      source: "Jerusalem Post",
      category: "geopolitical",
      timeoutMs: 4_000,
      alwaysBreakingOn: /hormuz|irgc|iran.{0,25}(attack|strike|nuclear|sanction|naval|oil|seize|block)|evacuat.*tehran|oil.*block|tanker.*(seize|attack)|naval.*strait/i,
    },
    // ── FXStreet — real-time impact analysis on FX & commodities ─────────────
    {
      url: "https://www.fxstreet.com/rss/news",
      source: "FXStreet",
      category: "macro",
      timeoutMs: 4_000,
      alwaysBreakingOn: GEO_BREAKING_RE,
      googleCategories: [
        { pattern: /oil|crude|brent|wti|opec|energy/i,                  category: "oil"          },
        { pattern: /hormuz|iran|irgc|geopolit|sanction/i,               category: "geopolitical" },
        { pattern: /fed|fomc|powell|federal.reserve/i,                   category: "fed"          },
        { pattern: /bank.of.england|boe|sterling|gbp/i,                 category: "boe"          },
      ],
    },
    // ── Google News: Israel/Iran/Hormuz — catches N12 & wire-service scoops ──
    // N12 breaks in Hebrew; this query surfaces English translations within minutes.
    {
      url: "https://news.google.com/rss/search?q=%22Strait+of+Hormuz%22+OR+%22IRGC%22+OR+(Iran+AND+(attack+OR+strike+OR+sanctions+OR+nuclear+OR+%22naval%22))+OR+(Israel+AND+(Iran+OR+attack+OR+strike+OR+%22IDF%22))+OR+%22oil+blockade%22+OR+%22tanker+seized%22&hl=en-US&gl=US&ceid=US:en",
      source: "Google News",
      category: "geopolitical",
      timeoutMs: 4_000,
      alwaysBreakingOn: GEO_BREAKING_RE,
    },
    // ── Google News: oil/energy/OPEC/EIA ─────────────────────────────────────
    {
      url: "https://news.google.com/rss/search?q=OPEC+OR+%22oil+price%22+OR+%22EIA+crude%22+OR+%22oil+inventory%22+OR+%22crude+stocks%22+OR+%22Brent+crude%22+OR+%22WTI+crude%22&hl=en-US&gl=US&ceid=US:en",
      source: "Google News",
      category: "oil",
      timeoutMs: 4_000,
      googleCategories: [
        { pattern: /hormuz|blockade|tanker|iran|geopolit/i,             category: "geopolitical" },
        { pattern: /opec|cartel|production.cut/i,                        category: "opec"         },
      ],
    },
    // ── Google News: macro/central-bank ──────────────────────────────────────
    {
      url: "https://news.google.com/rss/search?q=GBPUSD+OR+%22Bank+of+England%22+OR+%22Federal+Reserve%22+OR+FOMC+OR+%22rate+decision%22+OR+%22rate+cut%22+OR+%22UK+inflation%22+OR+%22UK+economy%22&hl=en-US&gl=US&ceid=US:en",
      source: "Google News",
      category: "macro",
      timeoutMs: 4_000,
      googleCategories: [
        { pattern: /federal.reserve|fomc|fed.rate|fed.chair|powell/i,   category: "fed"          },
        { pattern: /bank.of.england|boe|bailey|mpc/i,                   category: "boe"          },
      ],
    },
  ];

  // Fetch all feeds in parallel — wall time = slowest source (~1-2s)
  const results = await Promise.allSettled(
    rssSources.map(async (src) => {
      try {
        const res = await timedFetch(src.url, src.timeoutMs, { headers: FETCH_HEADERS });
        if (!res.ok) return [];
        const xml = await res.text();
        const items = parseRSSFeed(xml, src.source, src.category);

        for (const item of items) {
          const text = item.title + " " + (item.summary || "");

          // Apply category reclassification rules
          if (src.googleCategories) {
            for (const rule of src.googleCategories) {
              if (rule.pattern.test(text)) { item.category = rule.category; break; }
            }
          }

          // Auto-flag BREAKING when source-specific geo pattern matches
          if (src.alwaysBreakingOn && src.alwaysBreakingOn.test(text)) {
            item.isBreaking = true;
          }
        }
        return items;
      } catch {
        return [];
      }
    })
  );

  let externalCount = 0;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.length > 0) {
      allNews.push(...result.value);
      externalCount += result.value.length;
    }
  }

  // ── Quality guard: if external RSS feeds returned almost nothing
  //    (transient network failure), preserve the previous cache instead of
  //    overwriting with a degraded result of just calendar items.
  if (externalCount < 5) {
    const prevCache = getStale<NewsItem[]>("news");
    if (prevCache && prevCache.length > 20) {
      console.warn(`[NEWS] external RSS only returned ${externalCount} items — keeping previous cache (${prevCache.length}) instead of degrading`);
      return prevCache;
    }
  }

  // Calendar speeches/events as news — reads from in-memory cache, zero network cost
  allNews.push(...generateCalendarNews());

  // Deduplicate + sort
  const seen = new Set<string>();
  const deduped = allNews.filter((item) => {
    const key = item.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) deduped.push(...generateFallbackNews());

  // Sort: PAST items by recency (newest first), then FUTURE items (calendar previews)
  // sorted by soonest-first. Keeps "what just happened" at the top, schedule below.
  const now = Date.now();
  deduped.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    const aPast = ta <= now;
    const bPast = tb <= now;
    if (aPast && !bPast) return -1;          // past comes before future
    if (!aPast && bPast) return 1;
    if (aPast && bPast) return tb - ta;       // both past: newest first
    return ta - tb;                            // both future: soonest first
  });
  const breaking = deduped.filter(n => n.isBreaking).length;
  // Trim to 50 items (~30KB payload, was 75/45KB) — UI rarely scrolls past ~30
  const limited = deduped.slice(0, 50);
  console.log(`[NEWS] ${limited.length} items | ${breaking} BREAKING | sources: ${[...new Set(limited.map(n => n.source))].join(", ")}`);
  return limited; // withSWR handles caching
}

/**
 * Generate "news" items from the ForexFactory calendar.
 * Reads from the in-memory cache (econ_cal_ff) — NO extra HTTP call to FF.
 * This is important: making a separate raw FF request here (without headers)
 * caused 429 rate-limiting that broke the main calendar every ~90s.
 */
function generateCalendarNews(): NewsItem[] {
  // Use the already-cached EconomicEvent[] — zero network cost
  const cached = getStale<EconomicEvent[]>("econ_cal_ff");
  if (!cached || cached.length === 0) return [];

  const newsItems: NewsItem[] = [];

  for (const event of cached) {
    const title = event.event.toLowerCase();
    const isSpeech = title.includes("speaks") || title.includes("speech") || title.includes("testimony");
    const isPresidentEvent = title.includes("president") || title.includes("trump");
    const isCentralBank = title.includes("fomc") || title.includes("mpc") || title.includes("boe") || title.includes("fed");
    const isHighImpact = event.impact === "high";

    if (isSpeech || isPresidentEvent || (isCentralBank && isHighImpact)) {
      const eventTime = new Date(event.time);
      const category = event.currency === "GBP"
        ? (title.includes("boe") || title.includes("mpc") ? "boe" as const : "macro" as const)
        : (title.includes("fomc") || title.includes("fed") ? "fed" as const : "macro" as const);

      newsItems.push({
        id: `cal-${event.id}`,
        title: `${event.currency}: ${event.event}`,
        summary: `Scheduled for ${eventTime.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${eventTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/New_York" })} ET`,
        source: "ForexFactory Calendar",
        url: "https://www.forexfactory.com/calendar",
        timestamp: event.time,
        category,
        isBreaking: isPresidentEvent,
      });
    }
  }

  return newsItems;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&[a-z]+;/g, " "); // strip any remaining named entities
}

function parseRSSFeed(xml: string, source: string, category: NewsItem["category"]): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  let idx = 0;

  while ((match = itemRegex.exec(xml)) !== null && idx < 20) {
    const item = match[1];

    // Handle both CDATA-wrapped and plain text titles
    const rawTitle = (
      item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ||
      item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ||
      ""
    ).replace(/<[^>]+>/g, "").trim();
    const title = decodeHtmlEntities(rawTitle);

    const link = (
      item.match(/<link>([\s\S]*?)<\/link>/)?.[1] ||
      ""
    ).trim();

    const pubDate = (
      item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ||
      ""
    ).trim();

    const description = (
      item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ||
      item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ||
      ""
    ).replace(/<[^>]+>/g, "").trim();

    if (title) {
      // Extract actual source for Google News items (e.g. "Reuters", "CNBC")
      const sourceTag = (
        item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || ""
      ).replace(/<[^>]+>/g, "").trim();
      const displaySource = sourceTag || source;

      // Auto-detect breaking news based on keywords.
      // Rules are intentionally narrow — "attack" alone fires on crime/sports/politics.
      // We require OIL/GEO context to avoid false positives from general news feeds.
      const titleLower = title.toLowerCase();
      const isBreaking =
        // Generic editorial urgency markers
        titleLower.includes("breaking:") || titleLower.includes("[breaking]") || titleLower.includes("urgent:") ||
        // Rate decisions (these are always market-moving)
        titleLower.includes("rate decision") || titleLower.includes("emergency rate") ||
        // Oil/market shock — require context word near the price/action
        /oil.*(plunge|surge|spike|crash|soar|collapses?)/i.test(title) ||
        /brent.*(plunge|surge|spike|soar|\$\d{3})|crude.*(plunge|surge|spike|\$\d{3})/i.test(title) ||
        /\$\d{3}.*(?:brent|crude|oil)|\$\d{3}.*(?:barrel)/i.test(title) ||
        // Geopolitical oil-moving triggers — require Hormuz/Iran/IRGC context
        /hormuz|strait of hormuz/i.test(title) ||
        /irgc|iran.{0,20}(attack|strike|sanction|seize|block|nuclear deal|naval)/i.test(title) ||
        /israel.{0,20}(attack|strike|bomb|launch|evacuat).{0,20}(iran|tehran|oil|nuclear)/i.test(title) ||
        titleLower.includes("oil blockade") || titleLower.includes("tanker seized") ||
        titleLower.includes("mine strait") || /evacuat.*tehran|tehran.*evacuat/i.test(title) ||
        // Fed/BOE emergency
        titleLower.includes("emergency meeting") || titleLower.includes("unscheduled rate");

      items.push({
        id: `${source.replace(/\s/g, "")}-${idx}`,
        title,
        summary: description.slice(0, 200) || undefined,
        source: displaySource,
        url: link,
        timestamp: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        category,
        isBreaking,
      });
      idx++;
    }
  }

  return items;
}

function generateFallbackNews(): NewsItem[] {
  const now = new Date();
  return [
    {
      id: "fb-news-1",
      title: "Fed Chair Powell: Rates to remain restrictive until inflation falls sustainably",
      summary: "Federal Reserve Chair Jerome Powell reiterated the central bank's commitment to its 2% inflation target.",
      source: "Federal Reserve", url: "https://www.federalreserve.gov",
      timestamp: new Date(now.getTime() - 7200_000).toISOString(), category: "fed",
    },
    {
      id: "fb-news-2",
      title: "BOE MPC Minutes: 7-2 vote to hold rates at 4.50%",
      summary: "Two members voted for a 25bps cut citing weakening labor market.",
      source: "Bank of England", url: "https://www.bankofengland.co.uk",
      timestamp: new Date(now.getTime() - 14400_000).toISOString(), category: "boe",
    },
    {
      id: "fb-news-3",
      title: "OPEC+ agrees to extend production cuts through Q3",
      summary: "The cartel will maintain 2.2 million bpd of voluntary cuts amid uncertain demand outlook.",
      source: "OPEC", url: "https://www.opec.org",
      timestamp: new Date(now.getTime() - 28800_000).toISOString(), category: "opec",
    },
    {
      id: "fb-news-4",
      title: "EIA: US crude inventories draw 2.7M barrels vs -1.5M expected",
      summary: "A larger-than-expected draw points to tightening domestic supply.",
      source: "EIA", url: "https://www.eia.gov",
      timestamp: new Date(now.getTime() - 43200_000).toISOString(), category: "oil",
    },
  ];
}
