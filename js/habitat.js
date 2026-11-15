// A future outpost, drawn as a hologram where MAV-A1's map says a crew could live: on the flat lava floor
// under a stable roof, near the ice. It assembles piece by piece (bottom-up, a bright build front, scan
// lines, rim glow), then its lights come on and warm the real cave walls. Illustrative concept, at real scale:
// a 6.4 m dome hub, three 10.5 m inflatable modules (3.5 m wide), connecting tunnels, a rover, a power line
// back toward the skylight.
//
// Also the epilogue light: warm light rising out of the skylight at night, as if the base were lit below.
import * as THREE from 'three';

const V3 = THREE.Vector3;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const holoVert = /* glsl */`
  varying vec3 vW, vN, vV;
  void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
    vV = cameraPosition - w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const holoFrag = /* glsl */`
  uniform float uBuild, uOpacity, uTime, uY0, uY1, uEdgeOnly; uniform vec3 uColor;
  varying vec3 vW, vN, vV;
  void main(){
    float h = (vW.y - uY0) / max(uY1 - uY0, 1e-3);
    if (h > uBuild * 1.04 - 0.02) discard;                                  // not built yet
    float front = 1.0 - smoothstep(0.0, 0.05, uBuild * 1.04 - 0.02 - h);     // the bright build front
    float ln = length(vN);                                                  // lines carry no normal
    float fres = ln > 1e-4 ? pow(clamp(1.0 - abs(dot(vN / ln, normalize(vV))), 0.0, 1.0), 2.2) : 0.0;
    float scan = 0.5 + 0.5 * sin(vW.y * 14.0 - uTime * 2.6);
    float a = mix(0.018 + 0.26 * fres + 0.035 * scan, 0.55, uEdgeOnly) + front * 0.8;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), front * 0.75), a * uOpacity * step(0.001, uBuild));
  }`;

export function createHabitat({ cave, s0 = 0.745 }) {
  const f = cave.frame(s0);
  const T = f.T.clone().setY(0).normalize(), side = new V3(-T.z, 0, T.x), UP = new V3(0, 1, 0);
  const floorY = Math.max(cave.surfacePoint(s0, -Math.PI / 2, f).y, cave.surfacePoint(s0, -Math.PI / 2 + 0.2, f).y, cave.surfacePoint(s0, -Math.PI / 2 - 0.2, f).y);
  const C = new V3(f.P.x, floorY + 0.05, f.P.z);
  const group = new THREE.Group(); group.name = 'habitat-hologram'; group.visible = false;
  const parts = [];
  const color = new THREE.Color(0x5fe8ff);

  const makeMat = (edge) => new THREE.ShaderMaterial({
    uniforms: { uBuild: { value: 0 }, uOpacity: { value: 0 }, uTime: { value: 0 }, uY0: { value: 0 }, uY1: { value: 1 }, uEdgeOnly: { value: edge ? 1 : 0 }, uColor: { value: color } },
    vertexShader: holoVert, fragmentShader: holoFrag,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  /** add a piece: geometry, position, orientation (local Y → dir), when it builds [a, b] of the whole sequence */
  function add(geo, pos, dir, a, b) {
    const mesh = new THREE.Mesh(geo, makeMat(false));
    mesh.position.copy(pos);
    if (dir) mesh.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 24), makeMat(true));
    mesh.add(edges);
    group.add(mesh);
    mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(mesh);
    for (const m of [mesh.material, edges.material]) { m.uniforms.uY0.value = bb.min.y; m.uniforms.uY1.value = bb.max.y; }
    parts.push({ mats: [mesh.material, edges.material], a, b });
    return mesh;
  }

  // hub: a low dome on a ring footing
  add(new THREE.CylinderGeometry(3.4, 3.5, 0.35, 48, 1), C.clone().add(new V3(0, 0.17, 0)), null, 0.0, 0.08);
  add(new THREE.SphereGeometry(3.2, 48, 18, 0, Math.PI * 2, 0, Math.PI / 2), C.clone().add(new V3(0, 0.35, 0)), null, 0.04, 0.22);
  // two inflatable modules along the tube (it is ~17 m wide at the floor), joined to the hub by short tunnels,
  // and a narrower greenhouse module alongside, linked by its own tunnel
  const mods = [T, T.clone().negate()];
  mods.forEach((d, i) => {
    const a = 0.16 + i * 0.14;
    const centre = C.clone().addScaledVector(d, 3.2 + 1.2 + 5.25).add(new V3(0, 1.95, 0));
    add(new THREE.CapsuleGeometry(1.75, 7, 10, 32), centre, d, a, a + 0.18);
    add(new THREE.CylinderGeometry(0.85, 0.85, 2.6, 24, 1, true), C.clone().addScaledVector(d, 3.6).add(new V3(0, 1.3, 0)), d, a - 0.02, a + 0.06);
    for (const k of [-2.6, 2.6]) add(new THREE.BoxGeometry(3.0, 0.25, 0.3), centre.clone().addScaledVector(d, k).add(new V3(0, -1.75, 0)), null, a - 0.02, a + 0.04);
  });
  const gh = C.clone().addScaledVector(T, 8.8).addScaledVector(side, 4.5).add(new V3(0, 1.6, 0));
  add(new THREE.CapsuleGeometry(1.4, 5.6, 10, 28), gh, T, 0.44, 0.58);
  add(new THREE.CylinderGeometry(0.7, 0.7, 1.6, 20, 1, true), C.clone().addScaledVector(T, 7.2).addScaledVector(side, 2.55).add(new V3(0, 1.6, 0)), side, 0.44, 0.5);
  // a pressurised rover parked by the hub, and a mast
  const rov = C.clone().addScaledVector(side, -6.2).addScaledVector(T, 2.5);
  add(new THREE.BoxGeometry(1.8, 1.3, 3.2), rov.clone().add(new V3(0, 1.15, 0)), T, 0.6, 0.7);
  for (const [x, z] of [[-0.95, -1.1], [0.95, -1.1], [-0.95, 1.1], [0.95, 1.1]]) {
    add(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 20), rov.clone().addScaledVector(side, x).addScaledVector(T, z).add(new V3(0, 0.45, 0)), side, 0.6, 0.66);
  }
  add(new THREE.CylinderGeometry(0.035, 0.035, 5.5, 6), C.clone().addScaledVector(side, 2.4).addScaledVector(T, -2.0).add(new V3(0, 2.75, 0)), null, 0.62, 0.74);

  // footprint on the floor (also drawn on the SLAM map)
  const fp = [[-15.5, -7.6], [15.5, -7.6], [15.5, 6.6], [-15.5, 6.6]].map(([t, s]) => C.clone().addScaledVector(T, t).addScaledVector(side, s).add(new V3(0, 0.06, 0)));
  const fpGeo = new THREE.BufferGeometry().setFromPoints([...fp, fp[0]]);
  const fpMat = makeMat(true); fpMat.uniforms.uY0.value = C.y - 1; fpMat.uniforms.uY1.value = C.y + 1;
  const footprint = new THREE.Line(fpGeo, fpMat); group.add(footprint);
  parts.push({ mats: [fpMat], a: 0, b: 0.02 });
  // power and comms line back toward the skylight, along the floor
  const pl = [];
  for (let i = 0; i <= 80; i++) { const s = s0 - (i / 80) * 0.12, ff = cave.frame(s); const p = cave.surfacePoint(s, -Math.PI / 2 + 0.55, ff).lerp(ff.P, 0.04); pl.push(p); }
  const plMat = makeMat(true); plMat.uniforms.uY0.value = C.y - 30; plMat.uniforms.uY1.value = C.y + 30;
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pl), plMat));
  parts.push({ mats: [plMat], a: 0.7, b: 0.85 });

  // windows + warm interior light, switched on when the base is complete
  const winMat = new THREE.MeshBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const windows = [...mods.map((d) => [C.clone().addScaledVector(d, 9.65), d, 1.78, 2.25]), [gh.clone().setY(C.y), T, 1.43, 1.85]];
  windows.forEach(([c0, d, r, y]) => {
    const n = new V3(-d.z, 0, d.x);
    for (const k of [-2.4, 0, 2.4]) for (const sgn of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.35), winMat);
      w.position.copy(c0).addScaledVector(d, k).addScaledVector(n, sgn * r).add(new V3(0, y, 0));
      w.lookAt(w.position.clone().addScaledVector(n, sgn));
      group.add(w);
    }
  });
  const light = new THREE.PointLight(0xffb36b, 0, 38, 1.4);
  light.position.copy(C).add(new V3(0, 4.5, 0));
  const lightGroup = new THREE.Group(); lightGroup.add(light);              // stays in the scene (light count fixed)

  // ---- epilogue: warm light rising out of the skylight at night
  const sc = cave.shaftCenter;
  const pitLight = new THREE.PointLight(0xffa860, 0, 60, 1.5);
  pitLight.position.set(sc.x, 40, sc.z);
  lightGroup.add(pitLight);
  const colMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 } },
    vertexShader: 'varying float vY; varying vec3 vN, vV; void main(){ vY = uv.y; vec4 w = modelMatrix * vec4(position, 1.0); vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform float uOpacity, uTime; varying float vY; varying vec3 vN, vV;
      void main(){ float y = clamp(vY, 0.0, 1.0); float ln = length(vN); float edge = ln > 1e-4 ? pow(abs(dot(vN / ln, normalize(vV))), 1.6) : 0.0;
        float flick = 0.92 + 0.08 * sin(uTime * 1.3 + y * 6.0);
        gl_FragColor = vec4(vec3(1.0, 0.7, 0.42), edge * pow(1.0 - y, 2.6) * smoothstep(0.0, 0.1, y) * uOpacity * 0.13 * flick); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const column = new THREE.Mesh(new THREE.CylinderGeometry(11, 6.6, 70, 40, 1, true), colMat);
  column.geometry.translate(0, 35, 0);
  column.position.set(sc.x, 38, sc.z); column.visible = false; column.name = 'skylight-glow';

  function update({ build = 0, opacity = 0, lights = 0, time = 0, epilogue = 0 }) {
    group.visible = opacity > 0.01;
    if (group.visible) for (const p of parts) {
      const b = smooth(p.a, p.b, build);
      for (const m of p.mats) { m.uniforms.uBuild.value = b; m.uniforms.uOpacity.value = opacity * (1 - 0.45 * lights); m.uniforms.uTime.value = time; }
    }
    winMat.opacity = lights * opacity;
    light.intensity = 90 * lights * opacity;
    pitLight.intensity = 520 * epilogue;
    column.visible = epilogue > 0.01;
    colMat.uniforms.uOpacity.value = epilogue; colMat.uniforms.uTime.value = time;
  }
  return { group, lightGroup, column, update, center: C, footprint: fp, frameT: T, side };
}
