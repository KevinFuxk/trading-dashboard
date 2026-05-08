/**
 * gov-calendar.ts — Direct government data, maximum free speed.
 *
 * SPEED STRATEGY:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Source         │ Latency │ Limit/day │ Updates at release?    │
 * ├─────────────────┼─────────┼───────────┼────────────────────────┤
 * │  BLS API        │  280ms  │ 25 no key │ Yes — exact embargo    │
 * │  BLS API + key  │  280ms  │ 500/day   │ Yes — exact embargo    │
 * │  FRED API + key │  120ms  │ unlimited │ Yes — exact embargo    │
 * │  ForexFactory   │   48ms  │ rate ltd  │ 5–30s after release    │
 * └─────────────────┴─────────┴───────────┴────────────────────────┘
 *
 * Sniper mode: race BLS + FRED in parallel at 1s intervals.
 * First source to show a new period wins and fires SSE immediately.
 * Without keys: BLS 25/day is enough for ~3 release events.
 * With keys: effectively unlimited.
 *
 * KEYS (all free, 30s to register):
 *   BLS_API_KEY  → https://data.bls.gov/registrationEngine/
 *   FRED_API_KEY → https://fred.stlouisfed.org/docs/api/api_key.html
 */

import type { EconomicEvent } from "./types";

const BLS_KEY  = process.env.BLS_API_KEY  || "";   // "" = anonymous 25/day
const FRED_KEY = process.env.FRED_API_KEY || "";   // "" = disabled

// ─── BLS Series split by release group ───────────────────────────────────────
// Splitting by release day means on CPI day we only call the CPI group (faster).

export interface BLSDataPoint {
  seriesId: string;
  name: string;
  year: string;
  period: string;
  value: number;
  prevValue: number;
  change: number;
  pctChange: number;
  unit: string;
  impact: "high" | "medium" | "low";
  formattedActual: string;
  formattedPrevious: string;
}

interface BLSSeriesConfig {
  id: string;
  fredId: string;   // FRED equivalent for parallel race
  name: string;
  unit: string;
  type: "pct_change" | "level" | "diff";
  currency: "USD";
  impact: "high" | "medium" | "low";
  releaseGroup: "cpi" | "ppi" | "jobs";
  releaseHourET: number;
  releaseMinET: number;
}

const BLS_SERIES: BLSSeriesConfig[] = [
  // BLS series ID (verified ✅)    FRED equivalent (verified ✅)
  { id: "CUSR0000SA0",    fredId: "CPIAUCSL",  name: "CPI m/m",                 unit: "%", type: "pct_change", currency: "USD", impact: "high",   releaseGroup: "cpi",  releaseHourET: 8, releaseMinET: 30 },
  { id: "CUSR0000SA0L1E", fredId: "CPILFESL",  name: "Core CPI m/m",            unit: "%", type: "pct_change", currency: "USD", impact: "high",   releaseGroup: "cpi",  releaseHourET: 8, releaseMinET: 30 },
  { id: "WPUFD4",         fredId: "PPIFID",    name: "PPI m/m",                 unit: "%", type: "pct_change", currency: "USD", impact: "high",   releaseGroup: "ppi",  releaseHourET: 8, releaseMinET: 30 },
  { id: "WPSFD4",         fredId: "PPIFIS",    name: "Core PPI m/m",            unit: "%", type: "pct_change", currency: "USD", impact: "medium", releaseGroup: "ppi",  releaseHourET: 8, releaseMinET: 30 },
  { id: "CES0000000001",  fredId: "PAYEMS",    name: "Non-Farm Payrolls",        unit: "K", type: "diff",       currency: "USD", impact: "high",   releaseGroup: "jobs", releaseHourET: 8, releaseMinET: 30 },
  { id: "LNS14000000",    fredId: "UNRATE",    name: "Unemployment Rate",        unit: "%", type: "level",      currency: "USD", impact: "high",   releaseGroup: "jobs", releaseHourET: 8, releaseMinET: 30 },
  { id: "CES0500000003",  fredId: "AHETPI",    name: "Avg Hourly Earnings m/m", unit: "%", type: "pct_change", currency: "USD", impact: "medium", releaseGroup: "jobs", releaseHourET: 8, releaseMinET: 30 },
];

// ─── In-process cache ─────────────────────────────────────────────────────────

const cache = new Map<string, { data: unknown; ts: number }>();
function getCached<T>(key: string, ttlMs: number): T | null {
  const e = cache.get(key);
  return e && Date.now() - e.ts < ttlMs ? (e.data as T) : null;
}
function setCache(key: string, data: unknown) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Detect which release group is active today ───────────────────────────────

function getTodaysReleaseGroup(): "cpi" | "ppi" | "jobs" | null {
  // We poll ForexFactory to know today's releases, but as a fast heuristic:
  // BLS releases are always 8:30 ET. If we're within the sniper window,
  // check which group we last fetched data for.
  return null; // null = fetch all groups
}

// ─── BLS API fetcher ──────────────────────────────────────────────────────────

async function fetchBLSGroup(group: "cpi" | "ppi" | "jobs" | null, year: number): Promise<BLSDataPoint[]> {
  const configs = group ? BLS_SERIES.filter(s => s.releaseGroup === group) : BLS_SERIES;
  const seriesIds = configs.map(s => s.id);

  const body: Record<string, unknown> = {
    seriesid: seriesIds,
    startyear: String(year - 1),
    endyear: String(year),
  };
  if (BLS_KEY) body.registrationkey = BLS_KEY;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  const res = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) throw new Error(`BLS ${res.status}`);
  const json = await res.json() as {
    status: string;
    Results?: { series: Array<{ seriesID: string; data: Array<{ year: string; period: string; value: string }> }> };
  };

  if (json.status !== "REQUEST_SUCCEEDED" || !json.Results) {
    throw new Error(`BLS status: ${json.status}`);
  }

  return parseBlsSeries(json.Results.series, configs);
}

// ─── FRED API fetcher (parallel race — faster at 120ms) ──────────────────────

