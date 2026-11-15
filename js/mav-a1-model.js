// MAV-A1 hexacopter: procedural Three.js model matched to the 4 reference views
// (assets/img/ref-mav-a1-views.webp).
//
//   6 arms at 60° (X-hex: nose between two arms), 6 motors, ONE 6-blade rotor per motor.
//   Hexagonal hull with violet hex-cell panels, LiDAR puck at the front of the top,
//   dual-lens stereo camera under the nose, avionics box under the tail, 4 angled legs.
//
// Units: 1 unit = motor-axis radius. Nose points +Z, up is +Y.
//
//   import { createMAVA1 } from './js/mav-a1-model.js';
//   const drone = createMAVA1();
//   scene.add(drone.object);
//   drone.setRPM(0.7);                    // 0..1, rotors ease toward it
//   drone.setAttitude(pitch, roll, yaw);  // radians; body tilts, root stays put
//   drone.update(dt);                     // call every frame
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const MAV_COLORS = {
  violet: 0x4e2e96, violetHi: 0x6c4fc8, seam: 0x1a1030,
  carbon: 0x141414, gun: 0x3a4250, silver: 0xb8c0cc,
  cyan: 0x00a8cc, orange: 0xff3305,
};

export const MAV_DIMENSIONS = {
  motorRadius: 1.0,      // hull centre → motor axis
  rotorRadius: 0.40,     // blade tip radius
  hullRadius: 0.455,     // hex circumradius
  rotors: 6, bladesPerRotor: 6,
  span: 2 * (1.0 + 0.40),
  footY: -0.62,          // feet below the hull centre
};

const V3 = THREE.Vector3;
const HALF_PI = Math.PI / 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const polar = (r, a, y = 0) => new V3(r * Math.cos(a), y, r * Math.sin(a));
const hexAngle = (k) => HALF_PI + (k * Math.PI) / 3; // pointy toward the nose (+Z)

// ------------------------------------------------------------------ textures
function canvasTexture(size, draw, repeat = [1, 1], srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const carbonTexture = () => canvasTexture(128, (g, s) => {
  g.fillStyle = '#111113';
  g.fillRect(0, 0, s, s);
  const n = 8, w = s / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const horiz = (x + y) % 2 === 0;
    const gr = horiz ? g.createLinearGradient(x * w, 0, x * w + w, 0) : g.createLinearGradient(0, y * w, 0, y * w + w);
    gr.addColorStop(0, '#141417'); gr.addColorStop(0.5, '#2b2b31'); gr.addColorStop(1, '#141417');
    g.fillStyle = gr;
    g.fillRect(x * w + 0.5, y * w + 0.5, w - 1, w - 1);
  }
}, [5, 5]);

const cellTexture = () => canvasTexture(256, (g, s) => {
  const gr = g.createLinearGradient(0, 0, s, s);
  gr.addColorStop(0, '#5b38ab'); gr.addColorStop(1, '#43278a');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(200,180,255,0.16)';
  g.lineWidth = 1;
  for (let i = 0; i <= s; i += 6) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke(); }
  g.strokeStyle = 'rgba(15,6,35,0.35)';
  for (let i = 0; i <= s; i += 32) { g.beginPath(); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); }
}, [2.5, 2.5]);

// translucent disc with 6 soft streaks: shown instead of blades at high RPM
const blurTexture = () => canvasTexture(256, (g, s) => {
  const c = s / 2;
  const rg = g.createRadialGradient(c, c, 8, c, c, c);
  rg.addColorStop(0, 'rgba(40,40,48,0.35)');
  rg.addColorStop(0.85, 'rgba(40,40,48,0.14)');
  rg.addColorStop(1, 'rgba(40,40,48,0)');
  g.fillStyle = rg;
  g.beginPath(); g.arc(c, c, c, 0, Math.PI * 2); g.fill();
  for (let k = 0; k < 6; k++) {
    for (let j = 0; j < 16; j++) {
      const a = (k * Math.PI) / 3 + j * 0.03;
      g.strokeStyle = `rgba(20,20,24,${0.10 * (1 - j / 16)})`;
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * 12, c + Math.sin(a) * 12);
      g.lineTo(c + Math.cos(a) * (c - 6), c + Math.sin(a) * (c - 6));
      g.stroke();
    }
  }
}, [1, 1]);

