"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type {
  EconomicEvent,
  TruthSocialPost,
  HormuzUpdate,
  OilInventory,
  NewsItem,
  Alert,
} from "@/lib/types";
import type { BLSDataPoint } from "@/lib/gov-calendar";

interface DashboardState {
  calendar: EconomicEvent[];
  truthSocial: TruthSocialPost[];
  hormuz: HormuzUpdate | null;
  oilInventory: OilInventory | null;
  news: NewsItem[];
  alerts: Alert[];
  connected: boolean;
  lastUpdate: string | null;
  blsActuals: BLSDataPoint[];      // live BLS data — shown as "direct from govt"
  sniperActive: boolean;            // true when US sniper is hammering BLS at release time
  ukSniperActive: boolean;          // true when UK sniper just fired (ForexFactory 5s polling)
  trumpSignalActive: boolean;       // true when Trump signal detected (Hormuz/signature phrase)
  trumpSignalPhrase: boolean;       // true if the specific signature phrase was detected
  fomcSniperActive: boolean;        // true when FOMC sniper is firing (14:00 ET FOMC days)
  fomcRateChange: { old: string; new: string; direction: "HIKE" | "CUT" | "HOLD" } | null;
  releaseSniperState: "hot" | "warm" | "idle";  // adaptive release sniper state
  releaseSniperLastFire: { newActuals?: { event: string; actual: string; source?: string }[] } | null;
  eiaSniperActive: boolean;       // true when EIA crude oil sniper is firing (Wed 10:30 ET)
  eiaSniperLastFire: { period: string; crudeBuild: number; isDraw: boolean; detectionLagSec?: number } | null;
}

const INITIAL_STATE: DashboardState = {
  calendar: [],
  truthSocial: [],
  hormuz: null,
  oilInventory: null,
  news: [],
  alerts: [],
  connected: false,
  lastUpdate: null,
  blsActuals: [],
  sniperActive: false,
  ukSniperActive: false,
  trumpSignalActive: false,
  trumpSignalPhrase: false,
  fomcSniperActive: false,
  fomcRateChange: null,
  releaseSniperState: "idle",
  releaseSniperLastFire: null,
  eiaSniperActive: false,
  eiaSniperLastFire: null,
};

/**
 * Hook that connects to the SSE stream for push-based updates.
 * Falls back to polling if SSE connection fails.
 *
 * LATENCY IMPROVEMENTS:
 * - SSE push: data arrives as soon as the server fetches it (no polling delay)
 * - Stale-while-revalidate: shows cached data instantly, refreshes in background
 * - Single connection instead of 5 separate fetch loops
 */
