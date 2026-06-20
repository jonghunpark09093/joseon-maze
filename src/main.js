import * as THREE from 'three';
import { Maze } from './maze.js';
import { DDGI } from './ddgi.js';
import { Pursuer } from './pursuer.js';
import { loadModel, modelUrl } from './models.js';

const EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.45;
const WALK_SPEED = 4.2;
const RUN_SPEED = 7.0;

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');

// --- Renderer -------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
app.appendChild(renderer.domElement);

// --- Scene ----------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);
scene.fog = new THREE.FogExp2(0x05060a, 0.085);

const camera = new THREE.PerspectiveCamera(
  72,
  window.innerWidth / window.innerHeight,
  0.05,
  200
);

// Faint moonlight so geometry is barely readable when the lantern is away.
const ambient = new THREE.AmbientLight(0x223044, 0.26);
scene.add(ambient);

const moon = new THREE.DirectionalLight(0x4060a0, 0.12);
moon.position.set(-1, 2, -0.5);
scene.add(moon);

// --- Maze -----------------------------------------------------------------
const maze = new Maze({ cellsX: 12, cellsZ: 12, cellSize: 4, wallHeight: 3.2 });
maze.build(scene);

// --- DDGI (our directly-implemented global illumination) -------------------
// Patches the maze materials so they receive indirect diffuse from the probe
// grid. The lantern's warm light bounces off the red walls into dark corners.
const ddgi = new DDGI(renderer, maze);
ddgi.patch(maze.materials.wall);
ddgi.patch(maze.materials.floor);
ddgi.patch(maze.materials.ceiling);

// --- Lantern (warm point light carried by the player) ---------------------
const lantern = new THREE.PointLight(0xffaa55, 3.4, 22, 1.5);
lantern.castShadow = true;
lantern.shadow.mapSize.set(1024, 1024);
lantern.shadow.camera.near = 0.1;
lantern.shadow.camera.far = 18;
lantern.shadow.bias = -0.0015;
scene.add(lantern);

// A small glowing orb so the lantern reads as a held object. Replaced by a
// Joseon lantern (등롱) GLB if one is present in public/models/.
const lanternOrb = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xffcc77 })
);
scene.add(lanternOrb);

// Optional art assets. Missing files resolve to null → procedural visuals stay.
let lanternModel = null;
loadModel(modelUrl('lantern.glb')).then((m) => {
  if (!m) return;
  lanternModel = m.root;
  lanternModel.scale.setScalar(0.4);
  lanternOrb.visible = false;
  scene.add(lanternModel);
});

// --- Controls -------------------------------------------------------------
// Custom first-person look so the game does NOT depend on the Pointer Lock
// API: pointer lock is used when available (best feel), but mouse-drag and
// arrow keys also drive the view — which keeps it playable inside sandboxed
// iframes/preview panels where pointer lock is blocked.
const canvas = renderer.domElement;
camera.rotation.order = 'YXZ';
const start = maze.cellToWorld(maze.startCell.gx, maze.startCell.gz);
camera.position.set(start.x, EYE_HEIGHT, start.z);

const LOOK_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.05;
let yaw = 0;
let pitch = 0;
let started = false;
let dragging = false;

function startGame() {
  if (won) return;
  if (dead) { location.reload(); return; }
  started = true;
  overlay.classList.add('hidden');
  canvas.requestPointerLock?.();
}
overlay.addEventListener('click', startGame);
canvas.addEventListener('mousedown', () => {
  dragging = true;
  if (started) canvas.requestPointerLock?.();
});
window.addEventListener('mouseup', () => (dragging = false));

document.addEventListener('mousemove', (e) => {
  if (!started) return;
  const locked = document.pointerLockElement === canvas;
  if (!locked && !dragging) return;
  yaw -= e.movementX * LOOK_SENS;
  pitch -= e.movementY * LOOK_SENS;
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
});

// Pressing Esc releases pointer lock — bring the overlay back to resume.
document.addEventListener('pointerlockchange', () => {
  if (!won && started && document.pointerLockElement !== canvas) {
    started = false;
    overlay.classList.remove('hidden');
  }
});

const keys = {};
document.addEventListener('keydown', (e) => (keys[e.code] = true));
document.addEventListener('keyup', (e) => (keys[e.code] = false));

function updateLook(dt) {
  const rate = 1.8 * dt;
  if (keys['ArrowLeft']) yaw += rate;
  if (keys['ArrowRight']) yaw -= rate;
  if (keys['ArrowUp']) pitch += rate;
  if (keys['ArrowDown']) pitch -= rate;
  pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  camera.rotation.set(pitch, yaw, 0);
}

// --- Movement with axis-separated collision -------------------------------
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const tmp = new THREE.Vector3();

