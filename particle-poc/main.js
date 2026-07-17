import * as THREE from "three";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 7000;
const MORPH_DURATION = 1500; // ms
const RESPONSE_HOLD_MS = 8000; // how long the waveform stays up after a reply
const API_URL = "http://localhost:5000/chat";
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
const barCurrentAmp = new Float32Array(BAR_COUNT).fill(BAR_BASELINE_AMP);
const barTargetAmp = new Float32Array(BAR_COUNT).fill(BAR_BASELINE_AMP);
const barNextChangeAt = new Float32Array(BAR_COUNT).fill(0);

function updateWaveformBars(time, delta) {
  for (let bar = 0; bar < BAR_COUNT; bar++) {
    if (time >= barNextChangeAt[bar]) {
      let next = BAR_MIN_TARGET_AMP + Math.random() * (BAR_MAX_TARGET_AMP - BAR_MIN_TARGET_AMP);
      const left = bar > 0 ? barTargetAmp[bar - 1] : next;
      const right = bar < BAR_COUNT - 1 ? barTargetAmp[bar + 1] : next;
      barTargetAmp[bar] = next * 0.55 + left * 0.225 + right * 0.225;
      barNextChangeAt[bar] = time + 0.14 + Math.random() * 0.22;
    }
  }
  const smoothing = 1 - Math.exp(-7 * delta);
  for (let bar = 0; bar < BAR_COUNT; bar++) {
    barCurrentAmp[bar] += (barTargetAmp[bar] - barCurrentAmp[bar]) * smoothing;
  }
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
const responseBox = document.getElementById("response-box");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");

function setAppState(next) {
  appState = next;
  stateLabel.textContent = next;
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
}

function enterErrorIdle(message) {
  clearTimeout(holdTimer);
  setAppState("idle");
  responseBox.textContent = message;
  responseBox.classList.add("visible", "error");
  morphToShape(shapeSphere, false);
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
  material.size = BASE_SIZE + params.sizePulseAmp * pulse01;
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
