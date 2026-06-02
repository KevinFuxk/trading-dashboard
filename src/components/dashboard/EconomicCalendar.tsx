"use client";

import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { EconomicEvent, Currency } from "@/lib/types";
import { Clock, Filter } from "lucide-react";

interface Props {
  events: EconomicEvent[];
  sniperActive?: boolean;    // true when US sniper is firing at BLS (8:30 ET)
  ukSniperActive?: boolean;  // true when UK sniper just detected new GBP actuals
  fomcSniperActive?: boolean; // true when FOMC sniper firing (14:00 ET FOMC day)
  fomcRateChange?: { old: string; new: string; direction: "HIKE" | "CUT" | "HOLD" } | null;
  releaseSniperState?: "hot" | "warm" | "idle";
}

export function EconomicCalendar({ events, sniperActive, ukSniperActive, fomcSniperActive, fomcRateChange, releaseSniperState }: Props) {
  const [filter, setFilter] = useState<Currency | "ALL">("ALL");

  const filtered = useMemo(() => {
    if (filter === "ALL") return events;
    return events.filter((e) => e.currency === filter);
  }, [events, filter]);

  // Group events by date
  const grouped = useMemo(() => {
    const groups = new Map<string, EconomicEvent[]>();
    for (const event of filtered) {
      const date = new Date(event.time).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const existing = groups.get(date) || [];
      existing.push(event);
      groups.set(date, existing);
    }
    return groups;
  }, [filtered]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            Economic Calendar
          </h2>
          {fomcSniperActive ? (
            <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider animate-pulse ${
              fomcRateChange?.direction === "HIKE" ? "bg-bearish/30 text-bearish"
              : fomcRateChange?.direction === "CUT"  ? "bg-bullish/30 text-bullish"
              : "bg-yellow-500/20 text-yellow-300"
            }`}>
              ⚡ LIVE FOMC{fomcRateChange ? ` ${fomcRateChange.direction} → ${fomcRateChange.new}` : ""}
            </span>
          ) : sniperActive ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-impact-high/20 text-impact-high text-[9px] font-bold uppercase tracking-wider animate-pulse">
              ⚡ LIVE BLS
            </span>
          ) : ukSniperActive ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[9px] font-bold uppercase tracking-wider animate-pulse">
              ⚡ LIVE ONS
            </span>
          ) : releaseSniperState === "hot" ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 text-[9px] font-bold uppercase tracking-wider animate-pulse">
              ⚡ HOT · 5s poll
            </span>
          ) : releaseSniperState === "warm" ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-300 text-[9px] font-mono uppercase">
              warm · 15s
            </span>
          ) : (
            <span className="text-[9px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted">
              BLS direct · idle
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Filter className="w-3 h-3 text-muted-foreground" />
          {(["ALL", "USD", "GBP"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`px-2 py-0.5 text-xs rounded font-mono transition-colors ${
                filter === c
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Table Header */}
      <div className="grid grid-cols-[56px_34px_36px_1fr_56px_56px_56px] gap-2 px-4 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-border shrink-0">
        <span>Time</span>
        <span>Ccy</span>
        <span>Imp</span>
        <span>Event</span>
        <span className="text-right">Actual</span>
        <span className="text-right">Fcst</span>
        <span className="text-right">Prev</span>
      </div>

      {/* Events */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="divide-y divide-border/50">
          {Array.from(grouped.entries()).map(([date, dayEvents]) => (
            <div key={date}>
              {/* Date header */}
              <div className="px-4 py-1.5 bg-muted/50 text-xs font-semibold text-muted-foreground">
                {date}
              </div>
              {/* Events for this date */}
              {dayEvents.map((event) => (
                <CalendarRow key={event.id} event={event} />
              ))}
            </div>
          ))}
          {events.length === 0 && (
            <div className="px-4 py-8 text-center space-y-1">
              <div className="text-muted-foreground text-sm">Calendar source unavailable</div>
              <div className="text-[10px] text-muted-foreground font-mono">Retrying ForexFactory — check back in 60s</div>
            </div>
          )}
          {events.length > 0 && filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-muted-foreground text-sm">
              No events for selected filter
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function CalendarRow({ event }: { event: EconomicEvent }) {
  const now = Date.now();
  const eventTime = new Date(event.time).getTime();
  const isPast = eventTime < now;
  const isImminent = !isPast && eventTime - now < 30 * 60_000;

  const time = new Date(event.time).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const impactColor = {
    high: "bg-impact-high",
    medium: "bg-impact-medium",
    low: "bg-impact-low",
  }[event.impact];

  // Compute surprise (actual vs forecast) — drives BEAT/MISS badge + color intensity
  const surprise = (() => {
    if (!event.actual || !event.forecast) return null;
    const a = parseFloat(event.actual.replace(/[%KMB+,]/g, ""));
    const f = parseFloat(event.forecast.replace(/[%KMB+,]/g, ""));
    if (isNaN(a) || isNaN(f)) return null;
    const diff = a - f;
    const denom = Math.max(Math.abs(f), 0.05);  // avoid div-by-zero on 0% forecasts
    const pct = (diff / denom) * 100;
    return { diff, pct, beat: diff > 0, miss: diff < 0 };
  })();
  const hasDeviation = surprise && Math.abs(surprise.pct) > 15;
  const isBigSurprise = surprise && Math.abs(surprise.pct) > 50;

  return (
    <div
      className={`grid grid-cols-[56px_34px_36px_1fr_56px_56px_56px] gap-2 px-4 py-1.5 text-xs items-center transition-colors hover:bg-muted/30 ${
        isImminent ? "bg-impact-high/5 border-l-2 border-l-impact-high" : ""
      } ${isPast ? "opacity-60" : ""}`}
    >
      {/* Time */}
      <span className={`font-mono ${isImminent ? "text-impact-high font-bold" : "text-muted-foreground"}`}>
        {time}
      </span>

      {/* Currency */}
      <span
        className={`font-mono font-bold ${
          event.currency === "USD" ? "text-green-400" : "text-blue-400"
        }`}
      >
        {event.currency}
      </span>

      {/* Impact dots */}
      <div className="flex gap-0.5">
        <span className={`w-2 h-2 rounded-full ${impactColor}`} />
        {event.impact !== "low" && (
          <span className={`w-2 h-2 rounded-full ${impactColor}`} />
        )}
        {event.impact === "high" && (
          <span className={`w-2 h-2 rounded-full ${impactColor}`} />
        )}
      </div>

      {/* Event name + surprise badge inline */}
      <span className={`truncate flex items-center gap-1.5 ${event.impact === "high" ? "font-semibold text-foreground" : "text-secondary-foreground"}`}>
        <span className="truncate">{event.event}</span>
        {surprise && hasDeviation && (
          <span
            className={`shrink-0 text-[8px] px-1 py-0.5 rounded font-bold uppercase tracking-wider ${
              surprise.beat ? "bg-bullish/20 text-bullish" : "bg-bearish/20 text-bearish"
            } ${isBigSurprise ? "animate-pulse" : ""}`}
            title={`${surprise.beat ? "Beat" : "Miss"} forecast by ${Math.abs(surprise.pct).toFixed(0)}%`}
          >
            {surprise.beat ? "▲ BEAT" : "▼ MISS"}{isBigSurprise ? " ⚡" : ""}
          </span>
        )}
      </span>

      {/* Actual — green flash if sourced directly from BLS (no FF delay) */}
      <span
        className={`text-right font-mono ${
          hasDeviation
            ? "text-impact-high font-bold"
            : event.actual && event.source === "BLS (direct)"
            ? "text-bullish font-bold"
            : event.actual
            ? "text-foreground"
            : "text-muted-foreground"
        }`}
        title={event.source === "BLS (direct)" ? "Live from BLS.gov — no middleman" : undefined}
      >
        {event.actual || "—"}
      </span>

      {/* Forecast */}
      <span className="text-right font-mono text-muted-foreground">
        {event.forecast || "—"}
      </span>

      {/* Previous */}
      <span className="text-right font-mono text-muted-foreground">
        {event.previous || "—"}
      </span>
    </div>
  );
}
