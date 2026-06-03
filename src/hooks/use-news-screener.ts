"use client";

import { useEffect, useRef, useState } from "react";
import type { ScreenedHeadline } from "@/lib/news-screener";

interface ScreenerState {
  headlines: ScreenedHeadline[];
  connected: boolean;
  lastUpdate: string | null;
  newestId: string | null;        // most recent headline ID for highlight flash
}

const INITIAL: ScreenerState = {
  headlines: [],
  connected: false,
  lastUpdate: null,
  newestId: null,
};

/**
 * SSE-driven hook — single source of truth for the screener panel.
 *  • Subscribes to /api/stream
 *  • Auto-reconnects with exponential backoff on disconnect
 *  • Fires `onNewHighImpact` when a headline arrives with `isHighImpact: true`
 *    (used by the sound chime — UI handles the actual audio play)
 */
export function useNewsScreener(onNewHighImpact?: (h: ScreenedHeadline) => void) {
  const [state, setState] = useState<ScreenerState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(onNewHighImpact);
  useEffect(() => { callbackRef.current = onNewHighImpact; }, [onNewHighImpact]);

  useEffect(() => {
    function connect() {
      esRef.current?.close();
      const es = new EventSource("/api/stream");
      esRef.current = es;

      es.onopen = () => {
        setState(prev => ({ ...prev, connected: true }));
        reconnectAttemptsRef.current = 0;
      };

      es.addEventListener("screener", (e) => {
        const headlines = JSON.parse(e.data) as ScreenedHeadline[];
        setState(prev => ({
          ...prev,
          headlines,
          lastUpdate: new Date().toISOString(),
          newestId: headlines[0]?.id ?? prev.newestId,
        }));
      });

      es.addEventListener("newHeadline", (e) => {
        const h = JSON.parse(e.data) as ScreenedHeadline;
        // Trigger callback for high-impact headlines (chime)
        if (h.isHighImpact && callbackRef.current) {
          callbackRef.current(h);
        }
      });

      es.onerror = () => {
        setState(prev => ({ ...prev, connected: false }));
        es.close();
        esRef.current = null;
        const attempts = reconnectAttemptsRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempts), 30_000);
        reconnectAttemptsRef.current = attempts + 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      esRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  return state;
}
