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

let engine = VoiceEngine.FREE;
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

// Browsers block audio until a real user gesture has occurred at least
// once; call this from a click/keydown handler as early as possible.
export function unlockAudio() {
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Maps an AnalyserNode frequency snapshot onto `barCount` bars. Voice
// energy concentrates in the lower/mid bins, so bins are sampled with a
// mild logarithmic spread rather than linearly — otherwise the back half
// of the bars would always read near-zero.
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
    window.speechSynthesis.cancel(); // stop anything already in flight
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
    // Web Audio graph wiring failed for some reason — fall back to plain
    // playback with no amplitude analysis rather than losing audio.
    audioEl.volume = 1;
  }

  const freqData = source ? new Uint8Array(analyser.frequencyBinCount) : null;
  let rafId = null;

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
      resolve({ ok: true, engine: VoiceEngine.PREMIUM, analysed: !!freqData });
    };
    audioEl.onerror = () => {
      if (rafId) cancelAnimationFrame(rafId);
      resolve({ ok: false, engine: VoiceEngine.PREMIUM, error: "audio playback failed" });
    };
    audioEl.play().catch((err) =>
      resolve({ ok: false, engine: VoiceEngine.PREMIUM, error: err.message })
    );
  });
}

// speak(text, { barCount, onAmplitude }) -> Promise<{ ok, engine, analysed?, error? }>
// onAmplitude(Float32Array(barCount)) is called on every animation frame
// while PREMIUM audio is actually playing. It is never called for FREE —
// callers should keep using their own simulated animation in that case.
export async function speak(text, { barCount = 32, onAmplitude } = {}) {
  if (engine === VoiceEngine.PREMIUM) {
    return speakPremium(text, { barCount, onAmplitude });
  }
  return speakFree(text);
}