async function fetchFREDGroup(group: "cpi" | "ppi" | "jobs" | null): Promise<BLSDataPoint[]> {
  if (!FRED_KEY) return [];

  const configs = group ? BLS_SERIES.filter(s => s.releaseGroup === group) : BLS_SERIES;
  const results: BLSDataPoint[] = [];

  // FRED doesn't support multi-series in one call, so parallel fetch
  await Promise.allSettled(
    configs.map(async (config) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);
      try {
        const url = `https://api.stlouisfed.org/fred/series/observations` +
          `?series_id=${config.fredId}&api_key=${FRED_KEY}` +
          `&sort_order=desc&limit=3&file_type=json`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return;

        const json = await res.json() as {
          observations: Array<{ date: string; value: string }>;
        };

        const obs = json.observations?.filter(o => o.value !== ".") ?? [];
        if (obs.length < 2) return;

        const v0 = parseFloat(obs[0].value);
        const v1 = parseFloat(obs[1].value);
        const period = `M${String(new Date(obs[0].date).getMonth() + 1).padStart(2, "0")}`;
        const year = String(new Date(obs[0].date).getFullYear());

        results.push(buildDataPoint(config, year, period, v0, v1));
      } catch { clearTimeout(timeout); }
    })
  );

  return results;
}

// ─── Shared parsing helpers ───────────────────────────────────────────────────

function parseBlsSeries(
  series: Array<{ seriesID: string; data: Array<{ year: string; period: string; value: string }> }>,
  configs: BLSSeriesConfig[]
): BLSDataPoint[] {
  const results: BLSDataPoint[] = [];
  for (const s of series) {
    const config = configs.find(c => c.id === s.seriesID);
    if (!config || s.data.length < 2) continue;
    const v0 = parseFloat(s.data[0].value);
    const v1 = parseFloat(s.data[1].value);
    results.push(buildDataPoint(config, s.data[0].year, s.data[0].period, v0, v1));
  }
  return results;
}

function buildDataPoint(config: BLSSeriesConfig, year: string, period: string, v0: number, v1: number): BLSDataPoint {
  const change = v0 - v1;
  const pctChange = v1 !== 0 ? (change / Math.abs(v1)) * 100 : 0;

  let formattedActual: string;
  let formattedPrevious: string;

  if (config.type === "pct_change") {
    formattedActual   = `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(1)}%`;
    formattedPrevious = `${v1.toFixed(1)}`;
  } else if (config.type === "diff") {
    const diffK = Math.round(change);
    formattedActual   = `${diffK >= 0 ? "+" : ""}${diffK}K`;
    formattedPrevious = `${Math.round(v1)}K`;
  } else {
    formattedActual   = `${v0.toFixed(1)}${config.unit}`;
    formattedPrevious = `${v1.toFixed(1)}${config.unit}`;
  }

  return {
    seriesId: config.id,
    name: config.name,
    year,
    period,
    value: v0,
    prevValue: v1,
    change,
    pctChange,
    unit: config.unit,
    impact: config.impact,
    formattedActual,
    formattedPrevious,
  };
}

// ─── Census / NAR / ADP series via FRED CSV (no API key required) ────────────
// FRED CSV endpoint at fred.stlouisfed.org/graph/fredgraph.csv works without a key
// for many series and updates within minutes of the official government release.
//
// Confirmed working (tested Apr 2026):
//   RSAFS   — Retail Sales (Census MARTS)          ✅
//   RSXFS   — Core Retail Sales ex-gas (Census)    ✅
//   DGORDER — Durable Goods Orders (Census)        ✅
//   HSN1F   — New Home Sales (Census, SAAR, K)     ✅
//
// Blocked (requires FRED API key — free at fred.stlouisfed.org/docs/api/api_key.html):
//   NPPTTL      — ADP Private Payrolls             → set FRED_API_KEY
//   PHSI        — Pending Home Sales Index         → set FRED_API_KEY
//   INVCMRMTSPL — Business Inventories             → set FRED_API_KEY
//   PCEPILFE    — Core PCE Price Index             → set FRED_API_KEY

interface CensusSeriesConfig {
  fredCsvId: string;
  name: string;
  unit: string;
  type: "pct_change" | "level_k";  // pct_change: compute m/m % | level_k: display raw value in K
  impact: "high" | "medium" | "low";
}

const CENSUS_SERIES: CensusSeriesConfig[] = [
  { fredCsvId: "RSAFS",   name: "Retail Sales m/m",         unit: "%", type: "pct_change", impact: "high"   },
  { fredCsvId: "RSXFS",   name: "Core Retail Sales m/m",    unit: "%", type: "pct_change", impact: "high"   },
  { fredCsvId: "DGORDER", name: "Durable Goods Orders m/m", unit: "%", type: "pct_change", impact: "medium" },
  { fredCsvId: "HSN1F",   name: "New Home Sales",            unit: "K", type: "level_k",   impact: "medium" },
];

