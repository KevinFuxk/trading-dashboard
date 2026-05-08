"use client";

import { useState, useRef } from "react";

/**
 * Inline SVG sparkline — pure SVG, no dependencies.
 * Two modes:
 *   • "line"  — connected polyline, good for level trends (Hormuz flow over months)
 *   • "bars"  — bar chart with positive/negative coloring (oil weekly builds/draws)
 *
 * Interactive: hover to see exact value + label in a floating tooltip.
 */

interface SparklineProps {
  data: number[];
  labels?: string[];
  width?: number;
  height?: number;
  mode?: "line" | "bars";
  positiveColor?: string;
  negativeColor?: string;
  lineColor?: string;
  /** Optional value formatter for the tooltip (defaults to "+1.5" / "-2.0") */
  valueFormat?: (n: number) => string;
}

export function Sparkline({
  data,
  labels,
  width = 220,
  height = 48,
  mode = "line",
  positiveColor = "rgb(239, 68, 68)",
  negativeColor = "rgb(34, 197, 94)",
  lineColor = "rgb(34, 211, 238)",
  valueFormat,
}: SparklineProps) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length === 0) return null;

  const min = Math.min(...data, 0);
  const max = Math.max(...data, 0);
  const range = max - min || 1;
  const padX = 2;
  const padY = 4;
  const w = width - padX * 2;
  const h = height - padY * 2;
  const dx = data.length > 1 ? w / (data.length - 1) : 0;
  const y = (v: number) => padY + h - ((v - min) / range) * h;
  const zeroY = y(0);

  const fmt = valueFormat ?? ((n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`);

  // Translate mouse X position to data index
  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = e.clientX - rect.left - padX;
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(localX / (dx || 1))));
    setHover({ i: idx, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  function handleLeave() {
    setHover(null);
  }

  const tooltip = hover ? (
    <div
      className="pointer-events-none absolute z-50 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-card/95 px-2 py-1 text-[10px] font-mono shadow-lg backdrop-blur-sm whitespace-nowrap"
      style={{ left: hover.x, top: Math.max(0, hover.y - 8) }}
    >
      <div className="text-muted-foreground">{labels?.[hover.i] ?? `#${hover.i}`}</div>
      <div className={`font-bold ${data[hover.i] >= 0 ? "text-bearish" : "text-bullish"}`}>
        {fmt(data[hover.i])}
      </div>
    </div>
  ) : null;

  if (mode === "bars") {
    const bw = data.length > 1 ? Math.max(2, (w / data.length) * 0.7) : 6;
    const bdx = data.length > 1 ? w / data.length : 0;
    return (
      <div className="relative inline-block" style={{ width, height }}>
        <svg ref={svgRef} width={width} height={height} className="block cursor-crosshair"
             onMouseMove={handleMove} onMouseLeave={handleLeave}>
          {/* Zero baseline */}
          <line x1={padX} x2={width - padX} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.15)" strokeWidth={1} strokeDasharray="2 2" />
          {data.map((v, i) => {
            const xPos = padX + i * bdx + (bdx - bw) / 2;
            const yTop = v >= 0 ? y(v) : zeroY;
            const barH = Math.max(1, Math.abs(zeroY - y(v)));
            const isHovered = hover?.i === i;
            return (
              <rect
                key={i}
                x={xPos}
                y={yTop}
                width={bw}
                height={barH}
                fill={v >= 0 ? positiveColor : negativeColor}
                opacity={isHovered ? 1 : 0.85}
                stroke={isHovered ? "rgba(255,255,255,0.6)" : "none"}
                strokeWidth={1}
              >
                {labels && labels[i] && <title>{labels[i]}: {fmt(v)}</title>}
              </rect>
            );
          })}
          {/* Hover guideline */}
          {hover && (
            <line
              x1={padX + hover.i * bdx + bdx / 2}
              x2={padX + hover.i * bdx + bdx / 2}
              y1={padY}
              y2={padY + h}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          )}
        </svg>
        {tooltip}
      </div>
    );
  }

  // Line mode
  const points = data.map((v, i) => `${padX + i * dx},${y(v)}`).join(" ");
  const areaPath = `M ${padX},${y(data[0])} L ${points.split(" ").slice(1).join(" L ")} L ${padX + (data.length - 1) * dx},${padY + h} L ${padX},${padY + h} Z`;
  return (
    <div className="relative inline-block" style={{ width, height }}>
      <svg ref={svgRef} width={width} height={height} className="block cursor-crosshair"
           onMouseMove={handleMove} onMouseLeave={handleLeave}>
        <path d={areaPath} fill={lineColor} fillOpacity={0.12} />
        <polyline
          points={points}
          fill="none"
          stroke={lineColor}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {data.map((v, i) => {
          const isHovered = hover?.i === i;
          return (
            <circle
              key={i}
              cx={padX + i * dx}
              cy={y(v)}
              r={isHovered ? 4 : (i === data.length - 1 ? 2.5 : 1.2)}
              fill={lineColor}
              stroke={isHovered ? "white" : "none"}
              strokeWidth={isHovered ? 1 : 0}
            >
              {labels && labels[i] && <title>{labels[i]}: {fmt(v)}</title>}
            </circle>
          );
        })}
        {/* Hover guideline */}
        {hover && (
          <line
            x1={padX + hover.i * dx}
            x2={padX + hover.i * dx}
            y1={padY}
            y2={padY + h}
            stroke="rgba(255,255,255,0.25)"
            strokeWidth={1}
            strokeDasharray="2 2"
          />
        )}
      </svg>
      {tooltip}
    </div>
  );
}
