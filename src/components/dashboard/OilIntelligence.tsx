"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { TruthSocialPost, HormuzUpdate, OilInventory } from "@/lib/types";
import { Fuel, Ship, BarChart3, MessageCircle } from "lucide-react";
import { Sparkline } from "./Sparkline";

interface Props {
  truthSocial: TruthSocialPost[];
  hormuz: HormuzUpdate | null;
  oilInventory: OilInventory | null;
  trumpSignalActive?: boolean;
  trumpSignalPhrase?: boolean;
  eiaSniperActive?: boolean;     // EIA Wed 10:30 ET sniper firing
  eiaSniperLastFire?: { period: string; crudeBuild: number; isDraw: boolean; detectionLagSec?: number } | null;
}

export function OilIntelligence({ truthSocial, hormuz, oilInventory, trumpSignalActive, trumpSignalPhrase, eiaSniperActive, eiaSniperLastFire }: Props) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
        <Fuel className="w-4 h-4 text-amber-400" />
        <h2 className="text-sm font-semibold tracking-wide uppercase">
          Oil Intelligence
        </h2>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {/* Hormuz Strait Monitor */}
          <HormuzPanel data={hormuz} />

          {/* EIA Inventory */}
          <InventoryPanel data={oilInventory} eiaSniperActive={eiaSniperActive} eiaSniperLastFire={eiaSniperLastFire} />

          {/* Trump posts — DIRECT from Truth Social via trumpstruth.org mirror */}
          {/* Strict keyword filter: oil / Iran / Hormuz only */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <MessageCircle className="w-3.5 h-3.5 text-purple-400" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                @realDonaldTrump
              </h3>
              <span className="text-[9px] text-muted-foreground font-mono ml-1">Truth Social · oil/iran filter</span>

              {/* Trump Signal badge — lights up when a Hormuz/oil post is detected */}
              {trumpSignalActive ? (
                <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider animate-pulse ml-1 ${
                  trumpSignalPhrase
                    ? "bg-red-500/30 text-red-300"      // signature phrase = highest confidence
                    : "bg-orange-500/20 text-orange-300" // Hormuz keyword match
                }`}>
                  {trumpSignalPhrase ? "🔴 SIGNAL" : "⚡ NEW POST"}
                </span>
              ) : null}

              <span className="ml-auto flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-bullish animate-pulse-live" />
                <span className="text-[10px] text-muted-foreground">30s</span>
              </span>
            </div>
            <div className="space-y-2">
              {truthSocial.length === 0 ? (
                <div className="rounded-lg border border-border bg-card p-3 text-center space-y-2">
                  <p className="text-xs text-muted-foreground">
                    No recent posts on oil / Iran / Hormuz from @realDonaldTrump
                  </p>
                  <a
                    href="https://truthsocial.com/@realDonaldTrump"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block text-[11px] font-mono px-3 py-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    Open Truth Social →
                  </a>
                </div>
              ) : (
                truthSocial.map((post) => (
                  <TruthSocialCard key={post.id} post={post} />
                ))
              )}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function HormuzPanel({ data }: { data: HormuzUpdate | null }) {
  if (!data) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Ship className="w-3.5 h-3.5 text-cyan-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Hormuz Risk · Brent Crude
          </h3>
        </div>
        <div className="text-xs text-muted-foreground py-2">Loading Brent/WTI prices…</div>
      </div>
    );
  }

  const trendIcon = data.trend === "up" ? "▲" : data.trend === "down" ? "▼" : "—";
  const trendColor =
    data.trend === "up" ? "text-bearish" : data.trend === "down" ? "text-bullish" : "text-muted-foreground";

  // Brent series for the chart — daily updates from FRED (real, not static)
  const brentSeries = data.history?.map(h => h.brent) || [];
  const brentLabels = data.history?.map(h => h.date) || [];
  const latestDate  = data.history?.[data.history.length - 1]?.date || "";
  const minBrent    = brentSeries.length > 0 ? Math.min(...brentSeries) : 0;
  const maxBrent    = brentSeries.length > 0 ? Math.max(...brentSeries) : 0;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Ship className="w-3.5 h-3.5 text-cyan-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Hormuz Risk · Brent Crude
        </h3>
        <span className="text-[9px] text-muted-foreground font-mono ml-1">
          {data.id === "hormuz-yahoo" ? "Yahoo · ~15min lag"
            : data.id === "hormuz-stooq" ? "Stooq · live"
            : data.id === "hormuz-fred" ? "FRED · 1-3d lag"
            : "live"}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-bullish animate-pulse-live" />
          <span className="text-[10px] text-muted-foreground">{latestDate || "LIVE"}</span>
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-2">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Brent</div>
          <div className="text-lg font-bold font-mono text-amber-300">
            ${data.brentSpot?.toFixed(2) || "—"}
          </div>
          {data.brentChangePct != null && (
            <div className={`text-[10px] font-mono ${data.brentChangePct >= 0 ? "text-bearish" : "text-bullish"}`}>
              {data.brentChangePct >= 0 ? "+" : ""}{data.brentChangePct.toFixed(2)}%
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">WTI</div>
          <div className="text-lg font-bold font-mono">${data.wtiSpot?.toFixed(2) || "—"}</div>
          <div className="text-[10px] text-muted-foreground">
            spread ${((data.brentSpot ?? 0) - (data.wtiSpot ?? 0)).toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Trend</div>
          <div className={`text-lg font-bold font-mono ${trendColor}`}>
            {trendIcon} {data.trend}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {data.dailyFlowMbpd} mbpd avg
          </div>
        </div>
      </div>
      {/* 30-day Brent history — actual daily updates */}
      {brentSeries.length > 1 && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wider">30-day Brent</span>
            <span className="text-[9px] text-muted-foreground font-mono">
              ${minBrent.toFixed(0)} – ${maxBrent.toFixed(0)}
            </span>
          </div>
          <Sparkline data={brentSeries} labels={brentLabels} mode="line" lineColor="rgb(251, 191, 36)" width={280} height={42}
            valueFormat={(n) => `$${n.toFixed(2)}`} />
        </div>
      )}
      {data.alerts.length > 0 && (
        <div className="mt-2 space-y-1">
          {data.alerts.map((alert, i) => (
            <div key={i} className="text-xs text-impact-high bg-impact-high/10 rounded px-2 py-1">
              {alert}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InventoryPanel({ data, eiaSniperActive, eiaSniperLastFire }: {
  data: OilInventory | null;
  eiaSniperActive?: boolean;
  eiaSniperLastFire?: { period: string; crudeBuild: number; isDraw: boolean; detectionLagSec?: number } | null;
}) {
  // Show a placeholder card even when data is loading — never silently render nothing
  if (!data) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <BarChart3 className="w-3.5 h-3.5 text-orange-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            EIA Crude Inventory
          </h3>
          <span className="text-[9px] text-muted-foreground font-mono ml-1">weekly · Wed 10:30 ET</span>
        </div>
        <div className="text-xs text-muted-foreground py-2">Loading EIA data…</div>
      </div>
    );
  }

  const isDraw = data.crudeBuild < 0;
  const isBiggerThanExpected = Math.abs(data.crudeBuild) > Math.abs(data.forecast);

  // Build the next-update countdown — EIA releases Wed 10:30 ET
  const latestPeriod = data.history?.[data.history.length - 1]?.period || data.timestamp.slice(0, 10);
  const buildSeries  = data.history?.map(h => h.build) || [];
  const buildLabels  = data.history?.map(h => h.period) || [];

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <BarChart3 className="w-3.5 h-3.5 text-orange-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {data.source} Crude Inventory
        </h3>
        <span className="text-[9px] text-muted-foreground font-mono ml-1">weekly · Wed 10:30 ET</span>
        {eiaSniperActive && (
          <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider animate-pulse ml-1 ${
            eiaSniperLastFire ? (eiaSniperLastFire.isDraw ? "bg-bullish/30 text-bullish" : "bg-bearish/30 text-bearish") : "bg-orange-500/20 text-orange-300"
          }`}>
            ⚡ LIVE EIA{eiaSniperLastFire ? ` ${eiaSniperLastFire.isDraw ? "DRAW" : "BUILD"} ${eiaSniperLastFire.crudeBuild >= 0 ? "+" : ""}${eiaSniperLastFire.crudeBuild}M${eiaSniperLastFire.detectionLagSec != null ? ` · ${eiaSniperLastFire.detectionLagSec}s` : ""}` : ""}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground font-mono">{latestPeriod}</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Actual</div>
          <div className={`text-lg font-bold font-mono ${isDraw ? "text-bullish" : "text-bearish"}`}>
            {data.crudeBuild > 0 ? "+" : ""}{data.crudeBuild}M
          </div>
          <div className="text-[10px] text-muted-foreground">
            {isDraw ? "DRAW" : "BUILD"} {isBiggerThanExpected ? "⚠️" : ""}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Forecast</div>
          <div className="text-lg font-mono text-muted-foreground">
            {data.forecast > 0 ? "+" : ""}{data.forecast}M
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase">Previous</div>
          <div className="text-lg font-mono text-muted-foreground">
            {data.previous > 0 ? "+" : ""}{data.previous}M
          </div>
        </div>
      </div>
      {/* History bar chart — last 12 weekly builds. Red = build (bearish for oil), Green = draw (bullish) */}
      {buildSeries.length > 1 && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] text-muted-foreground uppercase tracking-wider">12-week build/draw</span>
            <span className="text-[9px] font-mono">
              <span className="text-bearish">build</span> · <span className="text-bullish">draw</span>
            </span>
          </div>
          <Sparkline data={buildSeries} labels={buildLabels} mode="bars" width={280} height={48}
            positiveColor="rgb(239, 68, 68)" negativeColor="rgb(34, 197, 94)"
            valueFormat={(n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}M bbl`} />
        </div>
      )}
    </div>
  );
}

function TruthSocialCard({ post }: { post: TruthSocialPost }) {
  const timeAgo = getTimeAgo(post.timestamp);
  const exactTime = formatExactTime(post.timestamp);
  const isWH = post.url?.includes("whitehouse.gov");
  const isRepost = post.content.startsWith("🔁");
  const isSignal = post.content.includes("TRUMP SIGNAL");
  const isTSPost = post.content.includes("Truth Social") || post.content.includes("TRUMP SIGNAL");

  // Extract clean content (strip the prefix line we added server-side)
  const lines = post.content.split("\n");
  const prefixLine = lines[0];
  const cleanContent = lines.length > 1 ? lines.slice(1).join("\n") : post.content;

  return (
    <div className={`rounded-lg border bg-card p-3 hover:bg-muted/30 transition-colors ${
      isSignal
        ? "border-red-500/50 bg-red-950/20"
        : isTSPost && post.relevanceKeywords.length > 0
        ? "border-orange-500/40"
        : post.relevanceKeywords.length > 0
        ? "border-amber-500/30"
        : "border-border"
    }`}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-[10px] text-muted-foreground font-mono"
            title={`Posted ${new Date(post.timestamp).toLocaleString()}`}
          >
            <span className="text-foreground/80">{exactTime}</span>
            <span className="ml-1 opacity-60">· {timeAgo}</span>
          </span>
          {isSignal && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/30 text-red-300 font-bold uppercase">
              🔴 TRUMP SIGNAL
            </span>
          )}
          {!isSignal && isTSPost && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">
              Truth Social
            </span>
          )}
          {isWH && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono">
              WH.gov
            </span>
          )}
          {isRepost && (
            <span className="text-[9px] text-muted-foreground">repost</span>
          )}
        </div>
        <div className="flex gap-1 flex-wrap justify-end">
          {post.relevanceKeywords.slice(0, 3).map((kw) => (
            <span
              key={kw}
              className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono uppercase"
            >
              {kw}
            </span>
          ))}
        </div>
      </div>
      {/* Show source label as subtitle if it's a TS post with prefix */}
      {lines.length > 1 && (
        <p className="text-[10px] text-muted-foreground mb-1">{prefixLine}</p>
      )}
      <p className="text-xs leading-relaxed text-secondary-foreground whitespace-pre-line">
        {cleanContent}
      </p>
      {post.url && (
        <a
          href={post.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-primary hover:underline mt-1.5 inline-block"
        >
          {isWH ? "Read on whitehouse.gov →" : isTSPost ? "View source →" : "Read article →"}
        </a>
      )}
    </div>
  );
}

/**
 * Formats the exact wall-clock time of the post in the viewer's local TZ.
 * Today: "14:23:47"  | Yesterday or older: "May 5 14:23:47"
 */
function formatExactTime(timestamp: string): string {
  const d = new Date(timestamp);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  if (sameDay) return time;
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date} ${time}`;
}

function getTimeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 10)  return `just now`;
  if (seconds < 60)  return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  // For posts under 5 min, show "Xm Ys" precision so traders see the live edge
  if (minutes < 5)   return `${minutes}m ${seconds % 60}s ago`;
  if (minutes < 60)  return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
