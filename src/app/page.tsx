"use client";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { EconomicCalendar } from "@/components/dashboard/EconomicCalendar";
import { OilIntelligence } from "@/components/dashboard/OilIntelligence";
import { NewsFeed } from "@/components/dashboard/NewsFeed";
import { StatusBar } from "@/components/dashboard/StatusBar";
import { useDashboardStream } from "@/hooks/use-dashboard-stream";
import { useEffect, useState } from "react";

export default function Dashboard() {
  const {
    calendar,
    truthSocial,
    hormuz,
    oilInventory,
    news,
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
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card shrink-0">
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
          <span className="px-2 py-0.5 rounded bg-muted">
            {calendar.length} events
          </span>
          <span className="px-2 py-0.5 rounded bg-muted">
            {news.length} headlines
          </span>
          <span className="px-2 py-0.5 rounded bg-muted">
            {alerts.filter((a) => !a.dismissed).length} alerts
          </span>
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

          {/* Bottom row — News Feed full width (alerts removed per user request) */}
          <ResizablePanel defaultSize={45} minSize={20}>
            <NewsFeed news={news} alerts={alerts} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Status Bar */}
      <StatusBar connected={connected} lastUpdate={lastUpdate} />
    </div>
  );
}
