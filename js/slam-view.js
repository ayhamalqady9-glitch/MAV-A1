// SLAM 3D map window: a second, small 3D view (its own canvas and renderer) that shows the map
// MAV-A1 is building, the way a ground station would: the accumulated LiDAR point cloud coloured by
// height (turbo), the OctoMap occupancy voxels, the pose graph / trajectory, the relay nodes and the
// vehicle's current pose, seen from a slowly orbiting 3/4 view. It shares the cave's geometry buffers
// (each renderer uploads its own copy), so every point here is a point in the main scene.
import * as THREE from 'three';

const V3 = THREE.Vector3;
const TURBO = /* glsl */`
vec3 turbo(float x){ x = clamp(x, 0.0, 1.0); vec4 v4 = vec4(1.0, x, x*x, x*x*x); vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4, vec4(0.1357,4.6154,-42.6603,132.1311)) + dot(v2, vec2(-152.9424,59.2864)),
    dot(v4, vec4(0.0914,2.1942,4.8430,-14.1850)) + dot(v2, vec2(4.2773,2.8296)),
    dot(v4, vec4(0.1067,12.6419,-60.5820,110.3628)) + dot(v2, vec2(-89.9031,27.3482))), 0.0, 1.0); }`;

export function createSlamView({ canvas, cave, mobile = false, footprint = null }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x03070f);
  const camera = new THREE.PerspectiveCamera(38, 1.6, 0.5, 3000);

  // ---- accumulated point cloud (shared buffers), revealed up to the mapped distance
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: { uMapped: { value: 0 }, uPx: { value: renderer.getPixelRatio() }, uVeh: { value: new V3() }, uTime: { value: 0 } },
    vertexShader: `attribute float aS, aH; uniform float uMapped, uPx, uTime; uniform vec3 uVeh; varying float vA, vH, vFresh, vDepth, vLive;
      void main(){ vA = step(aS, uMapped); vH = aH; vFresh = exp(-max(uMapped - aS, 0.0) * 90.0) * vA;
        float d = distance(position, uVeh);
        vLive = (1.0 - smoothstep(5.0, 13.0, d)) * vA * (0.6 + 0.4 * sin(uTime * 6.0 - d * 0.9));   // the scan happening now
        vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        vDepth = smoothstep(25.0, 220.0, -mv.z);
        gl_PointSize = uPx * clamp(260.0 / -mv.z, 1.2, 3.4); }`,
    fragmentShader: `uniform float uMapped; varying float vA, vH, vFresh, vDepth, vLive; ${TURBO}
      void main(){ if (vA < 0.5 || vH > 0.66) discard;                                    // roof cut away to see inside
        vec2 c = gl_PointCoord - 0.5; float r = dot(c, c); if (r > 0.25) discard;
        vec3 col = turbo(0.08 + vH * 1.25);
        col *= mix(1.0, 0.38, vDepth);                                                     // depth cue (eye-dome style)
        col *= 1.0 - 0.45 * smoothstep(0.12, 0.25, r);                                     // dark rim gives every point a shape
        col = mix(col, vec3(1.0), vFresh * 0.55);
        col = mix(col, vec3(0.7, 1.0, 1.0), clamp(vLive, 0.0, 1.0) * 0.75);
        gl_FragColor = vec4(col, 1.0); }`,
  });
  const cloud = new THREE.Points(cave.cloudGeo, cloudMat); cloud.frustumCulled = false;
  scene.add(cloud);

  // ---- OctoMap voxels (shared instance buffer), height-coloured, translucent
  const voxMat = new THREE.ShaderMaterial({
    uniforms: { uMapped: { value: 0 }, uOpacity: { value: 0.22 } },
    vertexShader: `attribute float aS, aH; uniform float uMapped; varying float vOn, vH;
      void main(){ vOn = step(aS, uMapped - 0.004) * step(aH, 0.66); vH = aH; vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uOpacity; varying float vOn, vH; ${TURBO}
      void main(){ if (vOn < 0.5) discard; gl_FragColor = vec4(turbo(0.08 + vH * 1.25), uOpacity); }`,
    transparent: true, depthWrite: false,
  });
  const vox = new THREE.InstancedMesh(cave.voxels.geometry, voxMat, cave.voxCount);
  vox.instanceMatrix = cave.voxels.instanceMatrix; vox.frustumCulled = false;
  scene.add(vox);

  // ---- trajectory (pose graph): white line along the flown path, keyframe dots, backtrack in cyan
  const TN = 600, tp = new Float32Array(TN * 3);
  for (let i = 0; i < TN; i++) { const f = cave.frame(i / (TN - 1)); const p = f.P.clone().addScaledVector(f.up, 0.6); tp.set([p.x, p.y, p.z], i * 3); }
  const trajGeo = new THREE.BufferGeometry(); trajGeo.setAttribute('position', new THREE.BufferAttribute(tp, 3));
  const traj = new THREE.Line(trajGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
  const keys = new THREE.Points(trajGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 3, sizeAttenuation: false }));
  const backGeo = new THREE.BufferGeometry(); backGeo.setAttribute('position', trajGeo.attributes.position);
  const back = new THREE.Line(backGeo, new THREE.LineBasicMaterial({ color: 0x00e0ff }));
  back.position.y = 0.4;
  scene.add(traj, keys, back);

  // ---- vehicle pose: arrow + ring; relay nodes
  const pose = new THREE.Group();
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(1.1, 3.2, 3), new THREE.MeshBasicMaterial({ color: 0x00e0ff }));
  arrow.rotation.x = Math.PI / 2;
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.6, 40), new THREE.MeshBasicMaterial({ color: 0x00e0ff, transparent: true, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  pose.add(arrow, ring); scene.add(pose);
  const nodeMeshes = cave.nodes.map((n) => {
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(1.1), new THREE.MeshBasicMaterial({ color: 0xff7a3d }));
    m.position.copy(n.rest); scene.add(m); return m;
  });
  // the planned outpost's footprint, once the site is qualified
  let hab = null;
  if (footprint) {
    const pts = footprint.map((p) => p.clone().add(new V3(0, 0.4, 0)));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]), new THREE.LineBasicMaterial({ color: 0x9ff6ff, transparent: true }));
    const fill = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]]),
      new THREE.MeshBasicMaterial({ color: 0x00e0ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    hab = new THREE.Group(); hab.add(line, fill); hab.visible = false; scene.add(hab);
  }
  const grid = new THREE.GridHelper(600, 120, 0x1b3a5c, 0x0c1a2c);
  grid.position.set(-2, -16, -130); scene.add(grid);
  scene.fog = new THREE.Fog(0x03070f, 120, 420);
  const scaleBar = canvas.parentElement.querySelector('.slam-bar i');

  const target = new V3(), want = new V3(), camPos = new V3();
  let w = 0, h = 0, first = true;
  function size() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || (r.width === w && r.height === h)) return;
    w = r.width; h = r.height;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  /**
   * @param {object} st  mapped (0..1 of the tube), s (vehicle position on the path), heading yaw,
   *                     backtrack [a, b] path range or null, overview 0..1 (pull back to the whole map), time
   */
  function render({ mapped, s, yaw = 0, backtrack = null, overview = 0, time = 0, nodesUp = 0, habitat = 0 }) {
    if (hab) { hab.visible = habitat > 0.01; hab.children[0].material.opacity = habitat * (0.7 + 0.3 * Math.sin(time * 3)); hab.children[1].material.opacity = habitat * 0.18; }
    size();
    if (!w) return;
    cloudMat.uniforms.uMapped.value = mapped; voxMat.uniforms.uMapped.value = mapped;
    const n = Math.max(2, Math.round(Math.min(s, mapped) * (TN - 1)) + 1);
    const a = Math.round(0.03 * (TN - 1));                 // the pose graph starts under the skylight
    trajGeo.setDrawRange(a, Math.max(2, n - a));
    keys.geometry.setDrawRange(a, Math.max(2, n - a));
    if (backtrack) { const b0 = Math.round(backtrack[0] * (TN - 1)), b1 = Math.round(backtrack[1] * (TN - 1)); back.visible = true; backGeo.setDrawRange(Math.min(b0, b1), Math.abs(b1 - b0) + 1); }
    else back.visible = false;
    const f = cave.frame(Math.min(1, Math.max(0, s)));
    pose.position.copy(f.P).addScaledVector(f.up, 0.6);
    pose.rotation.y = yaw;
    ring.scale.setScalar(1 + 0.25 * Math.sin(time * 4));
    nodeMeshes.forEach((m, i) => { m.visible = s >= cave.nodes[i].s + 0.004 || nodesUp > i; m.rotation.y = time; });

    cloudMat.uniforms.uVeh.value.copy(pose.position); cloudMat.uniforms.uTime.value = time;
    // camera: a chase view behind and above the vehicle, looking down the tunnel it is mapping;
    // for the overview it lifts away and slowly circles the whole map
    const T = f.T.clone().setY(0).normalize(), side = new V3(-T.z, 0, T.x);
    const chaseTarget = pose.position.clone().addScaledVector(T, 14);
    const chasePos = pose.position.clone().addScaledVector(T, -30).addScaledVector(side, 9).add(new V3(0, 22, 0));
    const mid = cave.frame(0.42).P, az = time * 0.08 + 0.6;
    const overPos = mid.clone().add(new V3(Math.sin(az) * 170, 190, Math.cos(az) * 170));
    want.copy(chaseTarget).lerp(mid, overview);
    camPos.copy(chasePos).lerp(overPos, overview);
    if (first) { target.copy(want); camera.position.copy(camPos); first = false; }
    target.lerp(want, 0.12); camera.position.lerp(camPos, 0.12);
    camera.lookAt(target);
    // scale bar: how many pixels 10 m spans at the vehicle's distance
    if (scaleBar) {
      const d = camera.position.distanceTo(target), px = (10 / (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * h;
      scaleBar.style.width = `${Math.max(8, Math.min(140, px)).toFixed(0)}px`;
    }
    renderer.render(scene, camera);
  }
  return { render, renderer };
}
