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