async function fetchCensusData(): Promise<BLSDataPoint[]> {
  const results: BLSDataPoint[] = [];

  await Promise.allSettled(
    CENSUS_SERIES.map(async (s) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        const res = await fetch(
          `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${s.fredCsvId}`,
          {
            signal: controller.signal,
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              "Referer": "https://fred.stlouisfed.org/",
            },
          }
        );
        clearTimeout(timeout);
        if (!res.ok) return;

        const text = await res.text();
        if (text.includes("<")) return; // HTML = blocked

        const lines = text.trim().split("\n").slice(1).filter(l => l.trim() && !l.includes("."));
        if (lines.length < 2) return;

        const tail = lines.slice(-3);
        const pts = tail.map(l => {
          const [date, val] = l.split(",");
          return { date: date.trim(), value: parseFloat(val.trim()) };
        }).filter(p => !isNaN(p.value));

        if (pts.length < 2) return;

        const latest = pts[pts.length - 1];
        const prior  = pts[pts.length - 2];
        const prior2 = pts.length >= 3 ? pts[pts.length - 3] : null;

        const d = new Date(latest.date);
        const period = `M${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const sign   = (n: number) => n >= 0 ? "+" : "";

        let formattedActual: string;
        let formattedPrevious: string;

        if (s.type === "level_k") {
          // New Home Sales: level in thousands — display as "587K"
          const pctChange     = ((latest.value - prior.value) / prior.value) * 100;
          const prevPctChange = prior2 ? ((prior.value - prior2.value) / prior2.value) * 100 : 0;
          formattedActual   = `${Math.round(latest.value)}K`;
          formattedPrevious = `${Math.round(prior.value)}K`;
          results.push({
            seriesId: s.fredCsvId, name: s.name,
            year: String(d.getUTCFullYear()), period,
            value: latest.value, prevValue: prior.value,
            change: latest.value - prior.value, pctChange, unit: s.unit, impact: s.impact,
            formattedActual, formattedPrevious,
          });
          void prevPctChange; // suppress unused-var warning
        } else {
          // pct_change: compute m/m %
          const pctChange     = ((latest.value - prior.value) / prior.value) * 100;
          const prevPctChange = prior2 ? ((prior.value - prior2.value) / prior2.value) * 100 : 0;
          formattedActual   = `${sign(pctChange)}${pctChange.toFixed(1)}%`;
          formattedPrevious = `${sign(prevPctChange)}${prevPctChange.toFixed(1)}%`;
          results.push({
            seriesId: s.fredCsvId, name: s.name,
            year: String(d.getUTCFullYear()), period,
            value: latest.value, prevValue: prior.value,
            change: latest.value - prior.value, pctChange, unit: s.unit, impact: s.impact,
            formattedActual, formattedPrevious,
          });
        }

        console.log(`[CENSUS CSV] ${s.name}: ${formattedActual} (${latest.date})`);
      } catch { /* ignore — stale cache will cover */ }
    })
  );

  return results;
}

// ─── FRED API key — extra series (ADP, NAR, Census MTIS, BEA) ───────────────
// These require a FRED API key because their FRED CSV endpoint is blocked.
// Key is FREE to obtain in ~30 seconds: https://fred.stlouisfed.org/docs/api/api_key.html
// Add to .env.local: FRED_API_KEY=your_key_here

interface FREDExtraConfig {
  fredId: string;
  name: string;
  unit: string;
  type:
    | "pct_change"      // m/m % from index level (CPI, ECI, BUSINV, etc.)
    | "yoy_pct"         // y/y % from index level (Case-Shiller HPI y/y)
    | "diff_k"          // m/m diff in K (level in thousands)
    | "diff_persons"    // m/m diff in K (level in actual persons → /1000)
    | "level_k"         // level in K, display as "587K"
    | "level_native_k"  // level already in K (e.g. PERMIT=1372 → "1.37M")
    | "level_count_k"   // level in actual count → "189K" (ICSA)
    | "level_billions"  // level in millions → display as "$-57.3B" (BOPGSTB)
    | "level_pct"       // level already a % (DFEDTARU, GDP)
    | "level_index"     // index value as-is (UMCSENT)
    | "boe_rate_proxy"; // SONIA rounded to nearest 0.25% (BOE proxy)
  impact: "high" | "medium" | "low";
}

const FRED_EXTRA_SERIES: FREDExtraConfig[] = [
  // ADP Monthly Employment (ADPMNUSNERSA — replaces discontinued NPPTTL as of Jun 2022)
  // Values stored as actual persons (~132M), so diff_persons divides by 1000 → K
  { fredId: "ADPMNUSNERSA", name: "ADP Non-Farm Employment Change", unit: "K",  type: "diff_persons", impact: "high"   },
  // Census MTIS: Total Business Inventories (BUSINV, millions of dollars, SA)
  // Released ~6 weeks after reference month (Apr 21 = Feb data → 0.4% m/m ✅)
  { fredId: "BUSINV",       name: "Business Inventories m/m",       unit: "%",  type: "pct_change",   impact: "medium" },
  // Census Wholesale Trade: Merchant Wholesalers Inventories (WHLSLRIMSA, SA)
  { fredId: "WHLSLRIMSA",   name: "Wholesale Inventories m/m",      unit: "%",  type: "pct_change",   impact: "low"    },
  // BEA Core PCE Price Index — m/m %
  { fredId: "PCEPILFE",     name: "Core PCE Price Index m/m",       unit: "%",  type: "pct_change",   impact: "high"   },
  // Federal Funds Target Range Upper Limit — set by FOMC (8 meetings/year, 2:00 PM ET)
  // FRED updates within minutes of FOMC statement release. This is what FF shows as "actual".
  { fredId: "DFEDTARU",     name: "Federal Funds Rate",              unit: "%",  type: "level_pct",    impact: "high"   },
  // BEA Advance GDP q/q — quarterly, % Chg from Preceding Period (annualized rate)
  // Released ~30 days after quarter end (Q1 advance: end of April)
  { fredId: "A191RL1Q225SBEA", name: "Advance GDP q/q",              unit: "%",  type: "level_pct",    impact: "high"   },
  // BEA GDP Implicit Price Deflator q/q — quarterly inflation measure (released same day as GDP)
  { fredId: "A191RI1Q225SBEA", name: "Advance GDP Price Index q/q",  unit: "%",  type: "level_pct",    impact: "medium" },
  // BLS Employment Cost Index — quarterly, all civilian total compensation index (Dec 2005=100)
  // Released ~30 days after quarter end. We compute q/q % change from the index level.
  { fredId: "ECIALLCIV",    name: "Employment Cost Index q/q",       unit: "%",  type: "pct_change",   impact: "high"   },
  // Census — Durable Goods Orders m/m (API key fallback if FRED CSV is blocked)
  { fredId: "DGORDER",      name: "Durable Goods Orders m/m",       unit: "%",  type: "pct_change",   impact: "medium" },
  // Census — New Home Sales (SAAR, thousands — API key fallback)
  { fredId: "HSN1F",        name: "New Home Sales",                  unit: "K",  type: "level_k",      impact: "medium" },
  // ── Weekly / monthly secondary releases (low-medium impact) ────────────────
  // DOL Initial Jobless Claims — weekly, released Thu 8:30 ET (high market impact)
  { fredId: "ICSA",         name: "Unemployment Claims",              unit: "K",  type: "level_count_k",  impact: "high"   },
  // BEA Personal Income — monthly, released same day as Core PCE
  { fredId: "PI",           name: "Personal Income m/m",              unit: "%",  type: "pct_change",     impact: "low"    },
  // BEA Personal Spending (PCE) — monthly, released with Core PCE
  { fredId: "PCE",          name: "Personal Spending m/m",            unit: "%",  type: "pct_change",     impact: "low"    },
  // Census Building Permits — monthly, value in thousands SAAR
  { fredId: "PERMIT",       name: "Building Permits",                 unit: "K",  type: "level_native_k", impact: "low"    },
  // Census Housing Starts — monthly, value in thousands SAAR
  { fredId: "HOUST",        name: "Housing Starts",                   unit: "K",  type: "level_native_k", impact: "low"    },
  // Census Goods Trade Balance — monthly, in millions of dollars
  { fredId: "BOPGSTB",      name: "Goods Trade Balance",              unit: "B",  type: "level_billions", impact: "low"    },
  // S&P/Cotality Case-Shiller 20-City Composite Home Price Index — y/y %
  { fredId: "SPCS20RSA",    name: "S&P/CS Composite-20 HPI y/y",      unit: "%",  type: "yoy_pct",        impact: "low"    },
  // Univ of Michigan Consumer Sentiment (substitute for CB Consumer Confidence — different but correlated)
  { fredId: "UMCSENT",      name: "CB Consumer Confidence",           unit: "",   type: "level_index",    impact: "medium" },
  // BOE rate proxy via SONIA (Sterling Overnight Interbank Average Rate) — daily
  // SONIA tracks Bank Rate -0.05% so we round to nearest 0.25% (BOE moves in 25bp steps)
  { fredId: "IUDSOIA",      name: "Official Bank Rate",               unit: "%",  type: "boe_rate_proxy", impact: "high"   },
  // Census Factory Orders m/m — monthly, released ~1st week of month at 10:00 ET
  { fredId: "AMTMNO",       name: "Factory Orders m/m",               unit: "%",  type: "pct_change",     impact: "low"    },
  // NAR Pending Home Sales Index — m/m % (PHSI not available without special access — left as TBD)
  // { fredId: "PHSI", name: "Pending Home Sales m/m", unit: "%", type: "pct_change", impact: "medium" },
];

async function fetchFREDExtraData(): Promise<BLSDataPoint[]> {
  if (!FRED_KEY) return []; // silently skip — no key provided

  const results: BLSDataPoint[] = [];

  await Promise.allSettled(
    FRED_EXTRA_SERIES.map(async (s) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);
      try {
        // yoy_pct needs 13 obs (current + 12 ago); boe_rate_proxy needs ~30 to find last change
        const limit = s.type === "yoy_pct" ? 13
                    : s.type === "boe_rate_proxy" ? 30
                    : s.type === "level_pct" ? 30   // also needs history to find last change
                    : 3;
        const url = `https://api.stlouisfed.org/fred/series/observations` +
          `?series_id=${s.fredId}&api_key=${FRED_KEY}` +
          `&sort_order=desc&limit=${limit}&file_type=json`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return;

        const json = await res.json() as {
          observations: Array<{ date: string; value: string }>;
        };

        const obs = (json.observations ?? []).filter(o => o.value !== ".");
        if (obs.length < 2) return;

        const v0 = parseFloat(obs[0].value); // latest
        const v1 = parseFloat(obs[1].value); // prior
        const v2 = obs.length >= 3 ? parseFloat(obs[2].value) : null;

        const d = new Date(obs[0].date);
        const period = `M${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const sign = (n: number) => n >= 0 ? "+" : "";

        let formattedActual: string;
        let formattedPrevious: string;
        let pctChange = 0;

        if (s.type === "diff_persons") {
          // ADP (ADPMNUSNERSA): level stored in actual persons (~132M) → divide diff by 1000 → K
          const diffK     = Math.round((v0 - v1) / 1000);
          const prevDiffK = v2 != null ? Math.round((v1 - v2) / 1000) : 0;
          formattedActual   = `${sign(diffK)}${diffK}K`;
          formattedPrevious = `${sign(prevDiffK)}${prevDiffK}K`;
          pctChange = diffK;
        } else if (s.type === "diff_k") {
          // Generic: level in thousands → m/m diff in K
          const diff     = Math.round(v0 - v1);
          const prevDiff = v2 != null ? Math.round(v1 - v2) : 0;
          formattedActual   = `${sign(diff)}${diff}K`;
          formattedPrevious = `${sign(prevDiff)}${prevDiff}K`;
          pctChange = diff;
        } else if (s.type === "level_k") {
          // New Home Sales: level in thousands SAAR
          formattedActual   = `${Math.round(v0)}K`;
          formattedPrevious = `${Math.round(v1)}K`;
          pctChange = ((v0 - v1) / v1) * 100;
        } else if (s.type === "level_pct") {
          // FOMC Federal Funds Rate Target — value already in percent (e.g. 3.75)
          // For "previous" use the value from before the most recent change.
          formattedActual = `${v0.toFixed(2)}%`;
          let priorRate = v1;
          for (const o of obs.slice(1)) {
            const v = parseFloat(o.value);
            if (v !== v0) { priorRate = v; break; }
          }
          formattedPrevious = `${priorRate.toFixed(2)}%`;
          pctChange = v0 - priorRate;
        } else if (s.type === "boe_rate_proxy") {
          // SONIA → BOE Bank Rate proxy: round to nearest 0.25% (BOE moves in 25bp steps)
          // SONIA tracks Bank Rate ~0.05% below
          const round025 = (n: number) => Math.round(n * 4) / 4;
          const rounded     = round025(v0 + 0.05); // adjust for SONIA-Bank Rate spread
          const priorRoundedFrom = obs.slice(1).find((o: { value: string }) => {
            const r = round025(parseFloat(o.value) + 0.05);
            return r !== rounded;
          });
          const priorRounded = priorRoundedFrom ? round025(parseFloat(priorRoundedFrom.value) + 0.05) : rounded;
          formattedActual   = `${rounded.toFixed(2)}%`;
          formattedPrevious = `${priorRounded.toFixed(2)}%`;
          pctChange = rounded - priorRounded;
        } else if (s.type === "yoy_pct") {
          // y/y % from 12 months ago (Case-Shiller HPI y/y)
          const v12 = obs.length >= 13 ? parseFloat(obs[12].value) : (v2 ?? v1);
          const yoy = ((v0 - v12) / Math.abs(v12)) * 100;
          formattedActual   = `${sign(yoy)}${yoy.toFixed(1)}%`;
          formattedPrevious = obs.length >= 14 ? (() => {
            const vPrior = parseFloat(obs[1].value);
            const v13 = parseFloat(obs[13].value);
            const yoyPrior = ((vPrior - v13) / Math.abs(v13)) * 100;
            return `${sign(yoyPrior)}${yoyPrior.toFixed(1)}%`;
          })() : "—";
          pctChange = yoy;
        } else if (s.type === "level_count_k") {
          // Initial Claims (ICSA): raw count → divide by 1000, format K
          const k     = Math.round(v0 / 1000);
          const prevK = Math.round(v1 / 1000);
          formattedActual   = `${k}K`;
          formattedPrevious = `${prevK}K`;
          pctChange = k - prevK;
        } else if (s.type === "level_native_k") {
          // PERMIT/HOUST: value already in thousands. Format as "1.37M" if > 1000K else "850K"
          const fmt = (v: number) => v >= 1000 ? `${(v/1000).toFixed(2)}M` : `${Math.round(v)}K`;
          formattedActual   = fmt(v0);
          formattedPrevious = fmt(v1);
          pctChange = ((v0 - v1) / v1) * 100;
        } else if (s.type === "level_billions") {
          // BOPGSTB: value in millions → format as "$-57.3B"
          const b     = v0 / 1000;
          const prevB = v1 / 1000;
          formattedActual   = `${b < 0 ? "-" : ""}$${Math.abs(b).toFixed(1)}B`;
          formattedPrevious = `${prevB < 0 ? "-" : ""}$${Math.abs(prevB).toFixed(1)}B`;
          pctChange = b - prevB;
        } else if (s.type === "level_index") {
          // UMCSENT: index value as-is
          formattedActual   = v0.toFixed(1);
          formattedPrevious = v1.toFixed(1);
          pctChange = v0 - v1;
        } else {
          // pct_change: index/level → m/m %
          pctChange         = ((v0 - v1) / Math.abs(v1)) * 100;
          const prevPct     = v2 != null ? ((v1 - v2) / Math.abs(v2)) * 100 : 0;
          formattedActual   = `${sign(pctChange)}${pctChange.toFixed(1)}%`;
          formattedPrevious = `${sign(prevPct)}${prevPct.toFixed(1)}%`;
        }

        console.log(`[FRED KEY] ${s.name}: ${formattedActual} (${obs[0].date})`);
        results.push({
          seriesId: s.fredId, name: s.name,
          year: String(d.getUTCFullYear()), period,
          value: v0, prevValue: v1,
          change: v0 - v1, pctChange, unit: s.unit, impact: s.impact,
          formattedActual, formattedPrevious,
        });
      } catch { clearTimeout(timeout); }
    })
  );

  return results;
}

// ─── Public: fetch BLS data (BLS + FRED race) + Census data ──────────────────

/**
 * Bypass the BLS data cache so the next fetchBLSData() call
 * fetches fresh data from BLS + FRED + Census + extras.
 * Called by the FOMC sniper during the 14:00 ET release window.
 */
export function bypassBLSCache() {
  cache.delete("bls_data");
}

// Disk persistence for the BLS aggregate (BLS+FRED+Census+extras = 4 parallel races).
// Cold-start hit can be 3-5s otherwise. Disk cache stays useful up to 6h
// (BLS data points usually have a multi-day natural lag, so 6h staleness is fine).
import { readFileSync as _read, writeFileSync as _write } from "fs";
const BLS_DISK_CACHE = "/tmp/uigen_cache_bls_data.json";
function loadBlsDiskCache(): BLSDataPoint[] | null {
  try {
    const raw = _read(BLS_DISK_CACHE, "utf8");
    const parsed = JSON.parse(raw) as { ts: number; data: BLSDataPoint[] };
    if (Date.now() - parsed.ts < 6 * 3600_000) return parsed.data;
  } catch { /* no disk cache */ }
  return null;
}
function saveBlsDiskCache(data: BLSDataPoint[]): void {
  try { _write(BLS_DISK_CACHE, JSON.stringify({ ts: Date.now(), data })); } catch { /* ignore */ }
}

export async function fetchBLSData(): Promise<BLSDataPoint[]> {
  const cacheKey = "bls_data";
  const cached = getCached<BLSDataPoint[]>(cacheKey, 30_000);
  if (cached) return cached;

  // Cold start — try disk cache to avoid 3-5s of parallel API races
  if (!cache.has(cacheKey)) {
    const fromDisk = loadBlsDiskCache();
    if (fromDisk && fromDisk.length > 0) {
      console.log(`[BLS/FRED] disk cache hit: ${fromDisk.length} series`);
      setCache(cacheKey, fromDisk);
      // Kick off background refresh so next call sees fresh data
      _refreshBlsInBackground();
      return fromDisk;
    }
  }

  const year = new Date().getFullYear();
  const group = getTodaysReleaseGroup();

  // Race BLS API and FRED in parallel — first with new data wins.
  // BLS wins in practice (234ms, 1 call for all 7 series) vs FRED (745ms, 7 calls).
  // FRED is the fallback when BLS daily limit is hit.
  // Census data (Retail Sales) fetched in parallel — FRED CSV, no key required.
  const [blsResult, fredResult, censusResult, extraResult] = await Promise.allSettled([
    fetchBLSGroup(group, year),
    fetchFREDGroup(group),
    fetchCensusData(),
    fetchFREDExtraData(), // ADP, Pending Home Sales, Business Inventories, Core PCE
  ]);

  let results: BLSDataPoint[] = [];
  if (blsResult.status === "fulfilled" && blsResult.value.length > 0) {
    results = blsResult.value;
    console.log(`[BLS/FRED] BLS: ${results.length} series in ~234ms`);
  } else if (fredResult.status === "fulfilled" && fredResult.value.length > 0) {
    results = fredResult.value;
    console.log(`[BLS/FRED] FRED fallback: ${results.length} series`);
  } else {
    const stale = getCached<BLSDataPoint[]>(cacheKey, Infinity);
    if (stale) return stale;
    console.warn("[BLS/FRED] Both sources failed");
    return [];
  }

  // Census CSV series (Retail Sales, Durable Goods, New Home Sales) — always merged
  if (censusResult.status === "fulfilled" && censusResult.value.length > 0) {
    const existing = new Set(results.map(r => r.name));
    const fresh = censusResult.value.filter(r => !existing.has(r.name));
    results = [...results, ...fresh];
    console.log(`[CENSUS CSV] +${fresh.length} series (${fresh.map(s => s.name).join(", ")})`);
  }

  // FRED key series (ADP, Pending Home Sales, Business Inventories, Core PCE)
  if (extraResult.status === "fulfilled" && extraResult.value.length > 0) {
    const existing = new Set(results.map(r => r.name));
    const fresh = extraResult.value.filter(r => !existing.has(r.name));
    results = [...results, ...fresh];
    if (fresh.length > 0) console.log(`[FRED KEY] +${fresh.length} extra series (${fresh.map(s => s.name).join(", ")})`);
  }

  setCache(cacheKey, results);
  saveBlsDiskCache(results); // persist for cold-start next time
  return results;
}

// Background refresh — used when serving disk cache on cold start
let _blsRefreshing = false;
async function _refreshBlsInBackground(): Promise<void> {
  if (_blsRefreshing) return;
  _blsRefreshing = true;
  try {
    cache.delete("bls_data");
    await fetchBLSData();
  } catch { /* ignore */ }
  finally { _blsRefreshing = false; }
}

// ─── Release Sniper ───────────────────────────────────────────────────────────
// Polls at 1s intervals during release windows.
// Races BLS + FRED simultaneously — whoever detects the new period first fires.

interface SniperState {
  active: boolean;
  lastKnownPeriod: string;
  timer: ReturnType<typeof setInterval> | null;
  onUpdate: (data: BLSDataPoint[]) => void;
}

const sniperState: SniperState = {
  active: false,
  lastKnownPeriod: "",
  timer: null,
  onUpdate: () => {},
};

export function startReleaseSniperIfNeeded(onUpdate: (data: BLSDataPoint[]) => void) {
  sniperState.onUpdate = onUpdate;

  const now = new Date();
  const etOffset = isEDT(now) ? -4 : -5;
  const etNow = new Date(now.getTime() + etOffset * 3600_000);
  const etHour = etNow.getUTCHours();
  const etMin  = etNow.getUTCMinutes();
  const etSec  = etNow.getUTCSeconds();

  const isNearRelease = BLS_SERIES.some((s) => {
    const secUntil = (s.releaseHourET - etHour) * 3600 + (s.releaseMinET - etMin) * 60 - etSec;
    return secUntil >= -120 && secUntil <= 30;
  });

  if (!isNearRelease || sniperState.active) return;

  console.log("[SNIPER] 🎯 Release window — polling BLS+FRED every 1s");
  sniperState.active = true;

  // Seed lastKnownPeriod so we can detect the flip
  fetchBLSData().then((data) => {
    if (data.length > 0) sniperState.lastKnownPeriod = `${data[0].year}-${data[0].period}`;
  });

  sniperState.timer = setInterval(async () => {
    // ONLY race BLS + FRED for the 7 high-impact series. Don't bypass the
    // full bls_data cache here — that would force re-fetch of all 21 FRED
    // extras every 1s and blow past the 120/min rate limit.
    const year = new Date().getFullYear();
    const group = getTodaysReleaseGroup();

    // Race BLS + FRED simultaneously at 1s.
    // BLS wins ~234ms (1 call), FRED is fallback at ~745ms (7 calls).
    const [blsR, fredR] = await Promise.allSettled([
      fetchBLSGroup(group, year),
      fetchFREDGroup(group),
    ]);

    const candidates = [
      blsR.status  === "fulfilled" && blsR.value.length  > 0 ? blsR.value  : null,
      fredR.status === "fulfilled" && fredR.value.length > 0 ? fredR.value : null,
    ].filter((d): d is BLSDataPoint[] => d !== null);

    for (const fresh of candidates) {
      const newPeriod = `${fresh[0].year}-${fresh[0].period}`;
      if (newPeriod !== sniperState.lastKnownPeriod && sniperState.lastKnownPeriod !== "") {
        console.log(`[SNIPER] 🎯 NEW DATA: ${sniperState.lastKnownPeriod} → ${newPeriod}`);
        sniperState.lastKnownPeriod = newPeriod;
        // Now do ONE full refresh — bypass cache and re-fetch ALL series
        // (BLS + FRED + Census + 21 extras) so cache stays complete.
        cache.delete("bls_data");
        const fullData = await fetchBLSData().catch(() => fresh);
        sniperState.onUpdate(fullData);
        break; // first winner fires, stop checking others
      }
    }

    // Auto-stop 2min past window
    const etOff = isEDT(new Date()) ? -4 : -5;
    const et2 = new Date(Date.now() + etOff * 3600_000);
    const stillNear = BLS_SERIES.some(s => {
      const sec = (s.releaseHourET - et2.getUTCHours()) * 3600 + (s.releaseMinET - et2.getUTCMinutes()) * 60;
      return sec >= -120 && sec <= 30;
    });
    if (!stillNear) {
      console.log("[SNIPER] Window passed — stopping");
      stopReleaseSniperIfActive();
    }
  }, 1_000); // 1s — was 2s
}

export function stopReleaseSniperIfActive() {
  if (sniperState.timer) { clearInterval(sniperState.timer); sniperState.timer = null; }
  sniperState.active = false;
}

// ─── Merge BLS actuals into FF calendar ──────────────────────────────────────

export function mergeBLSActualsIntoCalendar(
  events: EconomicEvent[],
  blsData: BLSDataPoint[]
): EconomicEvent[] {
  if (blsData.length === 0) return events;

  const now = Date.now();
  // Keep actuals visible for the full week — events happened Mon can still show actuals Fri.
  // 7 days covers the entire ForexFactory weekly calendar window.
  const SEVEN_DAYS = 7 * 24 * 3600_000;

  return events.map((event) => {
    if (event.source !== "ForexFactory") return event;

    const releaseTime = new Date(event.time).getTime();
    if (now < releaseTime) return event;              // event hasn't happened yet
    if (now - releaseTime > SEVEN_DAYS) return event; // older than one week — skip

    const nameLower = event.event.toLowerCase();
    const match = blsData.find((bls) => {
      const b = bls.name.toLowerCase();
      // ── BLS direct series ────────────────────────────────────────────────────
      if (nameLower.includes("core cpi") && b.includes("core cpi")) return true;
      if ((nameLower === "cpi m/m" || nameLower.startsWith("cpi m/")) && b === "cpi m/m") return true;
      if (nameLower.includes("core ppi") && b.includes("core ppi")) return true;
      if ((nameLower.startsWith("ppi m/") || nameLower === "ppi m/m") && b === "ppi m/m") return true;
      if ((nameLower.includes("non-farm") || nameLower.includes("nonfarm")) && !nameLower.includes("adp") && b.includes("non-farm")) return true;
      if (nameLower.includes("unemployment rate") && event.currency === "USD" && b.includes("unemployment")) return true;
      if (nameLower.includes("average hourly earnings") && b.includes("avg hourly")) return true;
      // ── Census FRED CSV (no key needed) ─────────────────────────────────────
      if ((nameLower === "retail sales m/m" || nameLower.startsWith("retail sales m/")) && b === "retail sales m/m") return true;
      if ((nameLower.includes("core retail") || nameLower.includes("retail sales ex")) && b.includes("core retail")) return true;
      if ((nameLower.includes("durable goods") || nameLower.includes("durables")) && b.includes("durable goods")) return true;
      if (nameLower.includes("new home sales") && b.includes("new home sales")) return true;
      // ── FRED API key series (ADP, NAR, Census MTIS, BEA) ────────────────────
      if (nameLower.includes("adp") && b.includes("adp")) return true;
      if (nameLower.includes("pending home sales") && b.includes("pending home")) return true;
      if (nameLower.includes("business inventories") && b.includes("business inventories")) return true;
      if (nameLower.includes("wholesale inventories") && b.includes("wholesale inventories")) return true;
      if ((nameLower.includes("core pce") || nameLower === "pce price index m/m") && b.includes("core pce")) return true;
      // FOMC Federal Funds Rate — match the headline event AND FOMC Statement
      if ((nameLower === "federal funds rate" || nameLower.includes("fomc statement")) && b === "federal funds rate") return true;
      // BEA GDP Price Index (deflator) — match must include "gdp" on BOTH sides to avoid PCE collision
      if (nameLower.includes("gdp") && nameLower.includes("price index") && b.includes("gdp") && b.includes("price index")) return true;
      // BEA Advance/Prelim/Final GDP q/q (same FRED series, gets revised) — exclude price index
      if ((nameLower.includes("advance gdp") || nameLower.includes("prelim gdp") || nameLower.includes("final gdp") || nameLower === "gdp q/q")
          && !nameLower.includes("price index")
          && b === "advance gdp q/q") return true;
      // BLS Employment Cost Index q/q
      if (nameLower.includes("employment cost index") && b.includes("employment cost index")) return true;
      // DOL Initial Jobless Claims (weekly Thu 8:30 ET)
      if ((nameLower === "unemployment claims" || nameLower.includes("initial claims") || nameLower.includes("jobless claims")) && b === "unemployment claims") return true;
      // BEA Personal Income / Personal Spending m/m
      if (nameLower === "personal income m/m" && b === "personal income m/m") return true;
      if ((nameLower === "personal spending m/m" || nameLower.includes("personal consumption")) && b === "personal spending m/m") return true;
      // Census Building Permits / Housing Starts
      if (nameLower === "building permits" && b === "building permits") return true;
      if (nameLower === "housing starts" && b === "housing starts") return true;
      // Census Goods Trade Balance
      if ((nameLower === "goods trade balance" || nameLower.includes("trade balance")) && b === "goods trade balance") return true;
      // S&P/Cotality Case-Shiller HPI y/y (also matches generic "HPI m/m" with caveat)
      if ((nameLower.includes("composite-20") || nameLower.includes("case-shiller") || nameLower === "hpi y/y") && b.includes("composite-20")) return true;
      // CB Consumer Confidence (we substitute UMCSENT — closely correlated)
      if ((nameLower.includes("consumer confidence") || nameLower.includes("consumer sentiment")) && b.includes("consumer confidence")) return true;
      // BOE Official Bank Rate (proxy via SONIA rounded to nearest 0.25%)
      // Exclude "Votes" event which shows MPC vote split (e.g., "8-1"), not the rate
      if ((nameLower === "official bank rate" || (nameLower.includes("bank rate") && !nameLower.includes("vote")))
          && event.currency === "GBP" && b === "official bank rate") return true;
      // Census Factory Orders m/m
      if ((nameLower === "factory orders m/m" || nameLower === "factory orders") && b === "factory orders m/m") return true;
      // EIA Crude Oil Inventories — matched separately via fetchOilInventory injection
      return false;
    });

    if (!match) return event;

    // Period sanity check — daily series (Fed Funds Rate, SONIA) and weekly series
    // (Initial Claims) skip this entirely because they publish near event time.
    const skipPeriodCheckIds = ["DFEDTARU", "DFEDTARL", "DFF", "IUDSOIA", "ICSA"];
    if (!skipPeriodCheckIds.includes(match.seriesId)) {
      // Allow up to 2-month lag for monthly releases:
      //   1-month lag: CPI/PPI/Retail Sales (Apr release = Mar data)
      //   2-month lag: Business Inventories, Durable Goods (Apr release = Feb data)
      const eventDate = new Date(event.time);
      const expectedDataMonth = eventDate.getUTCMonth() - 1; // 0-indexed
      const blsMonth = parseInt(match.period.replace("M", ""), 10) - 1; // 0-indexed
      const lag = ((expectedDataMonth - blsMonth) + 12) % 12; // handles year boundary
      if (lag > 2) return event;
    }

    const censusCsvIds  = ["RSAFS", "RSXFS", "DGORDER", "HSN1F"];
    const fredKeyIds    = ["ADPMNUSNERSA", "BUSINV", "WHLSLRIMSA", "PCEPILFE", "PHSI", "DFEDTARU", "A191RL1Q225SBEA", "A191RI1Q225SBEA", "ECIALLCIV",
                           "ICSA", "PI", "PCE", "PERMIT", "HOUST", "BOPGSTB", "SPCS20RSA", "UMCSENT", "IUDSOIA", "AMTMNO"];
    const sourceLabel   = censusCsvIds.includes(match.seriesId) ? "Census (FRED)"
                        : fredKeyIds.includes(match.seriesId)   ? "FRED (keyed)"
                        : "BLS (direct)";
    return { ...event, actual: match.formattedActual, previous: match.formattedPrevious, source: sourceLabel };
  });
}

// ─── ONS UK data ─────────────────────────────────────────────────────────────

export interface ONSDataPoint {
  seriesId: string;
  name: string;
  latestValue: string;
  latestDate: string;
  currency: "GBP";
  unit: string;
  impact: "high" | "medium" | "low";
}

const ONS_SERIES = [
  { id: "IHYQ", dataset: "pgdp", name: "UK GDP m/m",          unit: "%", impact: "high"   as const },
  { id: "D7G7", dataset: "mm23", name: "UK CPI m/m",           unit: "%", impact: "high"   as const },
  { id: "LF24", dataset: "lms",  name: "UK Unemployment Rate", unit: "%", impact: "high"   as const },
];

export async function fetchONSData(): Promise<ONSDataPoint[]> {
  const cached = getCached<ONSDataPoint[]>("ons_data", 300_000);
  if (cached) return cached;

  const results: ONSDataPoint[] = [];
  await Promise.allSettled(
    ONS_SERIES.map(async (series) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);
      try {
        const res = await fetch(
          `https://api.ons.gov.uk/timeseries/${series.id}/dataset/${series.dataset}/data`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (!res.ok) return;
        const data = await res.json() as { months?: Array<{ date: string; value: string }> };
        const pts = data.months ?? [];
        const latest = pts[pts.length - 1];
        if (!latest) return;
        results.push({ seriesId: series.id, name: series.name, latestValue: latest.value, latestDate: latest.date, currency: "GBP", unit: series.unit, impact: series.impact });
      } catch { clearTimeout(timeout); }
    })
  );

  if (results.length > 0) setCache("ons_data", results);
  return results;
}

