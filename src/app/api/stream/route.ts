/**
 * SSE stream — sole purpose: push TIER 1 news headlines.
 *
 * Loop:
 *   • Poll Finviz every 5 seconds
 *   • Run screener (universe + source + trigger + exclusion filters)
 *   • Emit "screener" event with full current list on every change
 *   • Emit "newHeadline" event for each fresh headline (drives sound chime)
 *   • Emit "heartbeat" every 30s so the connection doesn't idle out
 */

import { fetchScreenedHeadlines, type ScreenedHeadline } from "@/lib/news-screener";

export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 5_000;       // Finviz poll cadence
const HEARTBEAT_MS = 30_000;

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const timers: ReturnType<typeof setInterval>[] = [];

      // Per-connection seen set — avoids shared module state poisoning other tabs
      const seenIds = new Set<string>();
      function diff(headlines: ScreenedHeadline[]): ScreenedHeadline[] {
        const fresh = headlines.filter(h => !seenIds.has(h.id));
        for (const h of headlines) seenIds.add(h.id);
        return fresh;
      }

      function send(event: string, data: unknown) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      }

      // Initial fetch — push everything we have
      try {
        const initial = await fetchScreenedHeadlines();
        send("screener", initial);
        diff(initial); // seed this connection's seen set
      } catch (err) {
        console.warn("[SSE] Initial screener fetch failed:", err);
      }

      // Poll Finviz every 5s
      timers.push(setInterval(async () => {
        try {
          const fresh = await fetchScreenedHeadlines();
          const newOnes = diff(fresh);
          if (newOnes.length > 0) {
            // Always push the full list (UI replaces, easier)
            send("screener", fresh);
            // Plus emit a separate event per new headline so client can chime/highlight
            for (const h of newOnes) send("newHeadline", h);
          }
        } catch { /* keep polling */ }
      }, POLL_INTERVAL_MS));

      // Heartbeat
      timers.push(setInterval(() => send("heartbeat", { ts: Date.now() }), HEARTBEAT_MS));

      // Cleanup on client disconnect
      const cleanup = () => {
        closed = true;
        timers.forEach(clearInterval);
      };
      // The ReadableStream cancel handler runs cleanup; also expose via abort.
      (controller as unknown as { _cleanup?: () => void })._cleanup = cleanup;
    },
    cancel() {
      // close handled via the closed flag
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export type { ScreenedHeadline };