// ------------------------------------------------------------------ geometry helpers
function named(mesh, name) { mesh.name = name; mesh.castShadow = true; mesh.receiveShadow = true; return mesh; }

function hexPrism(R, y0, y1, mat, bevel = 0.006) {
  const s = new THREE.Shape();
  for (let k = 0; k < 6; k++) {
    const a = hexAngle(k), x = R * Math.cos(a), z = R * Math.sin(a);
    if (k === 0) s.moveTo(x, -z); else s.lineTo(x, -z);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: y1 - y0, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
  });
  g.rotateX(-HALF_PI); // shape (x,-z) → world (x, depth, z)
  g.translate(0, y0, 0);
  return new THREE.Mesh(g, mat);
}

// convex polygon, fan-triangulated, always facing up (+Y)
function upPolygon(pts, mat, lift = 0, uvScale = 1.1) {
  const pos = [], uv = [];
  for (let i = 1; i < pts.length - 1; i++) {
    let a = pts[0], b = pts[i], c = pts[i + 1];
    const n = new V3().subVectors(b, a).cross(new V3().subVectors(c, a));
    if (n.y < 0) [b, c] = [c, b];
    for (const p of [a, b, c]) { pos.push(p.x, p.y + lift, p.z); uv.push(p.x * uvScale + 0.5, p.z * uvScale + 0.5); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

function shrink(pts, f) {
  const c = pts.reduce((acc, p) => acc.add(p), new V3()).multiplyScalar(1 / pts.length);
  return pts.map((p) => p.clone().sub(c).multiplyScalar(f).add(c));
}

function tube(p0, p1, r, mat, radial = 14) {
  const d = new V3().subVectors(p1, p0);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), radial, 1), mat);
  m.position.copy(p0).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize());
  return m;
}

function cylinderY(r, y0, y1, mat, radial = 28, rTop = r) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, r, y1 - y0, radial), mat);
  m.position.y = (y0 + y1) / 2;
  return m;
}

// one blade along +X, thickness along Y, twisted (more pitch at the root)
function bladeGeometry(L, spin) {
  const k = L / 0.40, V2 = THREE.Vector2, r0 = 0.03;
  const s = new THREE.Shape();
  s.moveTo(r0, -0.012);
  s.splineThru([new V2(0.10 * k, -0.023), new V2(0.18 * k, -0.028), new V2(0.28 * k, -0.025), new V2(L - 0.035, -0.017)]);
  s.quadraticCurveTo(L + 0.008, 0.002, L - 0.035, 0.021);
  s.splineThru([new V2(0.28 * k, 0.030), new V2(0.18 * k, 0.034), new V2(0.10 * k, 0.029), new V2(r0, 0.014)]);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.005, bevelEnabled: false, curveSegments: 10 });
  g.translate(0, 0, -0.0025);
  g.rotateX(-HALF_PI);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = clamp((p.getX(i) - r0) / (L - r0), 0, 1);
    const ang = spin * lerp(0.34, 0.10, t);
    const y = p.getY(i), z = p.getZ(i);
    p.setY(i, y * Math.cos(ang) - z * Math.sin(ang));
    p.setZ(i, y * Math.sin(ang) + z * Math.cos(ang));
  }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ model
