import * as THREE from 'three';

// A grid-pathfinding pursuer (the ghost). Unlike the tiger, which only reacts
// to line of sight, the ghost *senses* the player within a radius — through
// walls — which is creepier. While it senses you it lurks and roams slowly;
// once you cross into its sense radius it wakes, screams, and BFS-chases fast.
// It is faster than your walk but slower than your sprint, so you must run; and
// it only forgets you after you stay beyond the lose radius for a few seconds,
// so getting distance and waiting is the way to slip away. Rendered as a
// near-black silhouette with two emissive eyes that flare when it gives chase.
export class Pursuer {
  constructor(maze, scene, {
    catchRadius = 0.8,
    lurkSpeed = 1.6,
    chaseSpeed = 5.2,
    senseRadius = 16,   // world units: within this (even through walls) it wakes
    loseRadius = 30,    // must get beyond this to start being forgotten
    forgetTime = 4,     // seconds beyond loseRadius before it gives up
  } = {}) {
    this.maze = maze;
    this.catchRadius = catchRadius;
    this.lurkSpeed = lurkSpeed;
    this.chaseSpeed = chaseSpeed;
    this.senseRadius = senseRadius;
    this.loseRadius = loseRadius;
    this.forgetTime = forgetTime;

    this.state = 'lurk';     // 'lurk' | 'chase'
    this.forgetTimer = 0;
    this.target = null;      // current lurk wander target

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
    this._lurkAction = null;
    this._chaseAction = null;
    this._activeAction = null;
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
      // Resolve a "walk" clip for lurking and a "run" clip for the chase by
      // matching clip names loosely (Meshy exports e.g. Unsteady_Walk, Running).
      const find = (re) => Object.entries(actions).find(([k]) => re.test(k))?.[1] || null;
      const first = Object.values(actions)[0];
      this._lurkAction = find(/unsteady|walk/i) || first;
      this._chaseAction = find(/run/i) || first;
      this._activeAction = this._lurkAction;
      this._activeAction?.reset().play();
    }
  }

  // Crossfade between the lurk-walk and chase-run clips when the state changes.
  _syncClip() {
    if (!this.mixer || !this._chaseAction) return;
    const want = this.state === 'chase' ? this._chaseAction : this._lurkAction;
    if (!want || want === this._activeAction) return;
    want.reset().setEffectiveWeight(1).fadeIn(0.25).play();
    this._activeAction?.fadeOut(0.25);
    this._activeAction = want;
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
  // Sets `this.justWoke` true on the single frame it transitions lurk → chase,
  // so the caller can fire the scream stinger.
  update(dt, playerPos) {
    if (this.mixer) this.mixer.update(dt);
    this.justWoke = false;
    this._syncClip();

    const mg = this.maze.worldToGrid(this.pos.x, this.pos.z);
    const pg = this.maze.worldToGrid(playerPos.x, playerPos.z);
    const dist = Math.hypot(this.pos.x - playerPos.x, this.pos.z - playerPos.z);

    // --- State machine: sense (through walls) wakes it; distance loses it -----
    const senses = dist <= this.senseRadius;
    if (senses) {
      if (this.state !== 'chase') this.justWoke = true;
      this.state = 'chase';
      this.forgetTimer = this.forgetTime;
    } else if (this.state === 'chase') {
      // Keep chasing while you're still within the lose radius; only count down
      // toward giving up once you've put real distance between you and it.
      if (dist > this.loseRadius) {
        this.forgetTimer -= dt;
        if (this.forgetTimer <= 0) { this.state = 'lurk'; this.target = null; }
      } else {
        this.forgetTimer = this.forgetTime;
      }
    }

    // --- Pathing ------------------------------------------------------------
    this.repathTimer -= dt;
    if (this.state === 'chase') {
      if (this.repathTimer <= 0) {
        this.repathTimer = 0.4;
        this.path = this._bfs(mg, pg);
      }
    } else {
      // Lurk: drift between random cells so the ghost is never perfectly still.
      if (!this.target || (mg.gx === this.target.gx && mg.gz === this.target.gz)) {
        this.target = this.maze.roamTarget(mg, 3);
        this.path = this._bfs(mg, this.target);
      } else if (this.repathTimer <= 0) {
        this.repathTimer = 0.8;
        if (!this.path.length) this.path = this._bfs(mg, this.target);
      }
    }

    // --- Locomotion ---------------------------------------------------------
    const speed = this.state === 'chase' ? this.chaseSpeed : this.lurkSpeed;
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

    // Procedural "alive" motion when the loaded model has no skeletal clip: a
    // slow vertical float + subtle sway so even a static mesh never reads frozen.
    if (this._model && !this.mixer) {
      this._bob += dt;
      this._model.position.y = Math.sin(this._bob * 2.0) * 0.08;
      this._model.rotation.z = Math.sin(this._bob * 1.3) * 0.05;
    }

    // Eyes pulse subtly, and flare bright red while giving chase.
    this._pulse += dt;
    const peak = this.state === 'chase' ? 1.0 : 0.55;
    const e = peak - 0.25 + Math.sin(this._pulse * (this.state === 'chase' ? 9 : 4)) * 0.25;
    this.eyes[0].material.color.setRGB(e, e * 0.1, e * 0.1);

    const ddx = this.pos.x - playerPos.x;
    const ddz = this.pos.z - playerPos.z;
    return ddx * ddx + ddz * ddz < this.catchRadius * this.catchRadius;
  }

  // True if the straight grid line between two same-row/-column cells is all
  // floor. (Kept for parity with the tiger; the ghost senses through walls so
  // it doesn't strictly need LOS, but this is handy for tuning.)
  _hasLineOfSight(a, b) {
    if (a.gx === b.gx) {
      const step = a.gz < b.gz ? 1 : -1;
      for (let gz = a.gz; gz !== b.gz; gz += step) if (this.maze.isWallCell(a.gx, gz)) return false;
      return !this.maze.isWallCell(b.gx, b.gz);
    }
    if (a.gz === b.gz) {
      const step = a.gx < b.gx ? 1 : -1;
      for (let gx = a.gx; gx !== b.gx; gx += step) if (this.maze.isWallCell(gx, a.gz)) return false;
      return !this.maze.isWallCell(b.gx, b.gz);
    }
    return false;
  }

  // Straight-line world distance to the player (for proximity audio/UI).
  distanceTo(playerPos) {
    return Math.hypot(this.pos.x - playerPos.x, this.pos.z - playerPos.z);
  }
}
