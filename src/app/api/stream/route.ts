/**
 * SSE stream — pushes all dashboard data to the client.
 *
 * Normal mode:  each source pushed on its own interval.
 *
 * US Sniper:    8:30 ET BLS release windows — polls BLS+FRED every 1s.
 *               Calendar arrives within ~1s of official release.
 *
 * UK Sniper:    7:00 BST (ONS: CPI, GDP, unemployment) and 12:00 BST (BOE rate).
 *               Polls ForexFactory every 5s — FF is the fastest free UK source
 *               (~15-30s after ONS/BOE release vs 5-min cache normally).
 *               No free direct ONS API exists (deprecated); FRED UK data is months stale.
 */

import {
  fetchEconomicCalendar,
  fetchTruthSocialPosts,
  fetchHormuzData,
  fetchOilInventory,
  fetchNewsFeed,
  fetchFXTicker,
  fetchPremarketMovers,
  bypassFFCache,
  bypassEIACache,
} from "@/lib/data-sources";
import {
  startReleaseSniperIfNeeded,
  stopReleaseSniperIfActive,
  startUKSniperIfNeeded,
  stopUKSniperIfActive,
  bypassBLSCache,
  fetchBLSData,
} from "@/lib/gov-calendar";

export const dynamic = "force-dynamic";

const SOURCES = [
  // Calendar: 30s push — BLS sniper fires instantly on release days
  { name: "calendar",     fetcher: fetchEconomicCalendar, intervalMs: 30_000  },
  // Trump posts: 10s push — DIRECT from Truth Social (via trumpstruth.org mirror).
  // 10s SWR TTL means each interval gets fresh data. Combined: ~10-20s lag from Trump's post to UI.
  { name: "truthSocial",  fetcher: fetchTruthSocialPosts, intervalMs: 10_000  },
  // Hormuz: Yahoo Finance live Brent/WTI futures (90s SWR TTL). Push every 90s.
  { name: "hormuz",       fetcher: fetchHormuzData,       intervalMs: 90_000  },
  // Oil inventory: 2h SWR TTL — EIA weekly (Wed 10:30 ET). Push every 30 min.
  { name: "oilInventory", fetcher: fetchOilInventory,     intervalMs: 1_800_000 },
  // News: 90s SWR TTL — 3 feeds in parallel, SWR means push returns in <1ms
  { name: "news",         fetcher: fetchNewsFeed,         intervalMs: 90_000  },
  // FX ticker: 60s push — Yahoo Finance live FX + futures (GBPUSD, EURUSD, etc.)
  { name: "fx",           fetcher: fetchFXTicker,         intervalMs: 60_000  },
  // Premarket movers: 60s push — Yahoo screeners (gainers/losers/active) with quality filter
  { name: "movers",       fetcher: fetchPremarketMovers,  intervalMs: 60_000  },
] as const;

