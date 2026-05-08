"use client";

import { Wifi, WifiOff, Clock } from "lucide-react";

interface Props {
  connected: boolean;
  lastUpdate: string | null;
}

export function StatusBar({ connected, lastUpdate }: Props) {
  const now = new Date();
  const utcTime = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const etTime = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/New_York",
  });
  const londonTime = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Europe/London",
  });

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-card border-t border-border text-[10px] font-mono text-muted-foreground">
      <div className="flex items-center gap-4">
        {/* Connection status */}
        <div className="flex items-center gap-1.5">
          {connected ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-bullish animate-pulse-live" />
              <Wifi className="w-3 h-3 text-bullish" />
              <span className="text-bullish">CONNECTED</span>
            </>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-bearish" />
              <WifiOff className="w-3 h-3 text-bearish" />
              <span className="text-bearish">DISCONNECTED</span>
            </>
          )}
        </div>

        {/* Last update */}
        {lastUpdate && (
          <span>
            Last update: {new Date(lastUpdate).toLocaleTimeString("en-US", { hour12: false })}
          </span>
        )}
      </div>

      {/* Multi-timezone clocks */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          <span>UTC {utcTime}</span>
        </div>
        <span>ET {etTime}</span>
        <span>LON {londonTime}</span>
      </div>
    </div>
  );
}
