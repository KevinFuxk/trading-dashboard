/**
 * High-signal news screener — TIER 1 catalysts only.
 *
 * Pipeline (per 5s poll):
 *   1. Fetch Finviz Elite CSV (~70ms)
 *   2. Filter: must be in S&P 500 + Nasdaq 100 universe
 *   3. Filter: must come from trusted publisher
 *   4. Filter: must match a TIER 1 trigger phrase
 *   5. Filter: must NOT match any exclusion phrase
 *   6. Categorize + detect high-impact (chime trigger)
 *   7. Return; SSE pushes only the deltas
 *
 * Total latency Finviz publish → browser: ~85-100 ms
 */

import { readFileSync, writeFileSync } from "fs";

export interface ScreenedHeadline {
  id: string;                  // dedupe key
  ticker: string;
  title: string;
  source: string;              // publisher
  url: string;
  timestamp: string;           // ISO
  categories: string[];        // ['earnings', 'guidance', 'ma', ...]
  isHighImpact: boolean;       // triggers sound chime
}

// ════════════════════════════════════════════════════════════════
//  UNIVERSE: S&P 500 + Nasdaq 100 (~600 unique mega-caps)
//  Loaded from GitHub maintained CSV at boot, cached in /tmp for 7d.
// ════════════════════════════════════════════════════════════════

const UNIVERSE_DISK_CACHE = "/tmp/uigen_universe_cache.json";
const UNIVERSE_TTL_MS = 7 * 24 * 3600_000;
let UNIVERSE = new Set<string>();
let universeLoaded = false;

// Nasdaq 100 — hardcoded (changes ~10 names/year, easy to update).
// Last verified: 2026-06. Most overlap with S&P 500; this catches the
// few that aren't (e.g., LULU, MAR, REGN before they were added to S&P).
const NASDAQ_100: string[] = [
  "ADBE", "ADP", "ABNB", "GOOGL", "GOOG", "AMZN", "AMD", "AEP", "AMGN", "ADI",
  "ANSS", "AAPL", "AMAT", "APP", "ARM", "ASML", "AZN", "TEAM", "ADSK", "BKR",
  "BIIB", "BKNG", "AVGO", "CDNS", "CDW", "CHTR", "CTAS", "CSCO", "CCEP", "CTSH",
  "CMCSA", "CEG", "CPRT", "CSGP", "COST", "CRWD", "CSX", "DDOG", "DXCM", "FANG",
  "DASH", "EA", "EXC", "FAST", "FTNT", "GEHC", "GILD", "GFS", "HON", "IDXX",
  "INTC", "INTU", "ISRG", "KDP", "KLAC", "KHC", "LRCX", "LIN", "LULU", "MAR",
  "MRVL", "MELI", "META", "MCHP", "MU", "MSFT", "MSTR", "MDLZ", "MDB", "MNST",
  "NFLX", "NVDA", "NXPI", "ORLY", "ODFL", "ON", "PCAR", "PLTR", "PANW", "PAYX",
  "PYPL", "PDD", "PEP", "QCOM", "REGN", "ROP", "ROST", "SBUX", "SNPS", "TTWO",
  "TMUS", "TSLA", "TXN", "TTD", "VRSK", "VRTX", "WBD", "WDAY", "XEL", "ZS",
];

