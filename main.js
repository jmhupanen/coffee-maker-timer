import * as THREE from 'https://esm.sh/three@0.168.0';
import { OrbitControls } from 'https://esm.sh/three@0.168.0/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'https://esm.sh/three@0.168.0/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://esm.sh/three@0.168.0/addons/loaders/DRACOLoader.js';
// ── Constants ─────────────────────────────────────────────────────────────────
const PREHEAT = 30;
const PER_CUP = 33;
const MIN_CUPS = 1;
const MAX_CUPS = 12;

// ── App state ─────────────────────────────────────────────────────────────────
let cups = 6;
let totalTime = PREHEAT + cups * PER_CUP;
let elapsed = 0;
let state = 'idle';
let running = false;
let modelReady = false;
let speedMult = 1;

// ── Three.js handles ──────────────────────────────────────────────────────────
let renderer, camera, scene, controls, clock;
let coffeeMat, coffeeSurfaceMat, dripMat;
let coffeeMesh, coffeeSurfaceMesh, coffeeSurfaceGeo, dripMesh, carafeGroup;
const steamParticles = [];
const bodyMeshes = [];   // model meshes that respond to colour swatches

// ── Overlay anchor positions (estimated from bounding box after model loads) ──
// These are updated in onModelLoaded(); change them here to fine-tune.
const SPRAY = new THREE.Vector3();   // sprayhead world position
let CARAFE_LID_Y = 0;                 // world Y of carafe lid top
let CARAFE_RADIUS = 0.5;               // inner radius of carafe glass (derived from mesh)
let CARAFE_FILL_H = 1.0;              // usable fill height, computed after model loads
const CARAFE_CTR = new THREE.Vector3();  // carafe group centre (world)

// ── Audio handles ─────────────────────────────────────────────────────────────
let audioCtx = null;
let humSrc = null;
let humGain = null;
let audioBuffers = {};
let audioLoadPromise = null;

// ── Utilities ─────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function lerpHex(a, b, t) {
  const r = Math.round(lerp((a >> 16) & 0xff, (b >> 16) & 0xff, t));
  const g = Math.round(lerp((a >> 8) & 0xff, (b >> 8) & 0xff, t));
  const bl = Math.round(lerp(a & 0xff, b & 0xff, t));
  return (r << 16) | (g << 8) | bl;
}

function formatTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── Scene ─────────────────────────────────────────────────────────────────────
function initScene() {
  const canvas = document.getElementById('threejs-canvas');
  const wrapper = document.getElementById('canvas-wrapper');

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 2.2;
  renderer.setClearColor(0x000000, 0);

  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);
  camera.position.set(8.0, 2.2, 0.0);
  camera.lookAt(0, 1.8, 0);

  scene = new THREE.Scene();

  // Hemisphere gives wrap-around sky→ground ambient that eliminates dark faces
  scene.add(new THREE.HemisphereLight(0xfff8e7, 0x554433, 3.5));

  const key = new THREE.DirectionalLight(0xfff5e0, 4.0);
  key.position.set(4, 7, -4);
  key.castShadow = true;
  key.shadow.mapSize.width = 2048;
  key.shadow.mapSize.height = 2048;
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -1;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 22;
  scene.add(key);

  // Front fill
  const front = new THREE.DirectionalLight(0xffffff, 2.5);
  front.position.set(8, 2, 0);
  scene.add(front);

  // Left fill
  const left = new THREE.DirectionalLight(0xeef4ff, 2.0);
  left.position.set(3, 3, 6);
  scene.add(left);

  // Right fill
  const right = new THREE.DirectionalLight(0xfff0e0, 2.0);
  right.position.set(3, 3, -6);
  scene.add(right);

  // Back fill — stops the rear faces from being completely black
  const back = new THREE.DirectionalLight(0xffffff, 1.5);
  back.position.set(-7, 4, 0);
  scene.add(back);

  const rim = new THREE.DirectionalLight(0xffffff, 1.2);
  rim.position.set(-5, 6, 3);
  scene.add(rim);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.8, 0);
  controls.minDistance = 2;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.84;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  clock = new THREE.Clock();

  const resize = () => {
    const w = wrapper.clientWidth, h = wrapper.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(wrapper);
  resize();
}

