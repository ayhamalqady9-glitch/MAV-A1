// The Martian surface around the Arsia skylight, in the same world as the lava tube:
// the pit is a real hole whose shaft continues down into the cave (cave.js). The HiRISE image
// of this skylight is draped over the ground at the scale where its pit matches the 3D hole,
// so the orbital target and the place the drone flies to are visibly the same spot.
//
// Around it, a real Martian landscape:
//   · terrain regions: dark basaltic sand with ripples and small transverse dunes, fractured bedrock plates,
//     small impact craters (fresh ones with bright ejecta and boulders, old ones filled with sand),
//     lava-flow pressure ridges, and the thruster-scoured blast zone under the lander
//   · angular basalt rocks (block, tall, slab, weathered) clustered in rock fields and crater ejecta
//   · the horizon: a mountain range behind the lander, Arsia Mons' shield rising beyond the skylight,
//     mesas and buttes on the flanks and the rim of a large old crater, all in aerial perspective
//   · a regional dust storm front rolling in over the mountains (it comes closer as the mission goes on)
import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { createRockMaterial, GLSL_NOISE, GLSL_PHOTO, PHOTO } from './rock-material.js';
import { createLander } from './lander.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

export function createSurface({ hirise, pit, shaftCenter, shaftR, groundY, mobile = false }) {
  const group = new THREE.Group(); group.name = 'surface';
  const noise = new ImprovedNoise();
  const sc = shaftCenter;
  const HOLE = shaftR * 1.06;
  let seed = 20260715; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  // HiRISE footprint: the image's pit (pit.d of its width) spans the 3D hole
  const imgW = (HOLE * 2) / pit.d, imgH = imgW / pit.aspect;
  const imgC = new THREE.Vector2(sc.x + (0.5 - pit.u) * imgW, sc.z + (0.5 - pit.v) * imgH);
  const FOOT_R = Math.hypot(imgW, imgH) * 0.5;

  // lander site: flat ground ~38 m from the pit. The prevailing wind blows from beyond the lander toward the pit.
  const LANDER = new V3(sc.x + 30, 0, sc.z + 24);
  const toPit = new V3(sc.x - LANDER.x, 0, sc.z - LANDER.z).normalize();
  const WIND = new THREE.Vector2(toPit.x, toPit.z);
  const aFront = Math.atan2(toPit.z, toPit.x), aBack = Math.atan2(-toPit.z, -toPit.x);

  // ---------------------------------------------------------------- small impact craters (deterministic)
  const craters = [];
  for (let tries = 0; craters.length < 15 && tries < 600; tries++) {
    const big = craters.length < 3;
    const r = big ? 13 + rnd() * 14 : 2.8 + rnd() * 8;
    const d = big ? 120 + rnd() * 150 : 24 + rnd() * 150, a = rnd() * Math.PI * 2;
    const c = { x: sc.x + Math.cos(a) * d, z: sc.z + Math.sin(a) * d, r, fresh: rnd() < 0.5, ray: rnd() * 10 };
    if (Math.hypot(c.x - LANDER.x, c.z - LANDER.z) < r * 2.2 + 16) continue;
    if (Math.hypot(c.x - sc.x, c.z - sc.z) < FOOT_R + r * 1.8 + 4) continue;
    if (craters.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < (o.r + r) * 1.7)) continue;
    craters.push(c);
  }
  function craterH(x, z) {
    let h = 0;
    for (const c of craters) {
      const dx = x - c.x, dz = z - c.z, R3 = c.r * 3.2, d2 = dx * dx + dz * dz;
      if (d2 > R3 * R3) continue;
      const s = Math.sqrt(d2) / c.r;
      const depth = c.r * (c.fresh ? 0.2 : 0.08), rim = c.r * (c.fresh ? 0.065 : 0.028);
      if (s < 1) h += c.fresh ? -depth + (depth + rim) * s * s * s : -depth * (1 - smooth(0.55, 1, s)) + rim * smooth(0.7, 1, s);
      else h += rim * Math.pow(s, -3) * (1 - smooth(2.2, 3.2, s));
    }
    return h;
  }
  // ---------------------------------------------------------------- terrain regions
  function sandMask(x, z) {
    const n = noise.noise(x * 0.012 + 3.1, 11.3, z * 0.012 - 1.7) + 0.4 * noise.noise(x * 0.05, 2.2, z * 0.05);
    let s = smooth(0.1, 0.32, n);
    for (const c of craters) if (!c.fresh) { const d = Math.hypot(x - c.x, z - c.z) / c.r; if (d < 1) s = Math.max(s, 1 - smooth(0.55, 0.95, d)); }   // old craters hold sand
    return s;
  }
  const outcropMask = (x, z) => smooth(0.16, 0.34, noise.noise(x * 0.016 - 5, 4.4, z * 0.016 + 2) + 0.3 * noise.noise(x * 0.07, 8.8, z * 0.07));
  function ejectaMask(x, z) {
    let e = 0;
    for (const c of craters) {
      if (!c.fresh) continue;
      const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz) / c.r;
      if (d > 2.8 || d < 0.75) continue;
      const rays = 0.55 + 0.45 * Math.sin(Math.atan2(dz, dx) * 7 + c.ray) * Math.sin(Math.atan2(dz, dx) * 3 + c.ray * 2);
      e = Math.max(e, smooth(0.8, 1.02, d) * (1 - smooth(1.1, 2.8, d)) * rays);
    }
    return e;
  }

  function height(x, z) {
    const r = Math.hypot(x - sc.x, z - sc.z);
    let h = 1.8 * noise.noise(x * 0.013, 0.3, z * 0.013) + 0.55 * noise.noise(x * 0.06, 1.7, z * 0.06) + 0.12 * noise.noise(x * 0.3, 3.1, z * 0.3);
    h += 0.75 * Math.pow(1 - Math.abs(noise.noise(x * 0.021, 13.7, z * 0.008)), 5);              // lava-flow pressure ridges
    h += 30 * smooth(160, 520, r) * (0.65 + 0.35 * noise.noise(x * 0.004, 5.2, z * 0.004));   // Arsia's flank rising to the horizon
    h += 1.0 * Math.exp(-(((r - HOLE * 1.4) / 3.0) ** 2));                                  // raised rim
    h -= 3.6 * (1 - smooth(HOLE, HOLE * 1.28, r));                                           // edge rolls into the shaft
    if (r < 420) h += craterH(x, z);
    if (r < 175 && r > FOOT_R) {                                                             // small transverse dunes on the sand
      const sm = sandMask(x, z) * (1 - smooth(120, 175, r)) * smooth(FOOT_R, FOOT_R + 10, r);
      if (sm > 0.001) {
        const ph = (x * WIND.x + z * WIND.y) * (Math.PI * 2 / 9.5) + noise.noise(x * 0.03, 5.5, z * 0.03) * 3.0;
        h += sm * 0.5 * Math.pow(0.5 + 0.5 * Math.sin(ph), 1.8);
      }
    }
    if (r > 220 && r < 900) h += lavaFlows(x, z, r) + pitChain(x, z);
    const lr = Math.hypot(x - LANDER.x, z - LANDER.z);
    h = h * smooth(7, 16, lr);                                                               // flat landing site
    return groundY + h;
  }
  // Arsia's flank is a lava plain: overlapping flow lobes, each a flat-topped sheet ending in a steep, lobate
  // front a few to ~20 m high, stacked as they step up the volcano (uphill = beyond the lander)
  function lavaFlows(x, z, r) {
    const t = smooth(220, 360, r) * (1 - smooth(830, 890, r));
    if (t <= 0) return 0;
    const w = noise.noise(x / 160, 5.7, z / 160) * 0.35;                                   // lobes meander
    const n1 = noise.noise(x / 260 + w, 71.3, z / 260), n2 = noise.noise(x / 170 - w, 13.9, z / 170 + 4.1), n3 = noise.noise(x / 110, 33.1, z / 110);
    const up = 0.6 + 0.4 * Math.max(0, (x - sc.x) * -toPit.x + (z - sc.z) * -toPit.z) / Math.max(r, 1);   // taller fronts uphill
    let h = (9 * smooth(0.02, 0.07, n1) + 7 * smooth(0.18, 0.23, n2) + 5 * smooth(0.3, 0.34, n3)) * up;
    h += 1.2 * noise.noise(x / 18, 2.2, z / 18);                                                // hummocky crust
    return t * h;
  }
  // a chain of collapse pits, the kind that lines Arsia's flanks: steep walls, no raised rim (not impact craters)
  const chainC = new V3(sc.x, 0, sc.z).addScaledVector(new V3(-toPit.z, 0, toPit.x), 470).addScaledVector(toPit, -60);
  const chainDir = new V3(toPit.x, 0, toPit.z).applyAxisAngle(new V3(0, 1, 0), 0.5);
  const chain = [[-2, 26], [-1, 40], [0, 18], [1, 33], [2, 22]].map(([k, r]) => ({ c: chainC.clone().addScaledVector(chainDir, k * 92), r }));
  function pitChain(x, z) {
    let h = 0;
    for (const p of chain) {
      const d = Math.hypot(x - p.c.x, z - p.c.z) / p.r;
      if (d < 1.15) h -= p.r * 0.55 * (1 - smooth(0.72, 1.0, d)) - p.r * 0.08 * (1 - smooth(0.0, 0.7, d));   // sand-floored bowl
    }
    return h;
  }

  // ---------------------------------------------------------------- region map for the ground shader
  const RS = mobile ? 256 : 512, RSIZE = 640;
  const RC = new V3((sc.x + LANDER.x) / 2, 0, (sc.z + LANDER.z) / 2);
  const rd = new Uint8Array(RS * RS * 4);
  for (let j = 0; j < RS; j++) for (let i = 0; i < RS; i++) {
    const x = RC.x + ((i + 0.5) / RS - 0.5) * RSIZE, z = RC.z + ((j + 0.5) / RS - 0.5) * RSIZE;
    const fp = smooth(FOOT_R * 0.85, FOOT_R * 1.1, Math.hypot(x - sc.x, z - sc.z));        // the HiRISE drape rules its own footprint
    const blast = 1 - smooth(6, 13, Math.hypot(x - LANDER.x, z - LANDER.z));             // thrusters blew the dust off the bedrock
    const sand = sandMask(x, z) * fp * (1 - blast);
    const out = Math.max(outcropMask(x, z) * (1 - sand), blast * 0.9) * fp;
    const k = (j * RS + i) * 4;
    rd[k] = sand * 255; rd[k + 1] = out * 255; rd[k + 2] = ejectaMask(x, z) * fp * 255; rd[k + 3] = 255;
  }
  const regionTex = new THREE.DataTexture(rd, RS, RS, THREE.RGBAFormat, THREE.UnsignedByteType);
  regionTex.magFilter = THREE.LinearFilter; regionTex.minFilter = THREE.LinearMipmapLinearFilter; regionTex.generateMipmaps = true; regionTex.needsUpdate = true;

  // ---------------------------------------------------------------- terrain: polar grid, dense at the pit
  const NR = mobile ? 120 : 190, NA = mobile ? 180 : 300, RMAX = 900;
  const pos = new Float32Array((NR + 1) * NA * 3);
  for (let i = 0; i <= NR; i++) {
    const r = HOLE * Math.pow(RMAX / HOLE, i / NR);
    for (let j = 0; j < NA; j++) {
      const a = (j / NA) * Math.PI * 2, x = sc.x + Math.cos(a) * r, z = sc.z + Math.sin(a) * r;
      pos.set([x, height(x, z), z], (i * NA + j) * 3);
    }
  }
  const ringIndex = (nr, na) => {
    const idx = [];
    for (let i = 0; i < nr; i++) for (let j = 0; j < na; j++) {
      const a = i * na + j, b = i * na + (j + 1) % na, c = (i + 1) * na + j, d = (i + 1) * na + (j + 1) % na;
      idx.push(a, b, c, b, d, c);   // counter-clockwise seen from above → normals point up
    }
    return idx;
  };
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setIndex(ringIndex(NR, NA)); tg.computeVertexNormals();
  const groundMat = createRockMaterial({ dust: 0.9, scale: 1, bump: 1.2, photo: 0.55, ripples: 1, hirise, hiriseRect: new THREE.Vector4(imgC.x, imgC.y, imgW, imgH),
    region: regionTex, regionRect: new THREE.Vector4(RC.x, RC.z, RSIZE, 0), wind: WIND.clone(), photoSet: 'ground', photoScale: 0.42 });
  const ground = new THREE.Mesh(tg, groundMat); ground.name = 'terrain'; ground.receiveShadow = true;
  group.add(ground);

  // ---------------------------------------------------------------- the horizon: mountains, Arsia's shield, mesas, a crater rim
  const CR = { x: sc.x + Math.cos(aFront + 0.95) * 1850, z: sc.z + Math.sin(aFront + 0.95) * 1850, r: 520 };
  const angDist = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };
  function ridged(x, z, f, oct, s) {
    let sum = 0, amp = 1, norm = 0;
    for (let i = 0; i < oct; i++) { const n = 1 - Math.abs(noise.noise(x * f, s + i * 7.31, z * f)); sum += amp * n * n; norm += amp; amp *= 0.5; f *= 2.07; }
    return sum / norm;
  }
  function mountains(x, z) {
    const dx = x - sc.x, dz = z - sc.z, r = Math.hypot(dx, dz);
    const t = smooth(940, 1300, r); if (t <= 0) return 0;
    const a = Math.atan2(dz, dx);
    const back = smooth(1.3, 0.35, angDist(a, aBack)), front = smooth(1.6, 0.5, angDist(a, aFront));
    let h = 0;
    // uphill (beyond the lander) the shield of Arsia Mons rises a few degrees, stepped by stacked lava-flow fronts
    const steps = 22 * smooth(0.05, 0.1, noise.noise(x / 420, 11.3, z / 420)) + 16 * smooth(0.25, 0.3, noise.noise(x / 300, 23.7, z / 300));
    h += back * (150 * Math.pow(smooth(1000, 2600, r), 1.2) + steps * smooth(1000, 1400, r));
    h += front * 18 * ridged(x, z, 1 / 300, 3, 23) * smooth(1000, 1500, r);                  // downhill: an open lava plain
    const side = Math.max(0, 1 - back - front);
    const mz = noise.noise(x / 300, 31.7, z / 300) + 0.35 * noise.noise(x / 110, 9.1, z / 110);
    h += side * (30 * smooth(0.2, 0.26, mz) + 16 * smooth(0.46, 0.5, mz)) * smooth(1050, 1350, r);   // low flow plateaus
    h += 18 * ridged(x, z, 1 / 230, 4, 41) * smooth(1000, 1800, r);                           // hummocky lava
    h += 55 * smooth(1950, 2550, r) * (0.55 + 0.45 * ridged(x, z, 1 / 650, 3, 51));           // a low skyline hides the world's edge
    const cd = Math.hypot(x - CR.x, z - CR.z) / CR.r;                                          // an old impact crater's rim
    h += cd < 1 ? -35 + 90 * cd ** 4 : 55 * Math.exp(-(((cd - 1) / 0.28) ** 2));
    return h * t;
  }
  const FR = mobile ? 60 : 96, FA = mobile ? 480 : 800, R0 = 880, R1 = 2600;
  const fpos = new Float32Array((FR + 1) * FA * 3);
  for (let i = 0; i <= FR; i++) {
    const r = R0 * Math.pow(R1 / R0, i / FR);
    for (let j = 0; j < FA; j++) {
      const a = (j / FA) * Math.PI * 2, x = sc.x + Math.cos(a) * r, z = sc.z + Math.sin(a) * r;
      fpos.set([x, height(x, z) - 0.6 * (1 - smooth(892, 935, r)) + mountains(x, z), z], (i * FA + j) * 3);   // tucked under the near ground's edge
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  fg.setIndex(ringIndex(FR, FA)); fg.computeVertexNormals();
  const farMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  farMat.onBeforeCompile = (sh) => {
    sh.uniforms.uFarC = { value: new THREE.Vector2(sc.x, sc.z) };
    Object.assign(sh.uniforms, PHOTO);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 fW; varying vec3 fN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n fW = (modelMatrix * vec4(transformed, 1.0)).xyz; fN = mat3(modelMatrix) * objectNormal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 fW; varying vec3 fN; uniform vec2 uFarC;\n${GLSL_NOISE}\n${GLSL_PHOTO}`)
      .replace('#include <map_fragment>', `
        float fl = length(fN); vec3 fNn = fl > 1e-6 ? fN / fl : vec3(0.0, 1.0, 0.0);
        float foot = max(length(fwidth(fW)), 1e-3);
        float big = rk_fbmA(fW * 0.0032, 3, foot * 0.0032);
        float mid = rk_fbmA(fW * 0.028, 4, foot * 0.028);
        float fine = rk_fbmA(fW * 0.22, 3, foot * 0.22);
        float up = clamp(fNn.y, 0.0, 1.0), steep = 1.0 - smoothstep(0.5, 0.88, up);
        vec3 basalt = mix(vec3(0.045, 0.038, 0.034), vec3(0.15, 0.115, 0.095), mid);
        // layered walls of mesas and crater rims: irregular beds, faded out where a pixel spans several of them
        float strata = 0.5 + 0.5 * sin(fW.y * 0.21 + big * 14.0 + mid * 6.0);
        strata = mix(0.5, strata, (1.0 - smoothstep(2.0, 6.0, foot)) * smoothstep(0.35, 0.65, mid));
        basalt *= 0.85 + 0.3 * strata * steep;
        vec3 dustC = mix(vec3(0.36, 0.17, 0.085), vec3(0.6, 0.35, 0.2), clamp(fine * 0.4 + mid * 0.5, 0.0, 1.0));   // the near ground's dust
        float dustAmt = clamp(smoothstep(0.55, 0.92, up) * 0.95 + (big - 0.5) * 0.7 - steep * 0.5, 0.0, 1.0);
        float rise = smoothstep(940.0, 1400.0, length(fW.xz - uFarC));                   // plain → mountains
        vec3 fcol = mix(basalt, dustC, dustAmt) * mix(1.0, 0.72 + 0.3 * smoothstep(0.25, 0.75, big), rise);
        fcol = mix(fcol, vec3(0.16, 0.095, 0.065), smoothstep(0.62, 0.8, rk_fbmA(fW * 0.0018 + 3.0, 2, foot * 0.0018)) * smoothstep(0.3, 0.7, mid) * up * 0.3 * rise);   // dark sand sheets
        if (phOn > 0.5) {                                                               // photo strata on walls, photo ground on flats
          vec3 fw = pow(abs(fNn), vec3(4.0)); fw /= (fw.x + fw.y + fw.z + 1e-5);
          vec3 pc = texture2D(phStrataC, fW.zy * 0.022).rgb * fw.x + texture2D(phGroundC, fW.xz * 0.012).rgb * fw.y + texture2D(phStrataC, fW.xy * 0.022).rgb * fw.z;
          fcol *= mix(vec3(1.0), ph_ratio(pc, phStrataM * (fw.x + fw.z) + phGroundM * fw.y), 0.85);
          fcol = mix(fcol, mix(basalt * 1.3, dustC * 0.7, 0.22) * ph_ratio(pc, phStrataM), steep * 0.5);   // flow fronts: stacked dark basalt
        }
        diffuseColor.rgb *= fcol;
        float fH = rk_fbmA(fW * 0.05, 4, foot * 0.05) * 6.0;`)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = rk_perturb(-vViewPosition, normal, fH);');
  };
  farMat.customProgramCacheKey = () => 'mav-far-2';
  const far = new THREE.Mesh(fg, farMat); far.name = 'horizon'; far.receiveShadow = false;
  group.add(far);

  // ---------------------------------------------------------------- rocks: angular basalt in four shapes
  const rockShape = (v, { cuts = 4, flat = 0.62, stretch = 1, rough = 1, detail = 2 } = {}) => {
    const g = new THREE.IcosahedronGeometry(1, detail), gp = g.attributes.position;
    let s = 101 + v * 977; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const planes = Array.from({ length: cuts }, () => {                       // fracture planes: flat faces, sharp edges
      const th = r() * Math.PI * 2, ph = (r() - 0.35) * 1.2;
      return { n: new V3(Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph)), d: 0.55 + r() * 0.3 };
    });
    const q = new V3();
    for (let i = 0; i < gp.count; i++) {
      q.fromBufferAttribute(gp, i);
      q.multiplyScalar(1 + rough * (0.24 * noise.noise(q.x * 1.2 + v * 9, q.y * 1.2, q.z * 1.2) + 0.09 * noise.noise(q.x * 3.1, q.y * 3.1 + v * 5, q.z * 3.1)));
      q.x *= stretch;
      for (const p of planes) { const sd = q.dot(p.n) - p.d; if (sd > 0) q.addScaledVector(p.n, -sd * 0.93); }
      const l = q.length(); if (l > 1e-6) q.multiplyScalar(1 + rough * 0.035 * noise.noise(q.x * 7.5 + v, q.y * 7.5, q.z * 7.5));
      q.y = q.y < -0.2 ? -0.2 + (q.y + 0.2) * 0.12 : q.y * flat;                  // settled, flat underside
      gp.setXYZ(i, q.x, q.y, q.z);
    }
    // shared vertices (3–6× less vertex work for thousands of instances); the facets come back in the shader (flatShading)
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    const ix = mergeVertices(g, 1e-5); ix.computeVertexNormals(); return ix;
  };
  const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), s3 = new V3();
  const boulderMat = createRockMaterial({ dust: 0.4, scale: 2.2, bump: 1.6, photo: 0.9, photoSet: 'rock', photoScale: 0.62 });
  boulderMat.flatShading = true;
  const SHAPES = [
    { cuts: 5, flat: 0.7, stretch: 1.1, rough: 0.8 },     // block
    { cuts: 4, flat: 0.9, stretch: 0.9, rough: 1.0 },     // tall, fractured
    { cuts: 3, flat: 0.38, stretch: 1.35, rough: 0.6 },   // slab
    { cuts: 0, flat: 0.6, stretch: 1.0, rough: 1.1 },     // weathered, rounded
  ];
  const PER = mobile ? 330 : 950;
  // two levels of detail per shape: full detail near the lander and the pit, a lighter mesh for the far field
  const mkSet = (geo, v, lod) => { const m = new THREE.InstancedMesh(geo, boulderMat, PER); m.count = 0; m.castShadow = true; m.receiveShadow = true; m.name = `rocks-${v}-${lod}`; group.add(m); return m; };
  const rockSets = SHAPES.map((o, v) => mkSet(rockShape(v, o), v, 'near'));
  const rockFar = SHAPES.map((o, v) => mkSet(rockShape(v, { ...o, detail: 1 }), v, 'far'));
  // how rocky the ground is here: rock fields, bare bedrock and crater ejecta are rocky, sand is not
  const rockiness = (x, z) => Math.min(1, Math.max(0.05,
    0.3 + 0.8 * smooth(-0.15, 0.35, noise.noise(x * 0.03 + 9, 1.1, z * 0.03 - 4)) - 0.8 * sandMask(x, z) + 0.25 * outcropMask(x, z) + 1.4 * ejectaMask(x, z)));
  const nRocks = () => rockSets.reduce((a, m) => a + m.count, 0) + rockFar.reduce((a, m) => a + m.count, 0);
  for (let k = 0; nRocks() < PER * 4 && k < PER * 60; k++) {
    const near = Math.random() < 0.45;
    const c = near ? (Math.random() < 0.5 ? LANDER : new V3(sc.x, 0, sc.z)) : new V3(sc.x, 0, sc.z);
    const r = (near ? 5 : 11) + Math.pow(Math.random(), near ? 1.3 : 1.15) * (near ? 45 : 175), a = Math.random() * Math.PI * 2;
    const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
    if (Math.hypot(x - LANDER.x, z - LANDER.z) < 8 || Math.hypot(x - sc.x, z - sc.z) < HOLE * 1.4) continue;   // rim boulders would stripe the shaft with shadows
    const ej = ejectaMask(x, z);
    if (Math.random() > rockiness(x, z)) continue;
    const v = Math.floor(Math.random() * 4);
    let sz = (0.15 + Math.pow(Math.random(), 2.4) * 1.35) * (1 + ej * 0.7);
    if (Math.random() < 0.012 && r > 25) sz *= 2.2;                                      // the odd big boulder
    const nearSite = Math.min(Math.hypot(x - LANDER.x, z - LANDER.z), Math.hypot(x - sc.x, z - sc.z)) < 60 && sz > 0.42;   // fine mesh only where it shows
    const m = (nearSite ? rockSets : rockFar)[v];
    if (m.count >= PER || (nearSite ? rockSets : rockFar).reduce((a, q) => a + q.count, 0) >= PER * 2.4) continue;
    const buried = Math.random() < 0.35 ? -sz * (0.25 + Math.random() * 0.3) : sz * 0.08;   // half-buried in regolith
    const tilt = v === 2 ? 0.45 : 0.25;
    qq.setFromEuler(new THREE.Euler((Math.random() - 0.5) * tilt, Math.random() * 6.28, (Math.random() - 0.5) * tilt));
    m.setMatrixAt(m.count++, m4.compose(new V3(x, height(x, z) + buried, z), qq, s3.set(sz * (0.75 + Math.random() * 0.6), sz * (0.7 + Math.random() * 0.4), sz * (0.75 + Math.random() * 0.6))));
  }
  // split every instanced set into 80 m map chunks: the main camera, the sun's shadow camera and the CV camera
  // then only draw the chunks they can actually see (one big instanced mesh is never culled)
  function chunkify(mesh, cell = 80) {
    const bins = new Map(), mm = new THREE.Matrix4(), p = new V3();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, mm); p.setFromMatrixPosition(mm);
      const key = `${Math.floor(p.x / cell)}|${Math.floor(p.z / cell)}`;
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(mm.clone());
    }
    group.remove(mesh);
    return [...bins.values()].map((list) => {
      const c = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
      list.forEach((m, i) => c.setMatrixAt(i, m));
      c.instanceMatrix.needsUpdate = true; c.computeBoundingSphere();
      c.castShadow = mesh.castShadow; c.receiveShadow = mesh.receiveShadow; c.name = mesh.name;
      group.add(c);
      return c;
    });
  }
  const rockChunks = [...rockSets, ...rockFar].flatMap((m) => chunkify(m));
  // stones and gravel: two sizes, near the scene and spread wider, scarce on sand; they only receive shadows (AO grounds them)
  const pebMat = createRockMaterial({ dust: 0.45, scale: 6, bump: 1.2, photo: 0.7, photoSet: 'rock', photoScale: 1.7 });
  pebMat.flatShading = true;
  const scatter = (count, geo, minS, maxS, pw, spread) => {
    const mesh = new THREE.InstancedMesh(geo, pebMat, count);
    let pc = 0;
    for (let k = 0; pc < count && k < count * 5; k++) {
      const near = Math.random() < 0.6;
      const c = near ? (Math.random() < 0.5 ? LANDER : new V3(sc.x, 0, sc.z)) : new V3(sc.x, 0, sc.z);
      const r = (near ? 2.5 : HOLE * 1.15) + Math.pow(Math.random(), near ? 1.35 : 1.7) * (near ? spread * 0.45 : spread), a = Math.random() * Math.PI * 2;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      if (Math.hypot(x - sc.x, z - sc.z) < HOLE * 1.12 || Math.hypot(x - LANDER.x, z - LANDER.z) < 4.6) continue;
      if (Math.random() < sandMask(x, z) * 0.85) continue;
      const sz = minS + Math.pow(Math.random(), pw) * (maxS - minS);
      qq.setFromEuler(new THREE.Euler(Math.random() * 0.6, Math.random() * 6.28, Math.random() * 0.6));
      mesh.setMatrixAt(pc++, m4.compose(new V3(x, height(x, z) + sz * (Math.random() < 0.4 ? -0.15 : 0.12), z), qq, s3.set(sz * (0.8 + Math.random() * 0.6), sz * (0.7 + Math.random() * 0.4), sz * (0.8 + Math.random() * 0.6))));
    }
    mesh.count = pc; mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere();
    group.add(mesh);
    return mesh;
  };
  const stones = scatter(mobile ? 3000 : 9000, rockShape(5, { cuts: 3, rough: 1.2, detail: 0 }), 0.05, 0.32, 2.4, 95);    // stones (angular, 20 faces)
  stones.name = 'pebbles';
  const gravel = scatter(mobile ? 5000 : 16000, rockShape(6, { cuts: 2, rough: 1.3, detail: 0 }), 0.015, 0.07, 1.6, 70); // gravel
  gravel.name = 'gravel';
  const pebbles = [...chunkify(stones, 30), ...chunkify(gravel, 24)];   // small cells: culled finely by distance

  // ---------------------------------------------------------------- sky: Mars day → dusk (blue sunset), stars at night, storm haze
  const stormDir = new V3(Math.cos(aBack), 0, Math.sin(aBack));
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: new V3(-0.55, 0.32, -0.77).normalize() }, uDusk: { value: 0 }, uEarth: { value: new V3(0, 1, 0) }, uEarthGlow: { value: 1 },
      uStorm: { value: 0 }, uStormDir: { value: stormDir }, uTime: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 uSun, uEarth, uStormDir; uniform float uDusk, uEarthGlow, uStorm, uTime; varying vec3 vDir;
      ${GLSL_NOISE}
      float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }
      void main(){
        vec3 d = normalize(vDir); float el = clamp(d.y, -0.1, 1.0);
        vec3 dayH = vec3(0.56, 0.335, 0.2), dayZ = vec3(0.28, 0.16, 0.1);
        vec3 duskH = vec3(0.30, 0.17, 0.12), duskZ = vec3(0.012, 0.012, 0.03);
        vec3 col = mix(mix(dayH, dayZ, pow(max(el, 0.0), 0.55)), mix(duskH, duskZ, pow(max(el, 0.0), 0.4)), uDusk);
        float s = max(dot(d, uSun), 0.0);
        col += mix(vec3(0.9, 0.62, 0.36), vec3(0.32, 0.5, 0.85), uDusk) * (pow(s, 6.0) * 0.35 + pow(s, 60.0) * 0.6);  // Mars sunsets glow blue
        col += vec3(1.0, 0.95, 0.88) * smoothstep(0.9993, 0.9997, s) * 2.5 * smoothstep(-0.02, 0.01, d.y) * (1.0 - 0.6 * uStorm);   // sun disc
        // the Martian blue sunset hugs the horizon around the sun once it is down
        float hz = exp(-max(el, 0.0) * 9.0) * pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-5)), 0.0), 3.0);
        col += vec3(0.25, 0.45, 0.85) * hz * smoothstep(0.4, 0.9, uDusk) * 0.55;
        // thin water-ice clouds: high, streaky, drifting slowly, lit warm by day and blue-grey at dusk
        if (d.y > 0.015) {
          vec2 cp = d.xz / (d.y + 0.06);
          vec3 cq = vec3(cp.x * 0.55 + uTime * 0.0035, cp.y * 1.9 + uTime * 0.0012, 3.7);
          float cl = smoothstep(0.5, 0.78, rk_fbm(cq + rk_fbm(cq * 2.1 + 5.3, 2) * 0.6, 3));
          float cv = cl * smoothstep(0.015, 0.12, el) * (1.0 - 0.6 * smoothstep(0.35, 0.9, el));
          vec3 cc = mix(col * 1.32 + vec3(0.04, 0.025, 0.015), col * 1.15 + vec3(0.02, 0.03, 0.05), uDusk);
          col = mix(col, cc, cv * 0.55 * (1.0 - 0.7 * uStorm));
        }
        // dust storm: the sky thickens and browns, most of all low over the storm front
        float sb = pow(max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), uStormDir), 0.0), 2.0) * exp(-max(el, 0.0) * 4.0);
        vec3 stormC = vec3(0.34, 0.19, 0.105) * (1.0 - 0.75 * uDusk);
        col = mix(col, stormC, uStorm * (0.3 * exp(-max(el, 0.0) * 2.0) + 0.55 * sb));
        // Earth: the brightest "star" in the Martian evening sky, close to where the sun went down
        float ea = dot(d, uEarth);
        col += vec3(0.62, 0.78, 1.0) * (smoothstep(0.999986, 0.999997, ea) * 6.0 + pow(max(ea, 0.0), 30000.0) * 1.2 * uEarthGlow) * smoothstep(0.55, 0.9, uDusk) * (0.75 + 0.25 * uEarthGlow);
        vec3 g = floor(d * 420.0); float st = step(0.9975, h(g)) * smoothstep(0.05, 0.4, el) * uDusk * uDusk;
        col += vec3(st);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 24), skyMat);
  sky.renderOrder = -1; sky.frustumCulled = false; sky.name = 'sky';
  group.add(sky);

  // ---------------------------------------------------------------- dust storm front, rolling in over the mountains behind the lander
  // Three billowing curtains of dust on a wide arc (procedural, domain-warped noise rising and drifting).
  // setStorm(k): k 0 → far beyond the range, faint; k 1 → ~700 m away, towering, covering the mountains.
  const ARC = 2.1, thetaC = Math.PI / 2 - aBack;
  const stormGeo = new THREE.CylinderGeometry(1, 1, 1, 160, 1, true, thetaC - ARC / 2, ARC); stormGeo.translate(0, 0.5, 0);
  const storm = [{ rk: 1.0, hk: 1.0, seed: 0.0, ok: 0.9 }, { rk: 0.9, hk: 0.8, seed: 4.7, ok: 0.75 }, { rk: 0.8, hk: 0.62, seed: 9.3, ok: 0.55 }].map((l) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uSun: { value: new V3(0, 1, 0) }, uLight: { value: 1 }, uSeed: { value: l.seed }, uHaze: { value: new THREE.Color(0.5, 0.3, 0.175) } },
      vertexShader: `varying vec2 vUv; varying vec3 vW, vN; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = mat3(modelMatrix) * normal; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uTime, uOpacity, uLight, uSeed; uniform vec3 uSun, uHaze; varying vec2 vUv; varying vec3 vW, vN; ${GLSL_NOISE}
        void main(){
          float y = vUv.y;
          vec3 q = vec3(vW.x * 0.0042, y * 2.6 - uTime * 0.016, vW.z * 0.0042) + uSeed;
          float w = rk_fbm(q * 1.4 + vec3(0.0, -uTime * 0.011, 0.0), 2);
          float n = rk_fbm(q + (w - 0.5) * 1.2 + vec3(uTime * 0.005, 0.0, -uTime * 0.004), 4);
          float top = 0.6 + (n - 0.5) * 0.7;                                          // a soft, ragged upper edge: Mars dust fronts are diffuse
          float dens = 1.0 - smoothstep(top - 0.45, top + 0.12, y);
          dens *= smoothstep(0.0, 0.2, vUv.x) * (1.0 - smoothstep(0.8, 1.0, vUv.x));
          float nl = length(vN); vec3 nn = nl > 1e-6 ? -vN / nl : vec3(0.0, 0.0, 1.0);
          float sunF = max(dot(nn, uSun), 0.0);
          float edge = smoothstep(top - 0.2, top, y);                                  // sun catches the cauliflower tops
          float lit = clamp((0.45 + 0.55 * smoothstep(0.0, 0.9, y)) * (0.75 + 0.25 * n) * (0.75 + 0.25 * sunF) + edge * 0.1, 0.0, 1.0);
          vec3 col = mix(vec3(0.2, 0.11, 0.062), vec3(0.47, 0.27, 0.15), lit) * uLight;
          col = mix(col, uHaze * uLight, 0.25 * (1.0 - y));
          gl_FragColor = vec4(col, dens * uOpacity * (0.7 + 0.3 * n));
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const mesh = new THREE.Mesh(stormGeo, mat); mesh.name = 'dust-storm'; mesh.frustumCulled = false;
    mesh.position.set(sc.x, groundY - 8, sc.z); group.add(mesh);
    return { ...l, mesh, mat };
  });
  /** Storm progress 0..1 (distance, height, opacity) for this frame. */
  function setStorm(k, { time = 0, sun = null, light = 1, haze = null } = {}) {
    const R = lerp(1900, 800, k), H = lerp(420, 950, k), op = lerp(0.4, 0.86, k);   // dust is lifted kilometres high
    for (const l of storm) {
      l.mesh.scale.set(R * l.rk, H * l.hk, R * l.rk);
      const u = l.mat.uniforms; u.uOpacity.value = op * l.ok; u.uTime.value = time; u.uLight.value = light;
      if (sun) u.uSun.value.copy(sun); if (haze) u.uHaze.value.copy(haze);
    }
    skyMat.uniforms.uStorm.value = k;
    return R;
  }

  // ---------------------------------------------------------------- lander with its drone hangar
  const lander = createLander();
  lander.group.position.set(LANDER.x, groundY, LANDER.z);
  lander.group.rotation.y = Math.atan2(toPit.x, toPit.z);
  group.add(lander.group);

  // ---------------------------------------------------------------- dust kicked up by thrusters / rotor downwash
  // Ballistic grains under Mars gravity (3.71 m/s², ~38% of Earth's): fine dust feels drag and drifts in the
  // wind, coarse sand flies far on low arcs and lands. Time is scroll-driven (uT 0→1 = 0→7 s after the blast).
  const DN = mobile ? 900 : 2600, dPos = new Float32Array(DN * 3), dDir = new Float32Array(DN * 3), dSeed = new Float32Array(DN);
  for (let i = 0; i < DN; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random());
    dDir.set([Math.cos(a), Math.random(), Math.sin(a)], i * 3); dSeed[i] = Math.random();
    dPos.set([Math.cos(a) * r, 0, Math.sin(a) * r], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
  dustGeo.setAttribute('aDir', new THREE.BufferAttribute(dDir, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dSeed, 1));
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uCenter: { value: new V3() }, uRadius: { value: 10 }, uOpacity: { value: 0 }, uPx: { value: 1 },
      uG: { value: 3.71 }, uWind: { value: new V3(WIND.x * 0.8, 0, WIND.y * 0.8) }, uDur: { value: 7 } },
    vertexShader: `attribute vec3 aDir; attribute float aSeed; uniform float uT, uRadius, uPx, uG, uDur; uniform vec3 uCenter, uWind; varying float vA, vFine;
      void main(){
        float t = uT * uDur * (0.85 + 0.3 * fract(aSeed * 7.3));
        float fine = step(0.42, aSeed);                                   // fine dust vs. coarse sand
        float k = mix(0.35, 1.6, fine);                                     // drag coefficient (1/s)
        float sp = uRadius * mix(1.1, 0.75, fine) * (0.35 + 0.9 * aDir.y);  // initial horizontal speed (m/s)
        float vy = uRadius * mix(0.22, 0.42, fine) * (0.3 + 0.7 * fract(aSeed * 13.1));
        float e = (1.0 - exp(-k * t)) / k;
        vec3 h = vec3(aDir.x, 0.0, aDir.z);
        vec3 p = uCenter + position * 1.4 + h * sp * e + uWind * t * fine;
        float y = (vy + uG / k) * e - uG * t / k;                          // drag + gravity, closed form
        p.y += max(y, 0.0) + 0.05;
        float landed = step(y, 0.0) * step(0.2, t);
        vA = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(uDur * 0.45, uDur, t)) * mix(1.0, 0.25, landed * (1.0 - fine)) * step(0.001, uT);
        vFine = fine;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = uPx * mix(3.0, 60.0 + 70.0 * fract(aSeed * 3.7), fine) * (1.0 + t * 0.18 * fine) * (10.0 / -mv.z); }`,
    fragmentShader: `uniform float uOpacity; varying float vA, vFine; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25 || vFine > 0.5) discard;   // sand grains only
        float a = mix(1.0 - d * 4.0, pow(1.0 - d * 4.0, 2.0), vFine);
        gl_FragColor = vec4(mix(vec3(0.42, 0.27, 0.17), vec3(0.78, 0.56, 0.4), vFine), a * vA * uOpacity * mix(0.95, 0.34, vFine)); }`,
    transparent: true, depthWrite: false,
  });
  const dust = new THREE.Points(dustGeo, dustMat); dust.frustumCulled = false;
  group.add(dust);

  // ---------------------------------------------------------------- dust devils on the far plain (background only)
  // Martian dust devils are common, often hundreds of metres tall: a twisting column of dust that widens
  // upward, a debris skirt at its foot, drifting across the plain. Two of them wander behind the scene.
  const toL = new V3(LANDER.x - sc.x, 0, LANDER.z - sc.z).normalize(), sideL = new V3(-toL.z, 0, toL.x);
  const devils = [
    { c: new V3(LANDER.x, 0, LANDER.z).addScaledVector(toL, 380).addScaledVector(sideL, 130), dir: sideL.clone().negate(), H: 270, R: 24, speed: 0.021, phase: 0 },
    { c: new V3(sc.x, 0, sc.z).addScaledVector(toL, -400).addScaledVector(sideL, -110), dir: sideL.clone(), H: 240, R: 20, speed: 0.017, phase: 2.1 },
  ].map((d) => {
    const N = mobile ? 1000 : 2200, aH = new Float32Array(N), aA = new Float32Array(N), aS = new Float32Array(N);
    for (let i = 0; i < N; i++) { aH[i] = Math.random(); aA[i] = Math.random() * Math.PI * 2; aS[i] = Math.random(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aH', new THREE.BufferAttribute(aH, 1)); geo.setAttribute('aA', new THREE.BufferAttribute(aA, 1)); geo.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 }, uBase: { value: new V3() }, uDir: { value: d.dir }, uH: { value: d.H }, uR: { value: d.R },
        uSpeed: { value: d.speed }, uPhase: { value: d.phase }, uPx: { value: 1 }, uSun: { value: new V3(0, 1, 0) } },
      vertexShader: `attribute float aH, aA, aS; uniform float uTime, uH, uR, uSpeed, uPhase, uPx; uniform vec3 uBase, uDir; varying float vA, vLit;
        void main(){
          vec3 base = uBase + uDir * (70.0 * sin(uTime * uSpeed + uPhase));   // drifts slowly back and forth across the plain
          float skirt = step(aS, 0.22);
          float h = fract(aH + uTime * (0.035 + 0.03 * aS));                // dust rises up the column
          h = mix(h, h * 0.07, skirt);
          float r = uR * (0.3 + 1.9 * pow(h, 1.25)) * (0.6 + 0.8 * fract(aS * 7.1)) * mix(1.0, 3.0, skirt);
          float a = aA + uTime * (2.2 - 1.6 * h) * (0.8 + 0.4 * aS);       // spins faster near the ground
          vec3 lean = vec3(sin(uTime * 0.11 + h * 2.6), 0.0, cos(uTime * 0.09 + h * 2.1)) * uR * 1.4 * h;
          vec3 p = base + vec3(cos(a) * r, h * uH, sin(a) * r) + lean;
          vLit = 0.75 + 0.25 * cos(a);
          vA = pow(1.0 - h, 0.6) * 0.55 + skirt * 0.4;
          vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = min(uPx * (uR * (0.8 + 1.4 * h) + skirt * uR * 0.9) * 900.0 / -mv.z, uPx * 90.0); }`,
      fragmentShader: `uniform float uOpacity; varying float vA, vLit; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
          gl_FragColor = vec4(vec3(0.52, 0.32, 0.19) * vLit, pow(1.0 - d * 4.0, 1.6) * vA * uOpacity * 0.26); }`,
      transparent: true, depthWrite: false, fog: false,
    });
    const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; pts.name = 'dust-devil';
    mat.uniforms.uBase.value.set(d.c.x, groundY + height(d.c.x, d.c.z) - groundY - 2, d.c.z);
    group.add(pts);
    return pts;
  });

  // ---------------------------------------------------------------- chockstones in the skylight shaft
  // Blocks from the collapsed roof, jammed against the shaft wall and jutting most of the way across it. Each one
  // is a real obstacle: avoid(y) is the sideways offset MAV-A1 needs at height y to clear them by ~0.7 m.
  const fwd0 = toPit.clone(), side0 = new V3(-toPit.z, 0, toPit.x), UPv = new V3(0, 1, 0);
  const spurMat = createRockMaterial({ dust: 0.35, scale: 1.4, bump: 1.5, photo: 0.9, photoSet: 'rock', photoScale: 0.38 });
  spurMat.flatShading = true;
  const shaftRocks = new THREE.Group(); shaftRocks.name = 'shaft-rocks';
  const spurs = [
    { dy: -5.5, dir: side0.clone(), tip: 0.5, L: 4.2, H: 1.5, W: 2.6, v: 7 },
    { dy: -14, dir: fwd0.clone().negate().applyAxisAngle(UPv, 0.4), tip: 0.3, L: 4.4, H: 1.9, W: 3.0, v: 8 },
    { dy: -23.5, dir: side0.clone().negate().applyAxisAngle(UPv, -0.5), tip: 0.6, L: 4.0, H: 1.4, W: 2.4, v: 9 },
  ].map((s) => {
    const m = new THREE.Mesh(rockShape(s.v, { cuts: 5, flat: 0.85, stretch: 1.0, rough: 0.9, detail: 3 }), spurMat);
    const c = new V3(sc.x, groundY + s.dy, sc.z).addScaledVector(s.dir, s.tip + s.L);
    m.position.copy(c); m.scale.set(s.L, s.H, s.W);
    m.rotation.set((s.v % 2 ? 0.08 : -0.06), -Math.atan2(s.dir.z, s.dir.x), (s.v % 2 ? -0.05 : 0.07), 'YXZ');
    m.castShadow = true; m.receiveShadow = true; m.name = 'chockstone';
    shaftRocks.add(m);
    return { ...s, y: groundY + s.dy, center: c, tipPoint: new V3(sc.x, groundY + s.dy, sc.z).addScaledVector(s.dir, s.tip), mesh: m };
  });
  function avoid(y, clear = 2.15) {
    const o = new V3();
    for (const s of spurs) {
      const k = smooth(s.y + s.H + 4.5, s.y + s.H + 0.8, y) * smooth(s.y - s.H - 4.5, s.y - s.H - 0.8, y);
      if (k > 0) o.addScaledVector(s.dir, -Math.max(0, clear - s.tip) * k);
    }
    return o;
  }

  return {
    group, height, lander, sky, skyMat, shaftRocks, spurs, avoid, dust, dustMat, groundMat, rockSets: rockChunks, pebbles, devils, far, storm, setStorm,
    wind: WIND.clone(), sandMask,
    landerPos: LANDER.clone(), pitCenter: new V3(sc.x, groundY, sc.z), hole: HOLE, imgW, imgH,
    /** World position of the drone's hull resting on the hangar's lift pad (at the lift's current height, or `lift`). */
    padPoint(footY, lift) { return lander.group.localToWorld(new V3(0, lander.padTopY(lift) - footY + 0.02, 0)); },
    padYaw: lander.group.rotation.y,
  };
}
