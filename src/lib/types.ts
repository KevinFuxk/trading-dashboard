// ===== Economic Calendar =====
export type ImpactLevel = "high" | "medium" | "low";
export type Currency = "USD" | "GBP" | "EUR" | "ALL";

export interface EconomicEvent {
  id: string;
  time: string;        // ISO string
  currency: Currency;
  impact: ImpactLevel;
  event: string;
  actual?: string;
  forecast?: string;
  previous?: string;
  source?: string;     // e.g. "BLS", "BOE", "Fed"
}

// ===== Oil Intelligence =====
export interface TruthSocialPost {
  id: string;
  content: string;
  timestamp: string;
  url?: string;
  relevanceKeywords: string[];  // matched keywords
}

export interface HormuzUpdate {
  id: string;
  timestamp: string;
  // EIA chokepoint estimate (static unless EIA publishes new monthly data — rare)
  tankerCount: number;
  dailyFlowMbpd: number;  // million barrels per day
  // FRED daily crude prices (the best free proxy for Hormuz tension — updates every trading day)
  brentSpot?: number;
  wtiSpot?: number;
  brentChangePct?: number;
  trend: "up" | "down" | "stable";
  alerts: string[];
  history?: { date: string; brent: number; wti: number }[];  // last 30 trading days
}

export interface OilInventory {
  id: string;
  source: "EIA" | "API";
  timestamp: string;
  crudeBuild: number;     // in million barrels, positive = build
  forecast: number;
  previous: number;
  history?: { period: string; build: number }[];  // last 12 weeks of m/m changes
}

// ===== News Feed =====
export interface NewsItem {
  id: string;
  title: string;
  summary?: string;
  source: string;
  url: string;
  timestamp: string;
  category: "fed" | "boe" | "opec" | "geopolitical" | "macro" | "oil";
  isBreaking?: boolean;
}

// ===== Premarket / Intraday Movers =====
export type MoverCategory = "gainers" | "losers" | "active";
export interface MarketMover {
  symbol: string;             // e.g. "NVDA"
  name: string;               // e.g. "NVIDIA Corporation"
  price: number;              // current/last price
  change: number;             // absolute $ change
  changePct: number;          // % change vs prev close
  volume: number;             // shares traded today
  avgVolume?: number;         // 3-month avg daily volume
  marketCap?: number;         // in dollars
  sector?: string;            // e.g. "Technology"
  exchange?: string;          // NYSE, NASDAQ
  weekPerf?: number;          // 5-day % perf
  monthPerf?: number;         // 1-month % perf
  preMarketChangePct?: number;  // premarket-specific % move (when available)
}

export interface MoversData {
  asOf: string;               // ISO timestamp
  marketState: "PRE" | "REGULAR" | "POST" | "CLOSED";
  gainers: MarketMover[];
  losers: MarketMover[];
  active: MarketMover[];
}

// ===== FX & Commodity Ticker (header strip) =====
export interface FXQuote {
  symbol: string;       // e.g. "GBPUSD", "BRENT"
  display: string;      // e.g. "GBP/USD", "Brent"
  price: number;
  change: number;       // absolute daily change
  changePct: number;    // % daily change
  asOf: string;         // ISO timestamp of the quote
}

// ===== Alerts =====
export type AlertType = "event_imminent" | "data_release" | "deviation" | "keyword" | "breaking";
export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: string;
  dismissed: boolean;
  relatedEventId?: string;
}

// ===== SSE Stream =====
export type StreamEventType =
  | "economic_calendar"
  | "truth_social"
  | "hormuz"
  | "oil_inventory"
  | "news"
  | "alert"
  | "heartbeat";

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  timestamp: string;
}