export function createMAVA1({ scale = 1 } = {}) {
  const tex = { carbon: carbonTexture(), cell: cellTexture(), blur: blurTexture() };
  const M = {
    carbon: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: tex.carbon, roughness: 0.42, metalness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
    panel: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: tex.cell, roughness: 0.5, metalness: 0.1, clearcoat: 0.3, clearcoatRoughness: 0.45, envMapIntensity: 0.35 }),
    seam: new THREE.MeshStandardMaterial({ color: MAV_COLORS.seam, roughness: 0.7, metalness: 0.2 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1c2027, roughness: 0.55, metalness: 0.5 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x4a5260, roughness: 0.32, metalness: 0.85 }),
    silver: new THREE.MeshStandardMaterial({ color: MAV_COLORS.silver, roughness: 0.22, metalness: 1.0 }),
    blade: new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.48, metalness: 0.15, transparent: true }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.9, metalness: 0 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x06080c, roughness: 0.05, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.02 }),
    lidar: new THREE.MeshPhysicalMaterial({ color: 0x0b1016, roughness: 0.12, metalness: 0.35, clearcoat: 1 }),
    led: new THREE.MeshStandardMaterial({ color: MAV_COLORS.cyan, emissive: MAV_COLORS.cyan, emissiveIntensity: 2.2 }),
    blur: new THREE.MeshBasicMaterial({ map: tex.blur, transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide }),
    ledFault: new THREE.MeshStandardMaterial({ color: MAV_COLORS.orange, emissive: MAV_COLORS.orange, emissiveIntensity: 2.6 }),
  };

  const root = new THREE.Group(); root.name = 'MAV-A1';
  const body = new THREE.Group(); body.name = 'body'; body.rotation.order = 'YXZ';
  root.add(body);
  root.scale.setScalar(scale);

  // ---- hull
  const hull = new THREE.Group(); hull.name = 'hull'; body.add(hull);
  hull.add(named(hexPrism(0.455, -0.07, -0.005, M.carbon), 'hull-side'));
  hull.add(named(hexPrism(0.40, -0.09, -0.07, M.dark, 0.004), 'hull-bottom'));

  const Ro = 0.445, Ri = 0.235, yO = 0.0, yI = 0.045;
  const outer = (k) => polar(Ro, hexAngle(k % 6), yO);
  const inner = (k) => polar(Ri, hexAngle(k % 6), yI);
  for (let k = 0; k < 6; k++) {
    const quad = [outer(k), outer(k + 1), inner(k + 1), inner(k)];
    hull.add(named(upPolygon(quad, M.seam, 0), `panel-base-${k}`));
    hull.add(named(upPolygon(shrink(quad, 0.93), M.panel, 0.004), `panel-${k}`));
  }
  const centre = [0, 1, 2, 3, 4, 5].map(inner);
  hull.add(named(upPolygon(centre, M.seam, 0), 'panel-base-centre'));
  hull.add(named(upPolygon(shrink(centre, 0.9), M.panel, 0.004), 'panel-centre'));

  // ---- LiDAR puck + sensor head (front of the top)
  const lidar = new THREE.Group(); lidar.name = 'lidar'; lidar.position.set(0, 0, 0.30); hull.add(lidar);
  lidar.add(named(cylinderY(0.085, 0.03, 0.062, M.gun), 'lidar-base'));
  lidar.add(named(cylinderY(0.077, 0.062, 0.168, M.lidar), 'lidar-window'));
  lidar.add(named(cylinderY(0.085, 0.168, 0.205, M.dark, 28, 0.072), 'lidar-cap'));
  const scan = named(new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.0025, 6, 48, 0.9), M.led), 'lidar-scan');
  scan.rotation.x = HALF_PI; scan.position.y = 0.115; lidar.add(scan);
  for (const sx of [-1, 1]) {
    const ear = named(new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.05, 0.07, 3, 0.012), M.gun), 'sensor-ear');
    ear.position.set(sx * 0.125, 0.05, 0.06); lidar.add(ear);
  }

  // ---- stereo camera under the nose
  const cam = new THREE.Group(); cam.name = 'stereo-camera'; cam.position.set(0, -0.19, 0.28); hull.add(cam);
  const bracket = named(new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.09, 0.06, 2, 0.01), M.gun), 'camera-bracket');
  bracket.position.y = 0.06; cam.add(bracket);
  cam.add(named(new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.12, 0.11, 4, 0.035), M.dark), 'camera-body'));
  for (const sx of [-1, 1]) {
    const barrel = named(new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.046, 0.045, 32), M.dark), 'lens-barrel');
    barrel.rotation.x = HALF_PI; barrel.position.set(sx * 0.068, 0, 0.07); cam.add(barrel);
    const ring = named(new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.005, 8, 32), M.silver), 'lens-ring');
    ring.position.set(sx * 0.068, 0, 0.093); cam.add(ring);
    const glass = named(new THREE.Mesh(new THREE.CircleGeometry(0.033, 32), M.glass), 'lens-glass');
    glass.position.set(sx * 0.068, 0, 0.094); cam.add(glass);
  }

  // ---- avionics box under the tail (two cable loops + port, as in the rear view)
  const box = named(new THREE.Mesh(new RoundedBoxGeometry(0.20, 0.13, 0.17, 4, 0.02), M.dark), 'avionics-box');
  box.position.set(0, -0.16, -0.16); hull.add(box);
  for (const sx of [-1, 1]) {
    const loop = named(new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.007, 8, 24, Math.PI), M.gun), 'cable-loop');
    loop.position.set(sx * 0.04, -0.14, -0.247); loop.rotation.z = Math.PI; hull.add(loop);
  }
  const port = named(new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.016, 0.006, 1, 0.003), M.silver), 'port');
  port.position.set(0, -0.20, -0.248); hull.add(port);
  const tailLoop = named(new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 8, 24, Math.PI), M.silver), 'tail-loop');
  tailLoop.position.set(0, -0.02, -0.46); tailLoop.rotation.set(0, 0, Math.PI); hull.add(tailLoop);

  // ---- breadcrumb node dispenser (centre bottom) + one loaded node
  const dispenser = named(cylinderY(0.05, -0.13, -0.09, M.gun), 'node-dispenser');
  dispenser.position.z = 0.02; hull.add(dispenser);
  const nodeRing = named(new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.004, 6, 32), M.led), 'node-ring');
  nodeRing.rotation.x = HALF_PI; nodeRing.position.set(0, -0.13, 0.02); hull.add(nodeRing);
  const node = named(new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 14), M.led), 'relay-node');
  node.position.set(0, -0.15, 0.02); hull.add(node);

  // ---- arms, motors, rotors
  const rotors = [], leds = [];
  const bladeCW = bladeGeometry(MAV_DIMENSIONS.rotorRadius, 1);
  const bladeCCW = bladeGeometry(MAV_DIMENSIONS.rotorRadius, -1);
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3; // arms at 0°, 60°, … (edge midpoints of the hull)
    const arm = new THREE.Group(); arm.name = `arm-${k}`; body.add(arm);
    const root0 = polar(0.36, a, -0.04), tip = polar(1.0, a, -0.015);
    arm.add(named(tube(root0, tip, 0.021, M.carbon), 'arm-tube'));
    arm.add(named(tube(polar(0.43, a, -0.04), polar(0.51, a, -0.037), 0.033, M.gun), 'arm-root-clamp'));
    arm.add(named(tube(polar(0.67, a, -0.034), polar(0.72, a, -0.032), 0.03, M.gun), 'arm-fold-joint'));
    const bolt = named(cylinderY(0.009, -0.01, 0.006, M.silver, 12), 'bolt');
    bolt.position.add(polar(0.695, a, 0)); arm.add(bolt);
    arm.add(named(tube(polar(0.90, a, -0.019), polar(0.95, a, -0.017), 0.03, M.gun), 'motor-clamp'));

    const motor = new THREE.Group(); motor.name = `motor-${k}`; motor.position.copy(polar(1.0, a, 0)); arm.add(motor);
    motor.add(named(cylinderY(0.062, -0.045, 0.022, M.dark), 'motor-stator'));
    motor.add(named(cylinderY(0.06, 0.022, 0.05, M.gun), 'motor-bell'));
    motor.add(named(cylinderY(0.03, 0.05, 0.058, M.silver), 'motor-cap'));

    const led = named(new THREE.Mesh(new THREE.SphereGeometry(0.013, 12, 8), M.led), 'status-led');
    led.position.copy(polar(0.92, a, -0.042)); arm.add(led); leds.push(led);

    const dir = k % 2 === 0 ? 1 : -1; // alternate CW / CCW
    const rotor = new THREE.Group(); rotor.name = `rotor-${k}`; rotor.position.set(0, 0.066, 0); motor.add(rotor);
    const blades = new THREE.Group(); blades.name = 'blades'; rotor.add(blades);
    for (let b = 0; b < MAV_DIMENSIONS.bladesPerRotor; b++) {
      const blade = named(new THREE.Mesh(dir > 0 ? bladeCW : bladeCCW, M.blade), `blade-${b}`);
      blade.rotation.y = (b * Math.PI) / 3; blades.add(blade);
    }
    rotor.add(named(cylinderY(0.036, -0.012, 0.008, M.gun, 24, 0.032), 'hub'));
    const spinner = named(new THREE.Mesh(new THREE.SphereGeometry(0.022, 20, 10, 0, Math.PI * 2, 0, HALF_PI), M.silver), 'spinner');
    spinner.position.y = 0.008; rotor.add(spinner);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(MAV_DIMENSIONS.rotorRadius + 0.005, 48), M.blur);
    disc.name = 'rotor-blur'; disc.rotation.x = -HALF_PI; disc.position.y = 0.002; rotor.add(disc);
    rotors.push({ rotor, blades, disc, dir, omega: 0, fault: false });
  }

  // ---- landing gear: a rail along each flat side of the hull (the long bars in the
  // top view), with an angled leg dropping outward from each rail end (front view)
  const gear = new THREE.Group(); gear.name = 'landing-gear'; body.add(gear);
  const RAIL_X = 0.43, RAIL_Y = -0.105, RAIL_Z = 0.40;
  for (const sx of [-1, 1]) {
    gear.add(named(tube(new V3(sx * RAIL_X, RAIL_Y, -RAIL_Z - 0.05), new V3(sx * RAIL_X, RAIL_Y, RAIL_Z + 0.05), 0.013, M.carbon), 'rail'));
    for (const sz of [-1, 1]) {
      const mount = named(new THREE.Mesh(new RoundedBoxGeometry(0.09, 0.03, 0.04, 2, 0.008), M.gun), 'rail-mount');
      mount.position.set(sx * 0.38, -0.09, sz * 0.22); gear.add(mount);
      const top = new V3(sx * RAIL_X, RAIL_Y, sz * RAIL_Z);
      const foot = new V3(sx * 0.60, MAV_DIMENSIONS.footY, sz * 0.44);
      gear.add(named(tube(top, foot, 0.016, M.carbon), 'leg'));
      const knuckle = named(new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), M.gun), 'leg-knuckle');
      knuckle.position.copy(top); gear.add(knuckle);
      const pad = named(new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 12), M.rubber), 'foot');
      pad.scale.set(1, 0.85, 1); pad.position.copy(foot); gear.add(pad);
      gear.add(named(tube(foot.clone().lerp(top, 0.06), foot.clone().lerp(top, 0.1), 0.021, M.gun), 'foot-collar'));
    }
  }

  // ---- state + API
  const state = { rpm: 0, target: 0, alert: false, t: 0 };
  const ledColor = new THREE.Color();

  function update(dt) {
    state.t += dt;
    state.rpm += (state.target - state.rpm) * (1 - Math.exp(-dt * 2.5));
    const omega = state.rpm * 34;                       // visual rad/s
    const blur = THREE.MathUtils.smoothstep(state.rpm, 0.35, 0.8);
    M.blade.opacity = 1 - 0.8 * blur;
    M.blur.opacity = 0.9 * blur;
    for (const r of rotors) {
      const target = r.fault ? 0 : omega;              // a faulted rotor spins down
      r.omega += (target - r.omega) * (1 - Math.exp(-dt * (r.fault ? 2 : 6)));
      r.rotor.rotation.y += r.dir * r.omega * dt;
      r.disc.visible = !r.fault;
    }
    scan.rotation.z += dt * 5;                           // LiDAR scan line sweeps the window
    const pulse = 1.6 + 0.8 * Math.sin(state.t * (state.alert ? 10 : 3));
    M.led.emissiveIntensity = pulse;
  }

  return {
    object: root,
    body,
    parts: { hull, lidar, camera: cam, avionics: box, node, nodeRing, gear, rotors, leds },
    materials: M,
    dimensions: MAV_DIMENSIONS,
    get rpm() { return state.rpm; },
    setRPM(v) { state.target = clamp(v, 0, 1); },
    setAttitude(pitch = 0, roll = 0, yaw = 0) { body.rotation.set(pitch, yaw, roll); },
    /** Stop one rotor (0–5) and turn its LED orange; null restores all. */
    setRotorFault(k = null) {
      rotors.forEach((r, i) => { r.fault = i === k; leds[i].material = r.fault ? M.ledFault : M.led; });
    },
    setAlert(on) {
      state.alert = !!on;
      ledColor.setHex(on ? MAV_COLORS.orange : MAV_COLORS.cyan);
      M.led.color.copy(ledColor); M.led.emissive.copy(ledColor);
    },
    update,
    dispose() {
      root.traverse((o) => o.geometry && o.geometry.dispose());
      Object.values(M).forEach((m) => m.dispose());
      Object.values(tex).forEach((t) => t.dispose());
    },
  };
}
