import * as THREE from "three";
import { speak, setVoiceEngine, getVoiceEngine, unlockAudio, VoiceEngine } from "./voice.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 7000;
const MORPH_DURATION = 1500; // ms
const RESPONSE_HOLD_MS = 8000; // how long the waveform stays up after a reply
const API_URL = "http://localhost:5000/chat";
const CANNED_RESPONSE = "Is there anything I can assist you with today?";
const COLOR_A = new THREE.Color("#0066ff");
const COLOR_B = new THREE.Color("#00d4ff");
const BASE_SIZE = 0.06;

// ---------------------------------------------------------------------------
// Renderer / Scene / Camera
// ---------------------------------------------------------------------------
const container = document.getElementById("canvas-container");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0f);
scene.fog = new THREE.FogExp2(0x0a0a0f, 0.05);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 0, 7.5);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Soft circular sprite texture for glow-like points
// ---------------------------------------------------------------------------
function makeParticleTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(200,240,255,0.9)");
  gradient.addColorStop(0.6, "rgba(0,180,255,0.35)");
  gradient.addColorStop(1, "rgba(0,120,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Shape generators — each returns a Float32Array of length PARTICLE_COUNT * 3
// ---------------------------------------------------------------------------

// Shape A: fibonacci-lattice sphere (evenly distributed points on a sphere)
function generateSphere(n, radius) {
  const positions = new Float32Array(n * 3);
  const offset = 2 / n;
  const increment = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = i * offset - 1 + offset / 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * increment;
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;
    positions[i * 3] = x * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = z * radius;
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Shape B: a horizontal audio-waveform / level-meter formation — vertical
// bar-like particle clusters arranged in a shallow arc, evoking a voice
// equalizer rather than any literal face. Built from the same point-cloud
// morph mechanism as every other shape; what makes it "speak" is a live,
// smoothly-eased, semi-randomized per-bar amplitude animation that runs
// for as long as the response is being displayed (see updateWaveformBars
// / the RESPONDING branch in the render loop below).
// ---------------------------------------------------------------------------

const BAR_COUNT = 32;
const BAR_SPREAD = 4.0; // total horizontal span, world units
const BAR_WIDTH = (BAR_SPREAD / BAR_COUNT) * 0.6; // leaves a visible gap between bars
const BAR_ARC_DEPTH = 0.6; // gentle bow toward the camera at the center
const BAR_BASE_Y = -1.5; // floor the bars grow up from
const BAR_MAX_HEIGHT = 2.7;
const BAR_BASELINE_AMP = BAR_MAX_HEIGHT * 0.12; // resting height before "speech" kicks in
const BAR_MIN_TARGET_AMP = BAR_MAX_HEIGHT * 0.08;
const BAR_MAX_TARGET_AMP = BAR_MAX_HEIGHT * 0.92;

// Per-particle layout — fixed for the lifetime of the page, reused both to
// build the static baseline morph target and for the live animation.
const waveformBarIndex = new Int32Array(PARTICLE_COUNT);
const waveformT = new Float32Array(PARTICLE_COUNT); // random fraction up the bar
const waveformX = new Float32Array(PARTICLE_COUNT);
const waveformZ = new Float32Array(PARTICLE_COUNT);

function buildWaveformLayout(n) {
  const perBar = Math.ceil(n / BAR_COUNT);
  let i = 0;
  for (let bar = 0; bar < BAR_COUNT && i < n; bar++) {
    const barCenterX = -BAR_SPREAD / 2 + (bar + 0.5) * (BAR_SPREAD / BAR_COUNT);
    const archNorm = barCenterX / (BAR_SPREAD / 2); // -1..1
    const barCenterZ = BAR_ARC_DEPTH * (1 - archNorm * archNorm);
    const count = Math.min(perBar, n - i);
    for (let k = 0; k < count; k++) {
      waveformBarIndex[i] = bar;
      waveformT[i] = Math.random();
      waveformX[i] = barCenterX + (Math.random() - 0.5) * BAR_WIDTH;
      waveformZ[i] = barCenterZ + (Math.random() - 0.5) * BAR_WIDTH * 0.8;
      i++;
    }
  }
}

// Writes the waveform point cloud into `out` for the given per-bar
// amplitudes (length BAR_COUNT) — used both for the static baseline morph
// target and, every frame, to animate the live "speaking" bars.
function writeWaveformPositions(out, barAmps) {
  const count = out.length / 3;
  for (let i = 0; i < count; i++) {
    const amp = barAmps[waveformBarIndex[i]];
    out[i * 3] = waveformX[i];
    out[i * 3 + 1] = BAR_BASE_Y + waveformT[i] * amp;
    out[i * 3 + 2] = waveformZ[i];
  }
}

// Live per-bar amplitude state: each bar random-walks to a new target on
// its own loosely-randomized interval, blended a little with its
// neighbors' targets so the row reads as a flowing wave rather than
// independent per-bar noise, then eases toward that target every frame
// (never snaps) — the same smoothing philosophy as the THINKING breathing.
//
// When the PREMIUM voice engine is actually playing audio, voice.js feeds
// real per-bar frequency amplitude in here instead (see liveAmpBars below,
// wired up in enterResponding); the FREE engine (Web Speech API) can't
// expose its audio for analysis at all, so it always uses the simulated
// random walk — a known platform limitation, not a bug.
const barCurrentAmp = new Float32Array(BAR_COUNT).fill(BAR_BASELINE_AMP);
const barTargetAmp = new Float32Array(BAR_COUNT).fill(BAR_BASELINE_AMP);
const barNextChangeAt = new Float32Array(BAR_COUNT).fill(0);

let liveAmpBars = null; // Float32Array(BAR_COUNT), 0..1, or null when unavailable
let liveAmpTimestamp = -Infinity;
const LIVE_AMP_FRESHNESS_MS = 150; // if no fresh frame arrives, assume playback ended

function updateWaveformBars(time, delta) {
  const useLiveAudio = liveAmpBars && performance.now() - liveAmpTimestamp < LIVE_AMP_FRESHNESS_MS;

  if (useLiveAudio) {
    for (let bar = 0; bar < BAR_COUNT; bar++) {
      barTargetAmp[bar] = BAR_MIN_TARGET_AMP + liveAmpBars[bar] * (BAR_MAX_TARGET_AMP - BAR_MIN_TARGET_AMP);
    }
  } else {
    for (let bar = 0; bar < BAR_COUNT; bar++) {
      if (time >= barNextChangeAt[bar]) {
        let next = BAR_MIN_TARGET_AMP + Math.random() * (BAR_MAX_TARGET_AMP - BAR_MIN_TARGET_AMP);
        const left = bar > 0 ? barTargetAmp[bar - 1] : next;
        const right = bar < BAR_COUNT - 1 ? barTargetAmp[bar + 1] : next;
        barTargetAmp[bar] = next * 0.55 + left * 0.225 + right * 0.225;
        barNextChangeAt[bar] = time + 0.14 + Math.random() * 0.22;
      }
    }
  }

  // same eased smoothing regardless of source, so real-audio-driven bars
  // are just as free of harsh snapping as the simulated ones
  const smoothing = 1 - Math.exp(-7 * delta);
  for (let bar = 0; bar < BAR_COUNT; bar++) {
    barCurrentAmp[bar] += (barTargetAmp[bar] - barCurrentAmp[bar]) * smoothing;
  }
}

function smoothFalloff01(d) {
  const t = Math.min(1, Math.max(0, d));
  return 1 - t * t * (3 - 2 * t);
}

function resetWaveformBars(time) {
  for (let bar = 0; bar < BAR_COUNT; bar++) {
    barCurrentAmp[bar] = BAR_BASELINE_AMP;
    barTargetAmp[bar] = BAR_BASELINE_AMP;
    barNextChangeAt[bar] = time;
  }
}

// ---------------------------------------------------------------------------
// Build geometry / material / points
// ---------------------------------------------------------------------------
const shapeSphere = generateSphere(PARTICLE_COUNT, 2.1);
buildWaveformLayout(PARTICLE_COUNT);
const baselineAmps = new Float32Array(BAR_COUNT).fill(BAR_BASELINE_AMP);
const shapeWaveform = new Float32Array(PARTICLE_COUNT * 3);
writeWaveformPositions(shapeWaveform, baselineAmps);

const geometry = new THREE.BufferGeometry();
const currentPositions = new Float32Array(shapeSphere); // start on the sphere
geometry.setAttribute("position", new THREE.BufferAttribute(currentPositions, 3));

// per-particle color, randomly interpolated across the electric-blue range
const colors = new Float32Array(PARTICLE_COUNT * 3);
const tmpColor = new THREE.Color();
for (let i = 0; i < PARTICLE_COUNT; i++) {
  tmpColor.copy(COLOR_A).lerp(COLOR_B, Math.random());
  colors[i * 3] = tmpColor.r;
  colors[i * 3 + 1] = tmpColor.g;
  colors[i * 3 + 2] = tmpColor.b;
}
geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

const material = new THREE.PointsMaterial({
  size: BASE_SIZE,
  map: makeParticleTexture(),
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});

const points = new THREE.Points(geometry, material);
scene.add(points);

// ---------------------------------------------------------------------------
// Shape morph mechanics
// ---------------------------------------------------------------------------
let morphing = false;
let morphStart = 0;
let morphFrom = shapeSphere;
let morphTo = shapeSphere;
let showingWaveform = false;
// True once the sphere->waveform morph has finished and the live per-bar
// amplitude animation has taken over (see the RESPONDING branch in the
// render loop). Any new morph immediately clears this.
let waveformLive = false;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const shapeLabel = document.getElementById("shape-label");

function morphToShape(target, isWaveform) {
  if (!waveformLive && morphTo === target && (morphing || showingWaveform === isWaveform)) return;
  morphFrom = new Float32Array(geometry.attributes.position.array);
  morphTo = target;
  showingWaveform = isWaveform;
  waveformLive = false;
  shapeLabel.textContent = isWaveform ? "waveform" : "sphere";
  morphStart = performance.now();
  morphing = true;
}

// ---------------------------------------------------------------------------
// App state machine: idle -> thinking -> responding -> idle
// ---------------------------------------------------------------------------
const STATE_PARAMS = {
  idle: { breatheAmp: 0.035, breatheFreq: 0.18, sizePulseAmp: 0.0, opacityPulseAmp: 0.0, rotSpeed: 0.05 },
  thinking: { breatheAmp: 0.12, breatheFreq: 0.34, sizePulseAmp: 0.02, opacityPulseAmp: 0.22, rotSpeed: 0.09 },
  responding: { breatheAmp: 0.02, breatheFreq: 0.14, sizePulseAmp: 0.0, opacityPulseAmp: 0.0, rotSpeed: 0.045 },
};
const params = { ...STATE_PARAMS.idle };

let appState = "idle";
let holdTimer = null;

const stateLabel = document.getElementById("state-label");
const hoverLabel = document.getElementById("hover-label");
const voiceStatusLabel = document.getElementById("voice-status-label");
const responseBox = document.getElementById("response-box");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const voiceEngineSelect = document.getElementById("voice-engine");
const humToggleBtn = document.getElementById("hum-toggle");
const humVolumeInput = document.getElementById("hum-volume");

// ---------------------------------------------------------------------------
// Ambient idle hum — two soft detuned sine oscillators through a lowpass
// filter, gated to a near-silent gain outside of IDLE. Created lazily on
// the first user gesture (browser autoplay policy blocks audio otherwise).
// ---------------------------------------------------------------------------
let ambientCtx = null;
let ambientGain = null;
let ambientMuted = false;
let ambientVolume = parseFloat(humVolumeInput.value);

function setAmbientTargetGain(target, rampSeconds = 1.2) {
  if (!ambientGain) return;
  const now = ambientCtx.currentTime;
  const safeTarget = Math.max(0.0001, target);
  ambientGain.gain.cancelScheduledValues(now);
  ambientGain.gain.setValueAtTime(ambientGain.gain.value, now);
  ambientGain.gain.linearRampToValueAtTime(safeTarget, now + rampSeconds);
}

function ensureAmbientHum() {
  if (ambientCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  ambientCtx = new Ctx();
  ambientGain = ambientCtx.createGain();
  ambientGain.gain.value = 0;

  const filter = ambientCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;

  const osc1 = ambientCtx.createOscillator();
  osc1.type = "sine";
  osc1.frequency.value = 110;
  const osc2 = ambientCtx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = 110 * 1.5; // soft fifth overtone for a bit of shimmer
  osc2.detune.value = 6;

  osc1.connect(filter);
  osc2.connect(filter);
  filter.connect(ambientGain);
  ambientGain.connect(ambientCtx.destination);
  osc1.start();
  osc2.start();

  if (appState === "idle") setAmbientTargetGain(ambientMuted ? 0 : ambientVolume);
}

function unlockAllAudio() {
  ensureAmbientHum();
  unlockAudio(); // voice.js's own AudioContext, for PREMIUM playback
  if (ambientCtx && ambientCtx.state === "suspended") ambientCtx.resume().catch(() => {});
}
window.addEventListener("pointerdown", unlockAllAudio, { once: true });
window.addEventListener("keydown", unlockAllAudio, { once: true });

humToggleBtn.addEventListener("click", () => {
  ambientMuted = !ambientMuted;
  humToggleBtn.textContent = ambientMuted ? "🔇" : "🔊";
  if (appState === "idle") setAmbientTargetGain(ambientMuted ? 0 : ambientVolume, 0.4);
});
humVolumeInput.addEventListener("input", () => {
  ambientVolume = parseFloat(humVolumeInput.value);
  if (appState === "idle" && !ambientMuted) setAmbientTargetGain(ambientVolume, 0.15);
});

voiceEngineSelect.addEventListener("change", () => {
  setVoiceEngine(voiceEngineSelect.value === "premium" ? VoiceEngine.PREMIUM : VoiceEngine.FREE);
  voiceStatusLabel.textContent = getVoiceEngine();
});

function setAppState(next) {
  appState = next;
  stateLabel.textContent = next;
  // ambient hum only plays during IDLE
  if (ambientCtx) {
    setAmbientTargetGain(next === "idle" ? (ambientMuted ? 0 : ambientVolume) : 0, next === "idle" ? 1.2 : 0.6);
  }
}

function enterIdle() {
  clearTimeout(holdTimer);
  setAppState("idle");
  morphToShape(shapeSphere, false);
}

function enterThinking() {
  clearTimeout(holdTimer);
  setAppState("thinking");
  responseBox.classList.remove("visible", "error");
  morphToShape(shapeSphere, false);
}

function enterResponding(text) {
  setAppState("responding");
  responseBox.textContent = text;
  responseBox.classList.remove("error");
  responseBox.classList.add("visible");
  morphToShape(shapeWaveform, true);
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => {
    if (appState === "responding") enterIdle();
  }, RESPONSE_HOLD_MS);

  // speak the response aloud — the live per-bar amplitude callback only
  // ever fires for the PREMIUM engine (see voice.js); FREE always leaves
  // the bars on their simulated animation.
  liveAmpBars = null;
  voiceStatusLabel.textContent = `${getVoiceEngine()} (speaking…)`;
  speak(text, {
    barCount: BAR_COUNT,
    onAmplitude: (bars) => {
      liveAmpBars = bars;
      liveAmpTimestamp = performance.now();
    },
  }).then((result) => {
    if (result.ok) {
      voiceStatusLabel.textContent = result.analysed
        ? `${result.engine} (live amplitude)`
        : `${result.engine} (simulated)`;
    } else {
      voiceStatusLabel.textContent = `${result.engine} error`;
      console.warn("[voice] speak failed:", result.error);
    }
  });
}

function enterErrorIdle(message) {
  clearTimeout(holdTimer);
  setAppState("idle");
  responseBox.textContent = message;
  responseBox.classList.add("visible", "error");
  morphToShape(shapeSphere, false);
}

// Clicking the sphere while idle triggers the same THINKING -> RESPONDING
// lifecycle as a real chat message, but with a fixed canned reply and no
// network call at all.
function triggerCannedResponse() {
  if (appState !== "idle") return;
  enterThinking();
  setTimeout(() => {
    if (appState === "thinking") enterResponding(CANNED_RESPONSE);
  }, 900);
}

async function sendMessage(rawMessage) {
  const message = rawMessage.trim();
  if (!message || appState === "thinking") return;

  enterThinking();
  sendBtn.disabled = true;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `Request failed with status ${res.status}`);
    }

    enterResponding(data.response || "(empty response)");
  } catch (err) {
    const isNetworkErr = err instanceof TypeError;
    const msg = isNetworkErr
      ? "Couldn't reach Jarvis's API — is the Flask server running on localhost:5000?"
      : err.message;
    enterErrorIdle(msg);
  } finally {
    sendBtn.disabled = false;
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = chatInput.value;
  chatInput.value = "";
  sendMessage(message);
});

