import * as THREE from 'three';

// ---------------------------------------------------------------------------
// DDGI (Dynamic Diffuse Global Illumination) for a grid maze.
//
// The static maze is an occupancy grid, so primary rays are traced with an
// exact 2D grid-DDA (Amanatides-Woo) instead of hardware ray tracing — walls
// are full-height boxes, the floor/ceiling are horizontal planes. This gives
// software ray tracing of the environment that runs in a fragment shader.
//
// Pipeline per frame:
//   Pass A (gather): for each probe x ray, DDA-trace the maze, shade the hit
//                    with the lantern, output radiance + hit distance.
//   Pass B (blend):  integrate the rays into an octahedral irradiance atlas,
//                    temporally accumulated (hysteresis) for stability.
//   Pass C (sample): scene materials read the 8 surrounding probes and add the
//                    indirect diffuse term.
// ---------------------------------------------------------------------------

const RAYS_PER_PROBE = 64;
const OCTA = 8; // octahedral tile resolution per probe

// Shared GLSL: encodings, ray directions, the DDA tracer and hit shading.
const GLSL_COMMON = /* glsl */ `
const float PI = 3.14159265359;

vec2 octEncode(vec3 n){
  n /= (abs(n.x)+abs(n.y)+abs(n.z));
  vec2 e = n.xy;
  if(n.z < 0.0) e = (1.0 - abs(e.yx)) * vec2(e.x>=0.0?1.0:-1.0, e.y>=0.0?1.0:-1.0);
  return e*0.5+0.5;
}
vec3 octDecode(vec2 f){
  f = f*2.0-1.0;
  vec3 n = vec3(f.x, f.y, 1.0-abs(f.x)-abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x>=0.0 ? -t : t;
  n.y += n.y>=0.0 ? -t : t;
  return normalize(n);
}
vec3 sphericalFibonacci(float i, float n){
  const float PHI = 1.61803398875;
  float phi = 2.0*PI*fract(i*(PHI-1.0));
  float cosT = 1.0 - (2.0*i+1.0)/n;
  float sinT = sqrt(clamp(1.0-cosT*cosT, 0.0, 1.0));
  return vec3(cos(phi)*sinT, sin(phi)*sinT, cosT);
}
`;