export function useDashboardStream() {
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimersRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  // Merge incoming data into state
  const mergeData = useCallback((key: keyof DashboardState, data: unknown) => {
    setState((prev) => ({
      ...prev,
      [key]: data,
      lastUpdate: new Date().toISOString(),
    }));
  }, []);

  // Polling fallback — only used if SSE fails
  const fetchAndMerge = useCallback(async (
    endpoint: string,
    key: keyof DashboardState,
  ) => {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) return;
      const data = await res.json();
      mergeData(key, data);
    } catch (err) {
      console.warn(`[POLL] Failed to fetch ${endpoint}:`, err);
    }
  }, [mergeData]);

  // Generate alerts from calendar events
  const generateAlerts = useCallback((calendar: EconomicEvent[]): Alert[] => {
    const now = Date.now();
    const alerts: Alert[] = [];

    for (const event of calendar) {
      const eventTime = new Date(event.time).getTime();
      const minutesUntil = (eventTime - now) / 60_000;

      // Alert for high-impact events within 30 minutes
      if (event.impact === "high" && minutesUntil > 0 && minutesUntil <= 30) {
        alerts.push({
          id: `alert-${event.id}`,
          type: "event_imminent",
          severity: minutesUntil <= 5 ? "critical" : "warning",
          title: `${event.currency} ${event.event}`,
          message: `High-impact event in ${Math.round(minutesUntil)} min`,
          timestamp: new Date().toISOString(),
          dismissed: false,
          relatedEventId: event.id,
        });
      }

      // Alert for big deviations (actual vs forecast)
      // Only fire if: event is from ForexFactory (real schedule) AND
      // actual was provided by FF itself — not something we injected from BLS.
      // BLS-merged actuals use source "BLS (direct)" which is correct data
      // but the forecast field still comes from FF and comparison could be off.
      const isFFActual = event.source === "ForexFactory" || event.source === "BLS (direct)";
      const eventAge = now - new Date(event.time).getTime();
      const isRecentRelease = eventAge > 0 && eventAge < 2 * 3600_000; // released within 2h
      if (event.actual && event.forecast && isFFActual && isRecentRelease) {
        const actual = parseFloat(event.actual.replace(/[%KMB+]/g, ""));
        const forecast = parseFloat(event.forecast.replace(/[%KMB+]/g, ""));
        if (!isNaN(actual) && !isNaN(forecast) && Math.abs(forecast) > 0) {
          const deviation = Math.abs(actual - forecast);
          const threshold = Math.abs(forecast) * 0.2; // 20% deviation
          if (deviation > threshold && deviation > 0.1) {
            alerts.push({
              id: `dev-${event.id}`,
              type: "deviation",
              severity: "critical",
              title: `${event.currency} ${event.event} DEVIATION`,
              message: `Actual: ${event.actual} vs Forecast: ${event.forecast}`,
              timestamp: new Date().toISOString(),
              dismissed: false,
              relatedEventId: event.id,
            });
          }
        }
      }
    }

    return alerts;
  }, []);

  // Dismiss an alert
  const dismissAlert = useCallback((alertId: string) => {
    setState((prev) => ({
      ...prev,
      alerts: prev.alerts.map((a) =>
        a.id === alertId ? { ...a, dismissed: true } : a
      ),
    }));
  }, []);

  // Start polling fallback (used when SSE is unavailable)
  const startPolling = useCallback(() => {
    console.log("[DASHBOARD] Falling back to polling mode");
    // Fetch all data immediately
    fetchAndMerge("/api/economic-calendar", "calendar");
    fetchAndMerge("/api/oil-intel/truth-social", "truthSocial");
    fetchAndMerge("/api/oil-intel/hormuz", "hormuz");
    fetchAndMerge("/api/oil-intel/inventory", "oilInventory");
    fetchAndMerge("/api/news", "news");

    // Match server-side SWR TTLs so polling fallback isn't stale
    const timers = [
      setInterval(() => fetchAndMerge("/api/economic-calendar", "calendar"),       30_000),
      setInterval(() => fetchAndMerge("/api/oil-intel/truth-social", "truthSocial"), 10_000),
      setInterval(() => fetchAndMerge("/api/oil-intel/hormuz", "hormuz"),           90_000),  // was 30min ❌
      setInterval(() => fetchAndMerge("/api/oil-intel/inventory", "oilInventory"), 1_800_000), // weekly EIA, 30min OK
      setInterval(() => fetchAndMerge("/api/news", "news"),                          90_000),
    ];
    pollTimersRef.current = timers;
  }, [fetchAndMerge]);

  // Connect to SSE stream
  const connectSSE = useCallback(() => {
    // Clean up any existing connection
    eventSourceRef.current?.close();
    pollTimersRef.current.forEach(clearInterval);
    pollTimersRef.current = [];

    const es = new EventSource("/api/stream");
    eventSourceRef.current = es;

    es.onopen = () => {
      console.log("[SSE] Connected");
      setState((prev) => ({ ...prev, connected: true }));
      reconnectAttemptsRef.current = 0;
    };

    // Listen for each data type
    es.addEventListener("calendar", (e) => {
      mergeData("calendar", JSON.parse(e.data));
    });
    es.addEventListener("truthSocial", (e) => {
      mergeData("truthSocial", JSON.parse(e.data));
    });
    es.addEventListener("hormuz", (e) => {
      mergeData("hormuz", JSON.parse(e.data));
    });
    es.addEventListener("oilInventory", (e) => {
      mergeData("oilInventory", JSON.parse(e.data));
    });
    es.addEventListener("news", (e) => {
      mergeData("news", JSON.parse(e.data));
    });

    // BLS sniper events — fired the instant new US government data appears
    es.addEventListener("blsActuals", (e) => {
      const bls = JSON.parse(e.data) as BLSDataPoint[];
      setState((prev) => ({
        ...prev,
        blsActuals: bls,
        sniperActive: true,
        lastUpdate: new Date().toISOString(),
      }));
      // Clear US sniper badge after 10s
      setTimeout(() => {
        setState((prev) => ({ ...prev, sniperActive: false }));
      }, 10_000);
    });

    // UK sniper fired — new GBP actuals detected on ForexFactory
    es.addEventListener("ukSniperFired", () => {
      setState((prev) => ({
        ...prev,
        ukSniperActive: true,
        lastUpdate: new Date().toISOString(),
      }));
      setTimeout(() => {
        setState((prev) => ({ ...prev, ukSniperActive: false }));
      }, 15_000);
    });

    // Telegram — new oil-channel message arrived in real-time (sub-second)
    es.addEventListener("telegramMessage", (e) => {
      const msg = JSON.parse(e.data) as NewsItem;
      console.log(`[CLIENT] 📩 Telegram: ${msg.source} — ${msg.title.slice(0,80)}`);
      setState((prev) => ({
        ...prev,
        // Prepend the new message; dedup by id; cap at 50
        news: [msg, ...prev.news.filter(n => n.id !== msg.id)].slice(0, 50),
        lastUpdate: new Date().toISOString(),
      }));
    });

    // Adaptive Release Sniper — fires on state transitions and new actuals
    es.addEventListener("releaseSniperFired", (e) => {
      const data = JSON.parse(e.data) as {
        state?: "hot" | "warm" | "idle";
        newActuals?: { event: string; actual: string; source?: string }[];
      };
      if (data.newActuals?.length) {
        console.log("[CLIENT] 🎯 New release actuals:", data.newActuals.map(a => `${a.event}=${a.actual}`).join(", "));
      }
      setState((prev) => ({
        ...prev,
        releaseSniperState: data.state ?? prev.releaseSniperState,
        releaseSniperLastFire: data.newActuals?.length ? { newActuals: data.newActuals } : prev.releaseSniperLastFire,
        lastUpdate: new Date().toISOString(),
      }));
      // Auto-clear newActuals highlight after 30s so the UI doesn't stick
      if (data.newActuals?.length) {
        setTimeout(() => {
          setState((prev) => ({ ...prev, releaseSniperLastFire: null }));
        }, 30_000);
      }
    });

    // EIA Crude Oil Sniper — new weekly inventory detected (Wed 10:30 ET)
    es.addEventListener("eiaSniperFired", (e) => {
      const data = JSON.parse(e.data) as { period: string; crudeBuild: number; isDraw: boolean; detectionLagSec?: number };
      console.log(`[CLIENT] 🛢️ EIA: ${data.period} crude=${data.crudeBuild >= 0 ? "+" : ""}${data.crudeBuild}M (${data.isDraw ? "DRAW" : "BUILD"})${data.detectionLagSec != null ? ` — caught in ${data.detectionLagSec}s` : ""}`);
      setState((prev) => ({
        ...prev,
        eiaSniperActive: true,
        eiaSniperLastFire: { period: data.period, crudeBuild: data.crudeBuild, isDraw: data.isDraw, detectionLagSec: data.detectionLagSec },
        lastUpdate: new Date().toISOString(),
      }));
      setTimeout(() => {
        setState((prev) => ({ ...prev, eiaSniperActive: false }));
      }, 5 * 60_000);
    });

    // FOMC Sniper — new Fed Funds Rate detected (or HOLD confirmation)
    es.addEventListener("fomcSniperFired", (e) => {
      const data = JSON.parse(e.data) as { oldRate: string; newRate: string; direction: "HIKE" | "CUT" | "HOLD" };
      console.log(`[CLIENT] 🎯 FOMC ${data.direction}: ${data.oldRate} → ${data.newRate}`);
      setState((prev) => ({
        ...prev,
        fomcSniperActive: true,
        fomcRateChange: { old: data.oldRate, new: data.newRate, direction: data.direction },
        lastUpdate: new Date().toISOString(),
      }));
      // FOMC badge stays lit for 5 minutes (longest of all sniper badges
      // because FOMC is the highest-impact event of any release)
      setTimeout(() => {
        setState((prev) => ({ ...prev, fomcSniperActive: false }));
      }, 5 * 60_000);
    });

    // Trump Signal — new post detected containing Hormuz keywords or signature phrase
    es.addEventListener("trumpSignal", (e) => {
      const data = JSON.parse(e.data) as { isSignaturePhrase: boolean; preview: string };
      console.log("[CLIENT] 🔴 Trump Signal:", data.preview?.slice(0, 60));
      setState((prev) => ({
        ...prev,
        trumpSignalActive: true,
        trumpSignalPhrase: data.isSignaturePhrase,
        lastUpdate: new Date().toISOString(),
      }));
      // Keep badge active for 60s so you can see it even if away from screen
      setTimeout(() => {
        setState((prev) => ({ ...prev, trumpSignalActive: false, trumpSignalPhrase: false }));
      }, 60_000);
    });

    es.onerror = () => {
      console.warn("[SSE] Connection error");
      setState((prev) => ({ ...prev, connected: false }));
      es.close();
      eventSourceRef.current = null;

      // Exponential backoff reconnect: 1s, 2s, 4s, 8s, max 30s
      const attempts = reconnectAttemptsRef.current;
      const delay = Math.min(1000 * Math.pow(2, attempts), 30_000);
      reconnectAttemptsRef.current = attempts + 1;

      console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);

      // Fall back to polling while SSE is down
      if (attempts >= 2) {
        startPolling();
      }

      reconnectTimerRef.current = setTimeout(() => {
        pollTimersRef.current.forEach(clearInterval);
        pollTimersRef.current = [];
        connectSSE();
      }, delay);
    };
  }, [mergeData, startPolling]);

  // Main effect — connect on mount
  useEffect(() => {
    connectSSE();

    return () => {
      eventSourceRef.current?.close();
      pollTimersRef.current.forEach(clearInterval);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connectSSE]);

  // Re-generate alerts whenever calendar updates
  useEffect(() => {
    if (state.calendar.length > 0) {
      const newAlerts = generateAlerts(state.calendar);
      setState((prev) => ({
        ...prev,
        alerts: mergeAlerts(prev.alerts, newAlerts),
      }));
    }
  }, [state.calendar, generateAlerts]);

  // Alert timer — re-check every 60s for imminent events
  useEffect(() => {
    const timer = setInterval(() => {
      if (state.calendar.length > 0) {
        const newAlerts = generateAlerts(state.calendar);
        setState((prev) => ({
          ...prev,
          alerts: mergeAlerts(prev.alerts, newAlerts),
        }));
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, [state.calendar, generateAlerts]);

  return { ...state, dismissAlert };
}

function mergeAlerts(existing: Alert[], incoming: Alert[]): Alert[] {
  const map = new Map(existing.map((a) => [a.id, a]));
  for (const alert of incoming) {
    if (!map.has(alert.id)) {
      map.set(alert.id, alert);
    }
  }
  return Array.from(map.values())
    .filter((a) => !a.dismissed)
    .sort((a, b) => {
      const sevOrder = { critical: 0, warning: 1, info: 2 };
      return sevOrder[a.severity] - sevOrder[b.severity];
    });
}