// ── Load real model ───────────────────────────────────────────────────────────
function buildModel() {
  // Materials used by the overlay objects
  coffeeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0x1e0a03), roughness: 0.25, metalness: 0.05 });
  coffeeSurfaceMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0x1e0a03), roughness: 0.05, metalness: 0.12 });
  dripMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0x2c1a0e), transparent: true, opacity: 0, roughness: 1.0,
  });

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  loader.load(
    'moccamaster-optimized.glb',
    onModelLoaded,
    (xhr) => console.log(`Loading model… ${Math.round(xhr.loaded / xhr.total * 100)}%`),
    (err) => console.error('GLB load error:', err)
  );
}

function onModelLoaded(gltf) {
  const model = gltf.scene;

  // ── Scale to TARGET_H units tall, bottom at y = 0 ────────────────────────
  const TARGET_H = 3.6;
  const raw = new THREE.Box3().setFromObject(model);
  const rawSize = raw.getSize(new THREE.Vector3());
  const s = TARGET_H / rawSize.y;
  model.scale.setScalar(s);

  const rawCenter = raw.getCenter(new THREE.Vector3());
  model.position.set(-rawCenter.x * s, -raw.min.y * s, -rawCenter.z * s);

  model.traverse(child => { if (child.isMesh && child.name === 'BezierCurve') child.visible = false; });

  // Enable shadows + collect body meshes (colour swatches)
  model.traverse(child => {
    if (!child.isMesh) return;
    child.castShadow = child.receiveShadow = true;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    if (!mat?.color || mat.transparent) return;
    const b = mat.color.r + mat.color.g + mat.color.b;
    if (b > 0.55 && b < 2.85) { child.material = mat.clone(); bodyMeshes.push(child); }
  });

  // Add to scene then force a full world-matrix update so all child positions
  // are accurate before we traverse for glass / glow meshes.
  scene.add(model);
  scene.updateMatrixWorld(true);

  // ── Full bounding box (post-placement) ───────────────────────────────────
  const box = new THREE.Box3().setFromObject(model);
  const bCtr = box.getCenter(new THREE.Vector3());
  console.log(`[model] box  min=(${box.min.toArray().map(v => v.toFixed(2))})` +
    `  max=(${box.max.toArray().map(v => v.toFixed(2))})`);

  // ── Second traverse — accurate world positions now ────────────────────────
  const glassCandidates = [];
  const cylCandidates = [];   // opaque, roughly-circular XZ — used to refine carafe center

  model.traverse(child => {
    if (!child.isMesh) return;
    const mat = Array.isArray(child.material) ? child.material[0] : child.material;
    if (!mat) return;
    const mn = (mat.name || '').toLowerCase();

    const mb = new THREE.Box3().setFromObject(child);
    const mc = mb.getCenter(new THREE.Vector3());
    const ms = mb.getSize(new THREE.Vector3());

    const isGlass = mat.transparent || (mat.transmission ?? 0) > 0.05 ||
      mn.includes('glass') || mn.includes('polycarbonate') ||
      mn.includes('crystal') || mn.includes('transp');

    if (isGlass) {
      const glMat = mat.clone();
      child.material = Array.isArray(child.material) ? [glMat] : glMat;
      glMat.transparent = true;
      glMat.depthWrite = false;
      glMat.color.set(0x08090e);
      glMat.roughness = 0.04;
      glMat.metalness = 0.08;
      glMat.opacity = 0.22;
      if ((glMat.transmission ?? 0) > 0) glMat.transmission = 0;
      glassCandidates.push({
        name: child.name, mesh: child, box: mb, center: mc,
        vol: ms.x * ms.y * ms.z
      });
    } else {
      // Collect opaque cylindrical meshes in the lower 65% for center-refinement
      const minXZ = Math.min(ms.x, ms.z), maxXZ = Math.max(ms.x, ms.z);
      if (mc.y < box.max.y * 0.65 && minXZ > 0.5 && maxXZ / minXZ < 1.25) {
        cylCandidates.push({ center: mc.clone(), xz: minXZ, minY: mb.min.y });
      }
    }
  });

  // ── Pick carafe position ──────────────────────────────────────────────────
  // Use the largest glass mesh whose centre is in the lower 65 % of the model
  // (filters out the water-reservoir window which is in the upper half).
  const carafeHit = glassCandidates
    .filter(g => g.center.y < box.max.y * 0.65)
    .sort((a, b) => b.vol - a.vol)[0];

  if (carafeHit) {
    console.log(`[carafe] using glass mesh "${carafeHit.name}"  vol=${carafeHit.vol.toFixed(4)}`);
    CARAFE_LID_Y = carafeHit.box.max.y;
    const cs = carafeHit.box.getSize(new THREE.Vector3());
    // The smaller XZ dimension is the true glass diameter; the larger contains the handle
    const glassD = Math.min(cs.x, cs.z);
    CARAFE_RADIUS = glassD / 2 * 0.62;
    CARAFE_CTR.copy(carafeHit.center);
    CARAFE_FILL_H = Math.min(CARAFE_LID_Y - 0.18, 1.2);  // default from glass mesh

    // Algebraic circle fit on glass mesh vertices (mid-section only, avoids spout/lid bias)
    {
      const gpos = carafeHit.mesh?.geometry?.attributes?.position;
      if (gpos) {
        const m4 = carafeHit.mesh.matrixWorld;
        const h = carafeHit.box.getSize(new THREE.Vector3()).y;
        const loY = carafeHit.box.min.y + h * 0.2;
        const hiY = carafeHit.box.max.y - h * 0.2;
        let sx = 0, sz = 0, sx2 = 0, sz2 = 0, sxz = 0, sx3 = 0, sz3 = 0, sx2z = 0, sxz2 = 0, n = 0;
        const tmp = new THREE.Vector3();
        for (let i = 0; i < gpos.count; i++) {
          tmp.fromBufferAttribute(gpos, i).applyMatrix4(m4);
          if (tmp.y < loY || tmp.y > hiY) continue;
          const x = tmp.x, z = tmp.z;
          sx += x; sz += z; sx2 += x * x; sz2 += z * z; sxz += x * z;
          sx3 += x * x * x; sz3 += z * z * z; sx2z += x * x * z; sxz2 += x * z * z; n++;
        }
        if (n > 3) {
          const A = 2 * (sx2 - sx * sx / n), B = 2 * (sxz - sx * sz / n), C = 2 * (sz2 - sz * sz / n);
          const D = sx3 + sxz2 - sx * (sx2 + sz2) / n, E = sz3 + sx2z - sz * (sx2 + sz2) / n;
          const det = A * C - B * B;
          if (Math.abs(det) > 1e-9) {
            CARAFE_CTR.x = (D * C - B * E) / det;
            CARAFE_CTR.z = (A * E - B * D) / det;
            console.log(`[glass fit] cx=${CARAFE_CTR.x.toFixed(3)} cz=${CARAFE_CTR.z.toFixed(3)} n=${n}`);
          }
        }
      }
    }

    // Refine using nearest opaque cylindrical mesh (visible plastic carafe shell)
    const innerCandidates = cylCandidates.filter(c => {
      const dxz = Math.hypot(c.center.x - CARAFE_CTR.x, c.center.z - CARAFE_CTR.z);
      const dy = Math.abs(c.center.y - CARAFE_CTR.y);
      return dxz < 0.35 && dy < 0.45 && c.xz < glassD * 0.95 && c.xz > glassD * 0.45;
    });
    console.log('[cyl candidates]', innerCandidates.map(c =>
      `ctr=(${c.center.x.toFixed(2)},${c.center.y.toFixed(2)},${c.center.z.toFixed(2)}) xz=${c.xz.toFixed(2)} minY=${c.minY.toFixed(2)}`
    ).join(' | '));
    const inner = innerCandidates.sort((a, b) => a.xz - b.xz)[0];  // smallest = inner body

    if (inner) {
      // XZ comes from circle fit above; only use inner body for Y (fill height anchoring)
      const fillTop = CARAFE_LID_Y - 0.1;
      CARAFE_CTR.y = (inner.minY + fillTop) / 2;
      CARAFE_FILL_H = fillTop - inner.minY;
      console.log(`[carafe] fill h=${CARAFE_FILL_H.toFixed(2)}  ctr=(${CARAFE_CTR.toArray().map(v => v.toFixed(2))})`);
    }
    SPRAY.set(CARAFE_CTR.x, box.max.y * 0.87, CARAFE_CTR.z);
  } else {
    // Fallback: carafe lives in the front third of the model depth
    console.log('[carafe] no glass mesh found — using depth fallback');
    const fz = box.max.z * 0.65;
    SPRAY.set(bCtr.x, box.max.y * 0.87, fz);
    CARAFE_LID_Y = box.max.y * 0.62;
    CARAFE_CTR.set(bCtr.x, box.max.y * 0.34, fz);
  }

  console.log(`[overlay] SPRAY=(${SPRAY.toArray().map(v => v.toFixed(2))})`);
  console.log(`[overlay] CARAFE_LID_Y=${CARAFE_LID_Y.toFixed(2)}  CARAFE_CTR=(${CARAFE_CTR.toArray().map(v => v.toFixed(2))})`);

  buildOverlayObjects();
  modelReady = true;
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ── Overlay objects (sit on top of the real model geometry) ──────────────────
function buildOverlayObjects() {
  // Carafe group — holds the coffee liquid
  carafeGroup = new THREE.Group();
  carafeGroup.position.copy(CARAFE_CTR);
  scene.add(carafeGroup);

  // Coffee liquid cylinder — height derived from inner carafe body bounds
  const carafeH = Math.min(CARAFE_FILL_H, 1.2);
  coffeeMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(CARAFE_RADIUS, CARAFE_RADIUS, carafeH, 24),
    coffeeMat
  );
  coffeeMesh.visible = false;
  coffeeMesh.scale.y = 0.001;
  coffeeMesh.position.y = -carafeH / 2;
  carafeGroup.add(coffeeMesh);
  carafeGroup.userData.h = carafeH;

  // Rippling liquid surface disc — multi-ring so inner vertices exist for the wave
  const rings = 20, segs = 64;
  const rPos = [], rNrm = [], rIdx = [];
  for (let r = 0; r <= rings; r++) {
    const rf = r / rings;
    for (let s = 0; s <= segs; s++) {
      const theta = (s / segs) * Math.PI * 2;
      rPos.push(Math.cos(theta) * rf * CARAFE_RADIUS, 0, Math.sin(theta) * rf * CARAFE_RADIUS);
      rNrm.push(0, 1, 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s, b = (r + 1) * (segs + 1) + s;
      rIdx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  coffeeSurfaceGeo = new THREE.BufferGeometry();
  coffeeSurfaceGeo.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
  coffeeSurfaceGeo.setAttribute('normal', new THREE.Float32BufferAttribute(rNrm, 3));
  coffeeSurfaceGeo.setIndex(rIdx);
  coffeeSurfaceMesh = new THREE.Mesh(coffeeSurfaceGeo, coffeeSurfaceMat);
  coffeeSurfaceMesh.visible = false;
  carafeGroup.add(coffeeSurfaceMesh);

  // Drip stream between sprayhead and carafe lid
  const dripLen = SPRAY.y - 0.04 - CARAFE_LID_Y;
  const dripMidY = (SPRAY.y - 0.04 + CARAFE_LID_Y) / 2;
  dripMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.013, 0.018, Math.max(dripLen, 0.1), 8),
    dripMat
  );
  dripMesh.position.set(SPRAY.x, dripMidY, SPRAY.z);
  dripMesh.visible = false;
  scene.add(dripMesh);

  // Steam particles
  const steamBase = new THREE.MeshStandardMaterial({ color: 0xdddddd, transparent: true, opacity: 0 });
  for (let i = 0; i < 38; i++) {
    const sp = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), steamBase.clone());
    resetSteam(sp, true);
    sp.visible = false;
    scene.add(sp);
    steamParticles.push(sp);
  }
}