export async function GET() {
  const encoder = new TextEncoder();
  const cleanupRef: { fn?: () => void } = {};

  const stream = new ReadableStream({
    async start(controller) {
      // ── Per-connection state (no module-level leaks across reconnects) ──
      let lastTrumpPostIds = new Set<string>();
      let fomcSniperActive = false;
      let fomcSniperTimer: ReturnType<typeof setInterval> | null = null;
      let fomcBaselineRate: string | null = null;

      const timers: ReturnType<typeof setInterval>[] = [];
      let closed = false;

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

      // Diff-aware push: only send if the payload actually changed since last push.
      // Saves bandwidth + avoids client re-renders when nothing's new.
      // For burst events (sniperFired etc.) we still use raw send().
      const lastPayloadByEvent = new Map<string, string>();
      function sendIfChanged(event: string, data: unknown): boolean {
        const json = JSON.stringify(data);
        if (lastPayloadByEvent.get(event) === json) return false;
        lastPayloadByEvent.set(event, json);
        send(event, data);
        return true;
      }

      // Initial push — all sources at once (always sends)
      await Promise.allSettled(
        SOURCES.map(async (src) => {
          try {
            const data = await src.fetcher();
            lastPayloadByEvent.set(src.name, JSON.stringify(data));
            send(src.name, data);
          }
          catch (err) { console.warn(`[SSE] Initial ${src.name} failed:`, err); }
        })
      );

      // Regular interval push per source — diff-only after the initial push
      for (const src of SOURCES) {
        timers.push(setInterval(async () => {
          try { sendIfChanged(src.name, await src.fetcher()); }
          catch { /* cache handles fallback */ }
        }, src.intervalMs));
      }

      // Heartbeat every 30s
      timers.push(setInterval(() => send("heartbeat", { ts: Date.now() }), 30_000));

      // ── Telegram subscriber — push new oil-channel messages INSTANTLY ──
      // No polling delay: gramjs delivers MTProto events in real-time, we
      // forward each one straight to the client through SSE.
      let unsubTelegram: (() => void) | null = null;
      try {
        const { subscribeTelegram } = await import("@/lib/telegram");
        unsubTelegram = subscribeTelegram((msg) => {
          send("telegramMessage", msg);
          // Push updated news list so the new message appears in the feed too
          fetchNewsFeed().then(news => sendIfChanged("news", news)).catch(() => {});
        });
      } catch { /* telegram not configured — silent */ }

      // ── Trump Signal Sniper ───────────────────────────────────────
      // Polls every 30s. On each cycle:
      //  1. Fetch latest Trump posts (30s SWR cache — always fresh)
      //  2. Diff against last known post IDs
      //  3. If any NEW post contains the signature phrase or Hormuz keywords
      //     → fire "trumpSignal" SSE immediately (lights up badge on client)
      //  4. Always push full "truthSocial" update so client sees new posts
      timers.push(setInterval(async () => {
        try {
          const posts = await fetchTruthSocialPosts();
          const currentIds = new Set(posts.map(p => p.id));

          // Find posts we haven't seen before
          const newPosts = posts.filter(p => !lastTrumpPostIds.has(p.id));
          lastTrumpPostIds = currentIds;

          if (newPosts.length > 0) {
            // Check if any new post is a high-priority Trump Signal
            const signalPost = newPosts.find(p =>
              p.content.toLowerCase().includes("trump signal") ||
              p.content.toLowerCase().includes("attention to this matter") ||
              p.relevanceKeywords.some(k => ["hormuz", "strait", "blockade", "naval", "navy", "iran"].includes(k))
            );

            if (signalPost) {
              console.log(`[TRUMP SNIPER] 🔴 SIGNAL: "${signalPost.content.slice(0, 80)}"`);
              send("trumpSignal", {
                ts: Date.now(),
                isSignaturePhrase: signalPost.content.toLowerCase().includes("attention to this matter"),
                preview: signalPost.content.slice(0, 120),
              });
            }

            // Always push updated post list
            send("truthSocial", posts);
          }
        } catch { /* ignore */ }
      }, 10_000));

      // ── Adaptive Release Sniper ───────────────────────────────────
      // One unified detector that handles ALL non-BLS releases (GDP, ECI, Census,
      // FOMC, FRED-extras). The BLS sniper handles CPI/PPI/NFP at 1s separately.
      //
      // States:
      //  HOT    → poll every 5s (release imminent or just happened, missing actual)
      //  WARM   → poll every 15s (an event happened in last 2h, no missing actuals)
      //  IDLE   → poll every 60s (no recent or upcoming high-impact events)
      //
      // Hot triggers:
      //  • Any high-impact USD event in the next 5 min (pre-release warm-up)
      //  • Any high-impact event in last 30 min that's still missing an actual
      //
      // When in HOT and missing actuals exist: bypass ALL caches and push fresh.
      let releaseSniperTimer: ReturnType<typeof setTimeout> | null = null;
      let releaseSniperState: "hot" | "warm" | "idle" = "idle";
      let releaseSniperLastBlsBypassKey = 0; // 30s key — throttles BLS cache bypass under FRED rate limit
      const knownActualKey = (e: { id: string; actual?: string }) => `${e.id}:${e.actual}`;
      let knownActualsSnapshot = new Set<string>();

      function scheduleReleaseSniperTick(delayMs: number) {
        releaseSniperTimer = setTimeout(async () => {
          if (closed) return;
          let nextDelay = 60_000;
          let nextState: "hot" | "warm" | "idle" = "idle";

          try {
            const cal = await fetchEconomicCalendar();
            const now = Date.now();

            const upcoming = cal.filter(e =>
              e.impact === "high" &&
              new Date(e.time).getTime() > now &&
              new Date(e.time).getTime() - now < 5 * 60_000
            );
            const missing = cal.filter(e =>
              e.impact === "high" &&
              new Date(e.time).getTime() < now &&
              now - new Date(e.time).getTime() < 30 * 60_000 &&
              !e.actual
            );
            const recent = cal.filter(e =>
              e.impact === "high" &&
              new Date(e.time).getTime() < now &&
              now - new Date(e.time).getTime() < 2 * 3600_000
            );

            const isHot  = upcoming.length > 0 || missing.length > 0;
            const isWarm = !isHot && recent.length > 0;

            if (isHot)       { nextState = "hot";  nextDelay = 5_000;  }
            else if (isWarm) { nextState = "warm"; nextDelay = 15_000; }
            else             { nextState = "idle"; nextDelay = 60_000; }

            // Log state transitions
            if (nextState !== releaseSniperState) {
              console.log(`[RELEASE SNIPER] ${releaseSniperState} → ${nextState} (poll ${nextDelay/1000}s) | upcoming:${upcoming.length} missing:${missing.length}`);
              releaseSniperState = nextState;
              if (isHot) {
                send("releaseSniperFired", {
                  ts: now,
                  state: nextState,
                  upcoming: upcoming.map(e => ({ event: e.event, time: e.time })),
                  missing:  missing.map(e => e.event),
                });
              }
            }

            // When HOT: bypass FF cache (cheap, single fetch) every tick.
            // Only bypass BLS cache (forces 30+ FRED calls) every 30s in HOT mode
            // to stay under FRED's 120 req/min rate limit. The BLS sniper handles
            // 1-second granularity for its 7 series; adaptive sniper covers the rest.
            if (isHot) {
              bypassFFCache();
              const tickKey = Math.floor(Date.now() / 30_000);
              if (releaseSniperLastBlsBypassKey !== tickKey) {
                bypassBLSCache();
                releaseSniperLastBlsBypassKey = tickKey;
              }
              const fresh = await fetchEconomicCalendar();

              // Detect any new actuals since last snapshot → fire targeted event
              const currentSet = new Set(fresh.filter(e => e.actual).map(knownActualKey));
              const newActuals = fresh.filter(e =>
                e.actual &&
                e.currency === "USD" &&
                e.impact === "high" &&
                !knownActualsSnapshot.has(knownActualKey(e))
              );

              if (newActuals.length > 0 || knownActualsSnapshot.size === 0) {
                send("calendar", fresh);
                if (newActuals.length > 0) {
                  console.log(`[RELEASE SNIPER] 🎯 ${newActuals.length} new actual(s):`, newActuals.map(e => `${e.event}=${e.actual}`).join(", "));
                  send("releaseSniperFired", {
                    ts: now,
                    state: "hot",
                    newActuals: newActuals.map(e => ({ event: e.event, actual: e.actual, source: e.source })),
                  });
                }
              }
              knownActualsSnapshot = currentSet;
            }
          } catch { /* keep polling on error */ }

          scheduleReleaseSniperTick(nextDelay);
        }, delayMs);
      }
      // Kick off the adaptive loop (cleanup handled in cleanupRef.fn below)
      scheduleReleaseSniperTick(5_000);

      // ── FOMC Sniper (14:00 ET on FOMC days) ───────────────────────
      // Activates 5min before any "Federal Funds Rate" event. While active,
      // polls FRED DFEDTARU every 5s with cache bypass. As soon as FRED
      // publishes the new rate (typically 1-2 min after FOMC announcement)
      // → push fresh calendar + fire "fomcSniperFired" event.
      // Auto-deactivates 30 min after the event time.
      timers.push(setInterval(async () => {
        try {
          const cal = await fetchEconomicCalendar();
          const now = Date.now();

          const fomcEvent = cal.find(e =>
            e.event.toLowerCase() === "federal funds rate" &&
            e.currency === "USD" &&
            e.impact === "high"
          );

          if (!fomcEvent) return;

          const eventTime = new Date(fomcEvent.time).getTime();
          const minutesFromEvent = (now - eventTime) / 60_000;
          // Window: 5min before → 30min after the FOMC release time
          const inWindow = minutesFromEvent >= -5 && minutesFromEvent <= 30;

          if (inWindow && !fomcSniperActive) {
            fomcSniperActive = true;
            // Capture baseline (yesterday's rate)
            const baseline = await fetchBLSData();
            fomcBaselineRate = baseline.find(d => d.seriesId === "DFEDTARU")?.formattedActual || null;
            console.log(`[FOMC SNIPER] 🎯 Window opened — baseline rate: ${fomcBaselineRate}`);

            // Poll every 5s for FRED updates.
            // OPTIMIZATION: only direct-fetch DFEDTARU (1 call) instead of the full
            // fetchBLSData() (21 calls). At 5s × 30min = 360 ticks, that saves ~7,200 FRED calls.
            const FRED_KEY = process.env.FRED_API_KEY || "";
            let fomcLastFullRefreshKey = 0;
            fomcSniperTimer = setInterval(async () => {
              try {
                // Direct fetch of DFEDTARU only (1 FRED call vs 21)
                let currentRate: string | null = null;
                if (FRED_KEY) {
                  try {
                    const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=DFEDTARU&api_key=${FRED_KEY}&sort_order=desc&limit=1&file_type=json`,
                      { signal: AbortSignal.timeout(4_000) });
                    if (r.ok) {
                      const j = await r.json() as { observations?: Array<{ value: string }> };
                      const v = j.observations?.[0]?.value;
                      if (v && v !== ".") currentRate = `${parseFloat(v).toFixed(2)}%`;
                    }
                  } catch { /* fallthrough to cached */ }
                }
                // Fallback: read from cached BLS data (no extra network call)
                if (!currentRate) {
                  const cached = await fetchBLSData();
                  currentRate = cached.find(d => d.seriesId === "DFEDTARU")?.formattedActual ?? null;
                }

                // Push the full calendar at most every 30s — bypass FF (cheap)
                // every tick, but bypass BLS only every 30s (rate limit guard).
                bypassFFCache();
                const tickKey = Math.floor(Date.now() / 30_000);
                if (fomcLastFullRefreshKey !== tickKey) {
                  bypassBLSCache();
                  fomcLastFullRefreshKey = tickKey;
                }
                const updatedCalendar = await fetchEconomicCalendar();
                send("calendar", updatedCalendar);

                // Detect rate change (CUT or HIKE)
                if (currentRate && fomcBaselineRate && currentRate !== fomcBaselineRate) {
                  console.log(`[FOMC SNIPER] 🎯 RATE CHANGE: ${fomcBaselineRate} → ${currentRate}`);
                  send("fomcSniperFired", {
                    ts: Date.now(),
                    oldRate: fomcBaselineRate,
                    newRate: currentRate,
                    direction: parseFloat(currentRate) > parseFloat(fomcBaselineRate) ? "HIKE" : "CUT",
                  });
                  fomcBaselineRate = currentRate;
                } else if (currentRate) {
                  // Even on HOLD, fire badge so user sees "LIVE FOMC"
                  send("fomcSniperFired", {
                    ts: Date.now(),
                    oldRate: fomcBaselineRate,
                    newRate: currentRate,
                    direction: "HOLD",
                  });
                }
              } catch { /* ignore poll errors */ }
            }, 5_000);
          }

          // Auto-stop sniper 30 min past release time
          if (fomcSniperActive && minutesFromEvent > 30) {
            console.log("[FOMC SNIPER] Window passed — stopping");
            if (fomcSniperTimer) clearInterval(fomcSniperTimer);
            fomcSniperTimer = null;
            fomcSniperActive = false;
            fomcBaselineRate = null;
          }
        } catch { /* ignore */ }
      }, 30_000));

      // ── US Release Sniper (8:30 ET) ───────────────────────────────
      // Checks every 5s whether we're entering a BLS release window.
      // When inside window, polls BLS+FRED every 1s — fires calendar update
      // the instant new period data appears (~1s vs 5-30s via ForexFactory).
      timers.push(setInterval(async () => {
        startReleaseSniperIfNeeded(async (freshBLS) => {
          console.log(`[SSE] 🎯 US sniper pushed ${freshBLS.length} BLS actuals`);
          try {
            // Bypass FF cache so non-BLS USD events (Retail Sales, Census data)
            // also pick up whatever actuals ForexFactory has already posted.
            bypassFFCache();
            const updatedCalendar = await fetchEconomicCalendar();
            send("calendar", updatedCalendar);
            send("blsActuals", freshBLS); // triggers "⚡ LIVE BLS" badge on client
          } catch { /* ignore */ }
        });
      }, 5_000));

      // ── EIA Crude Oil Sniper (10:30 ET Wed/Thu) ──────────────────
      // ADAPTIVE POLLING — sub-second latency in the critical window:
      //   T−5 min → T−10s : 10s polling     (warming up, baseline checks)
      //   T−10s  → T+30s  : 1s polling      (BURST — we expect data here)
      //   T+30s  → T+5min : 3s polling      (catch late releases)
      //   T+5min → T+15min: 10s polling     (safety net for unusual delays)
      //   T+15min         : auto-stop
      //
      // EIA allows ~5000 req/hr; our peak is ~30 in burst window = no rate risk.
      let eiaSniperActive = false;
      let eiaSniperBaselinePeriod: string | null = null;
      let eiaSniperTimer: ReturnType<typeof setTimeout> | null = null;
      let eiaReleaseTime: number | null = null;  // epoch ms of next 10:30 ET release

      // Compute next 10:30 ET on Wed/Thu (returns ms timestamp)
      function nextEIAReleaseTime(now: Date): number | null {
        const m = now.getUTCMonth();
        const isEDT = (m > 2 && m < 10) || (m === 2 && now.getUTCDate() >= 8) || (m === 10 && now.getUTCDate() < 1);
        const etOffset = isEDT ? -4 : -5;
        // Try today first, then check next 8 days for Wed/Thu
        for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
          const candidate = new Date(now.getTime() + dayOffset * 24 * 3600_000);
          const etDate = new Date(candidate.getTime() + etOffset * 3600_000);
          const day = etDate.getUTCDay();
          if (day !== 3 && day !== 4) continue;  // Wed=3, Thu=4
          // 10:30 ET in UTC
          const release = new Date(Date.UTC(etDate.getUTCFullYear(), etDate.getUTCMonth(), etDate.getUTCDate(), 10 - etOffset, 30, 0));
          if (release.getTime() > now.getTime() - 15 * 60_000) return release.getTime();
        }
        return null;
      }

      // Decide poll interval based on time-distance from release
      function eiaPollInterval(secFromRelease: number): number {
        if (secFromRelease >= -10 && secFromRelease <= 30) return 1_000;   // BURST: 1s
        if (secFromRelease > 30 && secFromRelease <= 300)  return 3_000;   // catch-up: 3s
        if (secFromRelease > 300 && secFromRelease <= 900) return 10_000;  // safety: 10s
        return 10_000;                                                       // pre-window
      }

      async function eiaSniperTick() {
        if (closed || !eiaReleaseTime) return;
        const secFromRelease = (Date.now() - eiaReleaseTime) / 1000;

        try {
          bypassEIACache();
          const fresh = await fetchOilInventory();
          const freshPeriod = fresh?.timestamp.slice(0, 10);

          if (freshPeriod && eiaSniperBaselinePeriod && freshPeriod > eiaSniperBaselinePeriod) {
            const detectionLag = secFromRelease.toFixed(2);
            console.log(`[EIA SNIPER] 🎯 NEW DATA at T+${detectionLag}s: ${eiaSniperBaselinePeriod} → ${freshPeriod} (${fresh?.crudeBuild}M bbl)`);
            eiaSniperBaselinePeriod = freshPeriod;
            if (fresh) send("oilInventory", fresh);
            send("eiaSniperFired", {
              ts: Date.now(),
              period: freshPeriod,
              crudeBuild: fresh?.crudeBuild,
              isDraw: (fresh?.crudeBuild ?? 0) < 0,
              detectionLagSec: parseFloat(detectionLag),
            });
            bypassFFCache();
            const cal = await fetchEconomicCalendar();
            send("calendar", cal);
            // After detection, slow down polling — back to 30s
            eiaSniperTimer = setTimeout(eiaSniperTick, 30_000);
            return;
          }
        } catch { /* ignore */ }

        // Auto-stop 15 min past release
        if (secFromRelease > 900) {
          console.log("[EIA SNIPER] Window closed — stopping");
          eiaSniperTimer = null;
          eiaSniperActive = false;
          eiaSniperBaselinePeriod = null;
          eiaReleaseTime = null;
          return;
        }

        // Schedule next tick with adaptive interval
        const nextDelay = eiaPollInterval(secFromRelease);
        eiaSniperTimer = setTimeout(eiaSniperTick, nextDelay);
      }

      // Window detector — wakes the sniper 5 min before the release
      timers.push(setInterval(async () => {
        try {
          const now = new Date();
          const releaseTs = nextEIAReleaseTime(now);
          if (!releaseTs) return;
          const minToRelease = (releaseTs - now.getTime()) / 60_000;
          // Activate sniper from T−5 min through T+15 min
          if (minToRelease <= 5 && minToRelease >= -15 && !eiaSniperActive) {
            eiaSniperActive = true;
            eiaReleaseTime = releaseTs;
            const baseline = await fetchOilInventory();
            eiaSniperBaselinePeriod = baseline?.timestamp.slice(0, 10) ?? null;
            const releaseEt = new Date(releaseTs).toISOString();
            console.log(`[EIA SNIPER] 🎯 Armed for ${releaseEt} (T${minToRelease >= 0 ? "−" : "+"}${Math.abs(minToRelease).toFixed(1)} min) — baseline=${eiaSniperBaselinePeriod}`);
            // Start adaptive ticking immediately (will burst at T-10s → T+30s)
            eiaSniperTick();
          }
        } catch { /* ignore */ }
      }, 30_000));

      // ── UK Release Sniper (7:00 BST / 12:00 BST) ─────────────────
      // Checks every 5s whether we're near a UK release window.
      // When inside window, polls ForexFactory every 5s for GBP actuals.
      // Fires calendar refresh the moment a high-impact GBP event gets an actual.
      // Best free speed for UK data: ~15-30s after ONS/BOE releases.
      timers.push(setInterval(async () => {
        startUKSniperIfNeeded(async () => {
          console.log("[SSE] 🎯 UK sniper — new GBP actuals detected on ForexFactory");
          try {
            // Bypass FF cache so fetchEconomicCalendar() picks up the fresh actuals
            bypassFFCache();
            const updatedCalendar = await fetchEconomicCalendar();
            send("calendar", updatedCalendar);
            // Signal client to show UK sniper badge
            send("ukSniperFired", { ts: Date.now() });
          } catch { /* ignore */ }
        });
      }, 5_000));

      cleanupRef.fn = () => {
        closed = true;
        timers.forEach(clearInterval);
        if (unsubTelegram) unsubTelegram();
        stopReleaseSniperIfActive();
        stopUKSniperIfActive();
        if (fomcSniperTimer) clearInterval(fomcSniperTimer);
        fomcSniperTimer = null;
        fomcSniperActive = false;
        if (releaseSniperTimer) clearTimeout(releaseSniperTimer);
        releaseSniperTimer = null;
        if (eiaSniperTimer) clearTimeout(eiaSniperTimer);
        eiaSniperTimer = null;
        eiaSniperActive = false;
        eiaReleaseTime = null;
      };
    },
    cancel() {
      cleanupRef.fn?.();
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