function move(dt) {
  if (!started) return;

  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  right.crossVectors(forward, camera.up).normalize();

  let ix = 0;
  let iz = 0;
  if (keys['KeyW']) iz += 1;
  if (keys['KeyS']) iz -= 1;
  if (keys['KeyD']) ix += 1;
  if (keys['KeyA']) ix -= 1;
  if (ix === 0 && iz === 0) return;

  const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? RUN_SPEED : WALK_SPEED;
  tmp.set(0, 0, 0);
  tmp.addScaledVector(forward, iz);
  tmp.addScaledVector(right, ix);
  tmp.normalize().multiplyScalar(speed * dt);

  const p = camera.position;
  // Move X then Z independently so the player slides along walls.
  if (!maze.collides(p.x + tmp.x, p.z, PLAYER_RADIUS)) p.x += tmp.x;
  if (!maze.collides(p.x, p.z + tmp.z, PLAYER_RADIUS)) p.z += tmp.z;
}

// --- Win condition --------------------------------------------------------
let won = false;
let dead = false;
const exitWorld = maze.cellToWorld(maze.exitCell.gx, maze.exitCell.gz);

// A faint guiding glow at the exit.
const exitLight = new THREE.PointLight(0x88ccff, 1.4, 10, 2);
exitLight.position.set(exitWorld.x, 1.4, exitWorld.z);
scene.add(exitLight);

// --- Pursuer (the thing in the dark) --------------------------------------
const pursuer = new Pursuer(maze, scene);
loadModel(modelUrl('pursuer.glb')).then((m) => m && pursuer.setModel(m));

function gameOver() {
  if (dead || won) return;
  dead = true;
  started = false;
  document.exitPointerLock?.();
  overlay.classList.remove('hidden');
  overlay.querySelector('h1').textContent = '붙 잡 혔 다';
  overlay.querySelector('.start').textContent = '화면을 클릭해 다시 시작';
}

function checkWin() {
  if (won) return;
  const dx = camera.position.x - exitWorld.x;
  const dz = camera.position.z - exitWorld.z;
  if (dx * dx + dz * dz < 1.6 * 1.6) {
    won = true;
    started = false;
    document.exitPointerLock?.();
    overlay.classList.remove('hidden');
    overlay.querySelector('h1').textContent = '탈 출 성 공';
    overlay.querySelector('.start').textContent = '당신은 산을 빠져나왔다.';
  }
}

// --- Lantern flicker ------------------------------------------------------
let flickerSeed = 0;

function updateLantern(dt) {
  flickerSeed += dt;
  const flick = 3.4 + Math.sin(flickerSeed * 11) * 0.22 + Math.sin(flickerSeed * 23) * 0.12;
  lantern.intensity = flick;

  // Place the lantern slightly down-right of the eye, in front of the camera.
  camera.getWorldDirection(forward);
  right.crossVectors(forward, camera.up).normalize();
  lantern.position
    .copy(camera.position)
    .addScaledVector(forward, 0.4)
    .addScaledVector(right, 0.3)
    .add(tmp.set(0, -0.35, 0));
  lanternOrb.position.copy(lantern.position);
  if (lanternModel) {
    lanternModel.position.copy(lantern.position);
    lanternModel.rotation.y = yaw;
  }
}

// Dev-only debug handle for inspecting the scene from the console.
if (import.meta.env.DEV) {
  window.__game = { THREE, scene, camera, maze, lantern, ddgi, pursuer };
  // Deterministic camera orientation for repeatable report captures.
  window.__setLook = (y, p = 0) => { yaw = y; pitch = p; };
  // Save the current frame into captures/<name>.png via the dev capture endpoint.
  window.__cap = async (name) => {
    renderer.render(scene, camera);
    const data = renderer.domElement.toDataURL('image/png');
    const r = await fetch('/__capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data }),
    });
    return r.json();
  };
}

// --- Loop -----------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateLook(dt);
  move(dt);
  updateLantern(dt);
  checkWin();
  if (started && !won && !dead && pursuer.update(dt, camera.position)) gameOver();

  ddgi.setLantern(lantern.position, lantern.intensity);
  ddgi.update();

  const g = maze.worldToGrid(camera.position.x, camera.position.z);
  if (won) {
    hud.innerHTML = '탈출 완료';
  } else if (dead) {
    hud.innerHTML = '붙잡혔다';
  } else {
    const d = pursuer.distanceTo(camera.position);
    const danger = d < 6 ? ' · <span style="color:#ff4040">바로 뒤에 무언가 있다…</span>'
      : d < 12 ? ' · <span style="color:#ffb040">인기척</span>' : '';
    hud.innerHTML = `위치 [${g.gx}, ${g.gz}] · 출구 [${maze.exitCell.gx}, ${maze.exitCell.gz}]${danger}`;
  }

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