// ── Steam helpers ─────────────────────────────────────────────────────────────
function resetSteam(sp, scatter = false) {
  sp.position.set(
    SPRAY.x + (Math.random() - 0.5) * 0.25,
    scatter ? SPRAY.y + Math.random() * 0.9 : SPRAY.y + 0.05,
    SPRAY.z + (Math.random() - 0.5) * 0.2
  );
  sp.userData.vy = 0.006 + Math.random() * 0.006;
  sp.userData.vx = (Math.random() - 0.5) * 0.003;
  sp.userData.vz = (Math.random() - 0.5) * 0.003;
  sp.userData.maxY = SPRAY.y + 0.9 + Math.random() * 0.5;
}

// ── Animation helpers ─────────────────────────────────────────────────────────
function updateFill(progress) {
  const heatingFrac = PREHEAT / totalTime;
  const fillP = clamp((progress - heatingFrac) / (1 - heatingFrac), 0, 1);

  if (coffeeMesh && carafeGroup) {
    const h = carafeGroup.userData.h ?? 2.0;
    const effectiveFill = fillP * (cups / MAX_CUPS);
    const col = lerpHex(0x1e0a03, 0x0d0401, fillP);
    coffeeMesh.visible = fillP > 0.001;
    coffeeMesh.scale.y = Math.max(0.001, effectiveFill);
    coffeeMesh.position.y = -h / 2 + effectiveFill * h / 2;
    coffeeMat.color.setHex(col);
    if (coffeeSurfaceMesh) {
      coffeeSurfaceMesh.visible = fillP > 0.001;
      coffeeSurfaceMesh.position.y = -h / 2 + effectiveFill * h + 0.002;
      coffeeSurfaceMat.color.setHex(col);
    }
  }

  document.getElementById('fill-pct').textContent = `${Math.round(fillP * 100)}%`;
  document.getElementById('progress-fill').style.width = `${progress * 100}%`;
  document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', Math.round(progress * 100));
}

