"use client";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { EconomicCalendar } from "@/components/dashboard/EconomicCalendar";
import { OilIntelligence } from "@/components/dashboard/OilIntelligence";
import { NewsFeed } from "@/components/dashboard/NewsFeed";
import { MoversPanel } from "@/components/dashboard/MoversPanel";
import { StatusBar } from "@/components/dashboard/StatusBar";
import { TickerStrip } from "@/components/dashboard/TickerStrip";
import { NextReleaseCountdown } from "@/components/dashboard/NextReleaseCountdown";
import { useDashboardStream } from "@/hooks/use-dashboard-stream";
import { useEffect, useState } from "react";

export default function Dashboard() {
  const {
    calendar,
    truthSocial,
    hormuz,
    oilInventory,
    news,
    fx,
    movers,
    alerts,
    connected,
    lastUpdate,
    sniperActive,
    ukSniperActive,
    trumpSignalActive,
    trumpSignalPhrase,
    fomcSniperActive,
    fomcRateChange,
    releaseSniperState,
    eiaSniperActive,
    eiaSniperLastFire,
  } = useDashboardStream();

  // Live clock tick for StatusBar
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar — Row 1: brand + counters | Row 2: live ticker + next-release countdown */}
      <header className="flex flex-col border-b border-border bg-card shrink-0">
        {/* Row 1: brand + summary counts */}
        <div className="flex items-center justify-between px-4 py-1.5">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-primary animate-pulse-live" />
            <h1 className="text-sm font-bold tracking-wider uppercase font-mono">
              Trading Intelligence
            </h1>
            <span className="text-[10px] text-muted-foreground font-mono px-2 py-0.5 rounded bg-muted">
              GBPUSD / OIL
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono">
            <span className="px-2 py-0.5 rounded bg-muted">{calendar.length} events</span>
            <span className="px-2 py-0.5 rounded bg-muted">{news.length} headlines</span>
            <span className="px-2 py-0.5 rounded bg-muted">{alerts.filter((a) => !a.dismissed).length} alerts</span>
          </div>
        </div>
        {/* Row 2: live FX/crude ticker on the left, next-release countdown on the right */}
        <div className="flex items-center justify-between gap-4 px-4 py-1.5 border-t border-border/40 bg-muted/20 overflow-x-auto">
          <TickerStrip quotes={fx} />
          <NextReleaseCountdown events={calendar} />
        </div>
      </header>

      {/* 4-Panel Dashboard */}
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="vertical">
          {/* Top row */}
          <ResizablePanel defaultSize={55} minSize={30}>
            <ResizablePanelGroup direction="horizontal">
              {/* Economic Calendar */}
              <ResizablePanel defaultSize={55} minSize={25}>
                <EconomicCalendar
                  events={calendar}
                  sniperActive={sniperActive}
                  ukSniperActive={ukSniperActive}
                  fomcSniperActive={fomcSniperActive}
                  fomcRateChange={fomcRateChange}
                  releaseSniperState={releaseSniperState}
                />
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Oil Intelligence */}
              <ResizablePanel defaultSize={45} minSize={25}>
                <OilIntelligence
                  truthSocial={truthSocial}
                  hormuz={hormuz}
                  oilInventory={oilInventory}
                  trumpSignalActive={trumpSignalActive}
                  trumpSignalPhrase={trumpSignalPhrase}
                  eiaSniperActive={eiaSniperActive}
                  eiaSniperLastFire={eiaSniperLastFire}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle withHandle />

          {/* Bottom row — News Feed (left) + Premarket Movers (right) */}
          <ResizablePanel defaultSize={45} minSize={20}>
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel defaultSize={60} minSize={30}>
                <NewsFeed news={news} alerts={alerts} />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={40} minSize={25}>
                <MoversPanel data={movers} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Status Bar */}
      <StatusBar connected={connected} lastUpdate={lastUpdate} />
    </div>
  );
}
