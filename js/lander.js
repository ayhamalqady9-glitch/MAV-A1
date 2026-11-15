// The MAV-A1 carrier: a heavy Mars lander (in the family of Phoenix / InSight and the Sample Retrieval Lander
// concept) that carries the drone inside a sealed, dust-proof hangar on its deck. Built from what such a
// lander really has:
//   · a decagonal aluminium-honeycomb deck over an equipment bay in multi-layer insulation (silver / gold Kapton)
//   · titanium propellant tanks and a pressurant sphere, 3 clusters of throttled descent thrusters
//   · three legs (main strut + two side struts, shock absorber, crushable footpad)
//   · two UltraFlex fan-fold solar arrays, a UHF helix, an X-band dish on a gimbal, a weather mast, hazard cameras
//   · THE HANGAR: white-painted walls with stiffeners, two clamshell doors on hinges and telescopic actuators
//     (rubber dust seals along every edge), interior LED strips, and a pad lift that raises the drone to the
//     rim for take-off and lowers it back inside to charge on the induction coil
//   · Mars dust settled on every upward-facing surface, heaviest on the closed doors
// Local +Z faces the skylight. setDoors(0 closed → 1 open), setLift(0 down → 1 raised), padTopY(lift).
import * as THREE from 'three';
import { mergeStatic } from './merge-static.js';

const V3 = THREE.Vector3;

/** Mars dust on up-facing surfaces of any standard material (world-space, noisy, never NaN). */
function dusty(mat, amount = 0.5, key = 'd') {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 dWN; varying vec3 dWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n dWN = mat3(modelMatrix) * objectNormal; dWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 dWN; varying vec3 dWP;
        float dHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float dNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(dHash(i), dHash(i + vec2(1, 0)), f.x), mix(dHash(i + vec2(0, 1)), dHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float dL = length(dWN);
        float dUp = dL > 1e-5 ? clamp(dWN.y / dL, 0.0, 1.0) : 0.0;
        float dN = dNoise(dWP.xz * 2.7) * 0.55 + dNoise(dWP.xz * 13.0) * 0.45;
        float dd = clamp(smoothstep(0.3, 0.95, dUp) * ${amount.toFixed(2)} * (0.45 + 0.75 * dN) + (1.0 - dUp) * ${(amount * 0.12).toFixed(3)} * dN, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.56, 0.37, 0.25) * (0.85 + 0.3 * dN), dd);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.95, dd);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = mix(metalnessFactor, 0.0, dd);');
  };
  mat.customProgramCacheKey = () => `dusty-${key}-${amount}`;
  return mat;
}

