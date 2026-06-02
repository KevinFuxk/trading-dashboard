"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { MoversData, MarketMover } from "@/lib/types";
import { TrendingUp, TrendingDown, Flame, Activity } from "lucide-react";

/**
 * Premarket / Intraday Movers panel.
 *
 * Shows 3 sections with quality-filtered stocks (market cap ≥ $2B, vol ≥ 500K):
 *   🚀 GAINERS — top % up
 *   📉 LOSERS  — top % down
 *   🔥 ACTIVE  — most volume
 *
 * Market state badge: PRE / REGULAR / POST / CLOSED
 *
 * Each ticker shows: symbol, % move (colored), $price, volume, market cap.
 * Click ticker → opens Yahoo Finance page in new tab.
 */
export function MoversPanel({ data }: { data: MoversData | null }) {
  if (!data) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Activity className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold tracking-wide uppercase">Premarket Movers</h2>
        </div>
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Loading screener data…
        </div>
      </div>
    );
  }

  const stateLabel =
    data.marketState === "PRE"     ? "Pre-Market"    :
    data.marketState === "REGULAR" ? "Live"          :
    data.marketState === "POST"    ? "After-Hours"   :
                                     "Closed";
  const stateColor =
    data.marketState === "PRE"     ? "bg-amber-500/20 text-amber-300" :
    data.marketState === "REGULAR" ? "bg-bullish/20  text-bullish animate-pulse" :
    data.marketState === "POST"    ? "bg-purple-500/20 text-purple-300" :
                                     "bg-muted text-muted-foreground";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
        <Activity className="w-4 h-4 text-cyan-400" />
        <h2 className="text-sm font-semibold tracking-wide uppercase">Premarket Movers</h2>
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${stateColor}`}>
          {stateLabel}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground font-mono">
          ≥$2B cap · ≥500K vol · ≥2% move
        </span>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          <Section title="GAINERS" icon={<TrendingUp className="w-3.5 h-3.5 text-bullish" />} movers={data.gainers} positive />
          <Section title="LOSERS"  icon={<TrendingDown className="w-3.5 h-3.5 text-bearish" />} movers={data.losers}  positive={false} />
          <Section title="MOST ACTIVE" icon={<Flame className="w-3.5 h-3.5 text-orange-400" />} movers={data.active} />
        </div>
      </ScrollArea>
    </div>
  );
}

function Section({
  title, icon, movers, positive,
}: { title: string; icon: React.ReactNode; movers: MarketMover[]; positive?: boolean }) {
  if (movers.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-1.5 mb-2">
          {icon}
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        </div>
        <div className="text-[11px] text-muted-foreground italic">
          No strong movers right now (no stocks ≥$2B cap with ≥2% move).
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/30">
        {icon}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        <span className="ml-auto text-[10px] text-muted-foreground">{movers.length}</span>
      </div>
      <div className="divide-y divide-border/40">
        {movers.map(m => <MoverRow key={m.symbol} mover={m} positive={positive} />)}
      </div>
    </div>
  );
}

function MoverRow({ mover, positive }: { mover: MarketMover; positive?: boolean }) {
  // Use premarket % when available (pre/post hours), else regular % change
  const pct = mover.preMarketChangePct ?? mover.changePct;
  const isUp = positive ?? pct >= 0;
  const arrow = isUp ? "▲" : "▼";
  const color = isUp ? "text-bullish" : "text-bearish";

  const volMillions = (mover.volume / 1e6).toFixed(1);
  const capLabel =
    mover.marketCap == null ? "" :
    mover.marketCap >= 1e12 ? `${(mover.marketCap / 1e12).toFixed(1)}T` :
    mover.marketCap >= 1e9  ? `${(mover.marketCap / 1e9).toFixed(1)}B` :
    `${(mover.marketCap / 1e6).toFixed(0)}M`;

  // Highlight unusually high relative volume
  const rvol = mover.avgVolume ? mover.volume / mover.avgVolume : 0;
  const isHotVolume = rvol > 1.5;

  return (
    <a
      href={`https://finance.yahoo.com/quote/${encodeURIComponent(mover.symbol)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="grid grid-cols-[60px_1fr_72px_60px_60px] gap-2 items-center px-3 py-1.5 text-xs hover:bg-muted/40 transition-colors"
      title={`${mover.name}${mover.sector ? ` · ${mover.sector}` : ""}${mover.exchange ? ` · ${mover.exchange}` : ""}`}
    >
      <span className="font-mono font-bold text-foreground truncate">{mover.symbol}</span>
      <span className="truncate text-muted-foreground text-[11px]">{mover.name}</span>
      <span className={`font-mono font-bold text-right ${color}`}>
        {arrow} {Math.abs(pct).toFixed(2)}%
      </span>
      <span className="font-mono text-right text-foreground">${mover.price.toFixed(2)}</span>
      <span className={`font-mono text-right text-[10px] ${isHotVolume ? "text-orange-300 font-bold" : "text-muted-foreground"}`}
            title={isHotVolume ? `Volume ${rvol.toFixed(1)}× avg — unusual activity` : ""}>
        {volMillions}M
        {isHotVolume && " 🔥"}
        {capLabel && <span className="block text-[9px] opacity-60">{capLabel}</span>}
      </span>
    </a>
  );
}
