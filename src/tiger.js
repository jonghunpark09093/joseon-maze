import * as THREE from 'three';

// A second predator with AI distinct from the ghost. The ghost always knows
// where you are and grinds toward you; the tiger instead *roams* random parts
// of the maze and only charges when it gets a clear line of sight down a
// corridor — then it pounces faster than you can walk. It loses interest a few
// seconds after losing sight, so breaking line of sight is the way to survive.
export class Tiger {
  constructor(maze, scene, {
    roamSpeed = 2.4,
    pounceSpeed = 4.8,
    catchRadius = 0.9,
    sightCells = 7,
  } = {}) {
    this.maze = maze;
    this.roamSpeed = roamSpeed;
    this.pounceSpeed = pounceSpeed;
    this.catchRadius = catchRadius;
    this.sightCells = sightCells;

    this.group = new THREE.Group();

    // Procedural placeholder: a low, crouched orange body so the tiger reads as
    // a ground predator distinct from the tall black ghost. Replaced by a GLB.
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.7, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x8a3b12, roughness: 0.9, metalness: 0.0 })
    );
    body.position.y = 0.5;
    body.castShadow = true;
    this.group.add(body);

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd23a });
    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.16, 0.62, 0.78);
    eyeR.position.set(0.16, 0.62, 0.78);
    this.group.add(eyeL, eyeR);
    this.eyes = [eyeL, eyeR];

    // Spawn far from the entrance so the player isn't pounced at the door.
    const sp = maze.roamTarget(maze.startCell, 8);
    const s = maze.cellToWorld(sp.gx, sp.gz);
    this.pos = new THREE.Vector3(s.x, 0, s.z);
    this.group.position.copy(this.pos);
    scene.add(this.group);

    this.state = 'roam';        // 'roam' | 'pounce'
    this.path = [];
    this.repathTimer = 0;
    this.loseSightTimer = 0;    // grace period before giving up the chase
    this.target = null;         // current roam destination cell

    // Optional skinned model (set later via setModel); null = procedural box.
    this._proc = body;
    this.mixer = null;
    this._model = null;
    this._bob = 0;
  }

  // Swap the procedural box for a loaded glTF model (same contract as Pursuer).
  setModel({ root, mixer, actions }) {
    if (!root) return;
    this._proc.visible = false;
    this.group.add(root);
    this._model = root;
    this.mixer = mixer;
    if (mixer && actions) {
      const clip = actions.run || actions.Run || actions.walk || actions.Walk || Object.values(actions)[0];
      clip?.reset().play();
    }
  }

  _key(x, z) { return z * this.maze.gw + x; }

  // True if every grid cell on the straight line between two same-row/-column
  // cells is floor — i.e. the tiger can see the player straight down a corridor.
  _hasLineOfSight(a, b) {
    if (a.gx === b.gx) {
      const step = a.gz < b.gz ? 1 : -1;
      for (let gz = a.gz; gz !== b.gz; gz += step) {
        if (this.maze.isWallCell(a.gx, gz)) return false;
      }
      return !this.maze.isWallCell(b.gx, b.gz);
    }
    if (a.gz === b.gz) {
      const step = a.gx < b.gx ? 1 : -1;
      for (let gx = a.gx; gx !== b.gx; gx += step) {
        if (this.maze.isWallCell(gx, a.gz)) return false;
      }
      return !this.maze.isWallCell(b.gx, b.gz);
    }
    return false;
  }

  // BFS over floor cells; path from `start` to `goal` excluding the start cell.
  _bfs(start, goal) {
    const maze = this.maze;
    const prev = new Map();
    prev.set(this._key(start.gx, start.gz), null);
    const q = [start];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    let found = false;
    while (head < q.length) {
      const c = q[head++];
      if (c.gx === goal.gx && c.gz === goal.gz) { found = true; break; }
      for (const [dx, dz] of dirs) {
        const nx = c.gx + dx;
        const nz = c.gz + dz;
        if (maze.isWallCell(nx, nz)) continue;
        const k = this._key(nx, nz);
        if (prev.has(k)) continue;
        prev.set(k, c);
        q.push({ gx: nx, gz: nz });
      }
    }
    if (!found) return [];
    const path = [];
    let cur = goal;
    while (cur) { path.push(cur); cur = prev.get(this._key(cur.gx, cur.gz)); }
    path.reverse();
    path.shift();
    return path;
  }

  // Advance the tiger. Returns true on the frame it catches the player.
  update(dt, playerPos) {
    if (this.mixer) this.mixer.update(dt);

    const mg = this.maze.worldToGrid(this.pos.x, this.pos.z);
    const pg = this.maze.worldToGrid(playerPos.x, playerPos.z);
    const dist = Math.hypot(this.pos.x - playerPos.x, this.pos.z - playerPos.z);
    const cellDist = Math.abs(mg.gx - pg.gx) + Math.abs(mg.gz - pg.gz);

    // --- State transitions: see the player → pounce; lose sight → roam ------
    const sees = cellDist <= this.sightCells && this._hasLineOfSight(mg, pg);
    if (sees) {
      this.state = 'pounce';
      this.loseSightTimer = 2.5; // keep charging this long after losing sight
    } else if (this.state === 'pounce') {
      this.loseSightTimer -= dt;
      if (this.loseSightTimer <= 0) {
        this.state = 'roam';
        this.target = null;
      }
    }

    // --- Pathing ------------------------------------------------------------
    this.repathTimer -= dt;
    if (this.state === 'pounce') {
      if (this.repathTimer <= 0) {
        this.repathTimer = 0.35;
        this.path = this._bfs(mg, pg);
      }
    } else {
      // Roam: pick a fresh wander target when we have none or reached it.
      if (!this.target || (mg.gx === this.target.gx && mg.gz === this.target.gz)) {
        this.target = this.maze.roamTarget(mg, 4);
        this.path = this._bfs(mg, this.target);
      } else if (this.repathTimer <= 0) {
        this.repathTimer = 0.8;
        if (!this.path.length) this.path = this._bfs(mg, this.target);
      }
    }

    // --- Locomotion ---------------------------------------------------------
    const speed = this.state === 'pounce' ? this.pounceSpeed : this.roamSpeed;
    if (this.path.length) {
      const next = this.path[0];
      const t = this.maze.cellToWorld(next.gx, next.gz);
      const dx = t.x - this.pos.x;
      const dz = t.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        this.path.shift();
      } else {
        this.pos.x += (dx / d) * speed * dt;
        this.pos.z += (dz / d) * speed * dt;
      }
    }
    this.group.position.set(this.pos.x, 0, this.pos.z);
    this.group.lookAt(playerPos.x, this.group.position.y, playerPos.z);

    // Eyes flare brighter while pouncing; procedural float when no skeletal clip.
    const base = this.state === 'pounce' ? 1.0 : 0.55;
    this.eyes[0].material.color.setRGB(base, base * 0.82, base * 0.22);
    if (this._model && !this.mixer) {
      this._bob += dt;
      const amp = this.state === 'pounce' ? 0.05 : 0.1;
      this._model.position.y = Math.abs(Math.sin(this._bob * (this.state === 'pounce' ? 6 : 3))) * amp;
    }

    return dist < this.catchRadius;
  }

  distanceTo(playerPos) {
    return Math.hypot(this.pos.x - playerPos.x, this.pos.z - playerPos.z);
  }
}