function animateSurface() {
  if (!coffeeSurfaceMesh || !coffeeSurfaceMesh.visible) return;
  const now = performance.now() * 0.001;
  const pos = coffeeSurfaceGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const dist = Math.sqrt(x * x + z * z);
    pos.setY(i, Math.sin(dist * 12 - now * 2.5) * 0.007);
  }
  pos.needsUpdate = true;
}

function animateStream(active) {
  if (!dripMesh) return;
  if (!active) { dripMesh.visible = false; return; }
  dripMesh.visible = true;
  const t = performance.now() * 0.004;
  dripMat.opacity = 0.48 + Math.sin(t) * 0.34;
  dripMesh.scale.x = 0.8 + Math.sin(t * 1.5) * 0.2;
  dripMesh.scale.z = dripMesh.scale.x;
}

function animateSteam(active) {
  if (!active) { steamParticles.forEach(sp => { sp.visible = false; }); return; }
  steamParticles.forEach(sp => {
    sp.visible = true;
    sp.position.y += sp.userData.vy;
    sp.position.x += sp.userData.vx;
    sp.position.z += sp.userData.vz;
    const t = (sp.position.y - SPRAY.y) / (sp.userData.maxY - SPRAY.y);
    sp.material.opacity = t < 0.25 ? (t / 0.25) * 0.36 : (1 - t) * 0.36;
    if (sp.position.y > sp.userData.maxY) resetSteam(sp);
  });
}