export async function loadUniverse(): Promise<Set<string>> {
  if (universeLoaded && UNIVERSE.size > 0) return UNIVERSE;

  // Try disk cache first (instant)
  try {
    const raw = readFileSync(UNIVERSE_DISK_CACHE, "utf8");
    const parsed = JSON.parse(raw) as { ts: number; symbols: string[] };
    if (Date.now() - parsed.ts < UNIVERSE_TTL_MS && parsed.symbols.length > 100) {
      UNIVERSE = new Set(parsed.symbols);
      universeLoaded = true;
      console.log(`[SCREENER] Universe loaded from disk cache: ${UNIVERSE.size} tickers`);
      return UNIVERSE;
    }
  } catch { /* no cache yet */ }

  // Fetch S&P 500 from GitHub (auto-maintained CSV)
  const sp500 = new Set<string>();
  try {
    const r = await fetch(
      "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv",
      { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "trading-dashboard" } }
    );
    if (r.ok) {
      const csv = await r.text();
      const lines = csv.split(/\r?\n/).slice(1);
      for (const line of lines) {
        const symbol = line.split(",")[0]?.trim();
        if (symbol && symbol.match(/^[A-Z]{1,5}(\.[A-Z])?$/)) sp500.add(symbol);
      }
    }
  } catch (e) {
    console.warn("[SCREENER] S&P 500 fetch failed:", (e as Error).message);
  }

  // Merge S&P 500 + hardcoded Nasdaq 100
  const merged = new Set<string>([...sp500, ...NASDAQ_100]);
  UNIVERSE = merged;
  universeLoaded = true;

  // Persist to disk
  try {
    writeFileSync(UNIVERSE_DISK_CACHE, JSON.stringify({
      ts: Date.now(),
      symbols: [...merged],
    }));
  } catch { /* ignore */ }

  console.log(`[SCREENER] Universe loaded: ${sp500.size} S&P + ${NASDAQ_100.length} NDX = ${UNIVERSE.size} unique tickers`);
  return UNIVERSE;
}

// ════════════════════════════════════════════════════════════════
//  TIER 1 TRIGGER PATTERNS
//  Each category maps to regexes that catch real catalyst headlines.
// ════════════════════════════════════════════════════════════════

