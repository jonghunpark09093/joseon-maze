import * as THREE from 'three';

// Maze is generated with a recursive-backtracker on a WxH cell grid, then
// expanded into a (2W+1)x(2H+1) occupancy grid where 1 = wall, 0 = floor.
// The occupancy grid is the single source of truth: collision, rendering, and
// later the DDGI signed-distance field all read from it.
export class Maze {
  constructor({ cellsX = 12, cellsZ = 12, cellSize = 4, wallHeight = 3.2 } = {}) {
    this.cellsX = cellsX;
    this.cellsZ = cellsZ;
    this.cellSize = cellSize;
    this.wallHeight = wallHeight;

    this.gw = cellsX * 2 + 1; // occupancy grid width
    this.gh = cellsZ * 2 + 1; // occupancy grid height
    this.grid = this._generate();

    // World extents (grid origin at world 0,0; centered later via group offset).
    this.worldW = this.gw * cellSize;
    this.worldD = this.gh * cellSize;

    // Entrance: fixed top-left passage cell. Exit: the floor cell *farthest*
    // from the entrance (BFS), so every random maze still guarantees a long
    // route to the goal instead of a fixed corner.
    this.startCell = { gx: 1, gz: 1 };
    this.exitCell = this._farthestFrom(this.startCell);
  }

