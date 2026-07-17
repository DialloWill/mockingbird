import * as THREE from "three";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 7000;
const MORPH_DURATION = 1500; // ms
const RESPONSE_HOLD_MS = 8000; // how long the face stays up after a reply
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

// Uniform random point inside a disk of given radius, centered at (cx, cy)
function randomInDisk(cx, cy, radius) {
  const r = radius * Math.sqrt(Math.random());
  const theta = Math.random() * Math.PI * 2;
  return [cx + r * Math.cos(theta), cy + r * Math.sin(theta)];
}

// ---------------------------------------------------------------------------
// Shape B: a sculpted 3D head — a fibonacci-lattice ellipsoid (not a flat
// front-facing outline) with continuous surface displacement carving a
// brow ridge, recessed eye sockets, cheekbones, a bridged/tipped nose with
// nostril dimples, a jaw/chin taper, and closed neutral lips (no smile
// curve). Dense front-facing lattice + a sparser full-sphere layer for
// skull volume, plus a few explicit reinforcement clusters (eyes, brow
// line, nostrils, lip seam) so features read clearly at particle density.
// Still fully abstract/digital — proportion & volume carry the "face"
// read, not texture or photoreal shading.
// ---------------------------------------------------------------------------

function smoothFalloff01(d) {
  const t = Math.min(1, Math.max(0, d));
  return 1 - t * t * (3 - 2 * t);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function ellipseFalloff(dx, dy, rx, ry) {
  const d = Math.sqrt((dx / rx) * (dx / rx) + (dy / ry) * (dy / ry));
  return smoothFalloff01(d);
}

function segmentFalloff(x, y, x0, y0, x1, y1, thickness) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1e-6;
  let t = ((x - x0) * dx + (y - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x0 + t * dx;
  const py = y0 + t * dy;
  const d = Math.hypot(x - px, y - py);
  return smoothFalloff01(d / thickness);
}

// Head proportions (world units, roughly matching the sphere's on-screen
// scale so the morph doesn't jump in apparent size).
const HEAD_RX = 1.32;
const HEAD_RY = 1.95;
const HEAD_RZ = 1.48;

// Facial landmarks in unit-sphere-local (ux, uy) space, +y up, +z toward
// the camera (front of the face).
const EYE_X = 0.37, EYE_Y = 0.2;
const EYE_HALF_W = 0.21, EYE_UPPER_H = 0.1, EYE_LOWER_H = 0.075;
const BROW_Y = 0.38, BROW_HALF_W = 0.18; // half-width of a single eyebrow arc
const CHEEK_X = 0.42, CHEEK_Y = -0.18;
const NOSE_TOP_Y = 0.3, NOSE_TIP_Y = -0.22, NOSE_TIP_HALF_W = 0.085;
const NOSTRIL_X = 0.095, NOSTRIL_Y = -0.29;
const MOUTH_Y = -0.58, MOUTH_HALF_W = 0.26;
const CHIN_Y = -0.88;

// Only sculpt facial features on the front-facing part of the head; fades
// smoothly to nothing by the temples so the back/sides stay a plain,
// rounded cranium.
function frontMask(uz) {
  return smoothstep(-0.1, 0.35, uz);
}

// Jaw taper applied to the x-extent for the lower half of the head (all
// the way around, not just front) so the jawline reads as a defined
// silhouette rather than a perfectly round egg from any angle.
function jawXTaper(uy) {
  if (uy >= -0.25) return 1;
  const t = Math.min(1, (-uy - 0.25) / 0.55);
  return 1 - 0.22 * smoothstep(0, 1, t);
}

// A pure sphere/ellipsoid parametrization tapers to a sharp point at both
// poles (crown and chin) — anatomically wrong for a chin, which should be
// rounded/blunt. Clamping the pole coordinate before computing the
// horizontal radius keeps a minimum width near the very top/bottom
// instead of letting it collapse to zero.
function poleRadius(u) {
  const c = Math.max(-0.9, Math.min(0.9, u));
  return Math.sqrt(Math.max(0, 1 - c * c));
}

// Returns the world-space z displacement (protrusion positive, recession
// negative) for a point at unit-sphere-local (ux, uy, uz).
function facialDeltaZ(ux, uy, uz) {
  const fm = frontMask(uz);
  if (fm <= 0) return 0;

  let dz = 0;

  // brow ridge — a soft protruding arc above each eye
  for (const side of [-1, 1]) {
    const bx0 = side * (EYE_X - BROW_HALF_W);
    const bx1 = side * (EYE_X + BROW_HALF_W);
    const browFall = segmentFalloff(ux, uy, bx0, BROW_Y, bx1, BROW_Y, 0.1);
    dz += 0.05 * browFall;
  }

  // eye sockets — recessed almond regions beneath the brow
  for (const side of [-1, 1]) {
    const fall = ellipseFalloff(ux - side * EYE_X, uy - EYE_Y, EYE_HALF_W * 1.15, EYE_UPPER_H * 1.6);
    dz -= 0.09 * fall;
  }

  // cheekbones — broad soft bulges below/outward of the eyes
  for (const side of [-1, 1]) {
    const fall = ellipseFalloff(ux - side * CHEEK_X, uy - CHEEK_Y, 0.28, 0.24);
    dz += 0.05 * fall;
  }

  // nose bridge + tip — narrow near the brow, widening and protruding
  // more as it reaches the tip
  const noseT = smoothstep(NOSE_TIP_Y, NOSE_TOP_Y, uy); // 0 at tip, 1 at brow
  const noseTip = 1 - noseT; // 0 at brow, 1 at tip
  const bridgeHalfW = 0.045 + noseTip * (NOSE_TIP_HALF_W - 0.045);
  const noseXFall = smoothFalloff01(Math.abs(ux) / bridgeHalfW);
  const noseVerticalGate =
    smoothstep(NOSE_TIP_Y - 0.1, NOSE_TIP_Y, uy) * smoothstep(NOSE_TOP_Y + 0.1, NOSE_TOP_Y, uy);
  const noseBumpMag = 0.045 + noseTip * 0.11;
  dz += noseBumpMag * noseXFall * noseVerticalGate;

  // small nostril dimples tucked under the tip (subtle — this is texture,
  // not a hole cut through the bulge)
  for (const side of [-1, 1]) {
    const fall = ellipseFalloff(ux - side * NOSTRIL_X, uy - NOSTRIL_Y, 0.05, 0.032);
    dz -= 0.025 * fall;
  }

  // mouth — closed, neutral: upper lip (subtle) + lower lip (fuller) with
  // a thin seam groove between them, tapering flat at the corners. No
  // smile curve — the seam runs level. Kept subtle here; the explicit
  // upper/lower lip line reinforcement below carries most of the visible
  // lip-volume read.
  const mouthXFall = smoothFalloff01(Math.abs(ux) / MOUTH_HALF_W);
  const upperFall = ellipseFalloff(ux, uy - (MOUTH_Y + 0.05), MOUTH_HALF_W, 0.06) * mouthXFall;
  const lowerFall = ellipseFalloff(ux, uy - (MOUTH_Y - 0.06), MOUTH_HALF_W, 0.075) * mouthXFall;
  const seamFall = ellipseFalloff(ux, uy - MOUTH_Y, MOUTH_HALF_W * 0.94, 0.018) * mouthXFall;
  dz += 0.02 * upperFall;
  dz += 0.028 * lowerFall;
  dz -= 0.03 * seamFall;

  // chin — a small forward point beneath the mouth
  const chinFall = ellipseFalloff(ux, uy - CHIN_Y, 0.17, 0.13);
  dz += 0.055 * chinFall;

  return dz * fm;
}

// Projects a unit-sphere-local (ux, uy) onto the front of the head and
// writes a fully sculpted 3D point (used both by the lattice sampler and
// by the explicit reinforcement clusters below, so everything sits
// consistently on the same surface).
function sculptedPoint(ux, uy, extraDeltaZ, out, i3) {
  const uz = Math.sqrt(Math.max(0, 1 - ux * ux - uy * uy));
  const dz = facialDeltaZ(ux, uy, uz) + extraDeltaZ;
  const taperedUx = ux * jawXTaper(uy);
  out[i3] = taperedUx * HEAD_RX;
  out[i3 + 1] = uy * HEAD_RY;
  out[i3 + 2] = uz * HEAD_RZ + dz;
}

function generateFace(n) {
  const positions = new Float32Array(n * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const idxRef = { i: 0 };

  // --- base cranium: sparse full-sphere layer for all-around volume ----
  const backCount = Math.floor(n * 0.28);
  for (let k = 0; k < backCount; k++) {
    const uy = (k * (2 / backCount) - 1) + 1 / backCount;
    const r = poleRadius(uy);
    const phi = k * goldenAngle;
    const ux = Math.cos(phi) * r;
    const uz = Math.sin(phi) * r;
    const dz = facialDeltaZ(ux, uy, uz);
    const taperedUx = ux * jawXTaper(uy);
    positions[idxRef.i * 3] = taperedUx * HEAD_RX;
    positions[idxRef.i * 3 + 1] = uy * HEAD_RY;
    positions[idxRef.i * 3 + 2] = uz * HEAD_RZ + dz;
    idxRef.i++;
  }

  // --- dense front lattice: concentrates detail on the face itself -----
  // restricted to a forward "lune" (uz from -0.2 up through the front
  // pole) so the same particle budget resolves brow/socket/nose/mouth
  // detail far more clearly than spreading evenly over the whole skull.
  const frontCount = Math.floor(n * 0.36);
  const zMin = -0.2;
  const offset = (1 - zMin) / frontCount;
  for (let k = 0; k < frontCount; k++) {
    const uz = zMin + k * offset + offset / 2;
    const r = Math.sqrt(Math.max(0, 1 - uz * uz));
    const phi = k * goldenAngle;
    const ux = Math.cos(phi) * r;
    const uy = Math.sin(phi) * r;
    const dz = facialDeltaZ(ux, uy, uz);
    const taperedUx = ux * jawXTaper(uy);
    positions[idxRef.i * 3] = taperedUx * HEAD_RX;
    positions[idxRef.i * 3 + 1] = uy * HEAD_RY;
    positions[idxRef.i * 3 + 2] = uz * HEAD_RZ + dz;
    idxRef.i++;
  }

  // --- explicit eye reinforcement: almond outline + iris, recessed -----
  const eyeBudget = Math.floor(n * 0.13);
  const perEye = Math.floor(eyeBudget / 2);
  const perEyeOutline = Math.floor(perEye * 0.7);
  const perEyeIris = perEye - perEyeOutline;
  for (const side of [-1, 1]) {
    for (let i = 0; i < perEyeOutline; i++) {
      // t: 0 = nasal (inner) corner, 1 = temporal (outer) corner, for
      // BOTH eyes consistently — mirroring the sweep itself (not just the
      // eye center) so the outer-corner lift lands on the correct side
      // for each eye instead of getting flipped to the nasal side on one.
      const t = i / (perEyeOutline - 1);
      const s = -1 + 2 * t;
      const skewed = Math.pow(t, 1.3);
      const upper = EYE_UPPER_H * Math.sin(Math.PI * skewed);
      const lower = -EYE_LOWER_H * Math.sin(Math.PI * skewed);
      const localY = i % 2 === 0 ? upper : lower;
      const ex = side * (EYE_X + s * EYE_HALF_W);
      const ey = EYE_Y + localY;
      sculptedPoint(ex, ey, -0.045, positions, idxRef.i * 3);
      idxRef.i++;
    }
    for (let i = 0; i < perEyeIris; i++) {
      const [dx, dy] = randomInDisk(0, 0, EYE_HALF_W * 0.28);
      sculptedPoint(side * EYE_X + dx, EYE_Y + dy, -0.075, positions, idxRef.i * 3);
      idxRef.i++;
    }
  }

  // --- explicit brow-ridge reinforcement line ---------------------------
  const browBudget = Math.floor(n * 0.035);
  const perBrow = Math.floor(browBudget / 2);
  for (const side of [-1, 1]) {
    for (let i = 0; i < perBrow; i++) {
      const t = i / (perBrow - 1);
      const localX = -BROW_HALF_W + t * 2 * BROW_HALF_W;
      const arch = Math.sin(Math.PI * t) * 0.035;
      sculptedPoint(side * EYE_X + localX, BROW_Y + arch, 0.025, positions, idxRef.i * 3);
      idxRef.i++;
    }
  }

  // --- explicit nose bridge + tip reinforcement --------------------------
  // a crisp ridge line (narrow at the brow, widening toward the tip) plus
  // a small rounded cluster right at the tip, so the nose reads as a
  // defined bridge-to-tip structure rather than a vague sparse bump.
  const noseBudget = Math.floor(n * 0.045);
  const noseBridgeCount = Math.floor(noseBudget * 0.65);
  const noseTipCount = noseBudget - noseBridgeCount;
  for (let i = 0; i < noseBridgeCount; i++) {
    const t = i / (noseBridgeCount - 1); // 0 at brow, 1 at tip
    const uy = NOSE_TOP_Y + t * (NOSE_TIP_Y - NOSE_TOP_Y);
    const halfW = 0.025 + t * t * 0.045;
    const ux = (Math.random() * 2 - 1) * halfW;
    sculptedPoint(ux, uy, 0.018, positions, idxRef.i * 3);
    idxRef.i++;
  }
  for (let i = 0; i < noseTipCount; i++) {
    const [dx, dy] = randomInDisk(0, 0, 0.06);
    sculptedPoint(dx, NOSE_TIP_Y + dy * 0.6, 0.045, positions, idxRef.i * 3);
    idxRef.i++;
  }

  // --- explicit nostril rim reinforcement --------------------------------
  const nostrilBudget = Math.floor(n * 0.015);
  const perNostril = Math.floor(nostrilBudget / 2);
  for (const side of [-1, 1]) {
    for (let i = 0; i < perNostril; i++) {
      const [dx, dy] = randomInDisk(0, 0, 0.035);
      sculptedPoint(side * NOSTRIL_X + dx, NOSTRIL_Y + dy, -0.02, positions, idxRef.i * 3);
      idxRef.i++;
    }
  }

  // --- explicit upper/lower lip-line reinforcement ------------------------
  // two separate curves (fuller lower lip, subtler upper lip) that bow
  // away from the seam toward the center and taper to meet it at the
  // corners — this is what actually reads as lip *volume* rather than a
  // single line. No smile curve: both curves stay level overall, they
  // just have thickness.
  const lipBudget = Math.floor(n * 0.045);
  const perLipLine = Math.floor(lipBudget / 2);
  for (let pass = 0; pass < 2; pass++) {
    const isUpper = pass === 0;
    for (let i = 0; i < perLipLine; i++) {
      const t = i / (perLipLine - 1);
      const x = -MOUTH_HALF_W * 0.95 + t * 2 * (MOUTH_HALF_W * 0.95);
      const taper = Math.sin(Math.PI * t); // 0 at corners, 1 at center
      const yOff = isUpper ? 0.045 * taper : -0.062 * taper;
      const extra = isUpper ? 0.018 : 0.03;
      sculptedPoint(x, MOUTH_Y + yOff, extra, positions, idxRef.i * 3);
      idxRef.i++;
    }
  }

  // --- explicit lip-seam reinforcement (keeps the closed line crisp) ---
  const seamBudget = Math.floor(n * 0.025);
  for (let i = 0; i < seamBudget; i++) {
    const t = i / (seamBudget - 1);
    const x = -MOUTH_HALF_W * 0.92 + t * 2 * (MOUTH_HALF_W * 0.92);
    sculptedPoint(x, MOUTH_Y, -0.018, positions, idxRef.i * 3);
    idxRef.i++;
  }

  // --- lower-face (jaw/chin) density top-up absorbs any remainder ------
  // an extra spherical-cap lattice layer restricted to the lower head, so
  // the jaw/chin sits at higher density (reads more clearly) — sampled
  // as real points on the surface itself, not a floating outline shape.
  const jawRemainder = n - idxRef.i;
  if (jawRemainder > 0) {
    const yMin = -1;
    const yMax = -0.1;
    const offsetY = (yMax - yMin) / jawRemainder;
    for (let k = 0; k < jawRemainder; k++) {
      const uy = yMin + k * offsetY + offsetY / 2;
      const r = poleRadius(uy);
      const phi = k * goldenAngle;
      const ux = Math.cos(phi) * r;
      const uz = Math.sin(phi) * r;
      const dz = facialDeltaZ(ux, uy, uz);
      const taperedUx = ux * jawXTaper(uy);
      positions[idxRef.i * 3] = taperedUx * HEAD_RX;
      positions[idxRef.i * 3 + 1] = uy * HEAD_RY;
      positions[idxRef.i * 3 + 2] = uz * HEAD_RZ + dz;
      idxRef.i++;
    }
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Build geometry / material / points
// ---------------------------------------------------------------------------
const shapeSphere = generateSphere(PARTICLE_COUNT, 2.1);
const shapeFace = generateFace(PARTICLE_COUNT);

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
let showingFace = false;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const shapeLabel = document.getElementById("shape-label");

function morphToShape(target, isFace) {
  if (morphTo === target && (morphing || showingFace === isFace)) return;
  morphFrom = new Float32Array(geometry.attributes.position.array);
  morphTo = target;
  showingFace = isFace;
  shapeLabel.textContent = isFace ? "face" : "sphere";
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
  morphToShape(shapeFace, true);
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
    if (t >= 1) morphing = false;
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