// ─── EDT helper ───────────────────────────────────────────────────────────────

function isEDT(date: Date): boolean {
  const year = date.getUTCFullYear();
  const start = nthSunday(year, 2, 2);
  const end   = nthSunday(year, 10, 1);
  return date.getTime() >= start && date.getTime() < end;
}

function nthSunday(year: number, month: number, n: number): number {
  const d = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (count < n) {
    if (d.getUTCDay() === 0) count++;
    if (count < n) d.setUTCDate(d.getUTCDate() + 1);
  }
  d.setUTCHours(7, 0, 0, 0);
  return d.getTime();
}

// ─── BST (British Summer Time) helper ────────────────────────────────────────
// BST: last Sunday of March 01:00 UTC → last Sunday of October 01:00 UTC
// BST = UTC+1, GMT = UTC+0

function isBST(date: Date): boolean {
  const year = date.getUTCFullYear();
  const start = lastSundayOfMonth(year, 2, 1);  // March (month0=2)
  const end   = lastSundayOfMonth(year, 9, 1);  // October (month0=9)
  return date.getTime() >= start && date.getTime() < end;
}

function lastSundayOfMonth(year: number, month0: number, utcHour: number): number {
  // month0: 0-based month index (2=March, 9=October)
  const d = new Date(Date.UTC(year, month0 + 1, 0)); // day 0 of next month = last day of this month
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.getTime();
}