// ── State machine ─────────────────────────────────────────────────────────────
const PHASE_INFO = {
  idle: { label: 'Ready to brew', cls: '' },
  heating: { label: 'Heating up…', cls: 'heating' },
  brewing: { label: 'Brewing…', cls: 'brewing' },
  finishing: { label: 'Finishing…', cls: 'brewing' },
  done: { label: 'Coffee ready!', cls: 'done' },
};

function enterState(next) {
  state = next;
  const { label, cls } = PHASE_INFO[next] ?? PHASE_INFO.idle;
  const phaseEl = document.getElementById('phase-label');
  phaseEl.textContent = label;
  phaseEl.className = 'phase-label' + (cls ? ` ${cls}` : '');

  if (next === 'done') {
    document.getElementById('done-overlay').classList.remove('hidden');
    document.getElementById('timer').classList.add('done');
    document.getElementById('timer').textContent = '00:00';
    if (dripMesh) dripMesh.visible = false;
    running = false;
    stopAudio();
    document.getElementById('start-btn').disabled = true;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();

  if (running) {
    elapsed += dt * speedMult;
    const remaining = Math.max(0, totalTime - elapsed);
    const progress = clamp(elapsed / totalTime, 0, 1);

    document.getElementById('timer').textContent = formatTime(remaining);
    updateFill(progress);

    if (state === 'heating' && elapsed >= PREHEAT) { enterState('brewing'); }
    if (state === 'brewing' && elapsed >= totalTime - 5) { enterState('finishing'); }
    if ((state === 'brewing' || state === 'finishing') && elapsed >= totalTime) { enterState('done'); }

    if (!running) { controls.update(); renderer.render(scene, camera); return; }

    if (modelReady) {
      const streamOn = state === 'brewing' || state === 'finishing';
      animateSurface();
      animateStream(streamOn);
      animateSteam((state === 'heating' && elapsed > 15) || streamOn);
    }
  }

  controls.update();
  renderer.render(scene, camera);
}

// ── Audio ─────────────────────────────────────────────────────────────────────
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window['webkitAudioContext'])();
    audioLoadPromise = loadAudioFiles();
  }
}

