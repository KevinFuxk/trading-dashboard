"use client";

import { useEffect, useState } from "react";
import type { EconomicEvent } from "@/lib/types";

/**
 * Countdown chip — shows the NEXT high-impact event and time remaining.
 * Updates every second. Pulses red when <5 minutes away (sniper window).
 */
export function NextReleaseCountdown({ events }: { events: EconomicEvent[] }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  void tick;

  const now = Date.now();
  const next = events
    .filter((e) => e.impact === "high" && new Date(e.time).getTime() > now)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())[0];

  if (!next) {
    return (
      <span className="text-[10px] text-muted-foreground font-mono">
        No high-impact events scheduled
      </span>
    );
  }

  const msUntil = new Date(next.time).getTime() - now;
  const hrs = Math.floor(msUntil / 3600_000);
  const mins = Math.floor((msUntil % 3600_000) / 60_000);
  const secs = Math.floor((msUntil % 60_000) / 1000);
  const isImminent = msUntil < 5 * 60_000;        // <5 min — sniper armed
  const isUpcoming = msUntil < 30 * 60_000;       // <30 min — orange warning

  const timeStr =
    hrs > 0 ? `${hrs}h ${mins}m`
    : mins > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s`
    : `${secs}s`;

  return (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono whitespace-nowrap ${
      isImminent ? "bg-impact-high/20 text-impact-high animate-pulse" :
      isUpcoming ? "bg-impact-medium/20 text-impact-medium" :
      "bg-muted text-muted-foreground"
    }`}>
      <span className="text-[9px] uppercase opacity-70">Next</span>
      <span className={`font-bold ${next.currency === "USD" ? "text-green-400" : "text-blue-400"}`}>
        {next.currency}
      </span>
      <span className="font-semibold">{next.event}</span>
      <span className="opacity-70">in</span>
      <span className="font-bold tabular-nums">{timeStr}</span>
    </div>
  );
}