// ─── UK Release Window Detection ─────────────────────────────────────────────
// ONS data:    07:00 BST → 06:00 UTC (summer) / 07:00 UTC (winter)
// BOE rate:    12:00 BST → 11:00 UTC (summer) / 12:00 UTC (winter)
// Sniper fires 30s before → 2 min after release time.

interface UKWindowCheck {
  near: boolean;
  windowName: string;
}

function isNearUKReleaseWindow(): UKWindowCheck {
  const now = new Date();
  const summer = isBST(now);
  const utcTotalSec =
    now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();

  const windows = [
    { utcHour: summer ? 6 : 7,  utcMin: 0, name: "ONS 7:00 BST" },
    { utcHour: summer ? 11 : 12, utcMin: 0, name: "BOE 12:00 BST" },
  ];

  for (const w of windows) {
    const windowSec = w.utcHour * 3600 + w.utcMin * 60;
    const diff = utcTotalSec - windowSec; // negative = before, positive = after
    // Window: 30s before release → 15 min after (ForexFactory can take up to 10 min to post actuals)
    if (diff >= -30 && diff <= 900) {
      return { near: true, windowName: w.name };
    }
  }
  return { near: false, windowName: "" };
}

// ─── ForexFactory direct fetch (no cache) for UK sniper ──────────────────────
// Called every 5s during UK release windows. Uses stable IDs so we can
// detect the moment an event flips from actual="" to actual="X.X%".