async function loadAudioFiles() {
  try {
    const resp = await fetch('sounds/coffee-hum.mp3');
    audioBuffers.hum = await audioCtx.decodeAudioData(await resp.arrayBuffer());
  } catch (_) { }
}

function startHumReal() {
  humGain = audioCtx.createGain();
  humGain.gain.setValueAtTime(0, audioCtx.currentTime);
  humGain.gain.linearRampToValueAtTime(0.28, audioCtx.currentTime + 4);
  humGain.connect(audioCtx.destination);
  humSrc = audioCtx.createBufferSource();
  humSrc.buffer = audioBuffers.hum;
  humSrc.loop = true;
  humSrc.connect(humGain);
  humSrc.start();
}

function startHumSynth() {
  const sr = audioCtx.sampleRate, len = sr * 4;
  const buf = audioCtx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.1;
    b6 = w * 0.115926;
  }
  humSrc = audioCtx.createBufferSource();
  humSrc.buffer = buf;
  humSrc.loop = true;
  const lp = audioCtx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.6;
  humGain = audioCtx.createGain();
  humGain.gain.setValueAtTime(0, audioCtx.currentTime);
  humGain.gain.linearRampToValueAtTime(0.28, audioCtx.currentTime + 4);
  humSrc.connect(lp); lp.connect(humGain); humGain.connect(audioCtx.destination);
  humSrc.start();
}

function startHum() {
  if (!audioCtx || humSrc) return;
  audioLoadPromise.then(() => {
    if (humSrc) return;
    audioBuffers.hum ? startHumReal() : startHumSynth();
  });
}

function stopHum() {
  if (!humSrc) return;
  humGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.7);
  const src = humSrc; humSrc = null;
  setTimeout(() => { try { src.stop(); } catch (_) { } }, 800);
}


function playDoneChime() {
  if (!audioCtx) return;
  [523.25, 659.25, 783.99].forEach((freq, i) => {
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    const t0 = audioCtx.currentTime + i * 0.2;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.05, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + 1.4);
  });
}

