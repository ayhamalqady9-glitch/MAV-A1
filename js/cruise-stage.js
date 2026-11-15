// The spacecraft in the opening shot: what really carries a lander to Mars. A cruise stage (solar-cell ring,
// radiators, thruster clusters, silver insulation) sits on the entry capsule: a white backshell over a 70°
// sphere-cone heat shield of dark ablator tiles, heat shield leading, as in Mars Science Laboratory / Mars 2020.
// (A Space Shuttle never left low Earth orbit; it could not have flown to Mars.)
// It is modelled here once and rendered to a transparent sprite that the intro animates over the video.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

function tex(size, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildCraft() {
  const g = new THREE.Group();
  const add = (geo, mat, parent = g) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };
  // ---- heat shield: 70° sphere-cone, ablator tiles (lathe: profile from the nose to the shoulder)
  const R = 2.25, NOSE = 0.55;
  const prof = [];
  for (let i = 0; i <= 10; i++) { const a = (i / 10) * (Math.PI / 2 - 0.349); prof.push(new THREE.Vector2(Math.sin(a) * NOSE, NOSE - Math.cos(a) * NOSE)); }
  const last = prof[prof.length - 1];
  for (let i = 1; i <= 12; i++) { const r = last.x + (R - last.x) * (i / 12); prof.push(new THREE.Vector2(r, last.y + (r - last.x) * Math.tan(0.349))); }
  prof.push(new THREE.Vector2(R + 0.03, prof[prof.length - 1].y + 0.04));
  const hsDepth = prof[prof.length - 1].y;
  const tiles = tex(1024, (c, N) => {
    c.fillStyle = '#3b2a1f'; c.fillRect(0, 0, N, N);
    for (let i = 0; i < 9000; i++) { const v = 40 + Math.random() * 30; c.fillStyle = `rgba(${v + 20},${v},${v - 12},0.25)`; c.fillRect(Math.random() * N, Math.random() * N, 3, 3); }
    c.strokeStyle = 'rgba(15,10,8,0.85)'; c.lineWidth = 2.5;
    for (let i = 0; i <= 24; i++) { c.beginPath(); c.moveTo((i / 24) * N, 0); c.lineTo((i / 24) * N, N); c.stroke(); }
    for (let j = 0; j <= 7; j++) { c.beginPath(); c.moveTo(0, (j / 7) * N); c.lineTo(N, (j / 7) * N); c.stroke(); }
  });
  const shield = add(new THREE.LatheGeometry(prof, 96), new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.88, metalness: 0.05, side: THREE.DoubleSide }));
  shield.rotation.z = Math.PI / 2;            // lathe axis (+Y) → travel axis: the nose points along +X
  shield.position.x = hsDepth;
  // ---- backshell: two cones, white thermal protection with panel seams, parachute cone on top
  const shell = tex(1024, (c, N) => {
    c.fillStyle = '#d9d5cc'; c.fillRect(0, 0, N, N);
    for (let i = 0; i < 6000; i++) { const v = Math.random() < 0.5 ? 255 : 150; c.fillStyle = `rgba(${v},${v * 0.97},${v * 0.9},0.05)`; c.fillRect(Math.random() * N, Math.random() * N, 4, 4); }
    c.strokeStyle = 'rgba(90,86,80,0.55)'; c.lineWidth = 2;
    for (let i = 0; i <= 12; i++) { c.beginPath(); c.moveTo((i / 12) * N, 0); c.lineTo((i / 12) * N, N); c.stroke(); }
    c.beginPath(); c.moveTo(0, N * 0.5); c.lineTo(N, N * 0.5); c.stroke();
  });
  const shellMat = new THREE.MeshStandardMaterial({ map: shell, roughness: 0.62, metalness: 0.05 });
  const bs1 = add(new THREE.CylinderGeometry(1.45, R, 1.25, 96, 1, true), shellMat); bs1.rotation.z = Math.PI / 2; bs1.position.x = -0.62;
  const bs2 = add(new THREE.CylinderGeometry(0.95, 1.45, 0.55, 96, 1, true), shellMat); bs2.rotation.z = Math.PI / 2; bs2.position.x = -1.52;
  const cap = add(new THREE.CylinderGeometry(0.95, 0.95, 0.06, 48), shellMat); cap.rotation.z = Math.PI / 2; cap.position.x = -1.8;
  // ---- cruise stage: a short drum with a ring of solar cells on its back face
  const silver = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 1, roughness: 0.3 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e6e1, metalness: 0.05, roughness: 0.5 });
  const drum = add(new THREE.CylinderGeometry(2.0, 2.0, 0.42, 64), silver); drum.rotation.z = Math.PI / 2; drum.position.x = -2.05;
  const cells = tex(1024, (c, N) => {
    c.fillStyle = '#c9ccd3'; c.fillRect(0, 0, N, N);
    const n = 40, s = N / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = 18 + Math.random() * 12; c.fillStyle = `rgb(${v},${v + 16},${v + 56})`; c.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3); }
  });
  const ring = add(new THREE.RingGeometry(0.75, 1.95, 72, 1), new THREE.MeshStandardMaterial({ map: cells, metalness: 0.4, roughness: 0.25 }));
  ring.rotation.y = -Math.PI / 2; ring.position.x = -2.27;
  for (let k = 0; k < 10; k++) {                                         // spokes between the solar panels
    const sp = add(new THREE.BoxGeometry(0.02, 1.2, 0.05), white); const a = (k / 10) * Math.PI * 2;
    sp.position.set(-2.28, Math.cos(a) * 1.35, Math.sin(a) * 1.35); sp.rotation.x = a;
  }
  const hub = add(new THREE.CylinderGeometry(0.7, 0.7, 0.12, 40), white); hub.rotation.z = Math.PI / 2; hub.position.x = -2.3;
  const horn = add(new THREE.CylinderGeometry(0.22, 0.08, 0.45, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xd6d6d0, roughness: 0.5, side: THREE.DoubleSide }));
  horn.rotation.z = Math.PI / 2; horn.position.set(-2.55, 0.25, 0.1);                       // medium-gain antenna
  for (let k = 0; k < 8; k++) {                                          // radiators and thruster clusters on the rim
    const a = (k / 8) * Math.PI * 2 + 0.2;
    if (k % 2) {
      const rad = add(new THREE.BoxGeometry(0.36, 0.04, 0.7), white); rad.position.set(-2.05, Math.cos(a) * 2.03, Math.sin(a) * 2.03); rad.rotation.x = a;
    } else {
      const pod = add(new THREE.BoxGeometry(0.22, 0.2, 0.2), silver); pod.position.set(-2.05, Math.cos(a) * 2.1, Math.sin(a) * 2.1); pod.rotation.x = a;
      const nz = add(new THREE.CylinderGeometry(0.03, 0.07, 0.14, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0x3a3330, metalness: 0.9, roughness: 0.4, side: THREE.DoubleSide }));
      nz.position.set(-2.05, Math.cos(a) * 2.24, Math.sin(a) * 2.24); nz.rotation.x = a;
    }
  }
  return g;
}