const TRIGGER_PATTERNS: Record<string, RegExp[]> = {
  earnings: [
    /\bbeats? (?:earnings|estimates|expectations|consensus|street)/i,
    /\btops? (?:earnings|estimates|expectations|consensus)/i,
    /\b(?:q[1-4]|quarterly|fy ?\d+) (?:earnings|results|revenue|report)/i,
    /\bEPS of \$[\d.]+/i,
    /\bearnings beat/i,
    /\brevenue (?:beat|topped|exceeded|jumps|surges)/i,
    /\bmisses? (?:earnings|estimates|expectations|consensus)/i,
    /\b(?:falls?|comes?) short of (?:earnings|estimates|expectations)/i,
    /\bearnings miss/i,
    /\bposts? (?:record|strong|weak) (?:earnings|results|revenue)/i,
  ],
  guidance: [
    /\braises? (?:guidance|forecast|outlook|full[- ]year|fy ?\d+)/i,
    /\b(?:lifts?|boosts?|hikes?) (?:guidance|forecast|outlook)/i,
    /\b(?:cuts?|lowers?|slashes?|trims?) (?:guidance|forecast|outlook)/i,
    /\bwithdraws? (?:guidance|forecast|outlook)/i,
    /\breaffirms? (?:guidance|outlook)/i,
    /\bguides? (?:above|below) (?:consensus|estimates)/i,
  ],
  ma: [
    /\bto acquire\b/i,
    /\bagrees? to acquire/i,
    /\bannounces? acquisition/i,
    /\bdefinitive (?:agreement|merger)/i,
    /\bmerger (?:agreement|announc)/i,
    /\btake[- ]private/i,
    /\bbuyout\b/i,
    /\bgoing private\b/i,
    /\b(?:spins?[- ]off|spin[- ]off)\b/i,
    /\bdivest(?:iture|s|ing)\b/i,
    /\btender offer\b/i,
    /\bhostile (?:bid|takeover)/i,
  ],
  fda: [
    /\bFDA approv(?:al|es|ed)\b/,
    /\bphase 3 (?:results|data|trial|topline)/i,
    /\bclinical trial (?:results|data)/i,
    /\bbreakthrough designation/i,
    /\bfast[- ]track designation/i,
    /\bcomplete response letter/i,
    /\bPDUFA date/i,
  ],
  regulatory: [
    /\bSEC charges?\b/,
    /\bDOJ (?:probe|investigation|charges|sues)/,
    /\bFTC (?:blocks?|sues|investigation)/,
    /\bantitrust (?:lawsuit|probe|ruling|approval)/i,
    /\bChapter 11\b/,
    /\bfile[sd]? for bankruptcy/i,
    /\bvoluntar(?:y|ily) bankruptcy/i,
    /\bgoing[- ]concern (?:warning|doubt|qualification|opinion)\b/i,
    /\bgoing concern\b/i,
    /\bdefault(?:ed|s|ing)? on (?:its |a )?(?:debt|bonds?|notes?|payment|loan)\b/i,
    /\bmissed? (?:debt |bond |interest |coupon )?payment\b/i,
  ],
  csuite: [
    /\bCEO (?:resigns?|steps? down|departs?|fired|out|to step down)/i,
    /\b(?:appoints?|names?) (?:new )?CEO\b/i,
    /\bnew CEO/i,
    /\bCFO (?:resigns?|steps? down|departs?|fired)/i,
    /\b(?:appoints?|names?) (?:new )?CFO/i,
    /\bactivist (?:investor|stake|campaign)/i,
    /\b13D filing/,
    /\bproxy fight/i,
    /\bboard (?:overhaul|reshuffle|shake[- ]up)/i,
  ],
  corporate: [
    /\bstock split\b/i,
    /\b(?:share|stock) (?:buyback|repurchase) (?:program|authoriz|of)/i,
    /\b\$\d+(?:\.\d+)?\s*(?:B|billion) (?:buyback|repurchase)/i,
    /\braises? (?:its )?dividend/i,
    /\bcuts? (?:its )?dividend/i,
    /\bsuspends? (?:its )?dividend/i,
    /\binitiates? (?:a )?dividend/i,
    /\bspecial dividend\b/i,
  ],
  contracts: [
    /\b(?:wins?|awarded|secures?) (?:a )?(?:contract|deal) (?:worth|valued|with)/i,
    /\b\$\d+(?:\.\d+)?\s*(?:B|billion) (?:contract|deal|order)/i,
    /\bPentagon (?:contract|award|deal)/i,
    /\bdefense contract\b/i,
    /\bgovernment contract\b/i,
    /\bmajor (?:contract|partnership|deal) with/i,
  ],
  analyst: [
    /\b(?:Goldman Sachs|Goldman) (?:upgrades?|downgrades?|raises?|cuts?|initiates?|reiterates?|reaffirms?)/i,
    /\bJ\.?P\.?\s*Morgan (?:upgrades?|downgrades?|raises?|cuts?|initiates?|reiterates?|reaffirms?)/i,
  ],
  // Equity dilution — major bearish catalyst (offerings = forced repricing)
  offering: [
    /\b(?:prices?|announces?|completes?) (?:a )?(?:public |common stock |equity |secondary )?offering\b/i,
    /\bsecondary (?:stock |equity |share )?offering\b/i,
    /\b(?:at[- ]the[- ]market|ATM) (?:offering|equity program|program)\b/i,
    /\bprices? (?:convertible (?:notes?|bonds?|debentures?))\b/i,
    /\bequity (?:offering|issuance|raise|program)\b/i,
    /\bshelf (?:registration|offering)\b/i,
    /\b(?:to )?raise[sd]? \$[\d.]+\s*(?:B|billion|M|million) (?:through|via|in) (?:stock|shares|equity|common stock)\b/i,
  ],
  // Credit rating actions — triggers covenant clauses, margin calls, forced selling
  credit: [
    /\b(?:Moody'?s|Moodys) (?:downgrades?|upgrades?|affirms?|cuts?|assigns?|lowers?|reviews?)\b/i,
    /\bFitch (?:downgrades?|upgrades?|affirms?|cuts?|assigns?|lowers?|reviews?)\b/i,
    /\bS&P (?:downgrades?|upgrades?|affirms?|cuts?|assigns?|lowers?)\b/i,
    /\bStandard &? Poor'?s? (?:downgrades?|upgrades?|affirms?|cuts?|lowers?)\b/i,
    /\bdowngraded? to (?:junk|speculative[- ]grade|non[- ]investment[- ]grade|Ba[123]?|B[123])\b/i,
    /\bcredit (?:rating|outlook) (?:downgraded?|upgraded?|cut|lowered?|raised?)\b/i,
  ],
};

const ALL_CATEGORIES = Object.keys(TRIGGER_PATTERNS);

function categorize(title: string): string[] {
  const matches: string[] = [];
  for (const cat of ALL_CATEGORIES) {
    if (TRIGGER_PATTERNS[cat].some(p => p.test(title))) matches.push(cat);
  }
  return matches;
}

// ════════════════════════════════════════════════════════════════
//  EXCLUSION PATTERNS — auto-reject noise
// ════════════════════════════════════════════════════════════════

const EXCLUSIONS: RegExp[] = [
  /\btop \d+ stocks?\b/i,
  /\b\d+ stocks? to (?:buy|watch|own|own now|consider)/i,
  /\bbest stocks? to (?:buy|own)/i,
  /\bstocks? to watch (?:now|today)/i,
  /\bwhy (?:is )?\w+ (?:is )?(?:up|down|surging|falling|jumping|plunging)/i,
  /\bwhat investors should know/i,
  /\bshould you buy\b/i,
  /\bis \w+ a (?:buy|sell|good buy|good investment)/i,
  /\bworth buying\b/i,
  /\b(?:Jim )?Cramer\b/i,
  /\bMad Money\b/i,
  /\bwebinar\b/i,
  /\bfree report\b/i,
  /\bsubscribe (?:now|today)/i,
  /\bMotley Fool\b/i,
  /\bZacks (?:rank|rating|consensus)/i,
  /\bmorning brief\b/i,
  /\bevening brief\b/i,
  /\bweekly recap\b/i,
  /\b(?:market|stock market) wrap\b/i,
  /\btop (?:gainers?|losers?)/i,
  /\bbiggest movers\b/i,
  /\b\d+ reasons? to\b/i,
  /\b(?:will|could) \w+ stock\b/i,
];

// ════════════════════════════════════════════════════════════════
//  TRUSTED PUBLISHERS
//  Only headlines from these sources pass.
// ════════════════════════════════════════════════════════════════

const TRUSTED_SOURCES = new Set<string>([
  // Tier A — real journalism
  "Reuters", "Bloomberg", "Wall Street Journal", "WSJ", "CNBC",
  "Barron's", "Financial Times", "FT", "MarketWatch",
  "AP", "Associated Press", "AP News",
  // Tier B — official company PR wires (high-trust for company-issued news)
  "PR Newswire", "Business Wire", "GlobeNewswire", "Globe Newswire",
  "PRNewswire", "BusinessWire",
]);

// ════════════════════════════════════════════════════════════════
//  HIGH-IMPACT DETECTOR — triggers the sound chime
// ════════════════════════════════════════════════════════════════

function detectHighImpact(title: string, categories: string[]): boolean {
  // Earnings beat by ≥10%
  if (categories.includes("earnings")) {
    const m = title.match(/beat(?:s|ing)?\s+(?:by\s+)?(\d+)%/i);
    if (m && parseInt(m[1]) >= 10) return true;
  }
  // FDA approval (always high-impact for biotech)
  if (categories.includes("fda") && /\bFDA approv(?:al|es|ed)\b/.test(title)) return true;
  // M&A: $1B+ deal OR hostile bid/tender offer (no $ needed — these always move)
  if (categories.includes("ma")) {
    const m = title.match(/\$(\d+(?:\.\d+)?)\s*(?:B|billion)/i);
    if (m && parseFloat(m[1]) >= 1) return true;
    if (/\b(?:hostile (?:bid|takeover)|tender offer)\b/i.test(title)) return true;
  }
  // Bankruptcy — extreme market mover for equity holders
  if (categories.includes("regulatory") &&
      /\bChapter 11\b|\bfile[sd]? for bankruptcy\b|\bvoluntar(?:y|ily) bankruptcy\b/i.test(title)) return true;
  // CEO departure (solo) — always material for S&P 500 names
  if (categories.includes("csuite") &&
      /\bCEO (?:resigns?|steps? down|departs?|fired|out\b|to step down)\b/i.test(title)) return true;
  // Guidance withdrawal or cut — major uncertainty signal for forward multiples
  if (categories.includes("guidance") &&
      /\b(?:withdraws?|suspends?|pulls?|cuts?|lowers?|slashes?|trims?) (?:guidance|forecast|outlook)\b/i.test(title)) return true;
  // CEO out + activist combo (rare but seismic)
  if (categories.includes("csuite") && categories.includes("ma")) return true;
  // Going-concern warning (imminent existential risk — stock typically -50% to -80%)
  if (categories.includes("regulatory") &&
      /\bgoing[- ]concern\b/i.test(title)) return true;
  // Debt default / missed payment (cross-default clauses, forced liquidation)
  if (categories.includes("regulatory") &&
      /\b(?:default(?:ed|s|ing)? on|missed? (?:debt |bond |interest |coupon )?payment)\b/i.test(title)) return true;
  // Credit downgrade to junk (covenant triggers, index exclusion, forced selling)
  if (categories.includes("credit") &&
      /\bdowngraded? to (?:junk|speculative[- ]grade|non[- ]investment[- ]grade|Ba[123]?|B[123])\b/i.test(title)) return true;
  // Large equity offering ≥$1B (significant dilution, reprices the float)
  if (categories.includes("offering")) {
    const offeringM = title.match(/\$(\d+(?:\.\d+)?)\s*(?:B|billion)/i);
    if (offeringM && parseFloat(offeringM[1]) >= 1) return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════
//  MAIN: fetch + screen
// ════════════════════════════════════════════════════════════════

let lastFetchAt = 0;
let lastResults: ScreenedHeadline[] = [];

export async function fetchScreenedHeadlines(): Promise<ScreenedHeadline[]> {
  const FINVIZ = process.env.FINVIZ_AUTH_TOKEN || "";
  if (!FINVIZ) {
    console.warn("[SCREENER] FINVIZ_AUTH_TOKEN not set");
    return [];
  }

  // Always ensure universe is loaded
  await loadUniverse();

  const t0 = Date.now();
  let csv = "";
  try {
    const r = await fetch(
      `https://elite.finviz.com/news_export.ashx?v=3&auth=${FINVIZ}`,
      {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/csv" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!r.ok) {
      console.warn(`[SCREENER] Finviz HTTP ${r.status}`);
      return lastResults;
    }
    csv = await r.text();
  } catch (err) {
    console.warn("[SCREENER] Finviz fetch failed:", (err as Error).message);
    return lastResults;
  }

  // Parse CSV: "Title","Source",Date,"Url",Category,"Ticker"
  const lines = csv.split(/\r?\n/).slice(1);
  const results: ScreenedHeadline[] = [];
  let parseFails = 0, universeRejects = 0, sourceRejects = 0, triggerRejects = 0, exclusionRejects = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(/^"([^"]*)","([^"]*)",([^,]+),"([^"]*)",([^,]+),"([^"]+)"$/);
    if (!m) { parseFails++; continue; }
    const [, title, source, dateStr, url, _category, ticker] = m;
    void _category;
    const cleanTicker = ticker.trim().toUpperCase();

    // FILTER 1: Universe (S&P 500 + Nasdaq 100)
    if (!UNIVERSE.has(cleanTicker)) { universeRejects++; continue; }

    // FILTER 2: Trusted source
    const cleanSource = source.trim();
    if (!TRUSTED_SOURCES.has(cleanSource)) { sourceRejects++; continue; }

    // FILTER 3: TIER 1 trigger phrase
    const cleanTitle = title.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const categories = categorize(cleanTitle);
    if (categories.length === 0) { triggerRejects++; continue; }

    // FILTER 4: Exclusions
    if (EXCLUSIONS.some(p => p.test(cleanTitle))) { exclusionRejects++; continue; }

    // Parse timestamp
    const ts = new Date(dateStr.trim().replace(" ", "T") + "Z");
    if (isNaN(ts.getTime())) continue;

    const isHighImpact = detectHighImpact(cleanTitle, categories);

    results.push({
      id: `${cleanTicker}_${ts.getTime()}_${url}`,
      ticker: cleanTicker,
      title: cleanTitle,
      source: cleanSource,
      url: url.trim(),
      timestamp: ts.toISOString(),
      categories,
      isHighImpact,
    });
  }

  // Deduplicate by URL (Finviz sometimes lists the same article under multiple tickers)
  const seenUrls = new Set<string>();
  const deduped = results.filter(r => {
    if (seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  });

  // Sort newest first
  deduped.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const latency = Date.now() - t0;
  console.log(`[SCREENER] ${deduped.length} TIER 1 / ${lines.length} total | ${latency}ms | rejects: uni=${universeRejects} src=${sourceRejects} trig=${triggerRejects} excl=${exclusionRejects}`);

  lastFetchAt = Date.now();
  lastResults = deduped;
  return deduped;
}

export function getLastResults(): ScreenedHeadline[] {
  return lastResults;
}

export function getLastFetchAt(): number {
  return lastFetchAt;
}