interface FFRawUK {
  title: string;
  country: string;
  date: string;
  impact: string;
  forecast: string;
  previous: string;
  actual?: string;
}

async function fetchFFForSniper(): Promise<EconomicEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(
      "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
      {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.forexfactory.com/",
          "Origin": "https://www.forexfactory.com",
        },
        cache: "no-store",
      }
    );
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`FF ${res.status}`);

    const raw: FFRawUK[] = await res.json();
    return raw
      .filter(e => e.country === "GBP")
      .map(e => ({
        // Stable ID: title+date so sniper can track across fetches
        id: `ff-uk-${e.title.replace(/\s+/g, "_")}-${e.date}`,
        time: new Date(e.date).toISOString(),
        currency: "GBP" as const,
        impact: (() => {
          const l = e.impact.toLowerCase();
          if (l === "high") return "high" as const;
          if (l === "medium") return "medium" as const;
          return "low" as const;
        })(),
        event: e.title,
        forecast: e.forecast || undefined,
        previous: e.previous || undefined,
        actual: e.actual || undefined,
        source: "ForexFactory" as const,
      }));
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

// ─── UK Release Sniper ────────────────────────────────────────────────────────
// Strategy: poll ForexFactory JSON every 5s during UK release windows.
// ForexFactory is the fastest free UK data source — updates ~15-30s after ONS/BOE.
// Watch for high-impact GBP events flipping from actual="" to actual="X.X%".
//
// Why not ONS direct? api.ons.gov.uk is deprecated (all 404).
// Why not FRED UK?    FRED UK series stale by months (not suitable for sniper).
// Why not BOE direct? Checked separately below; FF covers rate decisions too.

