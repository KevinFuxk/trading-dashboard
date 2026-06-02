"use client";

import { useEffect, useRef, useState } from "react";
import type { FXQuote } from "@/lib/types";

/**
 * Live FX + commodity ticker strip for the header.
 *
 * Each quote pulses GREEN when its price ticks up, RED when it ticks down.
 * Uses a small ref to track previous price per symbol so the flash only
 * happens on actual change events (not on every re-render).
 */
export function TickerStrip({ quotes }: { quotes: FXQuote[] }) {
  if (quotes.length === 0) {
    return (
      <div className="flex items-center gap-3 text-[11px] font-mono text-muted-foreground">
        <span className="opacity-60">Loading FX…</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-[11px] font-mono">
      {quotes.map((q) => <TickerCell key={q.symbol} quote={q} />)}
    </div>
  );
}

function TickerCell({ quote }: { quote: FXQuote }) {
  const prevPriceRef = useRef<number>(quote.price);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (quote.price !== prevPriceRef.current) {
      setFlash(quote.price > prevPriceRef.current ? "up" : "down");
      prevPriceRef.current = quote.price;
      const t = setTimeout(() => setFlash(null), 1500);
      return () => clearTimeout(t);
    }
  }, [quote.price]);

  const up = quote.changePct >= 0;
  // For pairs ending in JPY, show 2 decimals; for forex, 4; for crude, 2.
  const isJpy = quote.symbol.endsWith("JPY");
  const isCrude = quote.symbol === "BRENT" || quote.symbol === "WTI";
  const priceFmt = isCrude ? `$${quote.price.toFixed(2)}` :
                   isJpy   ? quote.price.toFixed(2) :
                             quote.price.toFixed(4);
  const arrow = up ? "▲" : "▼";

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors duration-700 ${
        flash === "up"   ? "bg-bullish/30" :
        flash === "down" ? "bg-bearish/30" :
        "bg-transparent"
      }`}
    >
      <span className="text-muted-foreground">{quote.display}</span>
      <span className={`font-bold ${up ? "text-bullish" : "text-bearish"}`}>{priceFmt}</span>
      <span className={`text-[10px] ${up ? "text-bullish" : "text-bearish"}`}>
        {arrow} {Math.abs(quote.changePct).toFixed(2)}%
      </span>
    </div>
  );
}