// Tracer GLSL — needs the maze uniforms. Kept separate because only the gather
// pass uses it.
const GLSL_TRACE = /* glsl */ `
uniform sampler2D uOcc;       // occupancy grid (R), 1 = wall
uniform ivec2 uGrid;          // grid dims (gw, gh)
uniform float uCellSize;
uniform vec2 uWorldHalf;      // (worldW/2, worldD/2)
uniform float uWallHeight;
uniform vec3 uAlbWall;
uniform vec3 uAlbFloor;
uniform vec3 uAlbCeil;
uniform vec3 uSky;
uniform vec3 uLanternPos;
uniform vec3 uLanternColor;
uniform float uLanternInt;
uniform float uLanternRange;
uniform vec3 uAmbient;
uniform float uMaxDist;

bool occ(ivec2 c){
  if(c.x<0 || c.y<0 || c.x>=uGrid.x || c.y>=uGrid.y) return true;
  return texelFetch(uOcc, c, 0).r > 0.5;
}

struct Hit { float t; vec3 n; vec3 alb; bool sky; };

Hit traceMaze(vec3 ro, vec3 rd){
  Hit h; h.sky = true; h.t = uMaxDist; h.n = vec3(0.0); h.alb = vec3(0.0);

  vec2 pos = ro.xz + uWorldHalf;          // shift so grid starts at origin
  ivec2 cell = ivec2(floor(pos / uCellSize));
  if(occ(cell)){ h.sky=false; h.t=0.0; h.n=-rd; h.alb=uAlbWall; return h; }

  vec2 dir = rd.xz;
  ivec2 stp = ivec2(dir.x>=0.0?1:-1, dir.y>=0.0?1:-1);
  vec2 tDelta = vec2(
    abs(dir.x)<1e-6 ? 1e30 : abs(uCellSize/dir.x),
    abs(dir.y)<1e-6 ? 1e30 : abs(uCellSize/dir.y)
  );
  vec2 nextB = vec2(
    dir.x>=0.0 ? float(cell.x+1)*uCellSize : float(cell.x)*uCellSize,
    dir.y>=0.0 ? float(cell.y+1)*uCellSize : float(cell.y)*uCellSize
  );
  vec2 tMax = vec2(
    abs(dir.x)<1e-6 ? 1e30 : (nextB.x-pos.x)/dir.x,
    abs(dir.y)<1e-6 ? 1e30 : (nextB.y-pos.y)/dir.y
  );

  float tF = rd.y < -1e-4 ? (0.0 - ro.y)/rd.y : 1e30;
  float tC = rd.y >  1e-4 ? (uWallHeight - ro.y)/rd.y : 1e30;
  float tPlane = min(tF, tC);

  for(int i=0; i<192; i++){
    float tHit; vec3 nrm;
    if(tMax.x < tMax.y){ tHit = tMax.x; cell.x += stp.x; tMax.x += tDelta.x; nrm = vec3(float(-stp.x),0.0,0.0); }
    else               { tHit = tMax.y; cell.y += stp.y; tMax.y += tDelta.y; nrm = vec3(0.0,0.0,float(-stp.y)); }

    if(tPlane <= tHit){
      h.sky=false; h.t=tPlane;
      if(tF<tC){ h.n=vec3(0.0,1.0,0.0); h.alb=uAlbFloor; }
      else     { h.n=vec3(0.0,-1.0,0.0); h.alb=uAlbCeil; }
      return h;
    }
    if(occ(cell)){ h.sky=false; h.t=tHit; h.n=nrm; h.alb=uAlbWall; return h; }
    if(tHit > uMaxDist) break;
  }
  return h;
}

vec3 shadeHit(Hit h, vec3 ro, vec3 rd){
  if(h.sky) return uSky;
  vec3 hp = ro + rd*h.t;
  vec3 Lv = uLanternPos - hp;
  float d = length(Lv);
  vec3 Ld = Lv / max(d, 1e-4);
  float falloff = pow(clamp(1.0 - d/uLanternRange, 0.0, 1.0), 2.0) / (1.0 + 0.15*d*d);
  float ndl = max(dot(h.n, Ld), 0.0);
  vec3 direct = uLanternColor * uLanternInt * falloff * ndl;
  return h.alb * (direct + uAmbient);
}
`;

