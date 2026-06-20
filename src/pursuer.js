import * as THREE from 'three';

// A grid-pathfinding pursuer. It BFS-paths to the player's cell over the maze
// occupancy grid and walks the path in world space. It is deliberately slower
// than the player's walk speed, so a player who knows the route can escape —
// the dread comes from not knowing the route. Rendered as a near-black silhouette
// with two emissive eyes so it only resolves when the lantern sweeps across it.
export class Pursuer {
  constructor(maze, scene, { speed = 2.7, catchRadius = 0.8 } = {}) {
    this.maze = maze;
    this.speed = speed;
    this.catchRadius = catchRadius;

    this.group = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.34, 1.15, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x07070a, roughness: 1.0, metalness: 0.0 })
    );
    body.position.y = 1.05;
    body.castShadow = true;
    this.group.add(body);

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a });
    const eyeGeo = new THREE.SphereGeometry(0.055, 8, 8);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.13, 1.62, 0.28);
    eyeR.position.set(0.13, 1.62, 0.28);
    this.group.add(eyeL, eyeR);
    this.eyes = [eyeL, eyeR];

    // Spawn deep in the maze, a few steps from the (now random) exit.
    const sp = maze.pursuerSpawn();
    const s = maze.cellToWorld(sp.gx, sp.gz);
    this.pos = new THREE.Vector3(s.x, 0, s.z);
    this.group.position.copy(this.pos);
    scene.add(this.group);

    this.path = [];
    this.repathTimer = 0;
    this._pulse = 0;

    // Optional skinned model (set later via setModel); null = procedural capsule.
    this._proc = body;
    this.mixer = null;
    this._model = null; // loaded glTF root, if any
    this._bob = 0;      // phase for the procedural float fallback
  }

  // Swap the procedural capsule for a loaded glTF model. Hides the capsule,
  // parents the model under the same group, and starts its first/named walk
  // clip if the GLB ships animations.
  setModel({ root, mixer, actions }) {
    if (!root) return;
    this._proc.visible = false;
    this.group.add(root);
    this._model = root;
    this.mixer = mixer;
    if (mixer && actions) {
      const walk = actions.walk || actions.Walk || actions.run || Object.values(actions)[0];
      walk?.reset().play();
    }
  }

  _key(x, z) { return z * this.maze.gw + x; }

  // Breadth-first search over floor cells; returns the cell path from the
  // pursuer's cell to the player's cell (excluding the start cell).
  _bfs(start, goal) {
    const maze = this.maze;
    const prev = new Map();
    prev.set(this._key(start.gx, start.gz), null);
    const q = [start];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let found = false;
    while (q.length) {
      const c = q.shift();
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

  // Advance the pursuer. Returns true on the frame it catches the player.
  update(dt, playerPos) {
    if (this.mixer) this.mixer.update(dt);
    this.repathTimer -= dt;
    if (this.repathTimer <= 0) {
      this.repathTimer = 0.5;
      const mg = this.maze.worldToGrid(this.pos.x, this.pos.z);
      const pg = this.maze.worldToGrid(playerPos.x, playerPos.z);
      this.path = this._bfs(mg, pg);
    }

    if (this.path.length) {
      const next = this.path[0];
      const t = this.maze.cellToWorld(next.gx, next.gz);
      const dx = t.x - this.pos.x;
      const dz = t.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        this.path.shift();
      } else {
        this.pos.x += (dx / d) * this.speed * dt;
        this.pos.z += (dz / d) * this.speed * dt;
      }
    }
    this.group.position.set(this.pos.x, 0, this.pos.z);
    this.group.lookAt(playerPos.x, this.group.position.y, playerPos.z);

    // Procedural "alive" motion when the loaded model has no skeletal clip: a
    // slow vertical float + subtle sway so even a static mesh never reads frozen.
    if (this._model && !this.mixer) {
      this._bob += dt;
      this._model.position.y = Math.sin(this._bob * 2.0) * 0.08;
      this._model.rotation.z = Math.sin(this._bob * 1.3) * 0.05;
    }

    // Eyes pulse subtly so the figure feels alive in the dark.
    this._pulse += dt;
    const e = 0.7 + Math.sin(this._pulse * 4.0) * 0.3;
    this.eyes[0].material.color.setRGB(e, e * 0.1, e * 0.1);

    const ddx = this.pos.x - playerPos.x;
    const ddz = this.pos.z - playerPos.z;
    return ddx * ddx + ddz * ddz < this.catchRadius * this.catchRadius;
  }

  // Straight-line world distance to the player (for proximity audio/UI).
  distanceTo(playerPos) {
    return Math.hypot(this.pos.x - playerPos.x, this.pos.z - playerPos.z);
  }
}
