"use client";

import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { NewsItem, Alert } from "@/lib/types";
import { Newspaper, ExternalLink, AlertTriangle } from "lucide-react";

interface Props {
  news: NewsItem[];
  alerts?: Alert[];
}

const CATEGORY_CONFIG = {
  fed: { label: "FED", color: "bg-green-500/20 text-green-300" },
  boe: { label: "BOE", color: "bg-blue-500/20 text-blue-300" },
  opec: { label: "OPEC", color: "bg-amber-500/20 text-amber-300" },
  geopolitical: { label: "GEO", color: "bg-red-500/20 text-red-300" },
  macro: { label: "MACRO", color: "bg-purple-500/20 text-purple-300" },
  oil: { label: "OIL", color: "bg-orange-500/20 text-orange-300" },
} as const;

type CategoryFilter = NewsItem["category"] | "all";

export function NewsFeed({ news, alerts = [] }: Props) {
  const [filter, setFilter] = useState<CategoryFilter>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return news;
    return news.filter((n) => n.category === filter);
  }, [news, filter]);

  // Active alerts (not dismissed) — shown as compact ticker
  const activeAlerts = alerts.filter(a => !a.dismissed);
  const criticalCount = activeAlerts.filter(a => a.severity === "critical").length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            News Feed
          </h2>
          {/* Compact alert badge — only shows if there are active alerts */}
          {activeAlerts.length > 0 && (
            <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
              criticalCount > 0 ? "bg-impact-high/20 text-impact-high animate-pulse" : "bg-impact-medium/20 text-impact-medium"
            }`}>
              <AlertTriangle className="w-2.5 h-2.5" />
              {activeAlerts.length} {criticalCount > 0 ? `(${criticalCount} CRIT)` : "alerts"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {(["all", "fed", "boe", "opec", "oil", "macro", "geopolitical"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`px-1.5 py-0.5 text-[10px] rounded font-mono uppercase transition-colors ${
                filter === c
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {c === "all" ? "ALL" : c}
            </button>
          ))}
        </div>
      </div>

      {/* Compact alerts ticker — replaces the full alerts panel */}
      {activeAlerts.length > 0 && (
        <div className="px-4 py-1.5 border-b border-border/50 shrink-0 bg-muted/20 overflow-hidden">
          <div className="flex items-center gap-3 text-[11px] overflow-x-auto whitespace-nowrap">
            {activeAlerts.slice(0, 6).map((alert) => (
              <div key={alert.id} className="flex items-center gap-1.5 shrink-0">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  alert.severity === "critical" ? "bg-impact-high animate-pulse" : "bg-impact-medium"
                }`} />
                <span className={alert.severity === "critical" ? "text-impact-high font-semibold" : "text-foreground"}>
                  {alert.title}
                </span>
                <span className="text-muted-foreground">— {alert.message}</span>
              </div>
            ))}
            {activeAlerts.length > 6 && (
              <span className="text-muted-foreground shrink-0">+{activeAlerts.length - 6} more</span>
            )}
          </div>
        </div>
      )}

      {/* News items */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="divide-y divide-border/50">
          {filtered.map((item) => (
            <NewsCard key={item.id} item={item} />
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-muted-foreground text-sm">
              No news for selected filter
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  const config = CATEGORY_CONFIG[item.category];
  const timeAgo = getTimeAgo(item.timestamp);
  const exactTime = formatExactTime(item.timestamp);
  const isTelegram = item.url?.startsWith("https://t.me/");

  return (
    <div className={`px-4 py-3 hover:bg-muted/30 transition-colors ${
      item.isBreaking ? "border-l-2 border-l-impact-high bg-impact-high/5" :
      isTelegram ? "border-l-2 border-l-blue-500/50" : ""
    }`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${config.color}`}>
              {config.label}
            </span>
            {isTelegram && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono font-bold">
                ✈ TELEGRAM
              </span>
            )}
            {item.isBreaking && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-impact-high/20 text-impact-high font-bold animate-pulse-live">
                BREAKING
              </span>
            )}
            <span
              className="text-[10px] text-muted-foreground font-mono ml-auto shrink-0"
              title={`Posted ${new Date(item.timestamp).toLocaleString()}`}
            >
              <span className="text-foreground/70">{exactTime}</span>
              <span className="ml-1 opacity-60">· {timeAgo}</span>
            </span>
          </div>
          <h3 className="text-xs font-medium leading-snug text-foreground mb-1">
            {item.title}
          </h3>
          {item.summary && (
            <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
              {item.summary}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[10px] text-muted-foreground">{item.source}</span>
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
              >
                <ExternalLink className="w-2.5 h-2.5" />
                Source
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatExactTime(timestamp: string): string {
  const d = new Date(timestamp);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (sameDay) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function getTimeAgo(timestamp: string): string {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 5)  return `${minutes}m ${seconds % 60}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
