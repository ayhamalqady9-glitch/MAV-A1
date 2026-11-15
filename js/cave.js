// Procedural Martian lava tube for the MAV-A1 site: vertical skylight shaft (its top meets the
// surface pit in surface.js), noisy basalt tube with a flattened lava-fill floor, and the
// mission graphics drawn on top of it:
//   · LiDAR: laser rays sweeping out of the drone's puck and lighting their hit points
//   · SLAM: the map is built as voxels that pop in behind the scan front (OctoMap), plus a dense
//           point cloud and a sparse wireframe of everything mapped so far
//   · VANGUARD-AI: candidate trajectories ahead of the drone, obstacle boxes, the chosen path
//   · breadcrumb relay nodes, backtrack path, ceiling stress map
// Path parameter s runs 0 (dead end behind the shaft) → 1 (deepest point).
import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { createRockMaterial, SCAN } from './rock-material.js';

const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const CAVE = { R: 9, SHAFT_R: 7, SHAFT_TOP: 52, SHAFT_S: 0.03, NODE_S: [0.12, 0.25, 0.38, 0.55] };

export function createCave({ pointCount = 60000, pixelRatio = 1, mobile = false }) {
  const { R } = CAVE;
  const noise = new ImprovedNoise();
  const group = new THREE.Group(); group.name = 'cave';

  const path = new THREE.CatmullRomCurve3([
    [0, 0, 0], [0, -1, -30], [12, -3, -60], [6, -4, -95], [-10, -6, -125],
    [-6, -7, -160], [8, -8, -195], [4, -9, -230], [-4, -10, -262],
  ].map((a) => new V3(...a)), false, 'centripetal');

  // stable frame (no Frenet twist): side is horizontal, up is roughly world up
  function frame(s) {
    const P = path.getPointAt(s), T = path.getTangentAt(s);
    const side = new V3().crossVectors(T, UP).normalize();
    const up = new V3().crossVectors(side, T).normalize();
    return { P, T, side, up };
  }

  function surfacePoint(s, theta, f = frame(s)) {
    const { P, side, up } = f;
    const c = Math.cos(theta), sn = Math.sin(theta);
    const n1 = noise.noise(P.x * 0.07 + c * 1.6, P.y * 0.07 + sn * 1.6, P.z * 0.07);
    const n2 = noise.noise(P.x * 0.31 + c * 3.1, P.y * 0.31 + sn * 3.1, P.z * 0.31);
    const n3 = noise.noise(P.x * 1.1 + c * 5.3, P.y * 1.1 + sn * 5.3, P.z * 1.1);
    const n4 = noise.noise(P.x * 3.4 + c * 11.7, P.y * 3.4 + sn * 11.7, P.z * 3.4);
    let r = R * (1 + 0.2 * n1 + 0.07 * n2 + 0.025 * n3 + 0.009 * n4);
    // lava benches: shelves along both walls where the flow level once stood, with a sharper lip
    const bl = (sn + 0.2 + 0.05 * n1) / 0.06;
    r *= 1 - 0.085 * Math.exp(-bl * bl) * (0.55 + 0.45 * noise.noise(P.x * 0.04, 3.3, P.z * 0.04));
    const ul = (sn - 0.45 - 0.06 * n2) / 0.05;
    r *= 1 - 0.035 * Math.exp(-ul * ul);
    let ly = sn * r * 0.82;
    const floor = -R * 0.5;
    if (ly < floor) ly = floor + (ly - floor) * 0.12;           // lava-filled flat floor
    return P.clone().addScaledVector(side, c * r * 1.18).addScaledVector(up, ly);
  }

  // ---------------------------------------------------------------- tube mesh
  const SEG = mobile ? 360 : 820, RAD = mobile ? 56 : 112;
  const pos = [], aS = [], aCeil = [], aStress = [];
  for (let i = 0; i <= SEG; i++) {
    const s = i / SEG, f = frame(s);
    for (let j = 0; j <= RAD; j++) {
      const th = (j / RAD) * Math.PI * 2;
      const p = surfacePoint(s, th, f);
      pos.push(p.x, p.y, p.z);
      aS.push(s); aCeil.push(smooth(0.25, 0.85, Math.sin(th)));
      aStress.push(0.42 + 0.6 * noise.noise(p.x * 0.11, p.y * 0.11, p.z * 0.11));
    }
  }
  // the skylight shaft drops into the tube ceiling at s = SHAFT_S: leave a hole there
  const shaftC = path.getPointAt(CAVE.SHAFT_S);
  const inShaft = (vi) => {
    const x = pos[vi * 3] - shaftC.x, y = pos[vi * 3 + 1] - shaftC.y, z = pos[vi * 3 + 2] - shaftC.z;
    return y > 2 && x * x + z * z < (CAVE.SHAFT_R * 1.02) ** 2;
  };
  const idx = [];
  for (let i = 0; i < SEG; i++) for (let j = 0; j < RAD; j++) {
    const a = i * (RAD + 1) + j, b = (i + 1) * (RAD + 1) + j;
    if (inShaft(a) && inShaft(b) && inShaft(a + 1) && inShaft(b + 1)) continue;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const tubeGeo = new THREE.BufferGeometry();
  tubeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tubeGeo.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 1));
  tubeGeo.setAttribute('aCeil', new THREE.Float32BufferAttribute(aCeil, 1));
  tubeGeo.setAttribute('aStress', new THREE.Float32BufferAttribute(aStress, 1));
  tubeGeo.setIndex(idx);
  tubeGeo.computeVertexNormals();

  const rockMat = createRockMaterial({ dust: 0.32, scale: 1.15, bands: 0.3, bump: 1.35, photoSet: 'rock', photoScale: 0.26 });
  rockMat.side = THREE.DoubleSide;
  const tube = new THREE.Mesh(tubeGeo, rockMat); tube.name = 'lava-tube'; tube.receiveShadow = true;
  group.add(tube);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), rockMat);
  cap.rotation.x = Math.PI / 2; cap.scale.set(1.25, 1, 0.9); cap.position.set(0, -0.6, 0.5); cap.name = 'tube-end';
  cap.receiveShadow = true; group.add(cap);

  // ---------------------------------------------------------------- shaft + skylight
  const shaftGeo = new THREE.CylinderGeometry(CAVE.SHAFT_R, CAVE.SHAFT_R * 1.08, CAVE.SHAFT_TOP - 4, 64, 40, true);
  const sp = shaftGeo.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i), a = Math.atan2(z, x);
    const k = 1 + 0.14 * noise.noise(Math.cos(a) * 2, y * 0.12, Math.sin(a) * 2) + 0.04 * noise.noise(Math.cos(a) * 7, y * 0.5, Math.sin(a) * 7);
    sp.setX(i, x * k); sp.setZ(i, z * k);
  }
  shaftGeo.computeVertexNormals();
  const shaftMat = createRockMaterial({ dust: 0.4, scale: 1.2, bands: 0, bump: 1.4, photoSet: 'rock', photoScale: 0.26 });   // weathered basalt, no banding
  shaftMat.side = THREE.DoubleSide;
  const shaft = new THREE.Mesh(shaftGeo, shaftMat);
  shaft.position.set(shaftC.x, (CAVE.SHAFT_TOP - 4) / 2 + 4, shaftC.z); shaft.name = 'skylight-shaft'; shaft.receiveShadow = true;
  group.add(shaft);

  const skyDisc = new THREE.Mesh(new THREE.CircleGeometry(CAVE.SHAFT_R * 1.1, 48), new THREE.MeshBasicMaterial({ color: 0xffe2c2, toneMapped: false }));
  skyDisc.rotation.x = Math.PI / 2; skyDisc.position.set(shaftC.x, CAVE.SHAFT_TOP, shaftC.z); skyDisc.name = 'skylight';
  group.add(skyDisc);

  const skyLight = new THREE.SpotLight(0xffd6b0, 900, 120, 0.42, 0.7, 1.4);
  skyLight.position.set(shaftC.x, CAVE.SHAFT_TOP + 4, shaftC.z); skyLight.target.position.set(shaftC.x, -4, shaftC.z - 4);
  group.add(skyLight, skyLight.target);

  const rayMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.5 } },
    vertexShader: `varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uOpacity; varying float vY; void main(){ gl_FragColor = vec4(1.0,0.86,0.7, uOpacity * 0.14 * pow(clamp(vY, 0.0, 1.0), 1.6)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const rays = new THREE.Mesh(new THREE.CylinderGeometry(CAVE.SHAFT_R * 0.9, CAVE.SHAFT_R * 1.6, CAVE.SHAFT_TOP, 32, 1, true), rayMat);
  rays.position.set(shaftC.x, CAVE.SHAFT_TOP / 2, shaftC.z); group.add(rays);

  const DUST = 900, dpos = new Float32Array(DUST * 3), dseed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    const r = Math.sqrt(Math.random()) * CAVE.SHAFT_R * 0.9, a = Math.random() * Math.PI * 2;
    dpos[i * 3] = Math.cos(a) * r; dpos[i * 3 + 1] = Math.random() * CAVE.SHAFT_TOP; dpos[i * 3 + 2] = Math.sin(a) * r; dseed[i] = Math.random();
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dpos, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dseed, 1));
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 }, uPx: { value: pixelRatio }, uTop: { value: CAVE.SHAFT_TOP } },
    vertexShader: `attribute float aSeed; uniform float uTime, uPx, uTop; varying float vA;
      void main(){ vec3 p = position; p.y = mod(p.y - uTime * (0.6 + aSeed), uTop);
        p.x += sin(uTime * 0.5 + aSeed * 20.0) * 0.4; vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vA = smoothstep(0.0, 12.0, p.y) * (0.4 + 0.6 * aSeed); gl_Position = projectionMatrix * mv; gl_PointSize = min(uPx * (1.5 + aSeed * 2.0) * (40.0 / -mv.z), uPx * 5.0); }`,
    fragmentShader: `uniform float uOpacity; varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; if (dot(c,c) > 0.25) discard; gl_FragColor = vec4(1.0, 0.85, 0.65, vA * uOpacity * 0.7); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeo, dustMat); dust.frustumCulled = false; dust.position.set(shaftC.x, 0, shaftC.z); group.add(dust);

  // ---------------------------------------------------------------- SLAM point cloud (dense, revealed by mapping)
  const N = pointCount, ppos = new Float32Array(N * 3), pS = new Float32Array(N), pB = new Float32Array(N), pH = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = Math.random(), th = Math.random() * Math.PI * 2, f = frame(s);
    const p = surfacePoint(s, th, f).lerp(f.P, 0.012);
    ppos[i * 3] = p.x; ppos[i * 3 + 1] = p.y; ppos[i * 3 + 2] = p.z;
    pS[i] = s; pB[i] = 0.5 + 0.5 * noise.noise(p.x * 0.5, p.y * 0.5, p.z * 0.5);
    pH[i] = Math.min(1, Math.max(0, (p.clone().sub(f.P).dot(f.up) + R * 0.5) / (R * 1.3)));   // 0 = floor, 1 = roof
  }
  const ptsGeo = new THREE.BufferGeometry();
  ptsGeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
  ptsGeo.setAttribute('aS', new THREE.BufferAttribute(pS, 1));
  ptsGeo.setAttribute('aB', new THREE.BufferAttribute(pB, 1));
  ptsGeo.setAttribute('aH', new THREE.BufferAttribute(pH, 1));
  const lidarMat = new THREE.ShaderMaterial({
    uniforms: { uMapped: { value: 0 }, uOrigin: { value: new V3() }, uPulse: { value: 0 }, uOpacity: { value: 1 }, uPx: { value: pixelRatio }, uTint: { value: new THREE.Color(0x00a8cc) } },
    vertexShader: `attribute float aS, aB, aH; uniform float uMapped, uPulse, uPx; uniform vec3 uOrigin;
      varying float vA, vP, vB, vH;
      void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        float d = distance(position, uOrigin);
        float q = (d - uPulse) / 1.4; vP = exp(-q * q) * step(0.5, uPulse);
        vA = smoothstep(aS - 0.004, aS, uMapped); vB = aB; vH = aH;
        gl_PointSize = min(uPx * (1.5 + vP * 2.4) * (60.0 / -mv.z), uPx * 5.0); }`,
    fragmentShader: `uniform float uOpacity; uniform vec3 uTint; varying float vA, vP, vB, vH;
      vec3 turbo(float x){ x = clamp(x, 0.0, 1.0); vec4 v4 = vec4(1.0, x, x*x, x*x*x); vec2 v2 = v4.zw * v4.z;
        return clamp(vec3(dot(v4, vec4(0.1357,4.6154,-42.6603,132.1311)) + dot(v2, vec2(-152.9424,59.2864)),
          dot(v4, vec4(0.0914,2.1942,4.8430,-14.1850)) + dot(v2, vec2(4.2773,2.8296)),
          dot(v4, vec4(0.1067,12.6419,-60.5820,110.3628)) + dot(v2, vec2(-89.9031,27.3482))), 0.0, 1.0); }
      void main(){ if (vA < 0.01) discard; vec2 c = gl_PointCoord - 0.5; float d = dot(c,c); if (d > 0.25) discard;
        vec3 col = mix(turbo(vH) * (0.55 + 0.6 * vB), vec3(0.85, 1.0, 1.0), vP * 0.7);
        gl_FragColor = vec4(col, vA * uOpacity * (0.5 + 0.5 * vP) * (1.0 - d * 2.0)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const lidar = new THREE.Points(ptsGeo, lidarMat); lidar.frustumCulled = false; lidar.name = 'lidar-cloud';
  group.add(lidar);

  // ---------------------------------------------------------------- SLAM OctoMap voxels: pop in behind the scan front
  const vox = new Map(), VS = 0.9;
  for (let i = 0; i <= (mobile ? 220 : 360); i++) {
    const s = i / (mobile ? 220 : 360), f = frame(s);
    for (let j = 0; j < 30; j++) {
      const p = surfacePoint(s, (j / 30) * Math.PI * 2, f).lerp(f.P, 0.03);
      const key = `${Math.round(p.x / VS)}|${Math.round(p.y / VS)}|${Math.round(p.z / VS)}`;
      const hh = Math.min(1, Math.max(0, (p.clone().sub(f.P).dot(f.up) + R * 0.5) / (R * 1.3)));
      if (!vox.has(key)) vox.set(key, { x: Math.round(p.x / VS) * VS, y: Math.round(p.y / VS) * VS, z: Math.round(p.z / VS) * VS, s, h: hh });
    }
  }
  const voxList = [...vox.values()];
  const voxGeo = new THREE.BoxGeometry(VS * 0.92, VS * 0.92, VS * 0.92);
  const vS = new Float32Array(voxList.length), vH = new Float32Array(voxList.length);
  const voxMat = new THREE.ShaderMaterial({
    uniforms: { uMapped: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: `attribute float aS; uniform float uMapped; varying vec2 vUv; varying float vFresh, vOn;
      void main(){ float age = uMapped - aS; float on = smoothstep(0.0, 0.0035, age);
        float pop = on * (1.0 + 0.55 * exp(-max(age, 0.0) * 380.0));
        vFresh = exp(-max(age, 0.0) * 140.0) * on; vOn = on; vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position * pop, 1.0); }`,
    fragmentShader: `uniform float uOpacity; varying vec2 vUv; varying float vFresh, vOn;
      void main(){ if (vOn < 0.01) discard; vec2 e = abs(vUv - 0.5) * 2.0; float edge = smoothstep(0.78, 0.97, max(e.x, e.y));
        vec3 col = mix(vec3(0.0, 0.62, 0.78), vec3(0.85, 1.0, 1.0), vFresh);
        gl_FragColor = vec4(col, (edge * 0.75 + 0.04 + vFresh * 0.3) * uOpacity * vOn); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const voxels = new THREE.InstancedMesh(voxGeo, voxMat, voxList.length);
  const vm = new THREE.Matrix4();
  voxList.forEach((v, i) => { vm.makeTranslation(v.x, v.y, v.z); voxels.setMatrixAt(i, vm); vS[i] = v.s; vH[i] = v.h; });
  voxGeo.setAttribute('aS', new THREE.InstancedBufferAttribute(vS, 1));
  voxGeo.setAttribute('aH', new THREE.InstancedBufferAttribute(vH, 1));
  voxels.frustumCulled = false; voxels.name = 'octomap-voxels';
  group.add(voxels);

  // ---------------------------------------------------------------- SLAM wireframe (low-res grid lines)
  const WS = 120, WR = 16, wpos = [], wS = [];
  const grid = [];
  for (let i = 0; i <= WS; i++) { const s = i / WS, f = frame(s); grid.push([]); for (let j = 0; j < WR; j++) grid[i].push(surfacePoint(s, (j / WR) * Math.PI * 2, f)); }
  const seg = (a, b, s1, s2) => { wpos.push(a.x, a.y, a.z, b.x, b.y, b.z); wS.push(s1, s2); };
  for (let i = 0; i <= WS; i++) for (let j = 0; j < WR; j++) {
    seg(grid[i][j], grid[i][(j + 1) % WR], i / WS, i / WS);
    if (i < WS) seg(grid[i][j], grid[i + 1][j], i / WS, (i + 1) / WS);
  }
  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
  wireGeo.setAttribute('aS', new THREE.Float32BufferAttribute(wS, 1));
  const wireMat = new THREE.ShaderMaterial({
    uniforms: { uMapped: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: `attribute float aS; uniform float uMapped; varying float vA; void main(){ vA = step(aS, uMapped); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uOpacity; varying float vA; void main(){ if (vA < 0.5) discard; gl_FragColor = vec4(0.0, 0.66, 0.8, uOpacity); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const wire = new THREE.LineSegments(wireGeo, wireMat); wire.frustumCulled = false; group.add(wire);
  const wireLines = wire;

  // ---------------------------------------------------------------- LiDAR laser sweep (updated every frame)
  const RINGS = [-0.0035, 0.0, 0.005], PER = 20, NRAYS = RINGS.length * PER;
  const beamPos = new Float32Array(NRAYS * 6), beamCol = new Float32Array(NRAYS * 6);
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3));
  beamGeo.setAttribute('color', new THREE.BufferAttribute(beamCol, 3));
  const beamMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const beams = new THREE.LineSegments(beamGeo, beamMat); beams.frustumCulled = false; beams.name = 'lidar-beams';
  group.add(beams);
  const hitPos = new Float32Array(NRAYS * 3);
  const hitGeo = new THREE.BufferGeometry(); hitGeo.setAttribute('position', new THREE.BufferAttribute(hitPos, 3));
  const hitMat = new THREE.PointsMaterial({ color: 0xbff6ff, size: 0.28, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const hits = new THREE.Points(hitGeo, hitMat); hits.frustumCulled = false; group.add(hits);
  beams.visible = false; hits.visible = false;                         // superseded by the scan drawn on the rock itself

  // ---------------------------------------------------------------- VANGUARD-AI trajectory candidates (updated every frame)
  const CANDS = [], CSEG = 16;
  for (const lat of [-2.6, 0, 2.6]) for (const vert of [-1.2, 0, 1.2]) CANDS.push({ lat, vert });
  const candPos = new Float32Array(CANDS.length * CSEG * 6), candCol = new Float32Array(CANDS.length * CSEG * 6);
  const candGeo = new THREE.BufferGeometry();
  candGeo.setAttribute('position', new THREE.BufferAttribute(candPos, 3));
  candGeo.setAttribute('color', new THREE.BufferAttribute(candCol, 3));
  const candMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const cands = new THREE.LineSegments(candGeo, candMat); cands.frustumCulled = false; cands.name = 'ai-candidates';
  group.add(cands);

  // ---------------------------------------------------------------- stress map overlay (Stage 08)
  const stressMat = new THREE.ShaderMaterial({
    uniforms: { uScan: { value: 0 }, uFrom: { value: 0.66 }, uOpacity: { value: 0 } },
    vertexShader: `attribute float aS, aCeil, aStress; varying float vS, vC, vT;
      void main(){ vS = aS; vC = aCeil; vT = aStress; vec3 p = position + normal * -0.05; gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.); }`,
    fragmentShader: `uniform float uScan, uFrom, uOpacity; varying float vS, vC, vT;
      vec3 ramp(float t){ vec3 a = vec3(0.098,0.027,0.22), b = vec3(0.04,0.14,0.345), c = vec3(0.0,0.66,0.8), d = vec3(1.0,0.2,0.02);
        return t < 0.45 ? mix(a,b,t/0.45) : (t < 0.8 ? mix(b,c,(t-0.45)/0.35) : mix(c,d,(t-0.8)/0.2)); }
      void main(){ float scanned = step(uFrom, vS) * step(vS, uScan); float lq = (vS - uScan) * 520.0; float line = exp(-lq * lq);
        float a = (scanned * 0.24 + line * 0.5) * vC * uOpacity; if (a < 0.01) discard;
        gl_FragColor = vec4(mix(ramp(clamp(vT,0.,1.)), vec3(0.75,1.,1.), line), a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const stress = new THREE.Mesh(tubeGeo, stressMat); stress.name = 'stress-map'; group.add(stress);

  const dot = document.createElement('canvas'); dot.width = dot.height = 64;
  const dg = dot.getContext('2d'), grd = dg.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  dg.fillStyle = grd; dg.fillRect(0, 0, 64, 64);
  const dotTex = new THREE.CanvasTexture(dot);
  hitMat.map = dotTex;
  const ICE = 260, ipos = new Float32Array(ICE * 3);
  for (let i = 0; i < ICE; i++) {
    const s = 0.72 + Math.random() * 0.08, th = Math.PI / 2 + (Math.random() - 0.5) * 1.1;
    const p = surfacePoint(s, th).lerp(frame(s).P, 0.03);
    ipos.set([p.x, p.y, p.z], i * 3);
  }
  const iceGeo = new THREE.BufferGeometry(); iceGeo.setAttribute('position', new THREE.BufferAttribute(ipos, 3));
  const iceMat = new THREE.PointsMaterial({ color: 0x6fd8ef, size: 0.09, map: dotTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const ice = new THREE.Points(iceGeo, iceMat); group.add(ice);

  // ---------------------------------------------------------------- obstacles (Stage 06)
  const obstacles = [];
  const boxGroup = new THREE.Group(); group.add(boxGroup);
  const obsMat = createRockMaterial({ dust: 0.25, scale: 2.0, bands: 0.2, bump: 1.6, photoSet: 'rock', photoScale: 0.45 });
  for (let k = 0; k < 22; k++) {
    const s = 0.19 + (k / 22) * 0.23 + Math.random() * 0.006;
    const f = frame(s);
    const ceiling = k % 3 !== 0;
    let mesh;
    if (ceiling) {
      const h = 2.2 + Math.random() * 3.2;
      const g = new THREE.ConeGeometry(0.55 + Math.random() * 0.7, h, 9, 6);
      const gp = g.attributes.position;
      for (let i = 0; i < gp.count; i++) { const v = new V3().fromBufferAttribute(gp, i); const k2 = 1 + 0.18 * noise.noise(v.x * 2 + k, v.y * 1.5, v.z * 2); gp.setXYZ(i, v.x * k2, v.y, v.z * k2); }
      g.computeVertexNormals();
      mesh = new THREE.Mesh(g, obsMat);
      mesh.rotation.x = Math.PI;                                       // hang point-down
      const p = surfacePoint(s, Math.PI / 2 + (Math.random() - 0.5) * 1.2, f);
      mesh.position.copy(p).addScaledVector(f.up, -h / 2 + 0.3);
    } else {
      const r = 0.9 + Math.random() * 1.3;
      const g = new THREE.IcosahedronGeometry(r, 2);
      const gp = g.attributes.position;
      for (let i = 0; i < gp.count; i++) { const v = new V3().fromBufferAttribute(gp, i); v.multiplyScalar(1 + 0.25 * noise.noise(v.x * 1.3 + k, v.y * 1.3, v.z * 1.3)); gp.setXYZ(i, v.x, v.y, v.z); }
      g.computeVertexNormals();
      mesh = new THREE.Mesh(g, obsMat);
      const p = surfacePoint(s, -Math.PI / 2 + (Math.random() - 0.5) * 1.4, f);
      mesh.position.copy(p).addScaledVector(f.up, r * 0.5);
    }
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    mesh.updateMatrixWorld();
    const box = new THREE.Box3().setFromObject(mesh);
    const hazard = k % 4 === 1;
    const helper = new THREE.Box3Helper(box, hazard ? 0xff3305 : 0x00a8cc);
    helper.material.transparent = true; helper.material.opacity = 0; helper.material.depthWrite = false;
    boxGroup.add(helper);
    obstacles.push({ s, mesh, helper, hazard, center: box.getCenter(new V3()) });
  }

  // ---------------------------------------------------------------- breakdown boulders on the floor + lava drips on the ceiling
  const boulderMat = createRockMaterial({ dust: 0.3, scale: 2.4, bands: 0.15, bump: 1.8, photo: 1, photoSet: 'rock', photoScale: 0.6 });
  const bGeos = [0, 1, 2].map((v) => {
    const g = new THREE.IcosahedronGeometry(1, 3), gp = g.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      const q = new V3().fromBufferAttribute(gp, i);
      const k2 = 1 + 0.32 * noise.noise(q.x * 1.2 + v * 7, q.y * 1.2, q.z * 1.2) + 0.12 * noise.noise(q.x * 3.1, q.y * 3.1 + v * 3, q.z * 3.1) + 0.04 * noise.noise(q.x * 8, q.y * 8, q.z * 8 + v);
      q.multiplyScalar(k2); q.y = q.y < -0.25 ? -0.25 + (q.y + 0.25) * 0.15 : q.y * (0.7 + 0.1 * v);   // flat-bottomed, settled
      gp.setXYZ(i, q.x, q.y, q.z);
    }
    g.computeVertexNormals(); return g;
  });
  const BOULDERS = mobile ? 160 : 420, m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s4 = new V3();
  const boulderMeshes = bGeos.map((g) => { const m = new THREE.InstancedMesh(g, boulderMat, BOULDERS); m.count = 0; m.castShadow = true; m.receiveShadow = true; group.add(m); return m; });
  for (let k = 0; k < BOULDERS * 3; k++) {
    const s = 0.05 + Math.random() * 0.93;
    if (CAVE.NODE_S.some((ns) => Math.abs(ns - s) < 0.012)) continue;
    if (s > 0.68 && s < 0.81) continue;                                   // the flat site the outpost is drawn on stays clear
    const f = frame(s), th = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const sz = 0.18 + Math.pow(Math.random(), 2.4) * 1.5;
    const p = surfacePoint(s, th, f).addScaledVector(f.up, sz * 0.18).lerp(f.P, 0.01);
    q4.setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.3, Math.random() * 6.28, (Math.random() - 0.5) * 0.3));
    const m = boulderMeshes[k % 3];
    if (m.count >= BOULDERS) continue;
    m.setMatrixAt(m.count++, m4.compose(p, q4, s4.set(sz * (0.8 + Math.random() * 0.5), sz, sz * (0.8 + Math.random() * 0.5))));
  }
  boulderMeshes.forEach((m) => { m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); });
  const dripGeo = new THREE.ConeGeometry(1, 1, 7, 3); dripGeo.translate(0, -0.5, 0);
  const DRIPS = mobile ? 500 : 1800;
  const drips = new THREE.InstancedMesh(dripGeo, createRockMaterial({ dust: 0.05, scale: 3, bump: 1.2, photo: 0.6, tint: 0.8 }), DRIPS);
  for (let k = 0; k < DRIPS; k++) {
    const s = Math.random(), f = frame(s), th = Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const len = 0.08 + Math.pow(Math.random(), 3) * 0.55, rad = len * (0.12 + Math.random() * 0.1);
    const p = surfacePoint(s, th, f).lerp(f.P, 0.004);
    q4.setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.25, Math.random() * 6.28, (Math.random() - 0.5) * 0.25));
    drips.setMatrixAt(k, m4.compose(p, q4, s4.set(rad, len, rad)));
  }
  drips.castShadow = false; drips.receiveShadow = true; drips.name = 'lavacicles'; group.add(drips);

  // ---------------------------------------------------------------- breadcrumb nodes + mesh links
  const nodeMat = new THREE.MeshStandardMaterial({ color: 0x00a8cc, emissive: 0x00a8cc, emissiveIntensity: 2.4 });
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00a8cc, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const nodes = CAVE.NODE_S.map((s, i) => {
    const f = frame(s);
    const floor = surfacePoint(s, -Math.PI / 2, f);
    const g = new THREE.Group(); g.name = `NODE_0${i + 1}`;
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 18, 12), nodeMat);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.18, 16), new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.8, roughness: 0.35 }));
    base.position.y = -0.3;
    g.add(core, base);
    const rings = [0, 1, 2].map(() => { const r = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 48), ringMat.clone()); r.rotation.x = -Math.PI / 2; r.position.y = -0.38; g.add(r); return r; });
    g.position.copy(floor).addScaledVector(f.up, 0.4);
    g.visible = false; group.add(g);
    return { s, group: g, rings, rest: g.position.clone() };
  });
  const linkGeo = new THREE.BufferGeometry().setFromPoints([new V3(shaftC.x, 1, shaftC.z), ...nodes.map((n) => n.rest.clone().add(new V3(0, 0.2, 0)))]);
  const linkMat = new THREE.LineDashedMaterial({ color: 0x00a8cc, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0 });
  const links = new THREE.Line(linkGeo, linkMat); links.computeLineDistances(); group.add(links);

  // ---------------------------------------------------------------- path dots (pose graph / look-ahead / backtrack)
  const PD = 1400, pdpos = new Float32Array(PD * 3), pdS = new Float32Array(PD);
  for (let i = 0; i < PD; i++) { const s = i / (PD - 1), f = frame(s); const p = f.P.clone().addScaledVector(f.up, -1.2); pdpos.set([p.x, p.y, p.z], i * 3); pdS[i] = s; }
  const pathGeo = new THREE.BufferGeometry();
  pathGeo.setAttribute('position', new THREE.BufferAttribute(pdpos, 3));
  pathGeo.setAttribute('aS', new THREE.BufferAttribute(pdS, 1));
  const pathMat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0 }, uB: { value: 0 }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0x00a8cc) }, uPx: { value: pixelRatio } },
    vertexShader: `attribute float aS; uniform float uA, uB, uPx; varying float vA;
      void main(){ vA = step(uA, aS) * step(aS, uB); vec4 mv = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*mv; gl_PointSize = min(uPx * 3.0 * (30.0 / -mv.z), uPx * 6.0); }`,
    fragmentShader: `uniform float uOpacity; uniform vec3 uColor; varying float vA; void main(){ if (vA < 0.5) discard; vec2 c = gl_PointCoord - 0.5; if (dot(c,c) > 0.25) discard; gl_FragColor = vec4(uColor, uOpacity); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pathDots = new THREE.Points(pathGeo, pathMat); pathDots.frustumCulled = false; group.add(pathDots);

  // ---------------------------------------------------------------- per-frame helpers
  const cyan = new THREE.Color(0x00a8cc), white = new THREE.Color(0xdffaff), orange = new THREE.Color(0xff3305), dim = new THREE.Color(0x335566);
  function updateScan(origin, s, time, opacity, axes = null) {
    SCAN.rkScanOn.value = opacity; SCAN.rkScanTime.value = time;
    beamMat.opacity = 0; hitMat.opacity = 0;
    if (opacity <= 0.01) return;
    SCAN.rkScanO.value.copy(origin);
    const f0 = frame(Math.min(1, Math.max(0, s)));
    SCAN.rkScanUp.value.copy(axes ? axes.up : f0.up); SCAN.rkScanFwd.value.copy(axes ? axes.fwd : f0.T); SCAN.rkScanSide.value.copy(axes ? axes.side : f0.side);
    if (opacity > -1) return;
    let k = 0;
    RINGS.forEach((ds, r) => {
      const f = frame(Math.min(1, Math.max(0, s + ds)));
      for (let i = 0; i < PER; i++) {
        const th = time * (2.6 + r * 0.7) + (i / PER) * Math.PI * 2 + r * 0.4;
        const h = surfacePoint(Math.min(1, Math.max(0, s + ds)), th, f);
        beamPos.set([origin.x, origin.y, origin.z, h.x, h.y, h.z], k * 6);
        beamCol.set([0.55, 0.95, 1.0, 0.0, 0.32, 0.4], k * 6);
        hitPos.set([h.x, h.y, h.z], k * 3);
        k++;
      }
    });
    beamGeo.attributes.position.needsUpdate = true; beamGeo.attributes.color.needsUpdate = true;
    hitGeo.attributes.position.needsUpdate = true;
  }
  const _q = new V3();
  function updatePlanner(origin, f, chosenLat, opacity) {
    candMat.opacity = opacity; cands.visible = opacity > 0.01;
    if (opacity <= 0.01) return;
    let best = 0, bestD = Infinity;
    CANDS.forEach((c, i) => { const d = Math.abs(c.lat - chosenLat) + Math.abs(c.vert) * 0.5; if (d < bestD) { bestD = d; best = i; } });
    let k = 0;
    CANDS.forEach((c, ci) => {
      let blocked = false;
      const pts = [];
      for (let j = 0; j <= CSEG; j++) {
        const u = j / CSEG;
        const p = origin.clone().addScaledVector(f.T, u * 11).addScaledVector(f.side, c.lat * u * u).addScaledVector(f.up, c.vert * u * u);
        for (const o of obstacles) if (Math.abs(o.s - 0.5) < 1 && _q.subVectors(p, o.center).lengthSq() < 2.2) blocked = true;
        pts.push(p);
      }
      const col = ci === best ? cyan : (blocked ? orange : dim);
      const tip = ci === best ? white : col;
      for (let j = 0; j < CSEG; j++) {
        candPos.set([pts[j].x, pts[j].y, pts[j].z, pts[j + 1].x, pts[j + 1].y, pts[j + 1].z], k * 6);
        const fade = 1 - j / CSEG;
        const c0 = col.clone().lerp(tip, j / CSEG).multiplyScalar(0.4 + 0.6 * fade);
        candCol.set([c0.r, c0.g, c0.b, c0.r * 0.9, c0.g * 0.9, c0.b * 0.9], k * 6);
        k++;
      }
    });
    candGeo.attributes.position.needsUpdate = true; candGeo.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------- API
  return {
    group, path, frame, surfacePoint, nodes, obstacles, shaftCenter: shaftC.clone(), cloudGeo: ptsGeo, voxels, voxCount: voxList.length, boulders: boulderMeshes,
    materials: { rock: rockMat, shaft: shaftMat, lidar: lidarMat, wire: wireMat, stress: stressMat, ice: iceMat, rays: rayMat, dust: dustMat, path: pathMat, link: linkMat, vox: voxMat },
    skyDisc, skyLight, shaft, tube,
    /** Drone pose on the path: position, yaw following the tunnel, and the local frame. */
    pose(s, height = 0) {
      const f = frame(Math.min(Math.max(s, 0), 1));
      return { ...f, position: f.P.clone().addScaledVector(f.up, height), yaw: Math.atan2(f.T.x, f.T.z) };
    },
    updateScan, updatePlanner,
    /** Draw the tube's interior or not (from the surface it is hidden under rock; the shaft always stays). */
    applyInterior(show) {
      for (const o of [tube, cap, drips, boxGroup, ...boulderMeshes, ...obstacles.map((ob) => ob.mesh)]) o.visible = show;
      if (!show) for (const o of [lidar, voxels, wireLines, stress, ice, pathDots, links, cands, ...nodes.map((n) => n.group)]) o.visible = false;
    },
    /** Per-frame state from the choreography. */
    set({ time = 0, mapped = 0, lidarOpacity = 1, origin, pulse = 0, wire = 0, voxels: voxO = 0, stressScan = 0, stressOpacity = 0,
      ice: iceO = 0, droneS = 0, boxes = 0, pathA = 0, pathB = 0, pathOpacity = 0, pathColor = 0x00a8cc, nodeDrop = null, links: linkO = 0, skylight = 1 }) {
      lidarMat.uniforms.uMapped.value = mapped; lidarMat.uniforms.uOpacity.value = lidarOpacity;
      if (origin) lidarMat.uniforms.uOrigin.value.copy(origin);
      lidarMat.uniforms.uPulse.value = pulse;
      voxMat.uniforms.uMapped.value = mapped - 0.006; voxMat.uniforms.uOpacity.value = voxO;
      wireMat.uniforms.uMapped.value = mapped - 0.015; wireMat.uniforms.uOpacity.value = wire * 0.22;
      stressMat.uniforms.uScan.value = stressScan; stressMat.uniforms.uOpacity.value = stressOpacity;
      iceMat.opacity = iceO;
      dustMat.uniforms.uTime.value = time; dustMat.uniforms.uOpacity.value = skylight;
      rayMat.uniforms.uOpacity.value = skylight;
      skyLight.intensity = 900 * skylight;
      pathMat.uniforms.uA.value = pathA; pathMat.uniforms.uB.value = pathB; pathMat.uniforms.uOpacity.value = pathOpacity;
      pathMat.uniforms.uColor.value.setHex(pathColor);
      linkMat.opacity = linkO;
      // anything fully faded out is not drawn at all (each is a full pass over big buffers)
      lidar.visible = lidarOpacity > 0.002; voxels.visible = voxO > 0.002; wireLines.visible = wire > 0.002;
      stress.visible = stressOpacity > 0.002; ice.visible = iceO > 0.002; pathDots.visible = pathOpacity > 0.002; links.visible = linkO > 0.002;
      for (const o of obstacles) {
        const near = 1 - smooth(0.02, 0.06, Math.abs(o.s - droneS - 0.02));
        o.helper.material.opacity = boxes * near * 0.9;
      }
      nodes.forEach((n, i) => {
        const dropping = nodeDrop && nodeDrop.index === i;
        n.group.visible = dropping ? nodeDrop.t > 0 : droneS >= n.s + 0.004;
        if (dropping) n.group.position.lerpVectors(nodeDrop.from, n.rest, 1 - Math.pow(1 - Math.min(nodeDrop.t, 1), 2.4));
        else n.group.position.copy(n.rest);
        const landed = dropping ? smooth(0.85, 1, nodeDrop.t) : 1;
        n.rings.forEach((r, k) => {
          const ph = (time * 0.6 + k / 3) % 1;
          r.scale.setScalar(0.4 + ph * 3.2); r.material.opacity = (1 - ph) * 0.65 * landed;
        });
      });
    },
  };
}