function canvasTex(size, draw, repeat = [1, 1], srgb = true, h = size) {
  const c = document.createElement('canvas'); c.width = size; c.height = h;
  draw(c.getContext('2d'), size, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// creased foil (bump)
const crinkle = () => canvasTex(512, (g, N) => {
  g.fillStyle = '#808080'; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 1100; i++) {
    const x = Math.random() * N, y = Math.random() * N, a = Math.random() * Math.PI, L = 8 + Math.random() * 60;
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)'; g.lineWidth = 0.5 + Math.random() * 2;
    g.beginPath(); g.moveTo(x - Math.cos(a) * L, y - Math.sin(a) * L); g.lineTo(x + Math.cos(a) * L + (Math.random() - 0.5) * 6, y + Math.sin(a) * L + (Math.random() - 0.5) * 6); g.stroke();
  }
}, [3, 1.5], false);
// honeycomb deck: panels with fastener rows
const deckTex = () => canvasTex(512, (g, N) => {
  g.fillStyle = '#8e9095'; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 2000; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? 255 : 0},${Math.random() < 0.5 ? 255 : 0},${Math.random() < 0.5 ? 255 : 0},0.025)`; g.fillRect(Math.random() * N, Math.random() * N, 3, 3); }
  g.strokeStyle = 'rgba(40,42,48,0.55)'; g.lineWidth = 2;
  for (let i = 0; i <= N; i += N / 4) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, N); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(N, i); g.stroke(); }
  g.fillStyle = 'rgba(30,30,34,0.6)';
  for (let i = 0; i <= N; i += N / 4) for (let j = 6; j < N; j += 16) { g.fillRect(i - 1.5, j, 3, 3); g.fillRect(j, i - 1.5, 3, 3); }
}, [2, 2]);
// white thermal-paint hull panels: seams, rivet rows, faint grime
const hullTex = () => canvasTex(512, (g, N) => {
  g.fillStyle = '#e3e0d9'; g.fillRect(0, 0, N, N);
  for (let i = 0; i < 2600; i++) { const v = Math.random() < 0.5 ? 255 : 120; g.fillStyle = `rgba(${v},${v * 0.9},${v * 0.8},0.035)`; g.fillRect(Math.random() * N, Math.random() * N, 2 + Math.random() * 5, 2 + Math.random() * 5); }
  g.strokeStyle = 'rgba(70,66,60,0.55)'; g.lineWidth = 2.2;
  for (let i = 0; i <= N; i += N / 4) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, N); g.stroke(); }
  g.beginPath(); g.moveTo(0, N * 0.5); g.lineTo(N, N * 0.5); g.stroke();
  g.fillStyle = 'rgba(80,76,70,0.65)';
  for (let i = 0; i <= N; i += N / 4) for (let j = 8; j < N; j += 22) { g.fillRect(i - 7, j, 2.5, 2.5); g.fillRect(i + 5, j, 2.5, 2.5); }
  for (let j = 8; j < N; j += 22) { g.fillRect(j, N * 0.5 - 7, 2.5, 2.5); g.fillRect(j, N * 0.5 + 5, 2.5, 2.5); }
  const gr = g.createLinearGradient(0, 0, 0, N); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(120,70,40,0.18)');
  g.fillStyle = gr; g.fillRect(0, 0, N, N);                                     // dust stain creeping up from the deck
}, [1, 1]);
// solar cells: dark blue cells, silver busbars, white gaps
const cellTex = () => canvasTex(512, (g, N) => {
  g.fillStyle = '#d7dae0'; g.fillRect(0, 0, N, N);
  const n = 16, s = N / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = 22 + Math.random() * 10;
    g.fillStyle = `rgb(${v},${v + 14},${v + 52})`; g.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
    g.fillStyle = 'rgba(200,210,230,0.35)'; for (let k = 1; k < 4; k++) g.fillRect(i * s + 1.5, j * s + (k * s) / 4, s - 3, 0.8);
  }
}, [3, 3]);
// docking target on the lift pad: concentric rings + square fiducials the drone's camera locks on to
const padTex = () => canvasTex(512, (g, N) => {
  const c = N / 2;
  g.fillStyle = '#1b1d22'; g.fillRect(0, 0, N, N);
  g.strokeStyle = '#d9dde3'; g.lineWidth = 6; for (const r of [0.86, 0.56, 0.26]) { g.beginPath(); g.arc(c, c, c * r, 0, Math.PI * 2); g.stroke(); }
  g.lineWidth = 4; g.beginPath(); g.moveTo(c - 40, c); g.lineTo(c + 40, c); g.moveTo(c, c - 40); g.lineTo(c, c + 40); g.stroke();
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2, x = c + Math.cos(a) * c * 0.98, y = c + Math.sin(a) * c * 0.98, S = 50;
    g.fillStyle = '#e8ebef'; g.fillRect(x - S / 2, y - S / 2, S, S);
    g.fillStyle = '#111'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i * 7 + j * 3 + k) % 3 === 0 || i === 0 || j === 0 || i === 3 || j === 3) g.fillRect(x - S / 2 + 5 + i * 10, y - S / 2 + 5 + j * 10, 10, 10);
  }
  g.strokeStyle = '#c8a400'; g.lineWidth = 10; g.setLineDash([26, 26]); g.strokeRect(5, 5, N - 10, N - 10);   // edge marking
}, [1, 1]);
// stencil on the front wall: name plate + hazard stripes by the door seam
const decalTex = () => canvasTex(1024, (g, W, H) => {
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(25,26,30,0.92)'; g.font = '700 150px "Saira", "Space Grotesk", Arial, sans-serif'; g.textBaseline = 'middle';
  g.fillText('MAV-A1', 40, H * 0.42);
  g.font = '600 46px "Saira", "Space Grotesk", Arial, sans-serif'; g.fillStyle = 'rgba(25,26,30,0.75)';
  g.fillText('HANGAR 01 · DUST-SEALED · DO NOT STEP', 44, H * 0.8);
  g.save(); g.beginPath(); g.rect(W - 300, 30, 260, 70); g.clip();
  for (let x = W - 340; x < W; x += 44) { g.fillStyle = '#d9a800'; g.beginPath(); g.moveTo(x, 100); g.lineTo(x + 22, 100); g.lineTo(x + 92, 30); g.lineTo(x + 70, 30); g.fill(); }
  g.restore();
}, [1, 1], true, 256);

export function createLander() {
  const g = new THREE.Group(); g.name = 'lander';
  const crk = crinkle(), hull = hullTex();
  const M = {
    deck: dusty(new THREE.MeshStandardMaterial({ map: deckTex(), color: 0xffffff, metalness: 0.55, roughness: 0.6 }), 0.55, 'deck'),
    silver: dusty(new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 1, roughness: 0.32, bumpMap: crk, bumpScale: 2.6 }), 0.35, 'silver'),
    gold: dusty(new THREE.MeshStandardMaterial({ color: 0xb8913f, metalness: 1, roughness: 0.36, bumpMap: crk, bumpScale: 3.0 }), 0.35, 'gold'),
    white: dusty(new THREE.MeshStandardMaterial({ color: 0xd8d6d0, metalness: 0.05, roughness: 0.55 }), 0.5, 'white'),
    hull: dusty(new THREE.MeshStandardMaterial({ map: hull, metalness: 0.08, roughness: 0.5 }), 0.45, 'hull'),
    doorTop: dusty(new THREE.MeshStandardMaterial({ map: hull, metalness: 0.08, roughness: 0.5 }), 0.8, 'doortop'),
    inner: new THREE.MeshStandardMaterial({ color: 0x2b2e34, metalness: 0.45, roughness: 0.55 }),
    seal: new THREE.MeshStandardMaterial({ color: 0x141416, metalness: 0, roughness: 0.85 }),
    ti: dusty(new THREE.MeshStandardMaterial({ color: 0xa9adb3, metalness: 0.85, roughness: 0.38 }), 0.3, 'ti'),
    carbon: dusty(new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.35, roughness: 0.5 }), 0.25, 'carbon'),
    alu: new THREE.MeshStandardMaterial({ color: 0x9a9da3, metalness: 0.9, roughness: 0.3 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd9dce0, metalness: 1, roughness: 0.15 }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x3a3230, metalness: 0.9, roughness: 0.42, side: THREE.DoubleSide }),
    cells: dusty(new THREE.MeshStandardMaterial({ map: cellTex(), metalness: 0.45, roughness: 0.28 }), 0.22, 'cells'),
    back: new THREE.MeshStandardMaterial({ color: 0xcfd2d6, metalness: 0.4, roughness: 0.5 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0b0d10, metalness: 0.2, roughness: 0.08, clearcoat: 1 }),
    pad: new THREE.MeshStandardMaterial({ map: padTex(), metalness: 0.3, roughness: 0.55 }),
    led: new THREE.MeshStandardMaterial({ color: 0xfff3e2, emissive: 0xfff1dc, emissiveIntensity: 2.2 }),
    decal: new THREE.MeshStandardMaterial({ map: decalTex(), transparent: true, roughness: 0.6, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  };
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x00a8cc, emissive: 0x00a8cc, emissiveIntensity: 1.6 });
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const polar = (a, r, y) => new V3(Math.cos(a) * r, y, Math.sin(a) * r);
  const strut = (p0, p1, r, mat, parent = g) => {
    const d = new V3().subVectors(p1, p0), m = add(new THREE.CylinderGeometry(r, r, d.length(), 10), mat, 0, 0, 0, parent);
    m.position.copy(p0).addScaledVector(d, 0.5); m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize()); return m;
  };
  const R = 3.1, D = 3.05;                 // deck radius, deck top
  const HW = 1.85, WH = 1.4, WT = 0.08;     // hangar half-width, wall height, wall thickness
  const LIFT = 1.0;                         // pad lift travel

  // ---- deck + equipment bay in multi-layer insulation
  add(new THREE.CylinderGeometry(R, R, 0.18, 10), M.deck, 0, D - 0.09).rotation.y = Math.PI / 10;
  add(new THREE.CylinderGeometry(R * 0.9, R * 0.84, 0.62, 10), M.silver, 0, D - 0.49).rotation.y = Math.PI / 10;
  for (let k = 0; k < 10; k++) if (k % 3 !== 1) {                                          // gold Kapton blanket panels
    const a = (k / 10) * Math.PI * 2, p = polar(a, R * 0.875, D - 0.49);
    const b = add(new THREE.BoxGeometry(1.3, 0.5, 0.04), M.gold, p.x, p.y, p.z);
    b.lookAt(polar(a, 4.5, D - 0.49 - 0.12));
  }
  for (let k = 0; k < 10; k++) {                                                           // deck edge rail
    const a0 = (k / 10) * Math.PI * 2 + Math.PI / 10, a1 = a0 + (Math.PI * 2) / 10;
    strut(polar(a0, R * 0.975, D + 0.02), polar(a1, R * 0.975, D + 0.02), 0.025, M.alu);
  }

  // ---- tanks under the deck
  for (const x of [-1.05, 1.05]) add(new THREE.SphereGeometry(0.62, 32, 20), M.ti, x, D - 1.32, -0.2);
  add(new THREE.SphereGeometry(0.34, 24, 16), M.ti, 0, D - 1.25, 1.05);
  add(new THREE.CylinderGeometry(2.15, 2.15, 0.08, 10), M.carbon, 0, D - 0.86).rotation.y = Math.PI / 10;   // lower structure plate

  // ---- three descent thruster clusters (between the legs)
  for (const deg of [90, 210, 330]) {
    const a = (deg * Math.PI) / 180, c = polar(a, 2.0, D - 1.0);
    add(new THREE.BoxGeometry(0.6, 0.24, 0.6), M.silver, c.x, c.y, c.z).rotation.y = -a;
    for (let i = -1; i <= 1; i++) {
      const p = polar(a + i * 0.15, 2.0, D - 1.3);
      const n = add(new THREE.CylinderGeometry(0.065, 0.14, 0.34, 16, 1, true), M.nozzle, p.x, p.y, p.z);
      n.rotation.z = Math.sign(Math.cos(a)) * 0.12;
    }
  }

  // ---- three legs: main strut with shock absorber, two side struts, crushable footpad
  for (const deg of [30, 150, 270]) {
    const a = (deg * Math.PI) / 180;
    const foot = polar(a, 3.95, 0.16), hip = polar(a, 2.35, D - 0.75);
    strut(hip, foot, 0.075, M.carbon);
    const mid = hip.clone().lerp(foot, 0.42), d = new V3().subVectors(foot, hip).normalize();
    const sleeve = add(new THREE.CylinderGeometry(0.12, 0.12, 0.95, 14), M.alu); sleeve.position.copy(mid); sleeve.quaternion.setFromUnitVectors(new V3(0, 1, 0), d);
    for (const s of [-0.42, 0.42]) strut(polar(a + s, 2.0, D - 1.05), foot.clone().add(new V3(0, 0.12, 0)), 0.042, M.carbon);
    add(new THREE.CylinderGeometry(0.45, 0.54, 0.12, 24), M.alu, foot.x, 0.07, foot.z);
    add(new THREE.SphereGeometry(0.12, 12, 8), M.alu, foot.x, 0.2, foot.z);
  }

  // ---- two UltraFlex solar arrays (decagonal fan-fold gores, radial spars, rim)
  for (const sx of [-1, 1]) {
    const arr = new THREE.Group(); arr.position.set(sx * 5.45, D - 0.12, 0); arr.rotation.z = -sx * 0.06; g.add(arr);
    const AR = 2.25, N = 10;
    for (let k = 0; k < N; k++) {                                                          // gores, alternately tilted
      const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2, lift = k % 2 ? 0.035 : -0.035;
      const geo = new THREE.BufferGeometry();
      const pts = [0, 0.02, 0, Math.cos(a0) * AR, lift, Math.sin(a0) * AR, Math.cos(a1) * AR, -lift, Math.sin(a1) * AR];
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0.5, 0.5, 0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5, 0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5], 2));
      geo.setIndex([0, 2, 1]); geo.computeVertexNormals();
      const top = new THREE.Mesh(geo, M.cells); top.castShadow = true; top.receiveShadow = true; arr.add(top);
      const backGeo = geo.clone(); backGeo.setIndex([0, 1, 2]); backGeo.computeVertexNormals(); backGeo.translate(0, -0.012, 0);
      const bk = new THREE.Mesh(backGeo, M.back); bk.castShadow = true; arr.add(bk);
      const sp = new THREE.Mesh(new THREE.BoxGeometry(AR, 0.03, 0.035), M.white);
      sp.position.set(Math.cos(a0) * AR / 2, 0.02 + lift / 2, Math.sin(a0) * AR / 2); sp.rotation.y = -a0; sp.castShadow = true; arr.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.16, 20), M.alu); hub.castShadow = true; arr.add(hub);
    strut(new V3(sx * 3.0, D - 0.15, 0), new V3(sx * 5.25, D - 0.13, 0), 0.06, M.alu);           // hinge boom
    strut(new V3(sx * 2.75, D - 0.55, 0), new V3(sx * 4.3, D - 0.16, 0), 0.03, M.alu);            // brace
  }

  // ---- deck equipment, kept in the strips around the hangar
  const helix = new THREE.CatmullRomCurve3(Array.from({ length: 60 }, (_, i) => new V3(Math.cos(i * 0.62) * 0.07, i * 0.012, Math.sin(i * 0.62) * 0.07)));
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 8), M.alu, 0.1, D + 0.18, -2.62);
  add(new THREE.TubeGeometry(helix, 200, 0.008, 6), M.alu, 0.1, D + 0.35, -2.62);                       // UHF helix
  add(new THREE.CylinderGeometry(0.05, 0.07, 0.62, 10), M.alu, -1.0, D + 0.31, -2.4);                    // HGA gimbal
  const dishPts = []; for (let i = 0; i <= 14; i++) { const r = (i / 14) * 0.48; dishPts.push(new THREE.Vector2(r, r * r * 0.55)); }
  const dish = add(new THREE.LatheGeometry(dishPts, 40), dusty(new THREE.MeshStandardMaterial({ color: 0xe2e0db, roughness: 0.6, side: THREE.DoubleSide }), 0.3, 'dish'), -1.0, D + 0.7, -2.4);
  dish.rotation.set(-0.6, 0, 0.45);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 6), M.alu, -1.0, D + 0.84, -2.4).rotation.set(-0.6, 0, 0.45);   // feed
  add(new THREE.CylinderGeometry(0.035, 0.035, 1.7, 8), M.white, 1.0, D + 0.85, -2.45);                 // weather mast
  for (const s of [-1, 1]) {
    strut(new V3(1.0, D + 1.6, -2.45), new V3(1.0 + s * 0.42, D + 1.6, -2.45), 0.012, M.white);
    add(new THREE.BoxGeometry(0.12, 0.08, 0.1), M.white, 1.0 + s * 0.45, D + 1.6, -2.45);
  }
  for (const x of [0.95, -0.95]) {                                                                      // hazard cameras
    add(new THREE.BoxGeometry(0.16, 0.12, 0.18), M.carbon, x, D + 0.08, 2.42);
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 14), M.glass, x, D + 0.08, 2.52).rotation.x = Math.PI / 2;
  }
  add(new THREE.BoxGeometry(0.42, 0.32, 0.8), M.silver, 2.45, D + 0.16, -0.5);                           // avionics box
  add(new THREE.BoxGeometry(0.45, 0.26, 0.6), M.gold, -2.45, D + 0.13, 0.55);                            // battery enclosure
  add(new THREE.BoxGeometry(0.06, 0.5, 1.1), M.white, 2.42, D + 0.25, 0.75);                             // radiator fin

  // ---- THE HANGAR -------------------------------------------------------------------------------------------
  const hangar = new THREE.Group(); hangar.name = 'hangar'; g.add(hangar);
  // walls: white outside, dark inside (box face order +x, −x, +y, −y, +z, −z)
  const wall = (w, d, x, z, innerFace) => {
    const mats = [M.hull, M.hull, M.seal, M.hull, M.hull, M.hull]; mats[innerFace] = M.inner;
    return add(new THREE.BoxGeometry(w, WH, d), mats, x, D + WH / 2, z, hangar);
  };
  wall(WT, 2 * HW, HW - WT / 2, 0, 1); wall(WT, 2 * HW, -HW + WT / 2, 0, 0);
  wall(2 * HW - 2 * WT, WT, 0, HW - WT / 2, 5); wall(2 * HW - 2 * WT, WT, 0, -HW + WT / 2, 4);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.BoxGeometry(0.16, WH + 0.06, 0.16), M.alu, sx * HW, D + (WH + 0.06) / 2, sz * HW, hangar);   // corner posts
  // stiffening ribs, outside
  for (const s of [-1, 1]) for (const k of [-0.9, 0, 0.9]) add(new THREE.BoxGeometry(0.05, WH - 0.12, 0.05), M.white, s * (HW + 0.02), D + WH / 2, k, hangar);
  for (const k of [-0.9, 0, 0.9]) add(new THREE.BoxGeometry(0.05, WH - 0.12, 0.05), M.white, k, D + WH / 2, -(HW + 0.02), hangar);
  for (const k of [-1.45, 1.45]) add(new THREE.BoxGeometry(0.05, WH - 0.12, 0.05), M.white, k, D + WH / 2, HW + 0.02, hangar);   // front: room for the stencil
  // exterior status strip (pulses while charging) and interior LED strips
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.012, 0.035, 2 * HW - 0.5), ringMat, s * (HW + 0.048), D + WH - 0.2, 0, hangar).castShadow = false;
    add(new THREE.BoxGeometry(2 * HW - 0.5, 0.035, 0.012), ringMat, 0, D + WH - 0.2, s * (HW + 0.048), hangar).castShadow = false;
    add(new THREE.BoxGeometry(0.02, 0.04, 2 * HW - 0.4), M.led, s * (HW - WT - 0.012), D + WH - 0.12, 0, hangar).castShadow = false;
    add(new THREE.BoxGeometry(2 * HW - 0.4, 0.04, 0.02), M.led, 0, D + WH - 0.12, s * (HW - WT - 0.012), hangar).castShadow = false;
  }
  // stencil on the front wall (faces the skylight)
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.625), M.decal); decal.position.set(0, D + 0.55, HW + 0.004); hangar.add(decal);
  // hangar floor + lift guide rails
  add(new THREE.BoxGeometry(2 * HW - 2 * WT, 0.03, 2 * HW - 2 * WT), M.inner, 0, D + 0.015, 0, hangar);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.CylinderGeometry(0.035, 0.035, LIFT + 0.25, 10), M.chrome, sx * 1.5, D + (LIFT + 0.25) / 2, sz * 1.5, hangar);
  add(new THREE.CylinderGeometry(0.19, 0.21, 0.04, 20), M.alu, 0, D + 0.02, 0, hangar);                  // lift cylinder collar (the cylinder is in the bay below)

  // the pad lift: landing pad with fiducials + induction coil, piston rod below
  const lift = new THREE.Group(); lift.name = 'pad-lift'; lift.userData.dynamic = true; hangar.add(lift);
  const PAD_Y = D + 0.05, PAD_T = 0.1;
  add(new THREE.BoxGeometry(3.1, PAD_T, 3.1), [M.carbon, M.carbon, M.pad, M.carbon, M.carbon, M.carbon], 0, -PAD_T / 2, 0, lift);
  const padRing = add(new THREE.TorusGeometry(1.22, 0.04, 8, 96), ringMat, 0, 0.012, 0, lift);
  padRing.rotation.x = Math.PI / 2; padRing.castShadow = false;
  add(new THREE.CylinderGeometry(0.11, 0.11, LIFT, 16), M.chrome, 0, -PAD_T - LIFT / 2, 0, lift);       // piston rod
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 12), M.alu, sx * 1.5, -0.07, sz * 1.5, lift);   // rail bushings

  // the clamshell doors: hinged along the two side walls, meeting in a shallow gable over the middle
  const GABLE = 0.07, OPEN = 1.92;
  const doors = [-1, 1].map((sx) => {
    const pivot = new THREE.Group(); pivot.position.set(sx * HW, D + WH + 0.02, 0); pivot.userData.dynamic = true; hangar.add(pivot);
    const L = HW + 0.03, Wd = 2 * HW + 0.14;
    add(new THREE.BoxGeometry(L, 0.07, Wd), [M.hull, M.hull, M.doorTop, M.inner, M.hull, M.hull], -sx * L / 2, 0.035, 0, pivot);
    for (const z of [-1.25, 0, 1.25]) add(new THREE.BoxGeometry(L - 0.25, 0.05, 0.06), M.white, -sx * (L / 2 + 0.05), 0.095, z, pivot);   // ribs
    add(new THREE.BoxGeometry(0.05, 0.07, Wd), M.seal, -sx * (L + 0.005), 0.03, 0, pivot);              // dust seal along the meeting edge
    for (const z of [-1, 1]) add(new THREE.BoxGeometry(L, 0.06, 0.04), M.seal, -sx * L / 2, 0.0, z * (Wd / 2 + 0.01), pivot);
    const hinge = add(new THREE.CylinderGeometry(0.055, 0.055, Wd - 0.1, 14), M.alu, 0, 0, 0, pivot); hinge.rotation.x = Math.PI / 2;
    // telescopic actuators outside the front and back walls: a body fixed to the wall, a rod pinned to the door
    const acts = [-1, 1].map((sz) => {
      const body = add(new THREE.CylinderGeometry(0.045, 0.045, 1, 12), M.white, 0, 0, 0, hangar);
      const rod = add(new THREE.CylinderGeometry(0.024, 0.024, 1, 10), M.chrome, 0, 0, 0, hangar);
      body.userData.dynamic = true; rod.userData.dynamic = true;
      add(new THREE.BoxGeometry(0.1, 0.08, 0.06), M.alu, sx * (HW - 0.38), D + WH - 0.55, sz * (HW + 0.075), hangar);   // wall clevis
      return { body, rod, base: new V3(sx * (HW - 0.38), D + WH - 0.55, sz * (HW + 0.075)), pin: new V3(-sx * 0.62, 0.0, sz * (HW + 0.075)) };
    });
    return { sx, pivot, acts };
  });

  const up = new V3(0, 1, 0), tmp = new V3(), dir = new V3();
  const state = { doors: -1, lift: -1 };
  function placeStrut(m, a, b, len) {
    dir.subVectors(b, a); const L = dir.length(); dir.multiplyScalar(1 / Math.max(L, 1e-6));
    const l = len ? Math.min(len, L) : L;
    m.position.copy(a).addScaledVector(dir, l / 2); m.quaternion.setFromUnitVectors(up, dir); m.scale.set(1, l, 1);
  }
  /** 0 = closed and sealed, 1 = fully open (each door swings ~110° outward). */
  function setDoors(k) {
    k = Math.min(1, Math.max(0, k));
    if (k === state.doors) return; state.doors = k;
    for (const d of doors) {
      d.pivot.rotation.z = -d.sx * (GABLE + k * OPEN);
      d.pivot.updateMatrix();
      for (const a of d.acts) {
        const pin = tmp.copy(a.pin).applyMatrix4(d.pivot.matrix);
        placeStrut(a.body, a.base, pin, 0.62);
        placeStrut(a.rod, a.base, pin);
      }
    }
  }
  /** 0 = pad down on the hangar floor, 1 = raised to the rim for take-off and landing. */
  function setLift(k) {
    k = Math.min(1, Math.max(0, k));
    if (k === state.lift) return; state.lift = k;
    lift.position.y = PAD_Y + PAD_T + k * LIFT;
  }
  const padTopY = (k = state.lift) => PAD_Y + PAD_T + Math.min(1, Math.max(0, k)) * LIFT;
  setDoors(0); setLift(0);
  mergeStatic(g, { keep: (o) => o.userData.dynamic });           // ~200 parts → a few dozen draw calls

  // thruster glow for the powered landing
  const glowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff7a30, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const glow = new THREE.Sprite(glowMat); glow.scale.set(6.5, 6.5, 1); glow.position.set(0, D - 1.65, 0); g.add(glow);
  return {
    group: g, deckY: D, hangarTop: D + WH, padRing, ringMat, glow, glowMat, dish, setDoors, setLift, padTopY,
    get doors() { return state.doors; }, get lift() { return state.lift; },
  };
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,220,180,0.55)'); r.addColorStop(1, 'rgba(255,160,90,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