/**
 * Render the craft to a transparent canvas of the given aspect, its travel axis pointing along `angle`
 * (radians, screen space, y down), seen three-quarters from behind so the solar ring shows.
 */
export function renderCruiseSprite({ aspect = 1.3, angle = Math.PI, height = 780 } = {}) {
  const w = Math.round(height * aspect), h = height;
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  r.setSize(w, h, false); r.setClearColor(0x000000, 0);
  r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.AgXToneMapping; r.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  const craft = buildCraft();
  const pivot = new THREE.Group(); pivot.add(craft); scene.add(pivot);
  craft.position.x = 0.4;                                               // centre the stack on its middle
  pivot.rotation.set(0, 0.62, -angle, 'ZYX');                           // turn the solar ring toward us, then align with the path
  const sun = new THREE.DirectionalLight(0xfff4e6, 3.2); sun.position.set(-4, 5, 6); scene.add(sun);
  const marsGlow = new THREE.DirectionalLight(0xff8a4a, 0.9); marsGlow.position.set(5, -3, 2); scene.add(marsGlow);
  scene.add(new THREE.HemisphereLight(0x9fb4d8, 0x2a1a12, 0.35));
  const cam = new THREE.PerspectiveCamera(18, w / h, 0.1, 100);
  cam.position.set(0, 0, 3.15 / Math.sin(THREE.MathUtils.degToRad(9)) * 1.0); cam.lookAt(0, 0, 0);
  r.render(scene, cam);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  out.getContext('2d').drawImage(canvas, 0, 0);
  pm.dispose(); r.dispose(); r.forceContextLoss();
  return out;
}
