// A living Martian surface (ambient, wall-clock animation; nothing here changes the story):
//   · saltation: sand grains hopping downwind a few centimetres above the ground, with faint dust streamers
//   · rotor downwash: when MAV-A1 flies close to the ground its six rotors push a ring of dust outward
//   · rockfall: small stones break off the skylight's rim now and then and fall down the shaft walls,
//     trailing dust, under Mars gravity (3.71 m/s²: a 50 m drop takes ~5 s)
//   · gusts: sheets of dust lifted by the wind sweep across the plain, more and faster as the storm nears
// Ground height comes from a small height texture baked from the terrain, so particles sit on the ground.
import * as THREE from 'three';

const V3 = THREE.Vector3;
const G = 3.71;

export function createEnvironment({ surface, cave, groundY, mobile = false, pixelRatio = 1 }) {
  // ---- terrain height texture (240 m square around the pit and the lander)
  const P0 = surface.pitCenter, L0 = surface.landerPos;
  const C = new V3((P0.x + L0.x) / 2, 0, (P0.z + L0.z) / 2), SIZE = 240, RES = mobile ? 128 : 192;
  const hd = new Float32Array(RES * RES);
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const x = C.x + ((i + 0.5) / RES - 0.5) * SIZE, z = C.z + ((j + 0.5) / RES - 0.5) * SIZE;
    hd[j * RES + i] = surface.height(x, z);
  }
  const hTex = new THREE.DataTexture(hd, RES, RES, THREE.RedFormat, THREE.FloatType);
  hTex.minFilter = hTex.magFilter = THREE.NearestFilter; hTex.needsUpdate = true;
  const hRect = new THREE.Vector4(C.x, C.z, SIZE, 0);
  const GLSL_H = /* glsl */`uniform sampler2D uHeight; uniform vec4 uHRect;
    float groundAt(vec2 xz){ vec2 uv = (xz - uHRect.xy) / uHRect.z + 0.5; return texture2D(uHeight, clamp(uv, 0.0, 1.0)).r; }`;
  const group = new THREE.Group(); group.name = 'environment';

  // ---- saltation + dust streamers
  const NS = mobile ? 7000 : 22000, sa = new Float32Array(NS * 3);
  for (let i = 0; i < NS; i++) sa.set([Math.random(), Math.random(), Math.random()], i * 3);
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NS * 3), 3));
  sg.setAttribute('aSeed', new THREE.BufferAttribute(sa, 3));
  const saltMat = new THREE.ShaderMaterial({
    uniforms: { uHeight: { value: hTex }, uHRect: { value: hRect }, uTime: { value: 0 }, uCenter: { value: new V3() }, uOpacity: { value: 0 },
      uWind: { value: surface.wind ? surface.wind.clone() : new THREE.Vector2(0.88, 0.47) }, uSpeed: { value: 6.5 }, uTop: { value: 0 }, uBox: { value: 60 }, uPx: { value: pixelRatio }, uLight: { value: 1 } },
    vertexShader: `attribute vec3 aSeed; uniform float uTime, uSpeed, uBox, uPx, uTop; uniform vec3 uCenter; uniform vec2 uWind; varying float vA, vBig; ${GLSL_H}
      void main(){
        float big = step(0.8, aSeed.z);                                            // soft dust streamers among the grains
        float sp = uSpeed * (0.55 + 0.6 * aSeed.z) * mix(1.0, 1.6, big);
        vec2 o = uCenter.xz - uBox * 0.5;
        vec2 xz = o + mod(aSeed.xy * uBox + uWind * uTime * sp - o, uBox);       // wraps round the camera's subject
        float hopF = 2.4 + 3.0 * fract(aSeed.z * 13.7);
        float hop = abs(sin(uTime * hopF + aSeed.z * 41.0)) * mix(0.04 + 0.42 * aSeed.z * aSeed.z, 0.2 + 0.6 * fract(aSeed.x * 7.0), big);
        vec3 p = vec3(xz.x, groundAt(xz) + 0.02 + hop, xz.y);
        float d = length(xz - uCenter.xz) / (uBox * 0.5);
        vA = (1.0 - smoothstep(0.65, 1.0, d)) * mix(1.0, 0.3 * (1.0 - uTop), big);   // streamers seen from above read as blobs: hide them
        vBig = big;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = uPx * mix(clamp(18.0 / -mv.z, 1.2, 4.0), clamp(240.0 / -mv.z, 4.0, 64.0), big); }`,
    fragmentShader: `uniform float uOpacity, uLight; varying float vA, vBig; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
        float a = mix(1.0, pow(1.0 - d * 4.0, 2.0), vBig);
        gl_FragColor = vec4(mix(vec3(0.34, 0.22, 0.15), vec3(0.55, 0.37, 0.26), vBig) * uLight, a * vA * uOpacity); }`,
    transparent: true, depthWrite: false,
  });
  const salt = new THREE.Points(sg, saltMat); salt.frustumCulled = false; salt.name = 'saltation'; group.add(salt);

  // ---- wind gusts: dust sheets sweeping across the plain (soft, wispy, ground-hugging)
  const NG = mobile ? 60 : 150, ga = new Float32Array(NG * 3);
  for (let i = 0; i < NG; i++) ga.set([Math.random(), Math.random(), Math.random()], i * 3);
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NG * 3), 3));
  gg.setAttribute('aSeed', new THREE.BufferAttribute(ga, 3));
  const gustMat = new THREE.ShaderMaterial({
    uniforms: { uHeight: { value: hTex }, uHRect: { value: hRect }, uTime: { value: 0 }, uCenter: { value: new V3() }, uStorm: { value: 0 }, uOpacity: { value: 0 },
      uWind: { value: saltMat.uniforms.uWind.value }, uBox: { value: 230 }, uPx: { value: pixelRatio }, uLight: { value: 1 }, uProj: { value: 1000 }, uTop: { value: 0 } },
    vertexShader: `attribute vec3 aSeed; uniform float uTime, uBox, uPx, uStorm, uProj; uniform vec3 uCenter; uniform vec2 uWind; varying float vA; varying vec2 vS; ${GLSL_H}
      void main(){
        float sp = (6.0 + 6.0 * aSeed.z) * (0.7 + 0.8 * uStorm);
        vec2 o = uCenter.xz - uBox * 0.5;
        vec2 xz = o + mod(aSeed.xy * uBox + uWind * uTime * sp - o, uBox);
        float size = 9.0 + 22.0 * aSeed.z;
        vec3 p = vec3(xz.x, groundAt(xz) + size * 0.22 + 0.4, xz.y);
        float d = length(xz - uCenter.xz) / (uBox * 0.5);
        float life = fract(uTime * (0.05 + 0.04 * aSeed.y) + aSeed.x * 7.0);            // each sheet rises, drifts, settles
        vA = (1.0 - smoothstep(0.55, 1.0, d)) * smoothstep(0.0, 0.25, life) * (1.0 - smoothstep(0.6, 1.0, life));
        vS = aSeed.xy * 31.0 + vec2(life * 1.7, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uPx * size * uProj / -mv.z, 2.0, 280.0 * uPx); }`,
    fragmentShader: `uniform float uOpacity, uLight, uStorm, uTop; varying float vA; varying vec2 vS;
      float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float gn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(gh(i), gh(i + vec2(1, 0)), f.x), mix(gh(i + vec2(0, 1)), gh(i + vec2(1, 1)), f.x), f.y); }
      void main(){
        vec2 c = gl_PointCoord - 0.5; c.y *= 1.9;                                     // flattened: sheets, not balls
        float r = length(c) * 2.0; if (r > 1.0 || vA < 0.003) discard;
        vec2 q = gl_PointCoord * 3.2 + vS;
        float n = gn(q) * 0.55 + gn(q * 2.3 + 4.1) * 0.3 + gn(q * 5.1 - 2.0) * 0.15;     // wispy
        float a = (1.0 - smoothstep(0.25, 1.0, r)) * smoothstep(0.3, 0.75, n) * vA * uOpacity * (0.06 + 0.13 * uStorm) * (1.0 - uTop);
        gl_FragColor = vec4(vec3(0.4, 0.22, 0.12) * uLight, a); }`,
    transparent: true, depthWrite: false,
  });
  const gusts = new THREE.Points(gg, gustMat); gusts.frustumCulled = false; gusts.name = 'gusts'; group.add(gusts);

  // ---- rotor downwash ring
  const ND = mobile ? 900 : 2600, da = new Float32Array(ND * 3);
  for (let i = 0; i < ND; i++) da.set([Math.random(), Math.random() * Math.PI * 2, Math.random()], i * 3);
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ND * 3), 3));
  dg.setAttribute('aSeed', new THREE.BufferAttribute(da, 3));
  const washMat = new THREE.ShaderMaterial({
    uniforms: { uHeight: { value: hTex }, uHRect: { value: hRect }, uTime: { value: 0 }, uCenter: { value: new V3() }, uStrength: { value: 0 }, uPx: { value: pixelRatio }, uLight: { value: 1 } },
    vertexShader: `attribute vec3 aSeed; uniform float uTime, uStrength, uPx; uniform vec3 uCenter; varying float vA; ${GLSL_H}
      void main(){
        float age = fract(uTime * (0.45 + 0.25 * aSeed.z) + aSeed.x);
        float r = 0.8 + age * (4.5 + 4.0 * aSeed.z);
        float a = aSeed.y + age * 0.6;                                             // a little swirl as it spreads
        vec2 xz = uCenter.xz + vec2(cos(a), sin(a)) * r;
        float y = groundAt(xz) + 0.08 + sin(age * 3.14159) * (0.25 + 0.9 * aSeed.z) * (1.0 - 0.4 * age);
        vA = (1.0 - age) * smoothstep(0.0, 0.12, age) * uStrength;
        vec4 mv = modelViewMatrix * vec4(xz.x, y, xz.y, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = uPx * clamp((90.0 + 120.0 * aSeed.z) / -mv.z, 2.0, 60.0); }`,
    fragmentShader: `uniform float uLight; varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25 || vA < 0.005) discard;
        gl_FragColor = vec4(vec3(0.47, 0.32, 0.22) * uLight, pow(1.0 - d * 4.0, 2.0) * vA * 0.3); }`,
    transparent: true, depthWrite: false,
  });
  const wash = new THREE.Points(dg, washMat); wash.frustumCulled = false; wash.name = 'downwash'; group.add(wash);

  // ---- rockfall down the skylight shaft
  const sc = cave.shaftCenter, NR = mobile ? 14 : 34, TOP = groundY - 2.2, BOTTOM = 6;
  const stoneGeo = new THREE.IcosahedronGeometry(1, 1);
  const sp = stoneGeo.attributes.position;
  for (let i = 0; i < sp.count; i++) { const v = new V3().fromBufferAttribute(sp, i); v.multiplyScalar(0.75 + 0.5 * Math.abs(Math.sin(v.x * 5.1 + v.y * 3.3 + v.z * 7.7))); sp.setXYZ(i, v.x, v.y, v.z); }
  stoneGeo.computeVertexNormals();
  const stones = new THREE.InstancedMesh(stoneGeo, new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 0.95 }), NR);
  stones.castShadow = false; stones.frustumCulled = false; group.add(stones);
  const rocks = Array.from({ length: NR }, (_, i) => ({ period: 4 + Math.random() * 7, phase: Math.random() * 20, size: 0.07 + Math.random() * 0.28, seed: i * 17.3 }));
  const TR = 7, trail = new Float32Array(NR * TR * 3), trailA = new Float32Array(NR * TR);
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(trail, 3)); tg.setAttribute('aA', new THREE.BufferAttribute(trailA, 1));
  const trailMat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: pixelRatio }, uLight: { value: 1 } },
    vertexShader: 'attribute float aA; uniform float uPx; varying float vA; void main(){ vA = aA; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = uPx * clamp(60.0 / -mv.z, 1.5, 22.0); }',
    fragmentShader: 'uniform float uLight; varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25 || vA < 0.01) discard; gl_FragColor = vec4(vec3(0.5, 0.35, 0.24) * uLight, pow(1.0 - d * 4.0, 2.0) * vA * 0.35); }',
    transparent: true, depthWrite: false,
  });
  const trails = new THREE.Points(tg, trailMat); trails.frustumCulled = false; group.add(trails);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s3 = new V3();
  const hash = (x) => { const s = Math.sin(x * 127.1) * 43758.5453; return s - Math.floor(s); };
  const fallT = Math.sqrt((2 * (TOP - BOTTOM)) / G);
  function stoneAt(r, t) {
    const cyc = Math.floor((t + r.phase) / r.period), tt = ((t + r.phase) % r.period) - 0.6;   // 0.6 s: it slips off the rim first
    const ang = hash(r.seed + cyc) * Math.PI * 2, rad = 5.7 + hash(r.seed + cyc + 0.5) * 0.6;
    const y = tt < 0 ? TOP + 0.4 * (-tt) : TOP - 0.5 * G * tt * tt;
    const wob = Math.sin(tt * 9 + r.seed) * 0.12 * Math.min(1, Math.max(0, tt));             // ticks off the wall
    return { p: new V3(sc.x + Math.cos(ang) * (rad + wob), y, sc.z + Math.sin(ang) * (rad + wob)), live: tt < fallT && y > BOTTOM, tt };
  }

  function update({ time, focus, surfaceK = 0, light = 1, drone = null, rpm = 0, shaftK = 0, storm = 0, proj = 1000, top = 0 }) {
    saltMat.uniforms.uTop.value = top; gustMat.uniforms.uTop.value = top;
    // saltation follows whatever the camera is looking at, in daylight on the surface; the storm whips it up
    saltMat.uniforms.uTime.value = time; saltMat.uniforms.uOpacity.value = surfaceK * (0.8 + 0.5 * storm); saltMat.uniforms.uLight.value = light;
    saltMat.uniforms.uSpeed.value = 6.5 * (1 + 0.7 * storm);
    if (focus) saltMat.uniforms.uCenter.value.copy(focus);
    salt.visible = surfaceK > 0.01;
    gustMat.uniforms.uTime.value = time; gustMat.uniforms.uOpacity.value = surfaceK; gustMat.uniforms.uLight.value = light;
    gustMat.uniforms.uStorm.value = storm; gustMat.uniforms.uProj.value = proj;
    if (focus) gustMat.uniforms.uCenter.value.copy(focus);
    gusts.visible = surfaceK > 0.01;
    // downwash: strongest near the ground, only with the rotors at speed, never over the open pit
    let k = 0;
    if (drone && surfaceK > 0.01) {
      const agl = drone.y - surface.height(drone.x, drone.z);
      const overPit = Math.hypot(drone.x - P0.x, drone.z - P0.z) < surface.hole * 1.1;
      k = overPit ? 0 : (1 - THREE.MathUtils.smoothstep(agl, 3.5, 9)) * THREE.MathUtils.smoothstep(rpm, 0.3, 0.6) * surfaceK;
      washMat.uniforms.uCenter.value.set(drone.x, 0, drone.z);
    }
    washMat.uniforms.uStrength.value = k; washMat.uniforms.uTime.value = time; washMat.uniforms.uLight.value = light;
    wash.visible = k > 0.01;
    // rockfall
    stones.visible = trails.visible = shaftK > 0.01;
    trailMat.uniforms.uLight.value = light;
    if (stones.visible) {
      rocks.forEach((r, i) => {
        const st = stoneAt(r, time);
        e.set(time * (2 + i), time * 1.3 + i, 0); q.setFromEuler(e);
        m4.compose(st.p, q, s3.setScalar(st.live ? r.size : 0.0001));
        stones.setMatrixAt(i, m4);
        for (let j = 0; j < TR; j++) {
          const pj = stoneAt(r, time - (j + 1) * 0.07);
          trail.set([pj.p.x, pj.p.y, pj.p.z], (i * TR + j) * 3);
          trailA[i * TR + j] = st.live && pj.live && pj.tt > 0 ? (1 - j / TR) * shaftK : 0;
        }
      });
      stones.instanceMatrix.needsUpdate = true;
      tg.attributes.position.needsUpdate = true; tg.attributes.aA.needsUpdate = true;
    }
  }
  return { group, update, salt, wash, stones, washMat, saltMat, gusts, gustMat };
}
