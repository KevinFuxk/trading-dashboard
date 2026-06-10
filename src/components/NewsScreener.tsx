"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNewsScreener } from "@/hooks/use-news-screener";
import { playAlphaChime, primeAlphaAlert, isMuted, setMuted } from "@/lib/alpha-alert";
import type { ScreenedHeadline } from "@/lib/news-screener";
import { Bell, BellOff, Circle, ExternalLink, Filter, Zap } from "lucide-react";

/**
 * Single-screen TIER 1 news terminal.
 *
 * Layout: full-page list, newest-on-top, color-coded by category.
 * Each row clicks through to the source article.
 * High-impact headlines play a chime (deduplicated per-session via localStorage).
 */

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  earnings:   { label: "EARNINGS",   color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" },
  guidance:   { label: "GUIDANCE",   color: "bg-cyan-500/20    text-cyan-300    border-cyan-500/40"    },
  ma:         { label: "M&A",        color: "bg-violet-500/20  text-violet-300  border-violet-500/40"  },
  fda:        { label: "FDA",        color: "bg-pink-500/20    text-pink-300    border-pink-500/40"    },
  regulatory: { label: "REGULATORY", color: "bg-amber-500/20   text-amber-300   border-amber-500/40"   },
  csuite:     { label: "C-SUITE",    color: "bg-purple-500/20  text-purple-300  border-purple-500/40"  },
  corporate:  { label: "CORPORATE",  color: "bg-blue-500/20    text-blue-300    border-blue-500/40"    },
  contracts:  { label: "CONTRACT",   color: "bg-teal-500/20    text-teal-300    border-teal-500/40"    },
  analyst:    { label: "ANALYST",    color: "bg-slate-500/20   text-slate-300   border-slate-500/40"   },
  shortseller:{ label: "SHORT RPT",  color: "bg-red-500/20     text-red-300     border-red-500/40"     },
};

export function NewsScreener() {
  const [muted, setMutedState] = useState(false);
  const [filterCat, setFilterCat] = useState<string | null>(null);

  // Sync mute state from localStorage on mount + prime audio context
  useEffect(() => {
    setMutedState(isMuted());
    primeAlphaAlert();
  }, []);

  // High-impact callback — plays chime
  const handleHighImpact = useCallback((h: ScreenedHeadline) => {
    if (!isMuted()) playAlphaChime(0.25);
    // Try desktop notification too (best-effort, silent if denied)
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(`🔔 ${h.ticker} — ${h.categories.join(", ")}`, {
          body: h.title.slice(0, 200),
          tag: h.id,
        });
      }
    } catch { /* ignore */ }
  }, []);

  const { headlines, connected, lastUpdate, newestId } = useNewsScreener(handleHighImpact);

  // Filter by category if user selected one
  const visible = useMemo(() => {
    if (!filterCat) return headlines;
    return headlines.filter(h => h.categories.includes(filterCat));
  }, [headlines, filterCat]);

  // Cap at 100 visible (older auto-drop)
  const display = visible.slice(0, 100);

  const highImpactCount = headlines.filter(h => h.isHighImpact).length;
  const lastUpdateLabel = lastUpdate ? new Date(lastUpdate).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-border bg-card px-4 py-2 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Circle className={`w-2 h-2 ${connected ? "fill-bullish text-bullish animate-pulse" : "fill-bearish text-bearish"}`} />
          <h1 className="text-sm font-bold tracking-wider uppercase font-mono">
            High-Signal News
          </h1>
          <span className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted">
            S&P 500 + NDX 100
          </span>
          <span className="text-[10px] text-muted-foreground font-mono px-1.5 py-0.5 rounded bg-muted">
            TIER 1 only
          </span>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground font-mono ml-auto">
          <span>
            <span className="font-bold text-foreground">{headlines.length}</span> headlines
          </span>
          {highImpactCount > 0 && (
            <span className="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
              🔔 {highImpactCount} HIGH-IMPACT
            </span>
          )}
          <span>updated {lastUpdateLabel}</span>
          <span>Finviz · 5s polling</span>

          <button
            onClick={() => {
              const next = !muted;
              setMutedState(next);
              setMuted(next);
              if (!next) playAlphaChime(0.15);
            }}
            className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted/40 transition-colors"
            title={muted ? "Sound muted — click to enable" : "Sound on — click to mute"}
          >
            {muted ? <BellOff className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
          </button>
        </div>
      </header>

      {/* ── Category filter row ─────────────────────────────────── */}
      <div className="shrink-0 px-4 py-1.5 border-b border-border/40 bg-muted/20 flex items-center gap-1.5 flex-wrap overflow-x-auto">
        <Filter className="w-3 h-3 text-muted-foreground shrink-0" />
        <button
          onClick={() => setFilterCat(null)}
          className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wider transition-colors ${
            filterCat === null ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          ALL ({headlines.length})
        </button>
        {Object.entries(CATEGORY_LABELS).map(([cat, { label }]) => {
          const count = headlines.filter(h => h.categories.includes(cat)).length;
          if (count === 0) return null;
          return (
            <button
              key={cat}
              onClick={() => setFilterCat(filterCat === cat ? null : cat)}
              className={`text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wider transition-colors ${
                filterCat === cat ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      {/* ── Headlines list ───────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {display.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-2">
            <div className="text-3xl opacity-30">📭</div>
            <div className="text-sm">No TIER 1 headlines{filterCat ? ` in ${CATEGORY_LABELS[filterCat]?.label ?? filterCat}` : ""} yet</div>
            <div className="text-xs">Polling Finviz every 5s — they appear here automatically</div>
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {display.map(h => (
              <HeadlineRow key={h.id} headline={h} isNewest={h.id === newestId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HeadlineRow({ headline, isNewest }: { headline: ScreenedHeadline; isNewest: boolean }) {
  const time = new Date(headline.timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const ageMin = Math.floor((Date.now() - new Date(headline.timestamp).getTime()) / 60_000);
  const ageLabel = ageMin < 1 ? "now" : ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin/60)}h${ageMin%60}m`;

  return (
    <li className={`group px-4 py-2 transition-colors ${
      headline.isHighImpact
        ? "bg-amber-500/5 border-l-2 border-l-amber-500"
        : isNewest
        ? "bg-violet-500/5 border-l-2 border-l-violet-500"
        : "hover:bg-muted/30"
    }`}>
      <a href={headline.url} target="_blank" rel="noopener noreferrer"
         className="flex items-start gap-3 cursor-pointer">
        {/* Time + age */}
        <div className="shrink-0 w-16 text-right flex flex-col">
          <span className="text-xs font-mono text-muted-foreground">{time}</span>
          <span className="text-[10px] text-muted-foreground/60 font-mono">{ageLabel}</span>
        </div>

        {/* Ticker */}
        <div className="shrink-0 w-16 flex flex-col items-start">
          <span className="text-sm font-bold font-mono text-foreground">{headline.ticker}</span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 mb-0.5">
            {headline.isHighImpact && (
              <Zap className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
            )}
            <p className="text-sm leading-snug text-foreground flex-1">
              {headline.title}
            </p>
            <ExternalLink className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 mt-1 transition-opacity" />
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {/* Category badges */}
            {headline.categories.map(cat => {
              const conf = CATEGORY_LABELS[cat];
              if (!conf) return null;
              return (
                <span key={cat}
                      className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${conf.color}`}>
                  {conf.label}
                </span>
              );
            })}
            {/* Source */}
            <span className="text-[10px] text-muted-foreground font-mono ml-auto">
              {headline.source}
            </span>
          </div>
        </div>
      </a>
    </li>
  );
}
