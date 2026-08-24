// voice.js — text-to-speech behind a single speak() interface with two
// swappable engines:
//   FREE    — the browser's built-in speechSynthesis. Zero cost, always
//             available, but the browser synthesizes and plays the audio
//             itself with no access for Web Audio to analyse — so there is
//             no way to derive real amplitude from it. Known limitation.
//   PREMIUM — calls the Flask backend's POST /speak (which holds the
//             ElevenLabs API key server-side) and plays the returned audio
//             through a Web Audio graph with an AnalyserNode, so callers
//             can get real per-bar frequency amplitude while it plays.

export const VoiceEngine = { FREE: "free", PREMIUM: "premium" };

const SPEAK_ENDPOINT = "http://localhost:5000/speak";

// --- Fix #3: default engine depends on environment ---
// During local dev/testing, default to FREE so casual testing doesn't
// burn ElevenLabs credits. Flip to PREMIUM for production builds by
// setting IS_PRODUCTION = true (or wire this to an actual build-time env
// var / config flag once you have a build step).
const IS_PRODUCTION = false; // TODO: replace with real env detection
let engine = IS_PRODUCTION ? VoiceEngine.PREMIUM : VoiceEngine.FREE;

export function setVoiceEngine(next) {
  engine = next;
}
export function getVoiceEngine() {
  return engine;
}

let audioCtx = null;
let analyser = null;

function ensureAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
  }
  return audioCtx;
}

export function unlockAudio() {
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function mapFrequenciesToBars(freqData, barCount) {
  const bars = new Float32Array(barCount);
  const usableBins = Math.floor(freqData.length * 0.75);
  for (let i = 0; i < barCount; i++) {
    const t0 = i / barCount;
    const t1 = (i + 1) / barCount;
    const startBin = Math.floor(Math.pow(t0, 1.6) * usableBins);
    const endBin = Math.max(startBin + 1, Math.floor(Math.pow(t1, 1.6) * usableBins));
    let sum = 0;
    let count = 0;
    for (let b = startBin; b < endBin && b < freqData.length; b++) {
      sum += freqData[b];
      count++;
    }
    bars[i] = count > 0 ? sum / count / 255 : 0;
  }
  return bars;
}

function speakFree(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) {
      resolve({ ok: false, engine: VoiceEngine.FREE, error: "speechSynthesis is not supported in this browser." });
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.onend = () => resolve({ ok: true, engine: VoiceEngine.FREE, analysed: false });
    utter.onerror = (e) =>
      resolve({ ok: false, engine: VoiceEngine.FREE, error: e.error || "speech synthesis error" });
    window.speechSynthesis.speak(utter);
  });
}

async function speakPremium(text, { barCount, onAmplitude }) {
  let res;
  try {
    res = await fetch(SPEAK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, engine: "premium" }),
    });
  } catch (err) {
    return {
      ok: false,
      engine: VoiceEngine.PREMIUM,
      error: "Couldn't reach the /speak endpoint — is the Flask server running on localhost:5000?",
    };
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, engine: VoiceEngine.PREMIUM, error: data.error || `TTS request failed (${res.status})` };
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (_e) {
      /* fall through and still try to play */
    }
  }

  const audioEl = new Audio(url);
  let source = null;
  try {
    source = ctx.createMediaElementSource(audioEl);
    source.connect(analyser);
    analyser.connect(ctx.destination);
  } catch (_err) {
    audioEl.volume = 1;
  }

  const freqData = source ? new Uint8Array(analyser.frequencyBinCount) : null;
  let rafId = null;

  // --- Fix #1: always disconnect the source node when we're done with it ---
  function cleanupAudioGraph() {
    if (source) {
      try {
        source.disconnect();
      } catch (_e) {
        /* already disconnected, ignore */
      }
    }
  }

  function tick() {
    if (freqData && onAmplitude) {
      analyser.getByteFrequencyData(freqData);
      onAmplitude(mapFrequenciesToBars(freqData, barCount));
    }
    if (!audioEl.paused && !audioEl.ended) rafId = requestAnimationFrame(tick);
  }

  return new Promise((resolve) => {
    audioEl.onplay = () => tick();
    audioEl.onended = () => {
      if (rafId) cancelAnimationFrame(rafId);
      URL.revokeObjectURL(url);
      cleanupAudioGraph();
      resolve({ ok: true, engine: VoiceEngine.PREMIUM, analysed: !!freqData });
    };
    audioEl.onerror = () => {
      if (rafId) cancelAnimationFrame(rafId);
      URL.revokeObjectURL(url);
      cleanupAudioGraph();
      resolve({ ok: false, engine: VoiceEngine.PREMIUM, error: "audio playback failed" });
    };
    audioEl.play().catch((err) => {
      cleanupAudioGraph();
      resolve({ ok: false, engine: VoiceEngine.PREMIUM, error: err.message });
    });
  });
}

// --- Fix #2: automatic fallback to FREE if PREMIUM fails ---
// speak(text, { barCount, onAmplitude }) -> Promise<{ ok, engine, analysed?, error?, fellBack? }>
export async function speak(text, { barCount = 32, onAmplitude } = {}) {
  if (engine === VoiceEngine.PREMIUM) {
    const result = await speakPremium(text, { barCount, onAmplitude });
    if (!result.ok) {
      console.warn(`[voice] PREMIUM failed (${result.error}) — falling back to FREE.`);
      const fallback = await speakFree(text);
      return { ...fallback, fellBack: true, premiumError: result.error };
    }
    return result;
  }
  return speakFree(text);
}