// glslVersion: THREE.GLSL3 makes three prepend "#version 300 es", so the
// shader bodies below must NOT declare it themselves.
const FULLSCREEN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export class DDGI {
  constructor(renderer, maze) {
    this.renderer = renderer;
    this.maze = maze;

    // Probe grid: one probe column per maze cell, a few levels vertically.
    const ny = 3;
    const y0 = 0.7;
    const ySpacing = (maze.wallHeight - 2 * y0) / (ny - 1);
    this.counts = new THREE.Vector3(maze.gw, ny, maze.gh);
    this.probeMin = new THREE.Vector3(
      -maze.worldW / 2 + maze.cellSize / 2,
      y0,
      -maze.worldD / 2 + maze.cellSize / 2
    );
    this.probeSpacing = new THREE.Vector3(maze.cellSize, ySpacing, maze.cellSize);
    this.probeTotal = maze.gw * ny * maze.gh;

    this.atlasCols = Math.ceil(Math.sqrt(this.probeTotal));
    this.atlasRows = Math.ceil(this.probeTotal / this.atlasCols);
    this.atlasW = this.atlasCols * OCTA;
    this.atlasH = this.atlasRows * OCTA;

    this._buildOccupancyTexture();
    this._buildTargets();
    this._buildPasses();

    // Uniforms shared into every patched scene material (by reference).
    this.shared = {
      uIrr: { value: this.irrA.textures[0] },
      uDepth: { value: this.irrA.textures[1] },
      uProbeMin: { value: this.probeMin },
      uProbeSpacing: { value: this.probeSpacing },
      uCounts: { value: this.counts },
      uOcta: { value: OCTA },
      uAtlasCols: { value: this.atlasCols },
      uIndirect: { value: 1.6 },
      uChebyshev: { value: 1 }, // 0 = no visibility (shows light leaking)
    };

    this.rayRot = new THREE.Matrix3();
    this._frame = 0;
  }

  _buildOccupancyTexture() {
    const { gw, gh, grid } = this.maze;
    const data = new Float32Array(gw * gh);
    for (let z = 0; z < gh; z++) {
      for (let x = 0; x < gw; x++) {
        data[z * gw + x] = grid[z][x] === 1 ? 1.0 : 0.0;
      }
    }
    const tex = new THREE.DataTexture(data, gw, gh, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this.occTex = tex;
  }

  _makeTarget(w, h, count = 1) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
      count,
    });
  }

  _buildTargets() {
    this.rayRT = this._makeTarget(RAYS_PER_PROBE, this.probeTotal);
    // MRT: textures[0] = octahedral irradiance, textures[1] = depth moments
    // (mean, mean²) — the second moment drives the Chebyshev visibility test
    // that stops light leaking through walls.
    this.irrA = this._makeTarget(this.atlasW, this.atlasH, 2);
    this.irrB = this._makeTarget(this.atlasW, this.atlasH, 2);
  }

  _buildPasses() {
    this._fsScene = new THREE.Scene();
    this._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this._fsScene.add(this._fsQuad);

    // --- Pass A: gather ---
    this.gatherMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uOcc: { value: this.occTex },
        uGrid: { value: new THREE.Vector2(this.maze.gw, this.maze.gh) },
        uCellSize: { value: this.maze.cellSize },
        uWorldHalf: { value: new THREE.Vector2(this.maze.worldW / 2, this.maze.worldD / 2) },
        uWallHeight: { value: this.maze.wallHeight },
        uAlbWall: { value: new THREE.Color(this.maze.albedo.wall) },
        uAlbFloor: { value: new THREE.Color(this.maze.albedo.floor) },
        uAlbCeil: { value: new THREE.Color(this.maze.albedo.ceiling) },
        uSky: { value: new THREE.Color(0x05060a) },
        uLanternPos: { value: new THREE.Vector3() },
        uLanternColor: { value: new THREE.Color(0xffaa55) },
        uLanternInt: { value: 3.4 },
        uLanternRange: { value: 22 },
        uAmbient: { value: new THREE.Color(0x0a0c12) },
        uMaxDist: { value: this.maze.worldW },
        uProbeMin: { value: this.probeMin },
        uProbeSpacing: { value: this.probeSpacing },
        uCounts: { value: this.counts },
        uK: { value: RAYS_PER_PROBE },
        uRayRot: { value: new THREE.Matrix3() },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
precision highp float;
precision highp int;
${GLSL_COMMON}
${GLSL_TRACE}
uniform vec3 uProbeMin;
uniform vec3 uProbeSpacing;
uniform ivec3 uCounts;
uniform int uK;
uniform mat3 uRayRot;
out vec4 fragColor;
void main(){
  int k = int(gl_FragCoord.x);
  int p = int(gl_FragCoord.y);
  int px = uCounts.x, py = uCounts.y;
  int ix = p % px;
  int tmp = p / px;
  int iy = tmp % py;
  int iz = tmp / py;
  vec3 ppos = uProbeMin + vec3(float(ix), float(iy), float(iz)) * uProbeSpacing;
  vec3 dir = normalize(uRayRot * sphericalFibonacci(float(k), float(uK)));
  Hit h = traceMaze(ppos, dir);
  vec3 rad = shadeHit(h, ppos, dir);
  fragColor = vec4(rad, h.sky ? uMaxDist : h.t);
}
`,
    });

    // --- Pass B: octahedral irradiance blend ---
    this.blendMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uRay: { value: this.rayRT.texture },
        uPrev: { value: this.irrB.textures[0] },
        uPrevDepth: { value: this.irrB.textures[1] },
        uK: { value: RAYS_PER_PROBE },
        uOcta: { value: OCTA },
        uAtlasCols: { value: this.atlasCols },
        uProbeTotal: { value: this.probeTotal },
        uRayRot: { value: new THREE.Matrix3() },
        uBlend: { value: 1.0 },
        uMaxDist: { value: this.maze.worldW },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
precision highp float;
precision highp int;
${GLSL_COMMON}
uniform sampler2D uRay;
uniform sampler2D uPrev;
uniform sampler2D uPrevDepth;
uniform int uK;
uniform int uOcta;
uniform int uAtlasCols;
uniform int uProbeTotal;
uniform mat3 uRayRot;
uniform float uBlend;
uniform float uMaxDist;
layout(location = 0) out vec4 oIrr;
layout(location = 1) out vec4 oDepth;
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  int tileX = px.x / uOcta;
  int tileY = px.y / uOcta;
  int p = tileY * uAtlasCols + tileX;
  if(p >= uProbeTotal){ oIrr = vec4(0.0); oDepth = vec4(0.0); return; }
  ivec2 local = px - ivec2(tileX, tileY) * uOcta;
  vec2 octUV = (vec2(local) + 0.5) / float(uOcta);
  vec3 dir = octDecode(octUV);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  // Depth moments use a sharper directional lobe so each texel stores the
  // distance to geometry roughly along its own direction.
  float dAcc = 0.0, d2Acc = 0.0, dwsum = 0.0;
  for(int k=0; k<uK; k++){
    vec4 ray = texelFetch(uRay, ivec2(k, p), 0);
    vec3 rdir = normalize(uRayRot * sphericalFibonacci(float(k), float(uK)));
    float c = max(dot(dir, rdir), 0.0);
    acc += ray.rgb * c;
    wsum += c;
    float wd = pow(c, 8.0);
    float dist = min(ray.a, uMaxDist);
    dAcc += dist * wd;
    d2Acc += dist * dist * wd;
    dwsum += wd;
  }
  vec3 irr = wsum > 0.0 ? acc / wsum : vec3(0.0);
  vec2 mom = dwsum > 0.0 ? vec2(dAcc, d2Acc) / dwsum : vec2(uMaxDist, uMaxDist * uMaxDist);
  vec3 prevI = texelFetch(uPrev, px, 0).rgb;
  vec2 prevD = texelFetch(uPrevDepth, px, 0).rg;
  oIrr = vec4(mix(prevI, irr, uBlend), 1.0);
  oDepth = vec4(mix(prevD, mom, uBlend), 0.0, 1.0);
}
`,
    });
  }

  // Patch a MeshStandardMaterial so it adds the DDGI indirect diffuse term.
  patch(material) {
    const shared = this.shared;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, shared);
      shader.vertexShader =
        'varying vec3 vWorldPos;\nvarying vec3 vWorldNrm;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          #ifdef USE_INSTANCING
            vWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
            vWorldNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
          #else
            vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
            vWorldNrm = normalize(mat3(modelMatrix) * objectNormal);
          #endif`
        );
      shader.fragmentShader =
        `varying vec3 vWorldPos;
         varying vec3 vWorldNrm;
         uniform sampler2D uIrr;
         uniform sampler2D uDepth;
         uniform vec3 uProbeMin;
         uniform vec3 uProbeSpacing;
         uniform ivec3 uCounts;
         uniform int uOcta;
         uniform int uAtlasCols;
         uniform float uIndirect;
         uniform float uChebyshev;
         ${GLSL_COMMON}
         ivec2 tileTexel(int p, vec3 d){
           int tileX = p % uAtlasCols;
           int tileY = p / uAtlasCols;
           vec2 oc = octEncode(d);
           ivec2 local = ivec2(clamp(oc*float(uOcta), vec2(0.0), vec2(float(uOcta)-1.0)));
           return ivec2(tileX, tileY)*uOcta + local;
         }
         vec3 sampleProbe(int p, vec3 n){ return texelFetch(uIrr, tileTexel(p,n), 0).rgb; }
         vec2 sampleDepth(int p, vec3 d){ return texelFetch(uDepth, tileTexel(p,d), 0).rg; }
         vec3 sampleIrradiance(vec3 P, vec3 N){
           vec3 g = (P - uProbeMin) / uProbeSpacing;
           ivec3 base = ivec3(floor(g));
           vec3 fr = g - vec3(base);
           vec3 sum = vec3(0.0);
           float wsum = 0.0;
           for(int i=0;i<8;i++){
             ivec3 o = ivec3(i & 1, (i >> 1) & 1, (i >> 2) & 1);
             ivec3 c = clamp(base + o, ivec3(0), uCounts - ivec3(1));
             vec3 tl = mix(1.0 - fr, fr, vec3(o));
             float w = tl.x * tl.y * tl.z;
             vec3 ppos = uProbeMin + vec3(c) * uProbeSpacing;
             vec3 toP = P - ppos;
             float dist = length(toP);
             vec3 dirPP = dist > 1e-4 ? toP / dist : N;
             // Back-face weighting: probes "behind" the surface contribute less.
             float ndp = dot(N, -dirPP);
             w *= clamp(ndp*0.5+0.5, 0.05, 1.0);
             int p = (c.z * uCounts.y + c.y) * uCounts.x + c.x;
             // Chebyshev visibility (variance shadow map in distance): if the
             // shading point is farther than the probe's mean distance to
             // geometry in this direction, it is probably behind a wall — this
             // is what stops indirect light leaking through maze walls.
             vec2 mom = sampleDepth(p, dirPP);
             float mean = mom.x;
             float variance = max(mom.y - mean*mean, 2e-4);
             float vis = 1.0;
             if(dist > mean){
               float dd = dist - mean;
               vis = variance / (variance + dd*dd);
               vis = vis*vis*vis;
             }
             w *= mix(1.0, max(vis, 0.02), uChebyshev);
             sum += w * sampleProbe(p, N);
             wsum += w;
           }
           return wsum > 0.0 ? sum / wsum : vec3(0.0);
         }
        ` + shader.fragmentShader.replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
           reflectedLight.indirectDiffuse += sampleIrradiance(vWorldPos, normalize(vWorldNrm)) * diffuseColor.rgb * uIndirect;`
        );
    };
    material.needsUpdate = true;
  }

  setLantern(pos, intensity) {
    this.gatherMat.uniforms.uLanternPos.value.copy(pos);
    if (intensity !== undefined) this.gatherMat.uniforms.uLanternInt.value = intensity;
  }

  update() {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();

    // New random ray rotation each frame so temporal accumulation covers the
    // sphere; gather and blend must share the SAME rotation this frame.
    const e = new THREE.Euler(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2
    );
    const m4 = new THREE.Matrix4().makeRotationFromEuler(e);
    this.rayRot.setFromMatrix4(m4);
    this.gatherMat.uniforms.uRayRot.value.copy(this.rayRot);
    this.blendMat.uniforms.uRayRot.value.copy(this.rayRot);

    // Pass A: gather rays.
    this._fsQuad.material = this.gatherMat;
    r.setRenderTarget(this.rayRT);
    r.render(this._fsScene, this._fsCam);

    // Pass B: blend into irradiance + depth atlas (ping-pong A<-B).
    this.blendMat.uniforms.uRay.value = this.rayRT.texture;
    this.blendMat.uniforms.uPrev.value = this.irrB.textures[0];
    this.blendMat.uniforms.uPrevDepth.value = this.irrB.textures[1];
    this.blendMat.uniforms.uBlend.value = this._frame < 2 ? 1.0 : 0.08;
    this._fsQuad.material = this.blendMat;
    r.setRenderTarget(this.irrA);
    r.render(this._fsScene, this._fsCam);

    // Swap so irrA (newest) feeds the materials and becomes next frame's prev.
    const t = this.irrA;
    this.irrA = this.irrB;
    this.irrB = t;
    this.shared.uIrr.value = this.irrB.textures[0];
    this.shared.uDepth.value = this.irrB.textures[1];

    r.setRenderTarget(prevTarget);
    this._frame++;
  }
}