// ---------------------------------------------------------------------------
// Hover / click interactivity — only active while IDLE. Hovering raycasts
// against the actual particle points (not just a screen-space circle) and
// eases in a localized outward ripple plus a small glow boost near the
// cursor; clicking while hovered runs the canned-response lifecycle.
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.14;
const pointerNDC = new THREE.Vector2(10, 10); // starts off-screen: no false hover before first move
let isHoveringSphere = false;
let hoverEase = 0;
const hoverPointLocal = new THREE.Vector3();
const RIPPLE_RADIUS = 0.9;
const RIPPLE_STRENGTH = 0.24;

renderer.domElement.addEventListener("pointermove", (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
});
renderer.domElement.addEventListener("pointerleave", () => {
  pointerNDC.set(10, 10);
});
renderer.domElement.addEventListener("click", () => {
  if (appState === "idle" && isHoveringSphere) triggerCannedResponse();
});

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
const posAttr = geometry.attributes.position;
const clock = new THREE.Clock();

let frameCount = 0;
let fpsAccum = 0;
const fpsLabel = document.getElementById("fps-label");

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);
  const time = clock.getElapsedTime();

  // morph tween
  if (morphing) {
    const elapsed = performance.now() - morphStart;
    const t = Math.min(elapsed / MORPH_DURATION, 1);
    const eased = easeInOutCubic(t);
    const arr = posAttr.array;
    const from = morphFrom;
    const to = morphTo;
    for (let i = 0; i < arr.length; i++) {
      arr[i] = from[i] + (to[i] - from[i]) * eased;
    }
    posAttr.needsUpdate = true;
    if (t >= 1) {
      morphing = false;
      if (showingWaveform && appState === "responding") {
        // hand off from the static morph to the live "speaking" animation,
        // seeded from the baseline it just settled into so there's no pop
        resetWaveformBars(time);
        waveformLive = true;
      }
    }
  }

  // live waveform "speaking" animation — runs for as long as we're
  // actively responding and past the initial morph-in
  if (waveformLive) {
    updateWaveformBars(time, delta);
    writeWaveformPositions(posAttr.array, barCurrentAmp);
    posAttr.needsUpdate = true;
  }

  // hover detection — only while idle and not mid-morph, so it never
  // fights the morph tween or the live waveform for the position buffer
  if (appState === "idle" && !morphing) {
    raycaster.setFromCamera(pointerNDC, camera);
    const hits = raycaster.intersectObject(points, false);
    isHoveringSphere = hits.length > 0;
    if (isHoveringSphere) {
      hoverPointLocal.copy(hits[0].point);
      points.worldToLocal(hoverPointLocal);
    }
  } else {
    isHoveringSphere = false;
  }
  hoverLabel.textContent = isHoveringSphere ? "yes" : "no";

  const hoverSmoothing = 1 - Math.exp(-6 * delta);
  hoverEase += ((isHoveringSphere ? 1 : 0) - hoverEase) * hoverSmoothing;
  if (hoverEase < 0.001) hoverEase = 0;

  // localized ripple/expansion around the cursor, eased in and out — only
  // touches the buffer while idle and while there's something to show
  // (actively hovering, or still easing out after the mouse left)
  if (appState === "idle" && !morphing && (isHoveringSphere || hoverEase > 0)) {
    const arr = posAttr.array;
    const hx = hoverPointLocal.x;
    const hy = hoverPointLocal.y;
    const hz = hoverPointLocal.z;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const rx = shapeSphere[i * 3];
      const ry = shapeSphere[i * 3 + 1];
      const rz = shapeSphere[i * 3 + 2];
      const dist = Math.hypot(rx - hx, ry - hy, rz - hz);
      const falloff = smoothFalloff01(dist / RIPPLE_RADIUS);
      const len = Math.hypot(rx, ry, rz) || 1;
      const push = (RIPPLE_STRENGTH * falloff * hoverEase) / len;
      arr[i * 3] = rx + rx * push;
      arr[i * 3 + 1] = ry + ry * push;
      arr[i * 3 + 2] = rz + rz * push;
    }
    posAttr.needsUpdate = true;
  }

  // smoothly ease breathing/pulse params toward the active state's targets
  // (rather than snapping) so transitions never look glitchy.
  const target = STATE_PARAMS[appState];
  const smoothing = 1 - Math.exp(-2.2 * delta);
  for (const key in params) {
    params[key] += (target[key] - params[key]) * smoothing;
  }

  const phase = time * params.breatheFreq * Math.PI * 2;
  const breathe = 1 + Math.sin(phase) * params.breatheAmp;
  points.scale.setScalar(breathe);
  points.rotation.y += delta * params.rotSpeed;

  const pulse01 = Math.sin(phase + 0.4) * 0.5 + 0.5;
  material.size = BASE_SIZE + params.sizePulseAmp * pulse01 + hoverEase * 0.014;
  material.opacity = 1 - params.opacityPulseAmp * (1 - pulse01);

  renderer.render(scene, camera);

  frameCount++;
  fpsAccum += delta;
  if (fpsAccum >= 0.5) {
    fpsLabel.textContent = Math.round(frameCount / fpsAccum);
    frameCount = 0;
    fpsAccum = 0;
  }
}

animate();
