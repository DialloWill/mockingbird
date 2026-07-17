import * as THREE from "three";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 6000;
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

// Jaw/cheek silhouette radius at angle t (0 = right side, increases CCW).
// Not a plain ellipse: tapers toward a chin, narrows slightly at the crown,
// and bulges gently at the cheeks, so the outline reads as a jaw rather
// than an emoji-oval.
function faceSilhouette(t, rx, ry) {
  const y = Math.sin(t);
  let rxMod = rx;
  if (y < -0.35) {
    const chinT = Math.min(1, (-y - 0.35) / 0.65);
    rxMod *= 1 - 0.3 * Math.pow(chinT, 1.6);
  } else if (y > 0.55) {
    const foreheadT = Math.min(1, (y - 0.55) / 0.45);
    rxMod *= 1 - 0.12 * foreheadT;
  } else {
    rxMod *= 1 + 0.05 * Math.cos((y + 0.15) * Math.PI * 0.6);
  }
  return { x: Math.cos(t) * rxMod, y: Math.sin(t) * ry };
}

// Almond-shaped lid curve sampler (used for both eyes and the mouth's lip
// curves) — a vesica shape: two arcs meeting at pointed corners.
// t: 0..1 across the shape, sign: +1/-1 for upper vs lower boundary.
function vesicaY(t, height, skew) {
  const skewed = Math.pow(t, skew);
  return height * Math.sin(Math.PI * skewed);
}

function generateEye(cx, cy, halfW, upperH, lowerH, outlineCount, irisCount, out, idxRef, jitterZ) {
  for (let i = 0; i < outlineCount; i++) {
    const t = i / (outlineCount - 1);
    const xLocal = -halfW + t * 2 * halfW;
    // skew the peak toward the outer (temporal) corner for a subtle
    // upswept, alert look — outer corner is at t=1 in local space.
    const upper = vesicaY(t, upperH, 1.35);
    const lower = -vesicaY(t, lowerH, 1.1);
    const y = i % 2 === 0 ? upper : lower;
    out[idxRef.i * 3] = cx + xLocal;
    out[idxRef.i * 3 + 1] = cy + y;
    out[idxRef.i * 3 + 2] = jitterZ() + 0.06;
    idxRef.i++;
  }
  for (let i = 0; i < irisCount; i++) {
    const [dx, dy] = randomInDisk(0, 0, halfW * 0.3);
    out[idxRef.i * 3] = cx + dx;
    out[idxRef.i * 3 + 1] = cy + dy;
    out[idxRef.i * 3 + 2] = jitterZ() + 0.12;
    idxRef.i++;
  }
}