function stopAudio() { stopHum(); playDoneChime(); }

// ── Brew control ──────────────────────────────────────────────────────────────
function startBrew() {
  initAudio();
  elapsed = 0; running = true;
  enterState('heating');
  startHum();
  document.getElementById('cup-dec').disabled = true;
  document.getElementById('cup-inc').disabled = true;
  document.getElementById('reset-btn').disabled = false;
  document.getElementById('start-btn').disabled = true;
  document.getElementById('start-icon').textContent = '⏳';
  document.getElementById('start-label').textContent = 'Brewing…';
  document.getElementById('start-btn').classList.add('brewing');
}

function resetBrew() {
  running = false; elapsed = 0; state = 'idle';
  stopHum();

  if (coffeeMesh) { coffeeMesh.visible = false; coffeeMesh.scale.y = 0.001; coffeeMesh.position.y = -(carafeGroup?.userData.h ?? 2) / 2; }
  if (coffeeSurfaceMesh) coffeeSurfaceMesh.visible = false;
  if (coffeeMat) coffeeMat.color.setHex(0x1e0a03);
  if (dripMesh) { dripMesh.visible = false; dripMat.opacity = 0; }
  steamParticles.forEach(sp => { sp.visible = false; if (SPRAY.length() > 0) resetSteam(sp, true); });
  document.getElementById('done-overlay').classList.add('hidden');
  document.getElementById('timer').classList.remove('done');
  document.getElementById('timer').textContent = formatTime(totalTime);
  document.getElementById('fill-pct').textContent = '0%';
  document.getElementById('progress-fill').style.width = '0%';
  document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', 0);
  document.getElementById('phase-label').textContent = 'Ready to brew';
  document.getElementById('phase-label').className = 'phase-label';
  document.getElementById('cup-dec').disabled = false;
  document.getElementById('cup-inc').disabled = false;
  document.getElementById('reset-btn').disabled = true;
  document.getElementById('start-btn').disabled = false;
  document.getElementById('start-icon').textContent = '▶';
  document.getElementById('start-label').textContent = 'Start Brewing';
  document.getElementById('start-btn').classList.remove('brewing');
}

// ── Machine colour (applied to all body meshes found in the real model) ───────
function setMachineColor(hexStr) {
  const col = new THREE.Color(hexStr);
  bodyMeshes.forEach(m => { if (m.material?.color) m.material.color.set(col); });
}

// ── Cup selector ──────────────────────────────────────────────────────────────
function updateCupUI() {
  totalTime = PREHEAT + cups * PER_CUP;
  document.getElementById('cup-count').textContent = cups;
  document.getElementById('timer').textContent = formatTime(totalTime);
  const m = Math.floor(totalTime / 60), s = totalTime % 60;
  document.getElementById('brew-time-hint').textContent =
    `Total brew time: ${m}m${s ? ' ' + s + 's' : ''}`;
  const container = document.getElementById('cup-dots');
  container.innerHTML = '';
  for (let i = 0; i < MAX_CUPS; i++) {
    const dot = document.createElement('span');
    dot.className = 'cup-dot' + (i < cups ? ' filled' : '');
    container.appendChild(dot);
  }
}

// ── UI wiring ─────────────────────────────────────────────────────────────────
function initUI() {
  document.getElementById('cup-dec').addEventListener('click', () => {
    if (running) return; cups = Math.max(MIN_CUPS, cups - 1); updateCupUI();
  });
  document.getElementById('cup-inc').addEventListener('click', () => {
    if (running) return; cups = Math.min(MAX_CUPS, cups + 1); updateCupUI();
  });
  document.getElementById('start-btn').addEventListener('click', startBrew);
  document.getElementById('reset-btn').addEventListener('click', resetBrew);

  document.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      setMachineColor(btn.dataset.color);
      document.querySelectorAll('.color-swatch').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('color-name').textContent = btn.title;
    });
  });

  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      speedMult = Number(btn.dataset.speed);
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  updateCupUI();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
initScene();
buildModel();
initUI();
tick();
