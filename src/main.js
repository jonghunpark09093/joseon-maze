import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { Maze } from './maze.js';

const EYE_HEIGHT = 1.6;
const PLAYER_RADIUS = 0.45;
const WALK_SPEED = 4.2;
const RUN_SPEED = 7.0;

const app = document.getElementById('app');
const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');

// --- Renderer -------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
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
const ambient = new THREE.AmbientLight(0x223044, 0.18);
scene.add(ambient);

const moon = new THREE.DirectionalLight(0x4060a0, 0.12);
moon.position.set(-1, 2, -0.5);
scene.add(moon);

// --- Maze -----------------------------------------------------------------
const maze = new Maze({ cellsX: 12, cellsZ: 12, cellSize: 4, wallHeight: 3.2 });
maze.build(scene);

// --- Lantern (warm point light carried by the player) ---------------------
const lantern = new THREE.PointLight(0xffaa55, 2.6, 16, 1.6);
lantern.castShadow = true;
lantern.shadow.mapSize.set(1024, 1024);
lantern.shadow.camera.near = 0.1;
lantern.shadow.camera.far = 18;
lantern.shadow.bias = -0.0015;
scene.add(lantern);

// A small glowing orb so the lantern reads as a held object.
const lanternOrb = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xffcc77 })
);
scene.add(lanternOrb);

// --- Controls -------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
const start = maze.cellToWorld(maze.startCell.gx, maze.startCell.gz);
camera.position.set(start.x, EYE_HEIGHT, start.z);

overlay.addEventListener('click', () => controls.lock());
controls.addEventListener('lock', () => overlay.classList.add('hidden'));
controls.addEventListener('unlock', () => {
  if (!won) overlay.classList.remove('hidden');
});

const keys = {};
document.addEventListener('keydown', (e) => (keys[e.code] = true));
document.addEventListener('keyup', (e) => (keys[e.code] = false));

// --- Movement with axis-separated collision -------------------------------
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const tmp = new THREE.Vector3();

function move(dt) {
  if (!controls.isLocked) return;

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
const exitWorld = maze.cellToWorld(maze.exitCell.gx, maze.exitCell.gz);

// A faint guiding glow at the exit.
const exitLight = new THREE.PointLight(0x88ccff, 1.4, 10, 2);
exitLight.position.set(exitWorld.x, 1.4, exitWorld.z);
scene.add(exitLight);

function checkWin() {
  if (won) return;
  const dx = camera.position.x - exitWorld.x;
  const dz = camera.position.z - exitWorld.z;
  if (dx * dx + dz * dz < 1.6 * 1.6) {
    won = true;
    controls.unlock();
    overlay.classList.remove('hidden');
    overlay.querySelector('h1').textContent = '탈 출 성 공';
    overlay.querySelector('.start').textContent = '당신은 산을 빠져나왔다.';
  }
}

// --- Lantern flicker ------------------------------------------------------
let flickerSeed = 0;

function updateLantern(dt) {
  flickerSeed += dt;
  const flick = 2.6 + Math.sin(flickerSeed * 11) * 0.18 + Math.sin(flickerSeed * 23) * 0.1;
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
}

// Dev-only debug handle for inspecting the scene from the console.
if (import.meta.env.DEV) {
  window.__game = { THREE, scene, camera, maze, controls, lantern };
}

// --- Loop -----------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  move(dt);
  updateLantern(dt);
  checkWin();

  const g = maze.worldToGrid(camera.position.x, camera.position.z);
  hud.innerHTML = won
    ? '탈출 완료'
    : `위치 [${g.gx}, ${g.gz}] · 출구 [${maze.exitCell.gx}, ${maze.exitCell.gz}]`;

  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