interface UKSniperState {
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastKnownActuals: Map<string, string>; // stableId → actual value
  onUpdate: () => void;
}

const ukSniperState: UKSniperState = {
  active: false,
  timer: null,
  lastKnownActuals: new Map(),
  onUpdate: () => {},
};

export async function startUKSniperIfNeeded(onNewData: () => void) {
  ukSniperState.onUpdate = onNewData;

  const check = isNearUKReleaseWindow();
  if (!check.near || ukSniperState.active) return;

  console.log(`[UK SNIPER] 🎯 ${check.windowName} — polling FF every 5s`);
  ukSniperState.active = true;

  // Seed: record which GBP events already have actuals before the release
  // so we don't re-fire for already-released data from earlier today.
  try {
    const seed = await fetchFFForSniper();
    for (const e of seed) {
      if (e.actual) ukSniperState.lastKnownActuals.set(e.id, e.actual);
    }
    console.log(`[UK SNIPER] Seeded ${ukSniperState.lastKnownActuals.size} existing actuals`);
  } catch { /* continue without seed */ }

  ukSniperState.timer = setInterval(async () => {
    try {
      const events = await fetchFFForSniper();
      let newActualFound = false;

      for (const e of events) {
        if (!e.actual) continue;
        if (ukSniperState.lastKnownActuals.has(e.id)) continue; // already tracked
        if (e.impact !== "high") continue; // only high-impact triggers immediate push

        // 🎯 New actual for a high-impact GBP event!
        console.log(`[UK SNIPER] 🎯 NEW: ${e.event} actual=${e.actual}`);
        ukSniperState.lastKnownActuals.set(e.id, e.actual);
        newActualFound = true;
      }

      if (newActualFound) {
        ukSniperState.onUpdate();
      }
    } catch (err) {
      console.warn("[UK SNIPER] Poll failed:", err);
    }

    // Auto-stop once 15 min past window (isNearUKReleaseWindow already checks 900s)
    if (!isNearUKReleaseWindow().near) {
      console.log("[UK SNIPER] Window passed (15 min) — stopping");
      stopUKSniperIfActive();
    }
  }, 5_000);
}

export function stopUKSniperIfActive() {
  if (ukSniperState.timer) { clearInterval(ukSniperState.timer); ukSniperState.timer = null; }
  ukSniperState.active = false;
  ukSniperState.lastKnownActuals.clear();
}
