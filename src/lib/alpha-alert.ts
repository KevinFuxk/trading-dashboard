"use client";

/**
 * Pleasant 3-note ascending chime — Web Audio API, no external files.
 * Browsers require a user gesture before audio can play, so we attempt to
 * "unlock" the AudioContext on the first click anywhere on the page.
 */

let ctx: AudioContext | null = null;
let unlocked = false;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/**
 * Call once on app mount — registers a one-time global click handler that
 * "primes" the AudioContext so chimes can fire later without user gesture.
 */
export function primeAlphaAlert() {
  if (typeof window === "undefined" || unlocked) return;
  const unlock = () => {
    const c = getCtx();
    if (c && c.state === "suspended") c.resume();
    unlocked = true;
    window.removeEventListener("click", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("click", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

/**
 * Play the HIGH ALPHA chime — a clean 3-note "C-E-G" major triad
 * (positive, attention-getting, but not jarring). About 700ms total.
 */
export function playAlphaChime(volume = 0.25) {
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") {
    c.resume().catch(() => {});
  }

  // Major triad: C5 (523.25), E5 (659.25), G5 (783.99)
  const notes = [523.25, 659.25, 783.99];
  const noteDur = 0.18;
  const gap = 0.04;

  const masterGain = c.createGain();
  masterGain.gain.value = volume;
  masterGain.connect(c.destination);

  notes.forEach((freq, i) => {
    const t0 = c.currentTime + i * (noteDur + gap);
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;

    // ADSR envelope so notes don't click
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(1, t0 + 0.02);          // attack 20ms
    g.gain.linearRampToValueAtTime(0.6, t0 + noteDur * 0.6); // decay
    g.gain.linearRampToValueAtTime(0, t0 + noteDur);        // release
    osc.connect(g).connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + noteDur + 0.05);
  });
}

/**
 * localStorage helpers — remember which briefings we've already alerted on,
 * so refreshing the page doesn't re-play the chime for the same briefing.
 */
const ALERTED_KEY = "alpha-alert-last-ts";
const MUTED_KEY   = "alpha-alert-muted";

export function hasAlertedOn(generatedAt: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(ALERTED_KEY) === generatedAt;
  } catch { return true; }
}

export function markAlerted(generatedAt: string) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(ALERTED_KEY, generatedAt); } catch {}
}

export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(MUTED_KEY) === "1"; } catch { return false; }
}

export function setMuted(muted: boolean) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(MUTED_KEY, muted ? "1" : "0"); } catch {}
}
