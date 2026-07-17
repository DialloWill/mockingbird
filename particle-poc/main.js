import * as THREE from "three";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 6000;
const MORPH_DURATION = 1400; // ms
const COLOR_A = new THREE.Color("#0066ff");
const COLOR_B = new THREE.Color("#00d4ff");

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

// Shape B: a simple recognizable face made of particles
// (oval outline + two eyes + a smiling mouth arc)
function generateFace(n) {
  const positions = new Float32Array(n * 3);

  // proportion of the total particle budget assigned to each face feature
  const outlineCount = Math.floor(n * 0.5);
  const eyeCount = Math.floor(n * 0.12); // per eye
  const mouthCount = Math.floor(n * 0.14);
  const noseCount = n - outlineCount - eyeCount * 2 - mouthCount; // remainder

  let idx = 0;
  const jitterZ = () => (Math.random() - 0.5) * 0.18;

  // face oval outline
  const faceRX = 1.7;
  const faceRY = 2.15;
  for (let i = 0; i < outlineCount; i++) {
    const t = (i / outlineCount) * Math.PI * 2;
    const wobble = 1 + (Math.random() - 0.5) * 0.03;
    const x = Math.cos(t) * faceRX * wobble;
    const y = Math.sin(t) * faceRY * wobble;
    positions[idx * 3] = x;
    positions[idx * 3 + 1] = y;
    positions[idx * 3 + 2] = jitterZ();
    idx++;
  }

  // eyes (filled disks)
  const eyePositions = [
    { cx: -0.68, cy: 0.35 },
    { cx: 0.68, cy: 0.35 },
  ];
  for (const eye of eyePositions) {
    for (let i = 0; i < eyeCount; i++) {
      const [x, y] = randomInDisk(eye.cx, eye.cy, 0.32);
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = jitterZ() + 0.05;
      idx++;
    }
  }

  // simple nose hint (small vertical cluster)
  for (let i = 0; i < noseCount; i++) {
    const t = Math.random();
    const x = (Math.random() - 0.5) * 0.08;
    const y = 0.15 - t * 0.55;
    positions[idx * 3] = x;
    positions[idx * 3 + 1] = y;
    positions[idx * 3 + 2] = jitterZ() + 0.08;
    idx++;
  }

  // smiling mouth arc: a "U" shape — corners up, center dips down
  for (let i = 0; i < mouthCount; i++) {
    const t = i / (mouthCount - 1);
    const x = -0.85 + t * 1.7;
    const y = -1.15 - Math.sin(t * Math.PI) * 0.35;
    positions[idx * 3] = x;
    positions[idx * 3 + 1] = y;
    positions[idx * 3 + 2] = jitterZ();
    idx++;
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Build geometry / material / points
// ---------------------------------------------------------------------------
const shapeA = generateSphere(PARTICLE_COUNT, 2.1);
const shapeB = generateFace(PARTICLE_COUNT);

const geometry = new THREE.BufferGeometry();
const currentPositions = new Float32Array(shapeA); // start on shape A
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
  size: 0.06,
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
// Morph state machine
// ---------------------------------------------------------------------------
let morphing = false;
let morphStart = 0;
let morphFrom = shapeA;
let morphTo = shapeB;
let showingFace = false;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const shapeLabel = document.getElementById("shape-label");

function triggerMorph() {
  if (morphing) return;
  morphFrom = new Float32Array(geometry.attributes.position.array);
  morphTo = showingFace ? shapeA : shapeB;
  showingFace = !showingFace;
  shapeLabel.textContent = showingFace ? "face" : "sphere";
  morphStart = performance.now();
  morphing = true;
}

document.getElementById("morph-btn").addEventListener("click", triggerMorph);
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    triggerMorph();
  }
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
  const delta = clock.getDelta();

  if (morphing) {
    const elapsed = performance.now() - morphStart;
    const t = Math.min(elapsed / MORPH_DURATION, 1);
    const eased = easeInOutCubic(t);
    const arr = posAttr.array;
    for (let i = 0; i < arr.length; i++) {
      arr[i] = morphFrom[i] + (morphTo[i] - morphFrom[i]) * eased;
    }
    posAttr.needsUpdate = true;
    if (t >= 1) morphing = false;
  }

  points.rotation.y += delta * 0.15;

  renderer.render(scene, camera);

  // lightweight fps readout
  frameCount++;
  fpsAccum += delta;
  if (fpsAccum >= 0.5) {
    fpsLabel.textContent = Math.round(frameCount / fpsAccum);
    frameCount = 0;
    fpsAccum = 0;
  }
}

animate();