  // BFS distance map (in cells) from a floor cell; -1 = wall/unreachable.
  _bfsDistances(start) {
    const dist = Array.from({ length: this.gh }, () =>
      new Int32Array(this.gw).fill(-1)
    );
    dist[start.gz][start.gx] = 0;
    const q = [start];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      const d = dist[c.gz][c.gx];
      for (const [dx, dz] of dirs) {
        const nx = c.gx + dx;
        const nz = c.gz + dz;
        if (this.isWallCell(nx, nz) || dist[nz][nx] !== -1) continue;
        dist[nz][nx] = d + 1;
        q.push({ gx: nx, gz: nz });
      }
    }
    return dist;
  }

  // The reachable floor cell with the greatest BFS distance from `start`.
  _farthestFrom(start) {
    const dist = this._bfsDistances(start);
    let best = start;
    let bestD = -1;
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) {
        if (dist[gz][gx] > bestD) {
          bestD = dist[gz][gx];
          best = { gx, gz };
        }
      }
    }
    return best;
  }

  // A floor cell at a *medium* distance from the player's start — scaled to the
  // maze (roughly 35–60% of the way to the exit). Far enough to be outside the
  // pursuer's sense radius at spawn (so the player gets a head start instead of
  // being chased from second one), close enough that the slow stalk reaches
  // them within the run.
  pursuerSpawn() {
    const dist = this._bfsDistances(this.startCell);
    let maxD = 0;
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) if (dist[gz][gx] > maxD) maxD = dist[gz][gx];
    }
    const lo = Math.round(maxD * 0.35);
    const hi = Math.round(maxD * 0.6);
    const candidates = [];
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) {
        const d = dist[gz][gx];
        if (d >= lo && d <= hi) candidates.push({ gx, gz });
      }
    }
    if (!candidates.length) return { ...this.exitCell };
    return candidates[(Math.random() * candidates.length) | 0];
  }

  // A random reachable floor cell whose BFS distance from `from` is within
  // [minDist, maxDist]. Used by the roaming tiger for its spawn (bounded range)
  // and wander targets (minDist only).
  roamTarget(from = this.startCell, minDist = 0, maxDist = Infinity) {
    const dist = minDist > 0 || maxDist < Infinity ? this._bfsDistances(from) : null;
    const cells = [];
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) {
        if (this.isWallCell(gx, gz)) continue;
        if (dist) {
          const d = dist[gz][gx];
          if (d < minDist || d > maxDist) continue;
        }
        cells.push({ gx, gz });
      }
    }
    if (!cells.length) return { ...this.exitCell };
    return cells[(Math.random() * cells.length) | 0];
  }

  _generate() {
    const gw = this.gw;
    const gh = this.gh;
    // Start fully walled.
    const grid = Array.from({ length: gh }, () => new Uint8Array(gw).fill(1));

    const visited = Array.from({ length: this.cellsZ }, () =>
      new Uint8Array(this.cellsX).fill(0)
    );
    const stack = [{ cx: 0, cz: 0 }];
    visited[0][0] = 1;
    grid[1][1] = 0;

    const dirs = [
      { dx: 1, dz: 0 },
      { dx: -1, dz: 0 },
      { dx: 0, dz: 1 },
      { dx: 0, dz: -1 },
    ];

    while (stack.length) {
      const cur = stack[stack.length - 1];
      const neighbors = [];
      for (const d of dirs) {
        const nx = cur.cx + d.dx;
        const nz = cur.cz + d.dz;
        if (nx >= 0 && nx < this.cellsX && nz >= 0 && nz < this.cellsZ && !visited[nz][nx]) {
          neighbors.push({ nx, nz, d });
        }
      }
      if (neighbors.length === 0) {
        stack.pop();
        continue;
      }
      const pick = neighbors[(Math.random() * neighbors.length) | 0];
      visited[pick.nz][pick.nx] = 1;
      // Carve the wall between the current cell and the chosen neighbor.
      grid[cur.cz * 2 + 1 + pick.d.dz][cur.cx * 2 + 1 + pick.d.dx] = 0;
      grid[pick.nz * 2 + 1][pick.nx * 2 + 1] = 0;
      stack.push({ cx: pick.nx, cz: pick.nz });
    }
    return grid;
  }

  // --- World <-> grid mapping ---------------------------------------------
  // Grid cell (gx,gz) center maps to world (gx*cs - worldW/2 + cs/2, ...).
  cellToWorld(gx, gz) {
    return new THREE.Vector3(
      gx * this.cellSize - this.worldW / 2 + this.cellSize / 2,
      0,
      gz * this.cellSize - this.worldD / 2 + this.cellSize / 2
    );
  }

  worldToGrid(x, z) {
    const gx = Math.floor((x + this.worldW / 2) / this.cellSize);
    const gz = Math.floor((z + this.worldD / 2) / this.cellSize);
    return { gx, gz };
  }

  isWallCell(gx, gz) {
    if (gx < 0 || gx >= this.gw || gz < 0 || gz >= this.gh) return true;
    return this.grid[gz][gx] === 1;
  }

  // Circle-vs-grid test used by player collision: returns true if a disc of
  // `radius` centered at world (x,z) overlaps any wall cell.
  collides(x, z, radius) {
    const minX = x - radius;
    const maxX = x + radius;
    const minZ = z - radius;
    const maxZ = z + radius;
    const a = this.worldToGrid(minX, minZ);
    const b = this.worldToGrid(maxX, maxZ);
    for (let gz = a.gz; gz <= b.gz; gz++) {
      for (let gx = a.gx; gx <= b.gx; gx++) {
        if (this.isWallCell(gx, gz)) {
          // Closest point on the cell AABB to the circle center.
          const c = this.cellToWorld(gx, gz);
          const half = this.cellSize / 2;
          const cx = Math.max(c.x - half, Math.min(x, c.x + half));
          const cz = Math.max(c.z - half, Math.min(z, c.z + half));
          const dx = x - cx;
          const dz = z - cz;
          if (dx * dx + dz * dz < radius * radius) return true;
        }
      }
    }
    return false;
  }

  // --- Rendering ----------------------------------------------------------
  build(scene) {
    const group = new THREE.Group();

    // Floor + ceiling planes spanning the whole grid.
    const floorGeo = new THREE.PlaneGeometry(this.worldW, this.worldD);
    // aoMap reads the 2nd UV set (`uv1` in modern three); the plane only ships
    // `uv`, so mirror it.
    floorGeo.setAttribute('uv1', floorGeo.getAttribute('uv'));

    // PBR floor (Poly Haven forest-ground set). The diffuse is multiplied by a
    // dark, desaturated tint so the lush daylight grass reads as dim mountain
    // earth under the lantern instead of a bright meadow.
    const TILE = 4; // world units per texture repeat (≈ one maze cell)
    const repX = this.worldW / TILE;
    const repZ = this.worldD / TILE;
    const tx = (name, srgb = false) => {
      const t = new THREE.TextureLoader().load(
        `${import.meta.env.BASE_URL}textures/floor/${name}`
      );
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repX, repZ);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      return t;
    };
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x6b6354,          // dark warm tint over the green albedo
      map: tx('diff.jpg', true),
      normalMap: tx('nor_gl.jpg'),
      roughnessMap: tx('rough.jpg'),
      aoMap: tx('ao.jpg'),
      roughness: 1.0,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);

    // Ceiling as per-cell tiles so we can leave a 3×3 OPENING over the exit —
    // the player emerges from the dark corridor to see the night sky above the
    // goal (sky background shows through the hole). Built as an InstancedMesh.
    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x171210,
      roughness: 1.0,
      metalness: 0.0,
    });
    const ceilGeo = new THREE.PlaneGeometry(this.cellSize, this.cellSize);
    ceilGeo.rotateX(Math.PI / 2); // face downward
    const SKY_OPEN = 1; // Chebyshev radius of the opening (1 = 3×3 cells)
    const ceilCells = [];
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) {
        const cheb = Math.max(Math.abs(gx - this.exitCell.gx), Math.abs(gz - this.exitCell.gz));
        if (cheb > SKY_OPEN) ceilCells.push({ gx, gz });
      }
    }
    const ceil = new THREE.InstancedMesh(ceilGeo, ceilMat, ceilCells.length);
    const cm = new THREE.Matrix4();
    ceilCells.forEach((c, i) => {
      const w = this.cellToWorld(c.gx, c.gz);
      cm.makeTranslation(w.x, this.wallHeight, w.z);
      ceil.setMatrixAt(i, cm);
    });
    ceil.instanceMatrix.needsUpdate = true;
    group.add(ceil);

    // Walls as a single InstancedMesh of boxes for performance.
    const wallCells = [];
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) {
        if (this.grid[gz][gx] === 1) wallCells.push({ gx, gz });
      }
    }
    const wallGeo = new THREE.BoxGeometry(this.cellSize, this.wallHeight, this.cellSize);
    wallGeo.setAttribute('uv1', wallGeo.getAttribute('uv')); // aoMap 2nd UV set

    // PBR wall (Poly Haven worn-wood planks). A warm reddish tint pushes the
    // brown planks toward the "단청" tone, so the directly-lit walls harmonise
    // with the red indirect bounce. (The DDGI bounce hue itself is driven by
    // `albedo.wall` below, not this texture, so color bleeding stays red.)
    const wtex = (name, srgb = false) => {
      const t = new THREE.TextureLoader().load(
        `${import.meta.env.BASE_URL}textures/wall/${name}`
      );
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      // ~2m per tile, texels kept square to the box faces (4 × 3.2).
      t.repeat.set(this.cellSize / 2, this.wallHeight / 2 * 0.8);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 4;
      return t;
    };
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x9c4e36,          // warm 단청-ish tint over the brown wood
      map: wtex('diff.jpg', true),
      normalMap: wtex('nor_gl.jpg'),
      roughnessMap: wtex('rough.jpg'),
      aoMap: wtex('ao.jpg'),
      roughness: 1.0,
      metalness: 0.0,
    });
    const inst = new THREE.InstancedMesh(wallGeo, wallMat, wallCells.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    wallCells.forEach((c, i) => {
      const w = this.cellToWorld(c.gx, c.gz);
      m.makeTranslation(w.x, this.wallHeight / 2, w.z);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);

    scene.add(group);
    this.group = group;
    // Exposed so the DDGI module can patch them and reuse the albedo values
    // when computing the indirect bounce.
    this.materials = { floor: floorMat, ceiling: ceilMat, wall: wallMat };
    this.albedo = { wall: 0x6e2a22, floor: 0x2a2118, ceiling: 0x171210 };
    return group;
  }
}
