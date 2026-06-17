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

    // Entrance: top-left passage cell. Exit: bottom-right passage cell.
    this.startCell = { gx: 1, gz: 1 };
    this.exitCell = { gx: this.gw - 2, gz: this.gh - 2 };
    this.grid[this.exitCell.gz][this.exitCell.gx] = 0;
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
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x2a2118,
      roughness: 0.95,
      metalness: 0.0,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    group.add(floor);

    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x171210,
      roughness: 1.0,
      metalness: 0.0,
    });
    const ceil = new THREE.Mesh(floorGeo, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = this.wallHeight;
    group.add(ceil);

    // Walls as a single InstancedMesh of boxes for performance.
    const wallCells = [];
    for (let gz = 0; gz < this.gh; gz++) {
      for (let gx = 0; gx < this.gw; gx++) {
        if (this.grid[gz][gx] === 1) wallCells.push({ gx, gz });
      }
    }
    const wallGeo = new THREE.BoxGeometry(this.cellSize, this.wallHeight, this.cellSize);
    // Warm reddish "단청" tone so indirect color bleeding will be visible later.
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x6e2a22,
      roughness: 0.85,
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
    return group;
  }
}