// Shape B: an expressive, structured particle face — almond eyes with
// brow hints, a bridged nose with nostril hints, a two-lip mouth curve,
// jaw/cheek contour, and sparse interior volume points for a sculpted
// (rather than flat-emoji) read. Still fully abstract/digital.
function generateFace(n) {
  const positions = new Float32Array(n * 3);
  const jitterZ = () => (Math.random() - 0.5) * 0.16;

  // feature budget (percentages of n) — cheekFill absorbs whatever is left
  // after every other feature (including per-side floor() rounding), so
  // the total always sums to exactly n with no unfilled trailing points.
  const jawCount = Math.floor(n * 0.22);
  const cheekContourCount = Math.floor(n * 0.08); // split across two arcs
  const browCount = Math.floor(n * 0.04); // split across two brows
  const eyeCount = Math.floor(n * 0.22); // split across two eyes
  const noseCount = Math.floor(n * 0.1);
  const mouthCount = Math.floor(n * 0.16);

  const idxRef = { i: 0 };
  const faceRX = 1.62;
  const faceRY = 2.25;

  // --- jaw / cheek silhouette -----------------------------------------
  for (let i = 0; i < jawCount; i++) {
    const t = (i / jawCount) * Math.PI * 2;
    const wobble = 1 + (Math.random() - 0.5) * 0.025;
    const { x, y } = faceSilhouette(t, faceRX * wobble, faceRY * wobble);
    positions[idxRef.i * 3] = x;
    positions[idxRef.i * 3 + 1] = y;
    positions[idxRef.i * 3 + 2] = jitterZ();
    idxRef.i++;
  }

  // --- secondary cheek contour arcs (depth/volume hint, pushed back) --
  const cheekArcRanges = [
    [Math.PI * 0.12, Math.PI * 0.62], // right cheek
    [Math.PI * 1.12, Math.PI * 1.62], // left cheek
  ];
  const perArc = Math.floor(cheekContourCount / 2);
  for (const [t0, t1] of cheekArcRanges) {
    for (let i = 0; i < perArc; i++) {
      const t = t0 + (i / perArc) * (t1 - t0);
      const { x, y } = faceSilhouette(t, faceRX * 0.88, faceRY * 0.9);
      positions[idxRef.i * 3] = x;
      positions[idxRef.i * 3 + 1] = y;
      positions[idxRef.i * 3 + 2] = jitterZ() - 0.28;
      idxRef.i++;
    }
  }
  // remainder from the floor division goes to interior fill naturally
  // via cheekFillCount below (idxRef tracks true position regardless).

  // --- eyebrows ----------------------------------------------------
  const browHalfW = 0.34;
  const browY = 0.78;
  const eyeCX = 0.62;
  const eyeCY = 0.32;
  const perBrow = Math.floor(browCount / 2);
  for (const side of [-1, 1]) {
    for (let i = 0; i < perBrow; i++) {
      const t = i / (perBrow - 1);
      // t=0 is the inner (nasal) end, t=1 is the outer end, which sits
      // slightly higher for a bit of natural arch + gentle lift.
      const arch = Math.sin(Math.PI * t) * 0.09;
      const lift = t * 0.1;
      const x = side * (eyeCX - browHalfW + t * 2 * browHalfW);
      const y = browY + arch + lift;
      positions[idxRef.i * 3] = x;
      positions[idxRef.i * 3 + 1] = y;
      positions[idxRef.i * 3 + 2] = jitterZ() + 0.08;
      idxRef.i++;
    }
  }

  // --- eyes (almond outline + iris cluster) ---------------------------
  const perEyeTotal = Math.floor(eyeCount / 2);
  const perEyeOutline = Math.floor(perEyeTotal * 0.72);
  const perEyeIris = perEyeTotal - perEyeOutline;
  for (const side of [-1, 1]) {
    generateEye(
      side * eyeCX,
      eyeCY,
      0.34,
      0.22,
      0.16,
      perEyeOutline,
      perEyeIris,
      positions,
      idxRef,
      jitterZ
    );
  }

  // --- nose bridge + nostril hints -------------------------------------
  const bridgeCount = Math.floor(noseCount * 0.65);
  const nostrilCount = noseCount - bridgeCount;
  const noseTopY = 0.62;
  const noseTipY = -0.12;
  for (let i = 0; i < bridgeCount; i++) {
    const t = i / (bridgeCount - 1);
    const wiggle = Math.sin(t * Math.PI * 1.4) * 0.035;
    const spread = Math.pow(t, 3) * 0.1 * (Math.random() - 0.5);
    positions[idxRef.i * 3] = wiggle + spread;
    positions[idxRef.i * 3 + 1] = noseTopY + t * (noseTipY - noseTopY);
    positions[idxRef.i * 3 + 2] = jitterZ() + 0.14 * t;
    idxRef.i++;
  }
  const perNostril = Math.floor(nostrilCount / 2);
  for (const side of [-1, 1]) {
    for (let i = 0; i < perNostril; i++) {
      const [dx, dy] = randomInDisk(0, 0, 0.05);
      positions[idxRef.i * 3] = side * 0.14 + dx;
      positions[idxRef.i * 3 + 1] = noseTipY - 0.05 + dy;
      positions[idxRef.i * 3 + 2] = jitterZ() + 0.12;
      idxRef.i++;
    }
  }

  // --- mouth: separate upper/lower lip curves, tapered at the corners --
  const mouthHalfW = 0.52;
  const mouthY = -1.05;
  const upperLipMax = 0.055;
  const lowerLipMax = 0.1;
  const perLip = Math.floor(mouthCount / 2);
  for (let pass = 0; pass < 2; pass++) {
    const isUpper = pass === 0;
    for (let i = 0; i < perLip; i++) {
      const t = i / (perLip - 1);
      const x = -mouthHalfW + t * 2 * mouthHalfW;
      const smile = Math.sin(Math.PI * t); // 0 at corners, 1 at center
      const seam = mouthY - 0.16 * smile; // corners up, center dips (smile)
      const cupidBow = isUpper ? 0.012 * Math.sin(4 * Math.PI * t) * smile : 0;
      const thickness = (isUpper ? upperLipMax : lowerLipMax) * smile;
      const y = isUpper ? seam + thickness + cupidBow : seam - thickness;
      positions[idxRef.i * 3] = x;
      positions[idxRef.i * 3 + 1] = y;
      positions[idxRef.i * 3 + 2] = jitterZ();
      idxRef.i++;
    }
  }

  // --- sparse interior cheek/volume fill --------------------------------
  // rejection-sampled so it avoids the eyes/nose/mouth, giving a subtle
  // sense of sculpted mass without turning the face into a filled disc.
  // Uses whatever budget remains (n - idxRef.i) so per-side floor()
  // rounding in the features above never leaves unfilled trailing points.
  const cheekFillCount = n - idxRef.i;
  let filled = 0;
  let attempts = 0;
  while (filled < cheekFillCount && attempts < cheekFillCount * 12) {
    attempts++;
    const t = Math.random() * Math.PI * 2;
    const rScale = 0.25 + Math.random() * 0.65;
    const { x: bx, y: by } = faceSilhouette(t, faceRX * rScale, faceRY * rScale);
    const nearEye =
      Math.abs(by - eyeCY) < 0.35 && Math.abs(Math.abs(bx) - eyeCX) < 0.4;
    const nearNose = Math.abs(bx) < 0.2 && by < 0.7 && by > -0.25;
    const nearMouth = Math.abs(bx) < 0.6 && by < -0.8 && by > -1.3;
    if (nearEye || nearNose || nearMouth) continue;
    positions[idxRef.i * 3] = bx;
    positions[idxRef.i * 3 + 1] = by;
    positions[idxRef.i * 3 + 2] = jitterZ() - 0.35 - Math.random() * 0.25;
    idxRef.i++;
    filled++;
  }
  // if rejection sampling couldn't fill the budget (very unlikely), pad
  // with low-density points along the jawline so the array is never short.
  while (filled < cheekFillCount) {
    const t = Math.random() * Math.PI * 2;
    const { x, y } = faceSilhouette(t, faceRX * 0.5, faceRY * 0.5);
    positions[idxRef.i * 3] = x;
    positions[idxRef.i * 3 + 1] = y;
    positions[idxRef.i * 3 + 2] = jitterZ() - 0.4;
    idxRef.i++;
    filled++;
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
