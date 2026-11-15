// PROJECT MAV-A1: scroll-driven mission story.
// Everything visual is a function of scroll progress p ∈ [0, 1] (scrolling back reverses it);
// only ambient loops (rotor spin, star twinkle, dust, laser sweep, node pulses) use wall-clock time.
//
// Sequence: mission video → globe/Tharsis targeting → entry past Olympus Mons → HiRISE target
// (no dive into the crater) → ONE continuous 3D world: the lander sets down beside the skylight,
// MAV-A1 takes off and flies to it, descends the shaft into the lava tube, maps it (LiDAR / SLAM /
// VANGUARD-AI), flies home, docks and recharges → MISSION SUCCESSFUL. All text lives in the 30% panel.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { createMAVA1, MAV_DIMENSIONS } from './mav-a1-model.js';
import { Plate, ZoomChain, zoomBetween, createStars } from './plates.js';
import { createCave, CAVE } from './cave.js';
import { createSurface } from './surface.js';
import { createSlamView } from './slam-view.js';
import { DETAIL, SCAN, PHOTO } from './rock-material.js';
import { createAudio } from './audio.js';
import { createCvFeed } from './cv-feed.js';
import { createHabitat } from './habitat.js';
import { createEnvironment } from './environment.js';
import { renderCruiseSprite } from './cruise-stage.js';
import { mergeStatic } from './merge-static.js';

// ------------------------------------------------------------------ helpers
const $ = (s) => document.querySelector(s);
const V3 = THREE.Vector3;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const range = (x, a, b) => clamp((x - a) / (b - a));
const smooth = (a, b, x) => { const t = range(x, a, b); return t * t * (3 - 2 * t); };
const ease = (t) => t * t * (3 - 2 * t);
const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const bump = (x, a, peak, b) => (x < peak ? smooth(a, peak, x) : 1 - smooth(peak, b, x));
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isNarrow = () => innerWidth < 760;
const MOBILE = isNarrow() || matchMedia('(pointer: coarse)').matches;
const UPV = new V3(0, 1, 0);

// ------------------------------------------------------------------ stage timeline (vh lengths)
const STAGES = [
  [1, 'Orbital approach', 160], [2, 'Entry & landing', 140], [3, 'MAV-A1 launch', 130], [4, 'Skylight descent', 120],
  [5, 'LiDAR-SLAM mapping', 110], [6, 'Autonomous navigation', 120], [7, 'Breadcrumb network', 190],
  [8, 'Habitat analysis', 150], [9, 'Return & recharge', 150], [10, 'Mission successful', 150],
];
const TOTAL = STAGES.reduce((a, s) => a + s[2], 0);
const ST = (() => { let acc = 0; return STAGES.map(([id, name, vh]) => { const s = { id, name, start: acc / TOTAL, end: (acc + vh) / TOTAL }; acc += vh; return s; }); })();
const P = (id, t) => ST[id - 1].start + t * (ST[id - 1].end - ST[id - 1].start);
const stageOf = (p) => { const i = ST.findIndex((s) => p < s.end); return i < 0 ? ST.length - 1 : i; };
function keyed(p, keys) {
  if (p <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (p <= keys[i][0]) {
    const [p0, v0] = keys[i - 1], [p1, v1] = keys[i];
    return lerp(v0, v1, (p - p0) / (p1 - p0 || 1));
  }
  return keys[keys.length - 1][1];
}

// ------------------------------------------------------------------ renderer, scenes, post-processing
const canvas = $('#stage-canvas');

// If the GPU drops a WebGL context (memory pressure, a driver reset), Chrome draws the dead canvas white. Hide it at
// once (the page stays black), say what is happening, then reload at the same point of the story, resuming PRESENT
// if it was playing: a fresh page is the only reliable way back for every texture and render target.
const GL_RESUME = 'mav-gl-resume';
let glLost = false;
function glRecover() {
  try {
    sessionStorage.setItem(GL_RESUME, JSON.stringify({ y: scrollY, present: !!(present.on && !present.paused) }));
  } catch (e) { /* storage blocked: reload from the top */ }
  location.reload();
}
function watchGL(cv) {
  cv.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();                                     // lets the browser hand the context back
    if (glLost) return;
    glLost = true;
    document.querySelectorAll('#stage-canvas, #slam-canvas').forEach((c) => { c.style.visibility = 'hidden'; });
    document.documentElement.classList.add('gl-lost');
    setTimeout(glRecover, 2500);                            // restored or not, reload once the message has shown
  }, false);
}
watchGL(canvas);
watchGL($('#slam-canvas'));

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, powerPreference: 'high-performance' });
const DPR = Math.min(devicePixelRatio, MOBILE ? 1.5 : 2);
renderer.setPixelRatio(DPR);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;          // filmic, keeps highlights and Mars colours natural
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x000000, 1);

const plateScene = new THREE.Scene();   // photos + zoom chain (stages 1–2)
const overlayScene = new THREE.Scene(); // original drone cutout (match-frame)
const ortho = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -10, 10);
const scene = new THREE.Scene();        // the 3D world: surface, lander, drone, lava tube
scene.fog = new THREE.FogExp2(0x000000, 0);
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 4200);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

const hemi = new THREE.HemisphereLight(0xe2b48c, 0x3a2216, 0.5);
const sun = new THREE.DirectionalLight(0xffe0c0, 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(MOBILE ? 1024 : 4096, MOBILE ? 1024 : 4096);
Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 32, bottom: -32, near: 1, far: 150 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
const rim = new THREE.DirectionalLight(0x00a8cc, 0.4); rim.position.set(-4, 2, -5);
const camLight = new THREE.PointLight(0xc8dcff, 0, 16, 1.6);
camera.add(camLight);
scene.add(hemi, sun, sun.target, rim, camera);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: MOBILE ? 0 : 4 }));
composer.addPass(new RenderPass(scene, camera));
// ground-truth ambient occlusion: contact shadows under rocks, in cave crevices and around the lander legs
let gtao = null;
if (!MOBILE) {
  gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.blendIntensity = 0.85;
  gtao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1.6, thickness: 2.2, scale: 1.0, samples: 16 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  // laser points, lines, glows and other additive overlays must not cast occlusion
  const render = gtao.render.bind(gtao);
  gtao.render = (...args) => {
    const hidden = [];
    scene.traverseVisible((o) => {
      const m = o.material;
      if (o.isPoints || o.isLine || o.isSprite || o.name === 'horizon' || (m && !Array.isArray(m) && m.transparent && !m.depthWrite)) hidden.push(o);   // no AO kilometres away
    });
    hidden.forEach((o) => { o.visible = false; });
    render(...args);
    hidden.forEach((o) => { o.visible = true; });
  };
  composer.addPass(gtao);
}
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.45, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// cheap edge smoothing for the tiers that skip multisampling
const fxaa = new ShaderPass(FXAAShader); fxaa.enabled = false;
composer.addPass(fxaa);
// camera lens: fine film grain, slight chromatic fringing toward the corners
const lens = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.016 }, uCA: { value: 0.0 }, uRes: { value: new THREE.Vector2(1, 1) }, uSat: { value: 1 }, uGrade: { value: 0 }, uSharp: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uGrain, uCA, uSat, uGrade, uSharp; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5; vec2 off = c * dot(c, c) * uCA * 4.0;
      vec3 col = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
      if (uSharp > 0.0) {                                                   // contrast-adaptive sharpening (AMD CAS style)
        vec2 t = 1.0 / uRes;
        vec3 a = texture2D(tDiffuse, vUv + vec2(0.0, t.y)).rgb, b = texture2D(tDiffuse, vUv - vec2(0.0, t.y)).rgb;
        vec3 d = texture2D(tDiffuse, vUv + vec2(t.x, 0.0)).rgb, e = texture2D(tDiffuse, vUv - vec2(t.x, 0.0)).rgb;
        vec3 mn = min(col, min(min(a, b), min(d, e))), mx = max(col, max(max(a, b), max(d, e)));
        vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
        vec3 w = -amp * mix(0.08, 0.2, uSharp);
        col = max((col + (a + b + d + e) * w) / (1.0 + 4.0 * w), 0.0);
      }
      float n = h(floor(vUv * uRes) + fract(uTime * 7.31) * 113.0) - 0.5;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = max(mix(vec3(l), col, uSat), 0.0);                          // Mars grade: the iron-oxide colour the filmic curve washes out
      vec3 cs = clamp(col, 0.0, 1.0);
      col = mix(col, cs * cs * (3.0 - 2.0 * cs), 0.3 * uGrade);             // a gentle S-curve: deeper shadows, warmer mids
      col *= mix(vec3(1.0), vec3(1.05, 0.97, 0.88), uGrade);
      col += n * uGrain * (1.15 - l);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
composer.addPass(lens);

// ------------------------------------------------------------------ adaptive quality: hold a steady ~60 fps on any GPU
// Four tiers trade resolution, multisampling, ambient occlusion and shadow-map size. The start tier follows the GPU
// (integrated graphics start at MEDIUM); while the 3D story runs, slow frames step down and a long steady 60 steps up
// (a tier that once failed is not retried). ?quality=low|medium|high|ultra pins a tier; Q cycles them by hand.
const GPU_NAME = (() => { try { const gl = renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : ''; } catch { return ''; } })();
const INTEGRATED = /intel|iris|uhd|hd graphics|radeon\(tm\) graphics|vega \d+ graphics|mali|adreno|powervr|apple gpu|swiftshader|llvmpipe|basic render/i.test(GPU_NAME);
// Resolution stays at (or within 20% of) the screen's own: what goes first is what the eye barely sees
// (ambient occlusion, multisampling → FXAA, shadow-map size, fine noise octaves), and a light contrast-adaptive
// sharpen keeps the two lower tiers crisp.
const TIERS = [
  { name: 'LOW', scale: 0.8, msaa: 0, ao: false, shadow: 2048, bloom: true, lite: true, sharp: 1 },
  { name: 'MEDIUM', scale: 0.9, msaa: 0, ao: false, shadow: 2048, bloom: true, lite: true, sharp: 0.6 },
  { name: 'HIGH', scale: 1, msaa: 0, ao: false, shadow: 2048, bloom: true, lite: false, sharp: 0.25 },
  { name: 'ULTRA', scale: 1, msaa: 4, ao: true, shadow: 4096, bloom: true, lite: false, sharp: 0 },
];
const qParam = (new URLSearchParams(location.search).get('quality') || '').toUpperCase();
const RECORDING = new URLSearchParams(location.search).has('record');
const Q = { i: 0, bad: new Set(), sum: 0, n: 0, hold: 0, slow: 0, fixed: false };
Q.i = RECORDING ? 3 : TIERS.some((t) => t.name === qParam) ? TIERS.findIndex((t) => t.name === qParam) : MOBILE ? 0 : INTEGRATED ? 2 : 3;
Q.fixed = RECORDING || TIERS.some((t) => t.name === qParam);
function applyQuality(i) {
  Q.i = i; Q.sum = 0; Q.n = 0; Q.hold = 0;
  const T = TIERS[i], pr = Math.min(devicePixelRatio, 1.5) * T.scale;
  renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) if (rt.samples !== T.msaa) { rt.samples = T.msaa; rt.dispose(); }
  if (W) composer.setSize(W, H);
  if (gtao) gtao.enabled = T.ao;
  bloom.enabled = T.bloom;
  document.documentElement.classList.toggle('q-blur', i >= 3);   // live backdrop blur only at ULTRA
  DETAIL.rkLite.value = T.lite ? 1 : 0;
  if (env) env.salt.geometry.setDrawRange(0, T.lite ? 9000 : Infinity);
  fxaa.enabled = T.msaa === 0;
  lens.uniforms.uSharp.value = T.sharp;
  if (W) { fxaa.uniforms.resolution.value.set(1 / (W * pr), 1 / (H * pr)); lens.uniforms.uRes.value.set(W * pr, H * pr); }
  if (sun.shadow.mapSize.x !== T.shadow) { sun.shadow.mapSize.set(T.shadow, T.shadow); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
}
function qualityTick(raw) {
  if (Q.fixed || document.hidden || state.mode !== '3d' || raw > 0.25) { Q.sum = 0; Q.n = 0; return; }
  Q.sum += Math.min(raw, 0.04); Q.n++;                               // one shader-compile hiccup must not count much
  if (Q.n < 40) return;
  const avg = (Q.sum / Q.n) * 1000; Q.sum = 0; Q.n = 0;
  if (avg > 20.5 && Q.i > 0) { if (++Q.slow >= 2) { Q.bad.add(Q.i); applyQuality(Q.i - 1); Q.slow = 0; } Q.hold = 0; }
  else if (avg < 17.6 && Q.i < TIERS.length - 1 && !Q.bad.has(Q.i + 1)) { Q.slow = 0; if (++Q.hold >= 6) applyQuality(Q.i + 1); }
  else { Q.hold = 0; Q.slow = 0; }
}
addEventListener('keydown', (e) => {
  if (e.key !== 'q' && e.key !== 'Q') return;
  Q.fixed = true; applyQuality((Q.i + 1) % TIERS.length);
  const tq = $('#qtoast'); if (tq) { tq.textContent = `QUALITY · ${TIERS[Q.i].name}`; tq.style.opacity = 1; clearTimeout(tq._t); tq._t = setTimeout(() => { tq.style.opacity = 0; }, 1600); }
});

let aspect = 1, W = 1, H = 1, PANEL = 0;

// ------------------------------------------------------------------ opening video → frame sequence
const introCanvas = $('#intro-canvas'), ictx = introCanvas.getContext('2d');
// frame set by the pixels the video will actually cover: 1080 px (phones), 1920 px, or 2880 px (large / high-DPI screens)
const FR_SET = MOBILE ? 'mobile' : ((innerWidth * 0.8) * Math.min(devicePixelRatio, 2) > 2100 ? 'hd' : 'desktop');
const FR = { set: FR_SET, count: 0, w: 1920, h: 1080, imgs: [], ok: [], key: '', alpha: -1 };
const VIDEO_DISC = { u: 0.300, v: 0.489, r: 0.410 };   // Mars in the last video frame (r in frame heights), fitted to the lit limb
// part of the frame that must stay on screen: planet + shuttle in landscape, the planet alone on a portrait phone
const SUBJECT = { landscape: [0.05, 0.06, 0.95, 0.95], portrait: [0.04, 0.06, 0.58, 0.94] };
const GLOBE_DISC = { x: 0, y: 0.01, r: 0.39 };         // Mars in mars-globe-tharsis (world units)
function loadFrames() {
  return fetch('assets/frames/frames.json').then((r) => r.json()).then((meta) => {
    const m = meta[FR.set];
    Object.assign(FR, { count: m.count, w: m.width, h: m.height, imgs: new Array(m.count), ok: new Array(m.count).fill(false), shuttle: meta.shuttle || null });
    // the craft in the clip is replaced (init) by a rendered cruise stage + entry capsule
    const order = [], seen = new Set([0, m.count - 1]);
    for (const step of [32, 16, 8, 4, 2, 1]) for (let i = 0; i < m.count; i += step) if (!seen.has(i)) { seen.add(i); order.push(i); }
    order.unshift(m.count - 1);
    const load = (i) => new Promise((res) => {
      const im = new Image(); im.decoding = 'async';
      im.onload = () => { FR.imgs[i] = im; FR.ok[i] = true; FR.key = ''; res(); };
      im.onerror = res;
      im.src = `assets/frames/${FR.set}/f_${String(i).padStart(3, '0')}.webp`;
    });
    let next = 0;
    const worker = async () => { while (next < order.length) await load(order[next++]); };
    return load(0).then(() => { for (let k = 0; k < 6; k++) worker(); });
  });
}
// the scene area is the screen minus the text panel (left 30% on desktop, bottom 38% on phones)
const sceneRect = () => (isNarrow() ? { x: 0, y: 0, w: W, h: H * 0.62 } : { x: PANEL, y: 0, w: W - PANEL, h: H });
function introGeom(zoom) {
  const r = sceneRect(), portrait = r.w / r.h < 1, B = portrait ? SUBJECT.portrait : SUBJECT.landscape;
  // as large as possible (cover) unless that would crop the subject; then centre the subject and
  // slide the frame so it fills as much of the scene area as it can
  const sc0 = Math.min(Math.max(r.w / FR.w, r.h / FR.h), r.w / ((B[2] - B[0]) * FR.w), r.h / ((B[3] - B[1]) * FR.h));
  const dw0 = FR.w * sc0, dh0 = FR.h * sc0;
  const slide = (lo, size, span, c) => (span >= size ? clamp(lo + size / 2 - c * span, lo + size - span, lo) : lo + (size - span) / 2);
  const dx0 = slide(r.x, r.w, dw0, (B[0] + B[2]) / 2), dy0 = slide(r.y, r.h, dh0, (B[1] + B[3]) / 2);
  const px = dx0 + VIDEO_DISC.u * dw0, py = dy0 + VIDEO_DISC.v * dh0;
  const dw = dw0 * zoom, dh = dh0 * zoom;
  return { dx: px - VIDEO_DISC.u * dw, dy: py - VIDEO_DISC.v * dh, dw, dh, px, py, R: VIDEO_DISC.r * dh, portrait, r };
}
// The clip's spacecraft was lifted out of every frame (tools/extract_frames.py); a cruise stage carrying the
// entry capsule (js/cruise-stage.js) flies here instead. It coasts toward Mars on a gentle arc (perspective:
// position and size ∝ 1/depth), catches a sun glint, picks up the planet's orange light and slips behind the
// limb toward its entry point. No engine plume: a lander arrives on a ballistic path, with only small
// trajectory-correction pulses.
const SHUTTLE_VP = { u: 0.548, v: 0.598 };                // where it meets the limb (frame fractions)
const MARS_C = { u: VIDEO_DISC.u, v: VIDEO_DISC.v };
function shuttleAt(k) {
  const sh = FR.shuttle, kk = clamp(k);
  const c0u = sh.u + sh.w / 2, c0v = sh.v + sh.h / 2;
  const a = clamp(kk / 0.82), e = easeInOut(a), z = 1 + 3.3 * Math.pow(e, 1.7), sc = 1 / z;   // recedes slowly at first, then quickly
  // perpendicular to the approach, for the arc (in frame-pixel space so it stays round)
  const dx = (SHUTTLE_VP.u - c0u) * FR.w, dy = (SHUTTLE_VP.v - c0v) * FR.h, L = Math.hypot(dx, dy) || 1;
  const nu = (-dy / L) / FR.w, nv = (dx / L) / FR.h, arc = Math.sin(Math.PI * e) * 0.09 * L * sc;
  let u = SHUTTLE_VP.u + (c0u - SHUTTLE_VP.u) * sc + nu * arc, v = SHUTTLE_VP.v + (c0v - SHUTTLE_VP.v) * sc + nv * arc;
  let scale = sc;
  const b = range(kk, 0.82, 1);                              // past the limb, heading behind the planet
  if (b > 0) { u += (MARS_C.u - SHUTTLE_VP.u) * 0.16 * easeIn(b); v += (MARS_C.v - SHUTTLE_VP.v) * 0.16 * easeIn(b); scale *= 1 - 0.25 * b; }
  return { u, v, scale };
}
function shuttlePose(k) {
  const q = shuttleAt(k), q2 = shuttleAt(Math.min(1, k + 0.01));
  return { ...q, tu: q2.u - q.u, tv: q2.v - q.v, alpha: 1 - smooth(0.95, 1, k), burn: 0 };
}
let shC = null;
function drawShuttle(g, s, k) {
  const sh = FR.shuttle, img = FR.shuttleImg;
  if (!sh || !img) return;
  const q = shuttlePose(k);
  if (q.alpha <= 0.01) return;
  const w = sh.w * g.dw * q.scale, h = sh.h * g.dh * q.scale;
  const cx = g.dx + q.u * g.dw, cy = g.dy + q.v * g.dh;
  // orientation: the sprite was drawn pointing along its original heading; turn it to follow the arc
  const base = Math.atan2((SHUTTLE_VP.v - (sh.v + sh.h / 2)) * g.dh, (SHUTTLE_VP.u - (sh.u + sh.w / 2)) * g.dw);
  const head = (q.tu || q.tv) ? Math.atan2(q.tv * g.dh, q.tu * g.dw) : base;
  let rot = head - base; while (rot > Math.PI) rot -= Math.PI * 2; while (rot < -Math.PI) rot += Math.PI * 2;
  rot = clamp(rot, -0.35, 0.35);
  const back = head + Math.PI;                                 // exhaust direction
  const fl = 0.82 + 0.18 * Math.sin(time * 43) * Math.sin(time * 17.3);
  const pcx = g.dx + MARS_C.u * g.dw, pcy = g.dy + MARS_C.v * g.dh, pR = VIDEO_DISC.r * g.dh;
  ictx.save();
  if (k > 0.8) {                                               // behind the planet: clip the disc out
    ictx.beginPath(); ictx.rect(0, 0, ictx.canvas.width, ictx.canvas.height); ictx.arc(pcx * s, pcy * s, pR * s, 0, Math.PI * 2); ictx.clip('evenodd');
  }
  ictx.globalAlpha = q.alpha;
  // 1) exhaust trail: where it has been, fading (follows the same path, so it bends with the arc)
  if (q.burn > 0.01) {
    ictx.globalCompositeOperation = 'lighter'; ictx.lineCap = 'round';
    let prev = [cx, cy];
    for (let j = 1; j <= 26; j++) {
      const p = shuttleAt(k - j * 0.011); if (k - j * 0.011 < 0) break;
      const x = g.dx + p.u * g.dw, y = g.dy + p.v * g.dh, f = 1 - j / 26;
      ictx.strokeStyle = `rgba(${Math.round(150 + 105 * f)},${Math.round(150 + 40 * f)},255,${0.22 * f * q.burn})`;
      ictx.lineWidth = Math.max(0.6, w * 0.05 * f) * s;
      ictx.beginPath(); ictx.moveTo(prev[0] * s, prev[1] * s); ictx.lineTo(x * s, y * s); ictx.stroke();
      prev = [x, y];
    }
    // 2) main engine plumes: white core, orange body, blue fringe, shock diamonds
    for (const [nu, nv, area] of sh.nozzles) {
      const big = area > 600;
      const ox = (nu - 0.5) * w, oy = (nv - 0.5) * h;
      const nx = cx + ox * Math.cos(rot) - oy * Math.sin(rot), ny = cy + ox * Math.sin(rot) + oy * Math.cos(rot);
      const L = w * (big ? 0.85 : 0.38) * (0.75 + 0.25 * q.burn) * fl, Rw = w * (big ? 0.075 : 0.04);
      ictx.save(); ictx.translate(nx * s, ny * s); ictx.rotate(back);
      for (const [len, rad, c0, c1] of [[1, 1.6, 'rgba(110,140,255,0.22)', 'rgba(60,90,255,0)'], [0.85, 1, 'rgba(255,170,90,0.75)', 'rgba(255,110,40,0)'], [0.45, 0.45, 'rgba(255,248,230,0.95)', 'rgba(255,220,170,0)']]) {
        const gr = ictx.createRadialGradient(0, 0, 0, 0, 0, L * len * s);
        gr.addColorStop(0, c0); gr.addColorStop(1, c1);
        ictx.save(); ictx.scale(1, (Rw * rad) / (L * len)); ictx.fillStyle = gr;
        ictx.globalAlpha = q.alpha * q.burn; ictx.beginPath(); ictx.arc(L * len * 0.45 * s, 0, L * len * s, 0, Math.PI * 2); ictx.fill(); ictx.restore();
      }
      ictx.restore();
    }
    ictx.globalCompositeOperation = 'source-over';
  }
  // 3) the shuttle, lit orange from the planet side as it gets close
  const pw = Math.max(2, Math.round(w * s)), ph = Math.max(2, Math.round(h * s));
  if (!shC) shC = document.createElement('canvas');
  if (shC.width !== pw || shC.height !== ph) { shC.width = pw; shC.height = ph; }
  const sc2 = shC.getContext('2d');
  sc2.globalCompositeOperation = 'source-over'; sc2.clearRect(0, 0, pw, ph); sc2.drawImage(img, 0, 0, pw, ph);
  const warm = 0.12 + 0.4 * smooth(0.25, 0.9, k);
  const ang = Math.atan2(pcy - cy, pcx - cx) - rot;
  const gx = Math.cos(ang) * pw * 0.5, gy = Math.sin(ang) * ph * 0.5;
  const lg = sc2.createLinearGradient(pw / 2 + gx, ph / 2 + gy, pw / 2 - gx, ph / 2 - gy);
  lg.addColorStop(0, `rgba(255,120,60,${warm})`); lg.addColorStop(0.6, 'rgba(255,120,60,0)');
  sc2.globalCompositeOperation = 'source-atop'; sc2.fillStyle = lg; sc2.fillRect(0, 0, pw, ph);
  sc2.fillStyle = `rgba(0,0,0,${0.18 * smooth(0.5, 1, k)})`; sc2.fillRect(0, 0, pw, ph);   // falls into the planet's shadow side
  ictx.save(); ictx.translate(cx * s, cy * s); ictx.rotate(rot); ictx.drawImage(shC, -pw / 2, -ph / 2); ictx.restore();
  // 4) hot nozzles + a sun glint off the wing as it turns
  ictx.globalCompositeOperation = 'lighter';
  if (q.burn > 0.01) for (const [nu, nv, area] of sh.nozzles) {
    const ox = (nu - 0.5) * w, oy = (nv - 0.5) * h;
    const nx = (cx + ox * Math.cos(rot) - oy * Math.sin(rot)) * s, ny = (cy + ox * Math.sin(rot) + oy * Math.cos(rot)) * s;
    const R = (Math.sqrt(area) / 529) * w * 2.6 * s * fl;
    const gr = ictx.createRadialGradient(nx, ny, 0, nx, ny, R);
    gr.addColorStop(0, `rgba(255,230,190,${0.8 * q.burn})`); gr.addColorStop(1, 'rgba(255,120,40,0)');
    ictx.fillStyle = gr; ictx.fillRect(nx - R, ny - R, R * 2, R * 2);
  }
  const glint = Math.exp(-Math.pow((k - 0.4) / 0.035, 2));
  if (glint > 0.02) {
    const gx2 = (cx - w * 0.12) * s, gy2 = (cy - h * 0.18) * s, Lg = w * (0.6 + 1.2 * glint) * s;
    for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const long = a === 0 || a === Math.PI / 2 ? 1 : 0.45;
      ictx.save(); ictx.translate(gx2, gy2); ictx.rotate(a); ictx.scale(1, 0.035);
      const gr = ictx.createRadialGradient(0, 0, 0, 0, 0, Lg * long);
      gr.addColorStop(0, `rgba(255,250,240,${0.9 * glint})`); gr.addColorStop(1, 'rgba(255,240,220,0)');
      ictx.fillStyle = gr; ictx.beginPath(); ictx.arc(0, 0, Lg * long, 0, Math.PI * 2); ictx.fill(); ictx.restore();
    }
    const gr = ictx.createRadialGradient(gx2, gy2, 0, gx2, gy2, w * 0.25 * s);
    gr.addColorStop(0, `rgba(255,255,255,${glint})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    ictx.fillStyle = gr; ictx.beginPath(); ictx.arc(gx2, gy2, w * 0.25 * s, 0, Math.PI * 2); ictx.fill();
  }
  ictx.restore();
}
function drawIntro(k, zoom, alpha) {
  if (!FR.count) alpha = 0;
  if (alpha !== FR.alpha) { introCanvas.style.opacity = alpha; introCanvas.style.visibility = alpha > 0.001 ? 'visible' : 'hidden'; FR.alpha = alpha; }
  if (alpha <= 0.001) return;
  const want = Math.round(clamp(k) * (FR.count - 1));
  let i = -1;
  for (let d = 0; d < FR.count && i < 0; d++) { if (FR.ok[want - d]) i = want - d; else if (FR.ok[want + d]) i = want + d; }
  if (i < 0) return;
  const moving = FR.shuttleImg && k > 0 && k < 1;
  const key = `${i}|${zoom.toFixed(4)}|${W}x${H}|${PANEL}|${k.toFixed(4)}|${moving ? Math.floor(time * 24) : 0}|${!!FR.shuttleImg}`;
  if (key === FR.key) return; FR.key = key;
  const g = introGeom(zoom), s = introCanvas.width / W, img = FR.imgs[i];
  ictx.fillStyle = '#000'; ictx.fillRect(0, 0, introCanvas.width, introCanvas.height);
  ictx.save(); ictx.beginPath(); ictx.rect(g.r.x * s, g.r.y * s, g.r.w * s, g.r.h * s); ictx.clip();
  ictx.drawImage(img, g.dx * s, g.dy * s, g.dw * s, g.dh * s);
  drawShuttle(g, s, k);
  // where the frame does not reach the edge of the scene area, fade it into black space
  const F = 56;
  const fade = (x0, y0, x1, y1, rx, ry, rw, rh) => {
    const gr = ictx.createLinearGradient(x0 * s, y0 * s, x1 * s, y1 * s);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    ictx.fillStyle = gr; ictx.fillRect(rx * s, ry * s, rw * s, rh * s);
  };
  if (g.dy > g.r.y + 0.5) fade(0, g.dy, 0, g.dy + F, g.dx, g.dy, g.dw, F);
  if (g.dy + g.dh < g.r.y + g.r.h - 0.5) fade(0, g.dy + g.dh, 0, g.dy + g.dh - F, g.dx, g.dy + g.dh - F, g.dw, F);
  if (g.dx > g.r.x + 0.5) fade(g.dx, 0, g.dx + F, 0, g.dx, g.dy, F, g.dh);
  if (g.dx + g.dw < g.r.x + g.r.w - 0.5) fade(g.dx + g.dw, 0, g.dx + g.dw - F, 0, g.dx + g.dw - F, g.dy, F, g.dh);
  ictx.restore();
}

// ------------------------------------------------------------------ assets
const sfx = MOBILE ? '-m' : '';
const URLS = {
  globe: `assets/img/mars-globe-tharsis${sfx}.webp`, olympus: `assets/img/olympus-mons${sfx}.webp`,
  pit: 'assets/img/arsia-skylight-pit.webp', mola: `assets/nasa/nasa-pia02820-mola-tharsis${sfx}.webp`,
  basalt: 'assets/img/basalt-detail.webp',
  // photo-scanned surfaces (CC0, Poly Haven): colour × AO and OpenGL normal maps
  gC: `assets/tex/ground-col${sfx}.webp`, gN: `assets/tex/ground-nor${sfx}.webp`, sC: `assets/tex/sand-col${sfx}.webp`, sN: `assets/tex/sand-nor${sfx}.webp`,
  rC: `assets/tex/rock-col${sfx}.webp`, rN: `assets/tex/rock-nor${sfx}.webp`,
  tC: `assets/tex/strata-col${sfx}.webp`, tN: `assets/tex/strata-nor${sfx}.webp`,
};
const T = {};
const manager = new THREE.LoadingManager();
const texturesReady = new Promise((res) => { manager.onLoad = res; });
manager.onProgress = (_u, done, total) => {
  const k = done / total;
  $('#loader-bar').style.transform = `scaleX(${k})`;
  $('#loader-pct').textContent = `${Math.round(k * 100)}%`;
};
manager.onError = (u) => { $('#loader-pct').textContent = `MISSING ASSET: ${u}`; };
const loader = new THREE.TextureLoader(manager);
for (const [k, u] of Object.entries(URLS)) loader.load(u, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; T[k] = t; });
Promise.all([texturesReady, loadFrames().catch(() => null)]).then(init);

// ------------------------------------------------------------------ world (filled in init)
let plates, chain, stars, drone, cave, surface, lamp, emRings, slam, beam, motes, uplink, cv, fan, habitat, env;
let L1, tharsis, L1c;
const PIT = { u: 0.688, v: 0.269, d: 0.068 };
const THARSIS = [0.22, 0.38];
const MOLA_DISC = 0.78;
const SPAN = MAV_DIMENSIONS.span, FOOT = MAV_DIMENSIONS.footY;
const GROUND_Y = CAVE.SHAFT_TOP + 2.6;
const W3 = {};   // world landmarks

async function init() {
  T.basalt.colorSpace = THREE.NoColorSpace; T.basalt.wrapS = T.basalt.wrapT = THREE.RepeatWrapping; T.basalt.needsUpdate = true;
  DETAIL.rkDetail.value = T.basalt; DETAIL.rkDetailOn.value = 1;
  const ph = (c, n) => { for (const t of [c, n]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true; } n.colorSpace = THREE.NoColorSpace; return [c, n]; };
  [PHOTO.phGroundC.value, PHOTO.phGroundN.value] = ph(T.gC, T.gN);
  [PHOTO.phSandC.value, PHOTO.phSandN.value] = ph(T.sC, T.sN);
  [PHOTO.phRockC.value, PHOTO.phRockN.value] = ph(T.rC, T.rN);
  [PHOTO.phStrataC.value, PHOTO.phStrataN.value] = ph(T.tC, T.tN);
  PHOTO.phOn.value = 1;
  plates = {
    globe: new Plate(T.globe, { order: 1 }), mola: new Plate(T.mola, { order: 2 }),
    olympus: new Plate(T.olympus, { order: 3, lift: 0.12 }), pit: new Plate(T.pit, { order: 4 }),
  };
  for (const [k, p] of Object.entries(plates)) (k === 'pit' ? overlayScene : plateScene).add(p.mesh);
  plates.mola.u.wipeOn.value = 1;
  plates.globe.u.edge.value = 0.14;
  plates.pit.u.edge.value = 0.08;
  plates.olympus.u.edge.value = 0.18;
  if (FR.shuttle) {                                                    // the real kind of craft that carries a lander to Mars
    const sh = FR.shuttle;
    const base = Math.atan2((SHUTTLE_VP.v - (sh.v + sh.h / 2)) * FR.h, (SHUTTLE_VP.u - (sh.u + sh.w / 2)) * FR.w);
    FR.shuttleImg = renderCruiseSprite({ aspect: (sh.w * FR.w) / (sh.h * FR.h), angle: base, height: MOBILE ? 420 : 760 });
    FR.shuttle = { ...sh, nozzles: [] }; FR.key = '';
  }
  stars = createStars(MOBILE ? 500 : 1100); stars.material.uniforms.uPx.value = DPR; plateScene.add(stars);

  chain = new ZoomChain([{ plate: plates.globe }, { plate: plates.olympus, parentPt: THARSIS, childPt: [0.5, 0.5], k: 0.085 }]);
  L1 = chain.layers[1];
  tharsis = chain.point(0, ...THARSIS);
  L1c = { x: L1.left + L1.w / 2, y: L1.top - L1.h / 2 };

  drone = createMAVA1();
  {                                                               // fewer draw calls: merge what does not move
    const dp = drone.parts, keepSet = new Set([dp.lidar, dp.camera, dp.node, dp.nodeRing, ...dp.leds, ...dp.rotors.map((r) => r.rotor)]);
    dp.rotors.forEach((r) => mergeStatic(r.blades, { transparent: true }));   // six blades turn as one
    mergeStatic(drone.body, { keep: (o) => keepSet.has(o) });
  }
  scene.add(drone.object);
  lamp = new THREE.SpotLight(0xfff1df, 0, 45, 0.55, 0.6, 1.4);     // neutral-warm LED, like a real survey lamp
  lamp.castShadow = !MOBILE; lamp.shadow.mapSize.set(1024, 1024); lamp.shadow.bias = -0.0006;
  // kept at the scene root (so the light set never changes when the drone is hidden: no shader recompiles),
  // and moved onto the drone's body every frame (followLamp)
  scene.add(lamp, lamp.target);

  cave = createCave({ pointCount: MOBILE ? 40000 : 130000, pixelRatio: DPR, mobile: MOBILE });
  scene.add(cave.group);
  scene.add(cave.skyLight, cave.skyLight.target);                 // lights outside groups that get hidden: a fixed light set
  habitat = createHabitat({ cave });
  scene.add(habitat.group, habitat.lightGroup, habitat.column);
  slam = createSlamView({ canvas: $('#slam-canvas'), cave, mobile: MOBILE, footprint: habitat.footprint });
  ({ beam, motes } = createLampHaze());
  fan = createLaserFan();
  surface = createSurface({ hirise: T.pit, pit: { ...PIT, aspect: T.pit.image.width / T.pit.image.height }, shaftCenter: cave.shaftCenter, shaftR: CAVE.SHAFT_R, groundY: GROUND_Y, mobile: MOBILE });
  surface.dustMat.uniforms.uPx.value = DPR;
  surface.devils.forEach((d) => { d.material.uniforms.uPx.value = DPR; });
  env = createEnvironment({ surface, cave, groundY: GROUND_Y, mobile: MOBILE, pixelRatio: DPR });
  scene.add(env.group);
  scene.add(surface.group);
  cave.group.add(surface.shaftRocks);                           // the chockstones live in the shaft, seen from above and below
  surface.group.updateMatrixWorld(true);
  surface.group.traverse((o) => { if (o.material && 'envMapIntensity' in o.material && !surfaceMats.includes(o.material)) surfaceMats.push(o.material); });
  // underground rock only gets light from the sun through the hole, the drone's lamp and a little bounce
  cave.group.traverse((o) => { const m = o.material; if (m && !Array.isArray(m) && 'envMapIntensity' in m) m.envMapIntensity = 0.1; });

  // world landmarks
  W3.pit = surface.pitCenter.clone();
  W3.lander = surface.landerPos.clone().setY(GROUND_Y);
  surface.lander.setLift(1);
  W3.pad = surface.padPoint(FOOT, 1);                        // the drone on the raised pad: where it takes off and lands
  W3.yaw = surface.padYaw;                                   // nose toward the pit
  W3.fwd = new V3(Math.sin(W3.yaw), 0, Math.cos(W3.yaw));
  W3.side = new V3().crossVectors(W3.fwd, UPV).normalize();
  W3.hover = W3.pit.clone().setY(GROUND_Y + 9);
  W3.caveEntryY = cave.pose(CAVE.SHAFT_S, 0.6).position.y + 1.2;
  W3.sunDir = surface.skyMat.uniforms.uSun.value.clone();
  W3.sunH = new V3(W3.sunDir.x, 0, W3.sunDir.z).normalize();
  W3.sunEl = Math.asin(W3.sunDir.y);
  // Earth sits ~25° from the sun along the horizon, 13° up: the evening star of Mars
  const eAz = isNarrow() ? -0.15 : -0.3;                       // keep Earth inside the narrower phone frame
  W3.earth = W3.sunH.clone().applyAxisAngle(UPV, eAz).multiplyScalar(Math.cos(0.2)).setY(Math.sin(0.2)).normalize();
  surface.skyMat.uniforms.uEarth.value.copy(W3.earth);
  uplink = createUplink();

  emRings = new THREE.Group();
  [[0.85, 0x00a8cc], [1.2, 0xff3305], [1.55, 0x00a8cc]].forEach(([r, c]) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, 0.022, 8, 96), new THREE.MeshBasicMaterial({ color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    m.rotation.x = Math.PI / 2; emRings.add(m);
  });
  emRings.position.copy(W3.pad).add(new V3(0, FOOT + 0.04, 0));
  scene.add(emRings);

  story.style.height = `${TOTAL + 100}vh`;
  buildScrubber(); buildCallouts(); buildNet();
  // machine vision: the same scene from the vehicle's camera, with the CV layer on top
  const saved = {};
  cv = createCvFeed({ box: $('#cv-box'), canvas: $('#cv-canvas'), renderer, scene, cave, surface, pit: PIT, pitImage: T.pit.image, groundY: GROUND_Y,
    beforeRender() {
      saved.drone = drone.object.visible; saved.beam = beam.visible; saved.motes = motes.visible; saved.scan = SCAN.rkScanOn.value; saved.up = uplink.visible;
      saved.glow = surface.lander.glow.visible; surface.lander.glow.visible = false;      // the descent camera looks past its own plume
      saved.fan = fan.visible; fan.visible = false;
      saved.hab = habitat.group.visible; habitat.group.visible = false;
      if (state.cv.hideDrone) drone.object.visible = false;
      beam.visible = false; motes.visible = false; SCAN.rkScanOn.value = 0; uplink.visible = false;
      saved.peb = surface.pebbles.map((c) => c.visible); surface.pebbles.forEach((c) => { c.visible = false; });   // too small for the small feed
    },
    afterRender() { drone.object.visible = saved.drone; beam.visible = saved.beam; motes.visible = saved.motes; SCAN.rkScanOn.value = saved.scan; uplink.visible = saved.up; surface.lander.glow.visible = saved.glow; fan.visible = saved.fan; habitat.group.visible = saved.hab;
      surface.pebbles.forEach((c, i) => { c.visible = saved.peb[i]; }); },
  });
  resize();
  addEventListener('resize', resize);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll(); pSmooth = pTarget;
  await warmUp();
  renderer.setAnimationLoop(frame);
  let resume = null;                                        // back from a GPU reset: same point, same mode
  try { resume = JSON.parse(sessionStorage.getItem(GL_RESUME) || 'null'); sessionStorage.removeItem(GL_RESUME); } catch (e) { /* none */ }
  if (resume) {
    scrollTo({ top: resume.y, behavior: 'auto' });
    if (resume.present) startPresent();
  }
  setTimeout(() => { const l = $('#loader'); l.style.opacity = 0; setTimeout(() => l.remove(), 700); }, 60);
  if (new URLSearchParams(location.search).has('debug')) {
    window.mav = {
      P, ST, drone, cave, surface, plates, camera, renderer, FR, W3, composer, bloom, gtao, lens, scene, lamp, camLight, sun, hemi, slam, beam,
      frame: () => frame(), present, env, quality: Q, TIERS, applyQuality, GPU_NAME,
      jump(id, t = 0.5) { scrollTo(0, P(id, t) * maxScroll()); onScroll(); pSmooth = pTarget; frame(); frame(); return `p=${pTarget.toFixed(4)}`; },
    };
  }
}

// Compile every shader the story will need while the loader is still showing, for each lighting set-up it uses
// (sun shadow on/off, the drone and its lamp in or out, the outpost's lights on/off): no stutter the first
// time a shot appears.
async function warmUp() {
  const pct = $('#loader-pct'); if (pct) pct.textContent = 'PREPARING SHADERS';
  const vis = [];
  scene.traverse((o) => { vis.push([o, o.visible]); o.visible = true; });
  const sunS = sun.castShadow, tw0 = performance.now();
  try {
    renderer.setRenderTarget(composer.renderTarget1);               // the variants the composer actually uses (linear, no tone map)
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera); else renderer.compile(scene, camera);
  } catch (e) { /* compiling ahead is only an optimisation */ }
  renderer.setRenderTarget(null);
  sun.castShadow = sunS;
  vis.forEach(([o, v]) => { o.visible = v; });
  const tw1 = performance.now();
  // then render one real frame of each kind of shot behind the loader: shadows, post-processing, the CV feed
  for (const [id, t] of [[2, 0.85], [3, 0.5], [4, 0.6], [5, 0.5], [6, 0.7], [8, 0.8], [9, 0.5], [9, 0.9], [10, 0.5], [10, 0.85]]) {
    scrollTo(0, P(id, t) * maxScroll()); onScroll(); pSmooth = pTarget; frame();
    await new Promise((r) => setTimeout(r, 0));                     // let the loader breathe
  }
  scrollTo(0, 0); onScroll(); pSmooth = pTarget; frame();
  Q.sum = 0; Q.n = 0; Q.hold = 0; clock.getDelta();                 // warm-up frames must not count as slow frames
  window.__warm = { compile: Math.round(tw1 - tw0), frames: Math.round(performance.now() - tw1), programs: renderer.info.programs.length };
}

// ------------------------------------------------------------------ scroll + layout
const story = $('#story');
const maxScroll = () => story.offsetHeight - innerHeight;
let pTarget = 0, pSmooth = 0;
function onScroll() { const m = maxScroll(); pTarget = m > 0 ? clamp(scrollY / m) : 0; }   // no 0/0 while the layout is still settling
const shiftX = () => (isNarrow() ? 0 : PANEL / W / 2);        // photo plates sit in the middle of the scene area
const shift3D = () => 0;                                        // the 3D subject (the drone) sits in the middle of the screen
const liftY = () => (isNarrow() ? 0.19 : 0);
function resize() {
  W = innerWidth; H = innerHeight; aspect = W / H;
  PANEL = isNarrow() ? 0 : $('#panel').getBoundingClientRect().width;
  renderer.setSize(W, H, false);
  applyQuality(Q.i);
  bloom.resolution.set(W, H);
  const s = Math.min(devicePixelRatio, FR.set === 'hd' ? 2 : 1.5);
  introCanvas.width = Math.round(W * s); introCanvas.height = Math.round(H * s); FR.key = '';
  if (typeof drawProfile === 'function' && prof !== undefined) drawProfile();
  camera.aspect = aspect; camera.fov = aspect < 0.8 ? 60 : 42;
  camera.setViewOffset(W, H, -W * shift3D(), H * liftY(), W, H);
  camera.updateProjectionMatrix();
  Object.assign(ortho, { left: -aspect / 2, right: aspect / 2, top: 0.5, bottom: -0.5 }); ortho.updateProjectionMatrix();
  onScroll();
}

// ------------------------------------------------------------------ zoom-chain views (stages 1–2)
const VIEW = (cx, cy, Hh) => ({ cx, cy, H: Hh });
function views() {
  const f = Math.max(1, 1 / aspect), sx = shiftX() * aspect, ly = liftY();
  const v = {
    tharsis: VIEW(tharsis.x * 0.85, tharsis.y * 0.85, 0.24 * f),
    olympus: VIEW(L1c.x, L1c.y, Math.min(L1.h * 0.86, (L1.w * 0.86) / aspect)),
  };
  for (const k in v) { v[k].cy -= ly * v[k].H; v[k].cx -= sx * v[k].H; }
  return v;
}
function matchView(zoom) {
  const g = introGeom(zoom);
  const Hv = GLOBE_DISC.r / (g.R / H);
  return VIEW(GLOBE_DISC.x - ((g.px - W / 2) / H) * Hv, GLOBE_DISC.y - ((H / 2 - g.py) / H) * Hv, Hv);
}
let curView = null;
function applyChain(view, alpha = 1) {
  curView = view;
  chain.apply(view);
  const s = 1 / view.H;
  const cover1 = Math.min((L1.w * s) / aspect, L1.h * s);
  plates.globe.opacity = alpha * (1 - smooth(1.7, 2.3, cover1));
  plates.olympus.opacity = alpha * smooth(0.25, 0.62, L1.h * s);
}
// put image point (u, v) at the centre of the scene area, `w` screen-heights wide
function placeOnSubject(plate, u, v, w) {
  const h = w / plate.aspect, cx = shift3D() * aspect, cy = liftY();
  plate.place(cx - (u - 0.5) * w, cy + (v - 0.5) * h, w);
}
const subjectPx = () => ({ x: W * (0.5 + shift3D()), y: H * (0.5 - liftY()) });
const worldToPx = (pt, view = curView) => ({ x: ((pt.x - view.cx) / view.H / aspect + 0.5) * W, y: (0.5 - (pt.y - view.cy) / view.H) * H });
const projectPx = (v3) => { const v = v3.clone().project(camera); return { x: (v.x * 0.5 + 0.5) * W, y: (0.5 - v.y * 0.5) * H, z: v.z }; };

// ------------------------------------------------------------------ per-frame state + lighting moods
const state = {};
function resetFrame() {
  for (const p of Object.values(plates)) { p.opacity = 0; p.u.brightness.value = 1; }
  stars.material.uniforms.uOpacity.value = 0; stars.material.uniforms.uScale.value = 1;
  drone.object.visible = false; cave.group.visible = false; surface.group.visible = false; emRings.visible = false;
  surface.lander.glowMat.opacity = 0; surface.dustMat.uniforms.uOpacity.value = 0;
  if (uplink) uplink.visible = false;
  if (fan) fan.visible = false;
  if (habitat) habitat.update({ time });
  surface.lander.group.position.y = GROUND_Y;
  surface.lander.setDoors(1); surface.lander.setLift(1);       // while MAV-A1 is away the hangar stands open, pad raised
  cave.updateScan(new V3(), 0, 0, 0); cave.updatePlanner(new V3(), cave.frame(0.5), 0, 0);
  drone.setAlert(false); drone.setRotorFault(null);
  lamp.intensity = 0; camLight.intensity = 0;
  camera.up.set(0, 1, 0);
  Object.assign(state, { flash: 0, black: 0, heat: 0, static: 0, reticle: null, callouts: 0, mola: null, alert: null, loc: null,
    intro: null, rpm: 0.6, droneS: undefined, mapped: undefined, mode: 'plates', overlay: false, slam: null, haze: 0, under: 0, lock: 0, cv: null, altOverride: undefined, eta: null, dusk: 0, focus: null, platesOver: 0, storm: 0.15, tau: 0 });
  if (surface) surface.skyMat.uniforms.uEarthGlow.value = 1;
}
let envK = -1;
const surfaceMats = [];
let surfEnvK = -1;
function setDroneEnv(k) { if (k === envK) return; envK = k; for (const m of Object.values(drone.materials)) if ('envMapIntensity' in m) m.envMapIntensity = k; }
const cDayFog = new THREE.Color(0.5, 0.3, 0.175), cDuskFog = new THREE.Color(0.2, 0.12, 0.1), cBlack = new THREE.Color(0, 0, 0);
const cSunDay = new THREE.Color(1.0, 0.88, 0.75), cSunDusk = new THREE.Color(1.0, 0.55, 0.3);
/** Lighting for a given place: dusk 0 (day) → 1 (night), under 0 (surface) → 1 (deep in the cave). */
function lightWorld(dusk, under, focus) {
  state.mode = '3d'; state.under = under; state.dusk = dusk; state.focus = focus;
  surface.skyMat.uniforms.uDusk.value = dusk; surface.skyMat.uniforms.uTime.value = time;
  surface.group.visible = under < 0.999;
  const el = lerp(W3.sunEl, -0.035, smooth(0.35, 1, dusk));
  const sunDir = W3.sunH.clone().multiplyScalar(Math.cos(el)).setY(Math.sin(el));
  surface.skyMat.uniforms.uSun.value.copy(sunDir);
  const sunK = (1 - under) * lerp(2.6, 0.5, dusk) * smooth(-0.03, 0.09, Math.sin(el));
  sun.intensity = sunK; sun.color.copy(cSunDay).lerp(cSunDusk, dusk);
  sun.target.position.copy(focus); sun.position.copy(focus).addScaledVector(sunDir, 70);
  sun.shadow.autoUpdate = sunK > 0.05;                            // (castShadow stays on: toggling it recompiles every shader)
  if (lamp) lamp.shadow.autoUpdate = under > 0.01;
  hemi.intensity = lerp(lerp(0.95, 0.2, dusk), 0.22, under);
  hemi.color.setRGB(lerp(0.88, 0.5, dusk), lerp(0.7, 0.4, dusk), lerp(0.55, 0.45, dusk));
  rim.intensity = lerp(0.3, 0.35, under);
  lamp.intensity = 140 * under; camLight.intensity = 30 * under;
  scene.fog.color.copy(cDayFog).lerp(cDuskFog, dusk).lerp(cBlack, under);
  scene.fog.density = lerp(0.00042, 0.012, under);            // Mars air is clear on a calm day: the horizon stays sharp
  setDroneEnv(lerp(0.7, 0.18, under) * lerp(1, 0.4, dusk));
  surface.devils.forEach((d) => { d.material.uniforms.uTime.value = time; d.material.uniforms.uOpacity.value = 1 - smooth(0.45, 0.85, dusk); });
  const se = Math.round(lerp(1, 0.08, dusk) * 100) / 100;     // the image-based fill fades with the daylight
  if (se !== surfEnvK) { surfEnvK = se; for (const m of surfaceMats) m.envMapIntensity = se; }
  cave.skyDisc.visible = camera.position.y < GROUND_Y - 2;
}
function fitDistance(span, frac) {
  const r = sceneRect(), vt = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return span / (frac * 2 * vt * Math.min(r.w / r.h, 1.6));
}
const screenUnits = (worldSize, dist) => worldSize / (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
function lookFrom(pos, target) { camera.position.copy(pos); camera.lookAt(target); }

// vehicle cameras for the machine-vision feed
function navCam(pitchDown = 0.2, ahead = 10) {
  drone.object.updateMatrixWorld(true);
  const q = drone.body.getWorldQuaternion(new THREE.Quaternion());
  const f = new V3(0, 0, 1).applyQuaternion(q).setY(0).normalize();
  const from = drone.parts.camera.localToWorld(new V3(0, 0, 0.08)).addScaledVector(f, 0.3);
  return { from, look: from.clone().addScaledVector(f, ahead).add(new V3(0, -ahead * Math.tan(pitchDown), 0)), up: UPV.clone() };
}
function downCam(headingUp) {
  const from = drone.object.position.clone().add(new V3(0, -0.45, 0));
  return { from, look: from.clone().add(new V3(0, -10, 0)), up: headingUp.clone() };
}

// ------------------------------------------------------------------ 01 · mission video → globe → Tharsis
function S1(t) {
  const k = range(t, 0, 0.6), zoom = 1 + 0.35 * smooth(0.55, 0.72, t);
  state.intro = { k, zoom, alpha: 1 - smooth(0.6, 0.72, t) };
  const u = range(t, 0.72, 1);
  applyChain(u > 0 ? zoomBetween(matchView(1.35), views().tharsis, ease(u)) : matchView(zoom));
  stars.material.uniforms.uOpacity.value = smooth(0.6, 0.72, t);
  stars.material.uniforms.uScale.value = 1 + 0.06 * u;
  const w = range(t, 0.76, 0.9), out = smooth(0.93, 0.99, t);
  if (w > 0 && out < 1) {
    const s = 1 / curView.H, r = sceneRect();
    plates.mola.place((0 - curView.cx) * s, (GLOBE_DISC.y - curView.cy) * s, MOLA_DISC * s);
    plates.mola.opacity = 1 - out;
    const x = r.x + w * r.w;
    plates.mola.u.wipe.value = x * DPR;
    state.mola = { x, a: (1 - out) * smooth(0.76, 0.79, t) };
  }
  if (curView) { const q = worldToPx(tharsis); state.reticle = { x: q.x, y: q.y, a: smooth(0.9, 0.96, t), scale: lerp(1.7, 1, smooth(0.9, 1, t)) }; }
  state.loc = t > 0.72 ? 'THARSIS VOLCANIC PROVINCE' : null;
  state.rpm = 0;
}

// ------------------------------------------------------------------ 02 · entry past Olympus Mons → 3D landing beside the skylight
function S2(t) {
  const plateA = 1 - smooth(0.4, 0.5, t);                       // the orbital view dissolves into the 3D landing
  if (plateA > 0) {
    const v = views();
    applyChain(zoomBetween(v.tharsis, v.olympus, ease(range(t, 0, 0.4))), plateA);
    stars.material.uniforms.uOpacity.value = 1 - smooth(0, 0.18, t);
    state.heat = Math.sin(range(t, 0.02, 0.44) * Math.PI) * 0.85;
    state.loc = 'PASSING OLYMPUS MONS · 18.65°N 133.8°W';
  }
  if (t < 0.4) return;
  state.platesOver = plateA;
  {
    const u = range(t, 0.45, 1);
    lightWorld(0.05, 0, W3.lander);
    cave.group.visible = true;
    const land = easeOut(range(u, 0.04, 0.72));
    surface.lander.group.position.y = GROUND_Y + lerp(34, 0, land);
    surface.group.updateMatrixWorld(true);
    surface.lander.glowMat.opacity = 0.95 * smooth(0.0, 0.08, u) * (1 - smooth(0.68, 0.78, u)) * (0.85 + 0.15 * Math.sin(time * 30));
    surface.lander.setDoors(0); surface.lander.setLift(0);        // MAV-A1 rides down sealed inside the hangar
    drone.object.visible = false;
    state.storm = 0.12;
    surface.dustMat.uniforms.uCenter.value.copy(W3.lander); surface.dustMat.uniforms.uRadius.value = 10;
    surface.dustMat.uniforms.uT.value = range(u, 0.55, 1); surface.dustMat.uniforms.uOpacity.value = u > 0.55 ? 1 : 0;
    const L = new V3().subVectors(W3.lander, W3.pit).setY(0).normalize(), sd = new V3().crossVectors(L, UPV);
    lookFrom(W3.pit.clone().addScaledVector(L, -13).addScaledVector(sd, 4).add(new V3(0, 9, 0)),
      W3.pit.clone().lerp(W3.lander, 0.62).add(new V3(0, lerp(34, 0, land) * 0.92 + 0.6, 0)));   // the descending lander stays mid-frame
    state.loc = 'ARSIA MONS · SKYLIGHT RIM';
    state.rpm = 0;
    const lp = surface.lander.group.position;
    state.altOverride = lp.y - GROUND_Y;
    state.cv = { mode: 'hazard', a: smooth(0.47, 0.53, t) * (1 - smooth(0.79, 0.84, t)), from: new V3(lp.x, lp.y + 1.2, lp.z), look: new V3(lp.x, lp.y - 20, lp.z),
      up: W3.fwd, fov: 72, hideDrone: false, info: { alt: lp.y - GROUND_Y } };
  }
}

// ------------------------------------------------------------------ 03 · the hangar opens, the lift raises MAV-A1 to the rim, lift-off,
// a hover for the vehicle sheet, then forward to the pit (no turning)
function S3(t) {
  lightWorld(0.08, 0, W3.lander.clone().lerp(W3.pit, range(t, 0.55, 1)));
  cave.group.visible = true;
  drone.object.visible = true;
  state.storm = 0.16;
  surface.lander.setDoors(easeInOut(range(t, 0.02, 0.15)));
  surface.lander.setLift(easeInOut(range(t, 0.14, 0.25)));
  surface.group.updateMatrixWorld(true);
  const onPad = surface.padPoint(FOOT);
  const A = W3.pad.clone().add(new V3(0, 3.2, 0)), B = W3.hover;
  const climb = ease(range(t, 0.28, 0.4)) * 3.2;
  const u = easeInOut(range(t, 0.55, 0.97));
  const pos = u > 0 ? A.clone().lerp(B, u).add(new V3(0, 3 * Math.sin(Math.PI * u), 0)) : onPad.clone().add(new V3(0, climb, 0));
  drone.object.position.copy(pos);
  const ur = range(t, 0.55, 0.97);
  const pitch = 0.24 * bump(ur, 0, 0.2, 0.55) - 0.17 * bump(ur, 0.62, 0.86, 1);
  const hover = smooth(0.34, 0.42, t) * (1 - smooth(0.52, 0.56, t));
  drone.setAttitude(pitch + 0.018 * Math.sin(time * 2.7) * hover, 0.022 * Math.sin(time * 3.3 + 1) * hover, W3.yaw);
  state.rpm = lerp(0, 0.78, smooth(0.22, 0.3, t)) + 0.1 * bump(ur, 0, 0.2, 0.6);
  // rotor downwash lifts a ring of dust around the lander at take-off
  surface.dustMat.uniforms.uCenter.value.copy(W3.lander); surface.dustMat.uniforms.uRadius.value = 5;
  surface.dustMat.uniforms.uT.value = range(t, 0.28, 0.62); surface.dustMat.uniforms.uOpacity.value = t > 0.28 && t < 0.62 ? 0.6 : 0;

  // camera: above the front of the lander, looking into the opening hangar → level with MAV-A1 as it climbs out
  // (front view, for the vehicle sheet) → a chase from behind-left on the way to the pit. The drone stays centred.
  const D = fitDistance(SPAN, isNarrow() ? 0.8 : 0.48);
  const hangarCam = W3.lander.clone().addScaledVector(W3.fwd, lerp(9.6, 8.2, ease(range(t, 0, 0.28))) * camK()).addScaledVector(W3.side, 2.6 * camK()).add(new V3(0, 4.0 + 4.2 * camK(), 0));
  const az = lerp(0, 0.65, ease(range(t, 0.4, 0.55))), el = lerp(0.1, 0.2, smooth(0.4, 0.55, t));
  const dir = W3.fwd.clone().applyAxisAngle(UPV, az);
  const front = pos.clone().addScaledVector(dir, D * Math.cos(el)).add(new V3(0, D * Math.sin(el) + 0.1, 0));
  const chase = pos.clone().addScaledVector(W3.fwd, -8).addScaledVector(W3.side, -3.2).add(new V3(0, 2.8, 0));
  const kB = smooth(0.25, 0.38, t), kC = smooth(0.53, 0.64, t);
  lookFrom(hangarCam.lerp(front, kB).lerp(chase, kC), pos.clone().lerp(pos.clone().addScaledVector(W3.fwd, 5), kC));

  state.callouts = smooth(0.38, 0.42, t) * (1 - smooth(0.52, 0.55, t));
  state.calloutT = range(t, 0.38, 0.52);
  state.loc = t < 0.3 ? 'ARSIA MONS · LANDER · HANGAR OPEN' : 'ARSIA MONS · LANDER → SKYLIGHT';
  state.cv = { mode: 'obstacles', a: smooth(0.5, 0.57, t), ...navCam(0.22, 12), fov: 66, hideDrone: true, info: { target: W3.pit, speed: bump(ur, 0, 0.4, 1) } };
}

// ------------------------------------------------------------------ 04 · over the pit: straight-down view → HiRISE target lock (the white
// orbital photo, matched to the same framing) → vertical descent into the shaft (fixed heading)
const FOV_T = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
function S4(t) {
  const yHover = W3.hover.y;
  const y = t < 0.44 ? yHover : (t < 0.76 ? lerp(yHover, GROUND_Y - 12, ease(range(t, 0.44, 0.76))) : lerp(GROUND_Y - 12, W3.caveEntryY, ease(range(t, 0.76, 1))));
  const pos = W3.hover.clone().setY(y).add(surface.avoid(y));      // sidesteps the chockstones wedged in the shaft
  const under = 1 - smooth(GROUND_Y - 26, GROUND_Y - 4, y);
  lightWorld(0.1, under, pos);
  state.haze = under;
  cave.group.visible = true; drone.object.visible = true;
  drone.object.position.copy(pos);
  const flare = -0.14 * bump(t, 0, 0.04, 0.12);
  const lean = surface.avoid(y - 0.5).sub(surface.avoid(y + 0.5));     // leans into the sidestep (going down)
  drone.setAttitude(flare + 0.012 * Math.sin(time * 2.1) + 0.12 * lean.dot(W3.fwd), 0.012 * Math.sin(time * 2.6) - 0.12 * lean.dot(W3.side), W3.yaw);

  // camera: stage 03's chase → straight down over the pit (screen-up = flight direction) → follow the descent
  const r = sceneRect(), frac = 0.26 * r.h / H;                              // pit ≈ 26% of the scene height
  const dTop = (2 * surface.hole / frac) / (2 * FOV_T()) * lerp(1, 0.9, range(t, 0.12, 0.4));
  const top = W3.pit.clone().add(new V3(0, dTop, 0));
  const chase = pos.clone().addScaledVector(W3.fwd, -8).addScaledVector(W3.side, -3.2).add(new V3(0, 2.8, 0));
  const camY = pos.y + lerp(9, 7, range(t, 0.5, 1));
  const follow = W3.hover.clone().setY(camY).add(surface.avoid(camY, 2.7)).addScaledVector(W3.side, 1.3).addScaledVector(W3.fwd, -1.7);
  const kUp = ease(range(t, 0, 0.13)), kDown = smooth(0.38, 0.54, t);
  const camP = chase.clone().lerp(top, kUp).lerp(follow, kDown);
  const look = pos.clone().addScaledVector(W3.fwd, 5).lerp(W3.pit, kUp).lerp(pos.clone().add(new V3(0, -1.5, 0)), kDown);
  camera.up.copy(UPV).lerp(W3.fwd, kUp * (1 - kDown)).normalize();
  lookFrom(camP, look);

  // the HiRISE image of this skylight, scaled and turned to sit exactly on the 3D ground under the camera
  const photo = smooth(0.13, 0.19, t) * (1 - smooth(0.32, 0.38, t));
  const d = camP.y - GROUND_Y, worldH = 2 * d * FOV_T();
  if (photo > 0) {
    const pl = plates.pit, w = surface.imgW / worldH, h = w / pl.aspect;
    const U = camera.up, phi = Math.atan2(U.x, -U.z);
    const ox = (PIT.u - 0.5) * w, oy = -(PIT.v - 0.5) * h;
    const c = Math.cos(phi), sn = Math.sin(phi);
    pl.place(0, 0, w);
    pl.mesh.position.set(shift3D() * aspect - (ox * c - oy * sn), liftY() - (ox * sn + oy * c), 0);
    pl.mesh.rotation.z = phi;
    pl.opacity = photo; state.overlay = true;
  }
  const lock = smooth(0.19, 0.25, t) * (1 - smooth(0.34, 0.4, t));
  state.lock = lock * (t < 0.3 ? 1 : 0);
  if (lock > 0) {
    const c = subjectPx(), pitPx = (2 * surface.hole / worldH) * H;
    state.reticle = { x: c.x, y: c.y, a: lock, scale: (pitPx * 0.5 + 22) / 46 * lerp(1.6, 1, smooth(0.19, 0.3, t)) };
  }
  cave.set({ time, mapped: 0, lidarOpacity: 0, skylight: under, droneS: 0 });
  const dodging = t > 0.44 && surface.avoid(y).length() > 0.35;
  state.alert = dodging ? 'OBSTACLE · CHOCKSTONE · LATERAL AVOID' : t > 0.8 ? 'SUNLIGHT & ORBITER LINK LOST' : null;
  state.loc = photo > 0.5 ? 'HiRISE · ARSIA MONS SKYLIGHT' : (under < 0.5 ? 'ARSIA MONS · SKYLIGHT' : 'SKYLIGHT SHAFT');
  state.rpm = 0.66;
  const floorY = cave.pose(CAVE.SHAFT_S).P.y - CAVE.R * 0.5;
  state.cv = t < 0.44
    ? { mode: 'trn', a: 1, ...downCam(W3.fwd), fov: 74, hideDrone: true, info: { alt: pos.y - GROUND_Y } }
    : { mode: 'descent', a: 1, ...downCam(W3.fwd), fov: 80, hideDrone: true, info: { floor: pos.y - floorY, wall: CAVE.SHAFT_R, spurs: surface.spurs, avoid: surface.avoid(y).length() } };
}

// ------------------------------------------------------------------ 05–08 · inside the lava tube
const CAVE_S = () => [[P(5, 0), CAVE.SHAFT_S], [P(5, 1), 0.18], [P(6, 1), 0.42], [P(7, 0.333), 0.52], [P(7, 0.667), 0.56], [P(7, 1), 0.7],
  [P(8, 0.38), 0.742], [P(8, 0.93), 0.75], [P(8, 1), 0.78]];
let pathLen = 0;
function rigPosition(s, back, up, side) {
  pathLen = pathLen || cave.path.getLength();
  const behind = cave.pose(Math.max(0, s - back / pathLen));
  return behind.position.clone().addScaledVector(behind.up, up).addScaledVector(behind.side, side);
}
const weaveAt = (t6) => Math.sin(clamp(t6) * Math.PI * 3) * 1.6;
function caveStage(p) {
  const s = keyed(p, CAVE_S());
  const t5 = range(p, P(5, 0), P(5, 1)), t6 = range(p, P(6, 0), P(6, 1)), t7 = range(p, P(7, 0), P(7, 1)), t8 = range(p, P(8, 0), P(8, 1));
  const sid = stageOf(p) + 1;
  const pose = cave.pose(s, 0.6);
  lightWorld(0.1, 1, pose.position);
  cave.group.visible = true; drone.object.visible = true;

  const weave = sid === 6 ? weaveAt(t6) : 0;
  const fault = sid === 6 && t6 > 0.6 && t6 < 0.86;
  pose.position.addScaledVector(pose.side, weave);
  drone.object.position.copy(pose.position);
  const roll = (sid === 6 ? -Math.cos(t6 * Math.PI * 3) * 0.18 : 0) + (fault ? Math.sin(time * 9) * 0.04 : 0);
  drone.setAttitude(0.12, roll, pose.yaw);
  if (fault) { drone.setRotorFault(2); state.alert = 'MOTOR 3 FAULT // RE-TRIM ACTIVE'; }

  const back = keyed(p, [[P(5, 0), 7], [P(5, 0.6), 6], [P(6, 0.1), 6.5], [P(7, 0.25), 6], [P(7, 0.4), 8], [P(7, 0.62), 8], [P(7, 0.78), 13], [P(8, 0), 13], [P(8, 0.15), 7]]);
  const up = keyed(p, [[P(5, 0), 2.8], [P(5, 0.6), 1.9], [P(6, 0.1), 1.6], [P(7, 0.25), 1.8], [P(7, 0.4), 1.6], [P(7, 0.62), 1.6], [P(7, 0.78), 4.2], [P(8, 0), 4.2], [P(8, 0.15), 1.2]]);
  const side = keyed(p, [[P(5, 0), -2.6], [P(5, 0.8), -2.2], [P(6, 0.1), -2.4], [P(7, 0.25), -2.2], [P(7, 0.4), -3.6], [P(7, 0.62), -3.6], [P(7, 0.78), -1.5], [P(8, 0.15), -2]]);
  const camPos = rigPosition(s, back, up, side);
  const look = pose.position.clone().addScaledVector(pose.T, 1.5);
  if (sid === 7) look.lerp(cave.nodes[3].rest, 0.32 * bump(t7, 0.36, 0.45, 0.66));
  if (sid === 8) {
    const a = lerp(-0.7, 1.1, ease(range(t8, 0, 0.45))), r = 4.8;
    const orbit = pose.position.clone().addScaledVector(pose.side, Math.sin(a) * r).addScaledVector(pose.T, -Math.cos(a) * r).addScaledVector(pose.up, -0.7);
    camPos.lerp(orbit, smooth(0, 0.2, t8));
    look.lerp(pose.position.clone().addScaledVector(pose.up, 0.9), smooth(0, 0.2, t8));
    // pull back and up the tunnel to watch the outpost being drawn on the floor below the drone
    const H = habitat.center, HT = habitat.frameT, HS = habitat.side;
    // camera stations follow the tunnel's own curve, so they stay inside it
    const fw = cave.frame(0.745 - 24 / 262), fn = cave.frame(0.745 - 18 / 262);
    const wide = fw.P.clone().addScaledVector(fw.side, 3.2).add(new V3(0, 3.4, 0));
    const near = fn.P.clone().addScaledVector(fn.side, 2.6).add(new V3(0, 2.6, 0));
    const reveal = smooth(0.42, 0.6, t8);
    camPos.lerp(wide.lerp(near, ease(range(t8, 0.6, 0.95))), reveal);
    look.lerp(H.clone().addScaledVector(HT, 1.5).add(new V3(0, 1.4, 0)), reveal);
    habitat.update({ build: range(t8, 0.46, 0.86), opacity: smooth(0.42, 0.5, t8), lights: smooth(0.86, 0.92, t8), time });
    state.black = smooth(0.96, 1, t8);
  }
  if (sid === 5 && t5 < 0.12) {                           // continue from the shaft shot
    const k = smooth(0, 0.12, t5);
    camPos.lerpVectors(pose.position.clone().addScaledVector(W3.side, 2.4).addScaledVector(W3.fwd, -3.2).add(new V3(0, 7, 0)), camPos, k);
  }
  lookFrom(camPos, look);

  // LiDAR sweep from the puck, SLAM voxels building, VANGUARD-AI candidate paths
  drone.object.updateMatrixWorld(true);
  const puck = drone.parts.lidar.localToWorld(new V3(0, 0.12, 0));
  const scanO = sid === 5 ? 1 : sid === 6 ? 0.55 : sid === 7 ? 0.6 : 0.4;
  const q = drone.body.getWorldQuaternion(new THREE.Quaternion());
  const axes = { up: new V3(0, 1, 0).applyQuaternion(q), fwd: new V3(0, 0, 1).applyQuaternion(q), side: new V3(1, 0, 0).applyQuaternion(q) };
  cave.updateScan(puck, s, time, scanO, axes);
  updateLaserFan(puck, axes, scanO);
  state.haze = 1;
  if (sid === 6) {
    const ahead = clamp((weaveAt(t6 + 0.16) - weave) * 1.4, -2.6, 2.6);
    cave.updatePlanner(pose.position, pose, ahead, smooth(0.02, 0.08, t6) * (1 - smooth(0.92, 1, t6)));
  }

  const b = range(t7, 0.333, 0.667), c = range(t7, 0.667, 1);
  let nodeDrop = null;
  if (sid === 7 && b > 0 && b < 1) nodeDrop = { index: 3, t: range(b, 0.08, 0.55), from: drone.parts.node.getWorldPosition(new V3()) };
  const alertA = sid === 7 && t7 < 0.333;
  if (alertA) { drone.setAlert(true); state.alert = '[WARNING] SURFACE LOS LOST'; }
  state.static = alertA ? 0.6 * smooth(0, 0.05, t7) * (1 - smooth(0.26, 0.34, t7)) : 0;
  const pulse = sid === 5 ? ((t5 % 0.12) / 0.12) * 26 + 0.6 : ((time * 0.22) % 1) * 26 + 0.6;
  cave.set({
    time, droneS: s, origin: pose.position,
    mapped: Math.min(1, s + 0.03), lidarOpacity: sid === 8 ? 0.35 : 0.55, pulse,
    voxels: 0,
    wire: 0,
    boxes: sid === 6 ? 1 : 0,
    pathA: sid === 5 ? CAVE.SHAFT_S : (sid === 7 && c > 0 ? lerp(s, CAVE.SHAFT_S, ease(c)) : 0),
    pathB: sid === 5 ? s - 0.01 : (sid === 7 && c > 0 ? s : 0),
    pathOpacity: sid === 5 ? 0.6 : (sid === 7 && c > 0 ? 1 : 0), pathColor: sid === 5 ? 0xcff6ff : 0x00a8cc,
    nodeDrop, links: sid === 7 ? smooth(0.42, 0.62, t7) : (sid === 8 ? 0.6 : 0),
    stressScan: lerp(0.66, 0.84, range(t8, 0.06, 0.42)), stressOpacity: sid === 8 ? 0.42 * smooth(0.04, 0.12, t8) * (1 - smooth(0.4, 0.48, t8)) : 0,
    ice: sid === 8 ? smooth(0.2, 0.34, t8) * (1 - 0.75 * smooth(0.4, 0.5, t8)) : 0,
    skylight: sid === 5 ? 1 - 0.6 * smooth(0.3, 1, t5) : 0.15,
  });
  state.rpm = fault ? 0.72 : 0.62;
  state.mapped = s + 0.03; state.droneS = s;
  state.slam = { mapped: Math.min(1, s + 0.03), s, yaw: pose.yaw, backtrack: sid === 7 && c > 0 ? [lerp(s, CAVE.SHAFT_S, ease(c)), s] : null, overview: 0,
    nodesUp: sid >= 7 ? (sid === 7 ? (b > 0.5 ? 4 : 3) : 4) : 0, a: sid === 5 ? smooth(0, 0.08, t5) : 1, habitat: sid === 8 ? smooth(0.3, 0.46, t8) : 0 };
  state.loc = `LAVA TUBE · ${Math.round(s * 262)} M IN`;
  const node = cave.nodes[3].group;
  state.cv = { mode: 'cave', a: sid === 5 ? smooth(0, 0.06, t5) : (sid === 8 ? 1 - smooth(0.92, 0.97, t8) : 1), ...navCam(0.12, 10), fov: 70, hideDrone: true,
    info: { s, hazards: sid === 6, node: sid === 7 && node.visible ? node.position : null, ice: sid === 8 && t8 > 0.22 ? cave.surfacePoint(0.76, Math.PI / 2).lerp(cave.frame(0.76).P, 0.08) : null, loop: sid === 7 && c > 0.4,
      zone: sid === 8 && t8 > 0.26 ? habitat : null } };
  if (sid === 5 && t5 < 0.12) state.alert = 'SUNLIGHT & ORBITER LINK LOST';
}

const exitCam = () => W3.pit.clone().addScaledVector(W3.fwd, 16).addScaledVector(W3.side, 9).add(new V3(0, 22, 0));
const camK = () => (isNarrow() ? 1.6 : 1);                     // phones: a narrow frame, so the close shots step back
const dockCam = () => W3.pad.clone().add(W3.fwd.clone().multiplyScalar(6.5).addScaledVector(W3.side, 2.6).add(new V3(0, 3.2, 0)).multiplyScalar(camK()));

// ------------------------------------------------------------------ 09 · one turn, fly home, climb out, fly to the lander, dock
function S9(t) {
  const homeYaw = W3.yaw + Math.PI;                        // nose toward the lander for the trip back
  if (t < 0.36) {
    const turn = smooth(0.02, 0.1, t);
    const s = lerp(0.78, CAVE.SHAFT_S, easeInOut(range(t, 0.09, 0.36)));
    const pose = cave.pose(s, 0.6);
    lightWorld(0.25, 1, pose.position);
    cave.group.visible = true; drone.object.visible = true;
    drone.object.position.copy(pose.position);
    const cruise = smooth(0.1, 0.14, t) * (1 - smooth(0.31, 0.36, t));
    drone.setAttitude(0.15 * cruise, 0, pose.yaw + Math.PI * turn);
    const cam = cave.pose(Math.min(1, s + 0.02), 1.9);
    lookFrom(cam.position.clone().addScaledVector(cam.side, 1.5), pose.position.clone().addScaledVector(pose.T, -1.5));
    cave.set({ time, droneS: 0.8, mapped: 0.81, lidarOpacity: 0.14, pulse: 0, voxels: 0, wire: 0, links: 0.6, skylight: smooth(0.15, 0.36, t), origin: pose.position });
    state.slam = { mapped: 0.81, s, yaw: pose.yaw + Math.PI * turn, backtrack: [s, 0.78], overview: 0.45 * smooth(0.12, 0.36, t), nodesUp: 4, a: 1, habitat: 1 };
    habitat.update({ build: 1, opacity: 0.75 * (1 - smooth(0.24, 0.34, t)), lights: 1, time });
    state.haze = 1;
    state.black = Math.max(1 - smooth(0, 0.035, t), smooth(0.335, 0.36, t));
    state.loc = 'LAVA TUBE · RETURN';
    state.rpm = 0.8;
    state.cv = { mode: 'cave', a: smooth(0.04, 0.1, t) * (1 - smooth(0.3, 0.35, t)), ...navCam(0.1, 10), fov: 70, hideDrone: true, info: { s, loop: true } };
  } else if (t < 0.56) {
    const u = range(t, 0.36, 0.56);
    const y = lerp(W3.caveEntryY, W3.hover.y, easeInOut(u));
    const pos = W3.hover.clone().setY(y).add(surface.avoid(y));       // the same chockstones, dodged on the way up
    const under = 1 - smooth(GROUND_Y - 26, GROUND_Y - 4, y);
    lightWorld(0.3, under, pos);
    state.storm = 0.4;
    cave.group.visible = true; drone.object.visible = true;
    drone.object.position.copy(pos);
    const lean = surface.avoid(y + 0.5).sub(surface.avoid(y - 0.5));
    drone.setAttitude(0.12 * lean.dot(W3.fwd), -0.12 * lean.dot(W3.side), lerp(cave.pose(CAVE.SHAFT_S).yaw + Math.PI, homeYaw, smooth(0.2, 0.9, u)));
    // camera: above MAV-A1 looking down past it (the descent's view), rising with it and dodging the same rocks;
    // out of the pit it widens into the shot over the skylight
    const camY = y + lerp(7, 9, u);
    const above = W3.hover.clone().setY(camY).add(surface.avoid(camY, 2.7)).addScaledVector(W3.side, 1.3).addScaledVector(W3.fwd, 1.7);
    const kX = smooth(0.8, 1, u);
    lookFrom(above.lerp(exitCam(), kX), pos.clone().add(new V3(0, -1.5, 0)).lerp(W3.pit.clone().lerp(pos, 0.6), kX));
    state.cv = { mode: 'descent', a: smooth(0.37, 0.41, t) * (1 - smooth(0.52, 0.555, t)), from: pos.clone().add(new V3(0, 0.5, 0)), look: pos.clone().add(new V3(0, 10, 0)),
      up: W3.fwd.clone(), fov: 80, hideDrone: true, info: { climb: true, floor: GROUND_Y - y, wall: CAVE.SHAFT_R, spurs: surface.spurs, avoid: surface.avoid(y).length() } };
    if (surface.avoid(y).length() > 0.35) state.alert = 'OBSTACLE · CHOCKSTONE · LATERAL AVOID';
    cave.set({ time, droneS: 0.8, mapped: 0.81, lidarOpacity: 0.3, pulse: 0, voxels: 0, wire: 0, links: 0.3, skylight: under, origin: pos });
    state.slam = { mapped: 0.81, s: CAVE.SHAFT_S, yaw: 0, backtrack: [CAVE.SHAFT_S, 0.78], overview: lerp(0.45, 1, u), nodesUp: 4, a: 1, habitat: 1 };
    state.haze = under;
    state.black = Math.max(state.black, 1 - smooth(0.36, 0.385, t));
    state.loc = under > 0.5 ? 'SKYLIGHT SHAFT · CLIMB' : 'ARSIA MONS · SKYLIGHT';
    state.rpm = 0.85;
  } else {
    // home ahead of a dust storm: land on the raised pad, ride the lift down into the hangar, the doors seal
    const u = range(t, 0.56, 1);
    state.storm = lerp(0.42, 0.82, u);
    lightWorld(lerp(0.3, 0.5, u), 0, W3.lander.clone().lerp(W3.pit, 0.3));
    cave.group.visible = true; drone.object.visible = true;
    const lift = 1 - easeInOut(range(u, 0.8, 0.9)), doors = 1 - easeInOut(range(u, 0.89, 0.99));
    surface.lander.setLift(lift); surface.lander.setDoors(doors);
    surface.group.updateMatrixWorld(true);
    const onPad = surface.padPoint(FOOT);
    const A = W3.hover, Bp = W3.pad.clone().add(new V3(0, 3, 0));
    const f = easeInOut(range(u, 0, 0.6));
    let pos = A.clone().lerp(Bp, f).add(new V3(0, 2.5 * Math.sin(Math.PI * f), 0));
    if (u > 0.6) pos = Bp.clone().lerp(W3.pad, ease(range(u, 0.6, 0.76)));
    if (u > 0.78) pos = onPad;                                        // rides the lift down into the hangar
    drone.object.position.copy(pos);
    drone.object.visible = doors > 0.003;
    const fr = range(u, 0, 0.6);
    drone.setAttitude(0.22 * bump(fr, 0, 0.2, 0.55) - 0.15 * bump(fr, 0.62, 0.86, 1), 0, homeYaw);
    const chase = pos.clone().addScaledVector(W3.fwd, 8.5).addScaledVector(W3.side, 3.2).add(new V3(0, 1.4, 0));
    const ahead = pos.clone().addScaledVector(W3.fwd, -6).add(new V3(0, -1.2, 0));
    const k0 = smooth(0, 0.22, u), k = smooth(0.55, 0.78, u);
    const dc = dockCam().add(new V3(0, 1.6 * smooth(0.78, 0.92, u), 0));        // rises to look down into the hangar
    const camP = exitCam().lerp(chase, k0).lerp(dc, k);
    const look = W3.pit.clone().lerp(pos, 0.6).lerp(ahead, k0).lerp(pos.clone().add(new V3(0, -0.2, 0)), k);
    lookFrom(camP, look);
    state.slam = { mapped: 0.81, s: CAVE.SHAFT_S, yaw: 0, backtrack: null, overview: 1, nodesUp: 4, a: 1, habitat: 1 };
    emRings.position.copy(onPad).add(new V3(0, FOOT + 0.04, 0));
    emRings.visible = u > 0.6 && u < 0.88;
    emRings.children.forEach((r, i) => { r.material.opacity = smooth(0.62, 0.72, u) * (1 - smooth(0.8, 0.87, u)) * (0.55 + 0.45 * Math.sin(time * 3 + i * 1.6)); r.scale.setScalar(1 + 0.08 * Math.sin(time * 2.4 + i)); });
    state.rpm = lerp(0.72, 0, smooth(0.74, 0.84, u));
    state.loc = u < 0.78 ? 'ARSIA MONS · LANDER' : doors > 0.003 ? 'ARSIA MONS · HANGAR CLOSING' : 'ARSIA MONS · HANGAR SEALED';
    state.alert = u > 0.06 && u < 0.6 ? 'DUST OPACITY RISING · RETURN TO HANGAR' : null;
    state.tau = 0.6 + 2.3 * state.storm;                               // optical depth (SIM): ~1.6 → 2.5 on the way home
    const dockA = smooth(0.0, 0.08, u) * (1 - smooth(0.8, 0.86, u));
    state.cv = u < 0.55
      ? { mode: 'obstacles', a: dockA, ...navCam(0.3, 12), fov: 66, hideDrone: true, info: { lander: W3.lander } }
      : { mode: 'dock', a: dockA, ...downCam(W3.fwd.clone().negate()), fov: 70, hideDrone: true,
        info: { pad: emRings.position.clone(), err: Math.hypot(pos.x - W3.pad.x, pos.z - W3.pad.z) + 0.02, alt: Math.max(0, pos.y - W3.pad.y) } };
  }
}

// ------------------------------------------------------------------ 10 · mission successful: docked at dusk, camera cranes up to the whole site
// ------------------------------------------------------------------ 10 · mission successful (sunset, Earth, uplink) → epilogue
function S10(t) {
  if (t < 0.74) { S10success(range(t, 0, 0.74)); state.black = Math.max(state.black, smooth(0.68, 0.74, t)); }
  else S10epilogue(range(t, 0.74, 1));
}
// epilogue, some night in the future: warm light rising out of the skylight from the outpost below
function S10epilogue(e) {
  lightWorld(1, 0, W3.pit);
  hemi.intensity = 0.05; hemi.color.setRGB(0.42, 0.52, 0.82);          // starlight only: the skylight is the one warm thing
  rim.intensity = 0.02;
  cave.group.visible = true;
  surface.lander.setDoors(0); surface.lander.setLift(0);
  state.storm = 0.3;
  habitat.update({ epilogue: smooth(0.04, 0.4, e), time });
  const from = W3.pit.clone().addScaledVector(W3.side, 27).addScaledVector(W3.fwd, -15).add(new V3(0, 22, 0));
  const to = W3.pit.clone().addScaledVector(W3.side, 18).addScaledVector(W3.fwd, -9).add(new V3(0, 14, 0));
  lookFrom(from.lerp(to, easeInOut(e)), W3.pit.clone().add(new V3(0, 2, 0)));
  cave.set({ time, droneS: 0.8, mapped: 0.81, lidarOpacity: 0, pulse: 0, voxels: 0, wire: 0, links: 0, skylight: 0, origin: W3.pit });
  state.black = 1 - smooth(0.0, 0.16, e);
  state.loc = 'ARSIA MONS · SOMEDAY';
  state.rpm = 0;
}
function S10success(t) {
  const dusk = lerp(0.5, 0.97, ease(range(t, 0, 0.8)));
  lightWorld(dusk, 0, W3.lander.clone().lerp(W3.pit, 0.5));
  cave.group.visible = true;
  surface.lander.setDoors(0); surface.lander.setLift(0);             // sealed: MAV-A1 charges inside, out of the dust
  state.storm = lerp(0.6, 0.45, t);
  state.tau = 0.6 + 2.3 * state.storm;
  surface.lander.ringMat.emissiveIntensity = 1.6 + 0.8 * Math.sin(time * 2.2);
  // camera: from the docking close-up, circle round the lander until it looks into the sunset
  const C = W3.lander.clone(), start = dockCam().add(new V3(0, 1.6, 0)).sub(C);     // picks up where the docking shot ended
  const a0 = Math.atan2(start.z, start.x), r0 = Math.hypot(start.x, start.z), h0 = start.y;
  const back = W3.sunH.clone().negate().applyAxisAngle(UPV, 0.1);             // stand behind the lander: it is silhouetted on the sunset
  const a1 = Math.atan2(back.z, back.x);
  let da = a1 - a0; while (da > Math.PI) da -= Math.PI * 2; while (da < -Math.PI) da += Math.PI * 2;
  const k = easeInOut(range(t, 0.08, 0.8));
  const a = a0 + da * k, r = lerp(r0, 21, k), h = lerp(h0, 3.6, k) + Math.sin(Math.PI * k) * 5;
  const camP = C.clone().add(new V3(Math.cos(a) * r, h, Math.sin(a) * r));
  const horizon = C.clone().addScaledVector(W3.sunH, 60).add(new V3(0, 9, 0));
  lookFrom(camP, W3.pad.clone().add(new V3(0, -1.2, 0)).lerp(horizon, ease(range(t, 0.1, 0.85))));
  // the map leaves for Earth: packets climbing a thin beam from the lander's dish
  const up = smooth(0.32, 0.5, t);
  // the map crosses ~228 million km: light needs ~12 min 40 s (scroll-compressed here), then Earth flashes
  const tx = range(t, 0.36, 0.88);
  state.eta = t > 0.33 ? { remain: (1 - tx) * LIGHT_TIME, k: tx, received: t >= 0.88 } : null;
  surface.skyMat.uniforms.uEarthGlow.value = 1 + 3 * bump(t, 0.87, 0.9, 1);
  if (up > 0) { uplink.visible = true; uplink.material.uniforms.uOpacity.value = up; uplink.material.uniforms.uTime.value = time; }
  cave.set({ time, droneS: 0.8, mapped: 0.81, lidarOpacity: 0, pulse: 0, voxels: 0, wire: 0, links: 0, skylight: 0.35, origin: W3.pit });
  state.slam = { mapped: 0.81, s: CAVE.SHAFT_S, yaw: 0, backtrack: null, overview: 1, nodesUp: 4, a: smooth(0.04, 0.16, t) * (1 - smooth(0.5, 0.66, t)), habitat: 1 };
  state.loc = t < 0.45 ? 'ARSIA MONS · HANGAR SEALED · CHARGING' : 'UPLINK → EARTH · VIA MRO';
  state.rpm = 0;
}
function createUplink() {
  const L = 900, g = new THREE.CylinderGeometry(1.4, 0.05, L, 10, 1, true);
  g.translate(0, L / 2, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: 'varying float vL; void main(){ vL = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uTime, uOpacity; varying float vL;
      void main(){ float l = clamp(vL, 0.0, 1.0); float pk = fract(l * 26.0 - uTime * 0.9); float packet = smoothstep(0.86, 0.97, pk) * (1.0 - smoothstep(0.97, 1.0, pk));
        float a = (0.035 + packet * 0.6) * (1.0 - smoothstep(0.3, 1.0, l)) * smoothstep(0.0, 0.004, l) * uOpacity;
        gl_FragColor = vec4(vec3(0.35, 0.85, 1.0) * (1.0 + packet), a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const m = new THREE.Mesh(g, mat); m.name = 'uplink'; m.frustumCulled = false; m.visible = false;
  surface.group.updateMatrixWorld(true);
  m.position.copy(surface.lander.dish.getWorldPosition(new V3()));
  m.quaternion.setFromUnitVectors(UPV, W3.earth);
  scene.add(m);
  return m;
}

// ------------------------------------------------------------------ lamp haze (cave): visible beam + dust motes lit by the lamp
function createLampHaze() {
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `varying float vL; varying vec3 vN, vV;
      void main(){ vL = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uOpacity; varying float vL; varying vec3 vN, vV;
      void main(){ float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.2); float l = clamp(vL, 0.0, 1.0); float along = pow(l, 1.6) * (1.0 - smoothstep(0.92, 1.0, l));
        gl_FragColor = vec4(vec3(0.75, 0.88, 1.0), edge * along * uOpacity * 0.11); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const g = new THREE.ConeGeometry(4.6, 13, 40, 1, true); g.translate(0, -6.5, 0);   // apex at the lamp, opening forward
  const beam = new THREE.Mesh(g, beamMat); beam.name = 'lamp-beam';
  beam.position.copy(LAMP_AT);
  beam.quaternion.setFromUnitVectors(new V3(0, -1, 0), LAMP_AIM.clone().sub(LAMP_AT).normalize());
  drone.body.add(beam);
  const M = MOBILE ? 500 : 1400, mp = new Float32Array(M * 3), ms = new Float32Array(M);
  for (let i = 0; i < M; i++) { mp.set([(Math.random() - 0.5) * 16, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 16], i * 3); ms[i] = Math.random(); }
  const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.BufferAttribute(mp, 3)); mg.setAttribute('aSeed', new THREE.BufferAttribute(ms, 1));
  const motesMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 }, uCenter: { value: new V3() }, uLamp: { value: new V3() }, uDir: { value: new V3(0, 0, 1) }, uPx: { value: DPR } },
    vertexShader: `attribute float aSeed; uniform float uTime, uPx; uniform vec3 uCenter, uLamp, uDir; varying float vA;
      void main(){ vec3 p = position + vec3(sin(uTime * 0.3 + aSeed * 40.0), sin(uTime * 0.21 + aSeed * 17.0) * 0.6, cos(uTime * 0.27 + aSeed * 23.0)) * 0.6;
        p = uCenter + mod(p - uCenter + 8.0, 16.0) - 8.0;
        vec3 v = p - uLamp; float d = length(v); float inBeam = smoothstep(0.82, 0.95, dot(v / max(d, 1e-3), uDir)) * (1.0 - smoothstep(4.0, 13.0, d));
        vA = inBeam * (0.35 + 0.65 * aSeed);
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = uPx * clamp(14.0 / -mv.z, 0.6, 3.0); }`,
    fragmentShader: `uniform float uOpacity; varying float vA; void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25 || vA < 0.01) discard;
        gl_FragColor = vec4(1.0, 0.93, 0.85, vA * uOpacity * (1.0 - d * 4.0)); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const motes = new THREE.Points(mg, motesMat); motes.frustumCulled = false; scene.add(motes);
  return { beam, motes };
}
const LAMP_AT = new V3(0, -0.1, 0.45), LAMP_AIM = new V3(0, -2.2, 7);   // on the drone's body: under the nose, aimed ahead and down
function followLamp() {
  drone.object.updateMatrixWorld(true);
  lamp.position.copy(LAMP_AT).applyMatrix4(drone.body.matrixWorld);
  lamp.target.position.copy(LAMP_AIM).applyMatrix4(drone.body.matrixWorld);
  lamp.updateMatrixWorld(); lamp.target.updateMatrixWorld();
}
function updateLampHaze() {
  const k = state.haze * (drone.object.visible ? 1 : 0);
  beam.material.uniforms.uOpacity.value = k; beam.visible = k > 0.01;
  motes.visible = k > 0.01;
  if (!motes.visible) return;
  const u = motes.material.uniforms;
  u.uOpacity.value = k; u.uTime.value = time; u.uCenter.value.copy(drone.object.position);
  drone.object.updateMatrixWorld(true);
  u.uLamp.value.setFromMatrixPosition(lamp.matrixWorld);
  u.uDir.value.setFromMatrixPosition(lamp.target.matrixWorld).sub(u.uLamp.value).normalize();
}
// the LiDAR's instantaneous scan plane: a faint fan of laser light turning with the head (same phase as the rock shader)
function createLaserFan() {
  const R = 6, N = 24, pos = [0, 0, 0], uv = [0, 0], idx = [];
  for (let i = 0; i <= N; i++) { const e = -0.3927 + (i / N) * 0.7854; pos.push(Math.cos(e) * R, Math.sin(e) * R, 0); uv.push(1, i / N); }
  for (let i = 1; i <= N; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uOpacity; varying vec3 vP; void main(){ float r = length(vP) / 6.0;
      gl_FragColor = vec4(vec3(0.55, 0.9, 1.0), pow(1.0 - smoothstep(0.0, 1.0, r), 2.0) * smoothstep(0.0, 0.04, r) * uOpacity * 0.045); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.visible = false; mesh.name = 'lidar-fan';
  scene.add(mesh);
  return mesh;
}
const _fm = new THREE.Matrix4();
function updateLaserFan(origin, axes, k) {
  fan.visible = k > 0.01; if (!fan.visible) return;
  const az = (((time * 0.42) % 1) - 0.5) * Math.PI * 2;          // where the head points (matches the shader)
  const dir = axes.fwd.clone().multiplyScalar(Math.cos(az)).addScaledVector(axes.side, Math.sin(az)).normalize();
  const z = new V3().crossVectors(dir, axes.up).normalize();
  _fm.makeBasis(dir, axes.up.clone().normalize(), z);
  fan.quaternion.setFromRotationMatrix(_fm);
  fan.position.copy(origin);
  fan.material.uniforms.uOpacity.value = k;
}

const slamBox = $('#slam-box');
const cvBox = $('#cv-box');
let cvA = 0, cvShown = -1;
let slamA = -1;
function updateSlamBox() {
  const st = state.slam, a = st ? st.a : 0;
  if (Math.abs(a - slamA) > 0.004) { slamBox.style.opacity = a.toFixed(3); slamA = a; }
  if (a > 0.01 && (RECORDING || (++slamTick & 1) === 1)) slam.render({ ...st, time });   // the map view at 30 Hz
}

// ------------------------------------------------------------------ sound (procedural, off until the visitor turns it on)
const audio = createAudio();
const sndBtn = $('#snd');
if (!audio) sndBtn.hidden = true;
else sndBtn.addEventListener('click', () => {
  const on = audio.toggle();
  sndBtn.setAttribute('aria-pressed', String(on)); $('#snd-lbl').textContent = on ? 'SOUND ON' : 'SOUND OFF';
});
let aPrev = { p: 0, alert: null, lock: 0, flash: 0 };
function updateAudio(p, id, t) {
  const prev = aPrev;
  aPrev = { p, alert: state.alert, lock: state.lock, flash: state.flash };
  if (!audio || !audio.on) return;
  const space = id === 1 ? 1 : id === 2 ? 1 - smooth(0.25, 0.45, t) : 0;
  const surf = state.mode === '3d' && surface.group.visible ? 1 - state.under : 0;
  audio.update({ space, roar: state.heat, wind: surf * (0.8 + 0.7 * (state.storm || 0)), rotor: drone.object.visible ? clamp(state.rpm * 1.25) : 0, rpm: state.rpm, lidar: SCAN.rkScanOn.value, cave: state.under, rad: state.rad || 0 });
  if (p <= prev.p) return;                                   // cues only play going forward
  const crossed = (x) => prev.p < x && p >= x;
  if (state.lock > 0.5 && prev.lock <= 0.5) audio.cue('lock');
  if (state.alert && state.alert !== prev.alert) audio.cue('alert');
  if (state.flash > 0.5 && prev.flash <= 0.5) audio.cue('flash');
  if (crossed(P(7, 0.517))) audio.cue('node');
  if (crossed(P(9, 0.894))) audio.cue('dock');
  if (crossed(P(3, 0.02)) || crossed(P(9, 0.952))) audio.cue('doors');
  if (crossed(P(10, 0.02))) audio.cue('success');
  if (crossed(P(8, 0.87))) audio.cue('lights');
  if (crossed(P(10, 0.76))) audio.cue('epilogue');
  if (crossed(P(10, 0.74 * 0.88))) audio.cue('received');
}

// ------------------------------------------------------------------ presentation mode (for judges): the story plays itself
// About 3½ minutes end to end, with sound and fullscreen. Space pauses, ←/→ jump a stage, Esc stops; scrolling
// or touching by hand pauses it. Pace per stage: the climactic shots run a little slower.
const PACE = { 1: 1.05, 2: 1.0, 3: 0.95, 4: 0.9, 5: 1.0, 6: 1.05, 7: 1.1, 8: 0.75, 9: 1.0, 10: 0.62 };
// speed: 1× is the original pace (~3½ min); the choice is remembered on this computer
const SPEEDS = [1, 1.5, 2, 3, 4];
let speedI = 2;
try { const v = +localStorage.getItem('mav-present-speed'); if (SPEEDS.includes(v)) speedI = SPEEDS.indexOf(v); } catch { /* storage blocked */ }
const present = { on: false, paused: false, y: 0, speed: SPEEDS[speedI] };
const presBtn = $('#present'), presLbl = $('#present-lbl'), hintEl = $('#hint'), speedLbl = $('#speed-lbl');
function setSpeed(i) {
  speedI = clamp(i, 0, SPEEDS.length - 1); present.speed = SPEEDS[speedI];
  speedLbl.textContent = `${present.speed}×`;
  try { localStorage.setItem('mav-present-speed', String(present.speed)); } catch { /* storage blocked */ }
  presentUI();
}
function presentUI() {
  presBtn.setAttribute('aria-pressed', String(present.on));
  presBtn.classList.toggle('paused', present.on && present.paused);
  presLbl.textContent = !present.on ? 'PRESENT' : present.paused ? 'PAUSED' : 'PLAYING';
  hintEl.textContent = present.on ? `SPACE ❚❚ · ← → STAGE · ↑↓ SPEED ${present.speed}× · ESC` : 'SCROLL ↓';
}
function startPresent() {
  present.on = true; present.paused = false;
  if (audio && !audio.on) { const on = audio.toggle(); sndBtn.setAttribute('aria-pressed', String(on)); $('#snd-lbl').textContent = on ? 'SOUND ON' : 'SOUND OFF'; }
  const el = document.documentElement;
  if (el.requestFullscreen && !document.fullscreenElement && !isNarrow()) el.requestFullscreen().catch(() => {});
  if (pTarget > 0.995) scrollTo({ top: 0, behavior: 'auto' });
  present.y = scrollY;
  presentUI();
}
function stopPresent() {
  present.on = false; present.paused = false; presentUI();
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}
function presentTick(dt) {
  if (!present.on || present.paused) return;
  const id = stageOf(pTarget) + 1, max = maxScroll();
  present.y = Math.min(max, present.y + 7.0 * PACE[id] * present.speed * innerHeight / 100 * dt);
  scrollTo({ top: present.y, behavior: 'auto' });
  if (present.y >= max - 0.5) { present.paused = true; presentUI(); }   // stays on the last frame
}
function presentJump(dir) {
  const id = clamp(stageOf(pTarget) + 1 + dir, 1, ST.length);
  present.y = P(id, dir > 0 ? 0.01 : 0.01) * maxScroll();
  scrollTo({ top: present.y, behavior: 'auto' });
}
presBtn.addEventListener('click', () => (present.on ? stopPresent() : startPresent()));
$('#speed').addEventListener('click', () => setSpeed((speedI + 1) % SPEEDS.length));
speedLbl.textContent = `${present.speed}×`;
addEventListener('keydown', (e) => {
  if (!present.on) return;
  if (e.code === 'Space') { e.preventDefault(); present.paused = !present.paused; present.y = scrollY; presentUI(); }
  else if (e.code === 'ArrowRight' || e.code === 'PageDown') { e.preventDefault(); presentJump(1); }
  else if (e.code === 'ArrowLeft' || e.code === 'PageUp') { e.preventDefault(); presentJump(-1); }
  else if (e.code === 'Escape') stopPresent();
  else if (e.code === 'ArrowUp' || e.key === '+') { e.preventDefault(); setSpeed(speedI + 1); }
  else if (e.code === 'ArrowDown' || e.key === '-') { e.preventDefault(); setSpeed(speedI - 1); }
});
const handPause = () => { if (present.on && !present.paused) { present.paused = true; presentUI(); } };
addEventListener('wheel', handPause, { passive: true });
addEventListener('touchstart', handPause, { passive: true });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && present.on && !isNarrow()) { /* left fullscreen with Esc: keep playing windowed */ } });

if (new URLSearchParams(location.search).has('record')) document.body.classList.add('rec');   // tools/record_presentation.mjs

// ------------------------------------------------------------------ DOM: panel beats, HUD, overlays
// Kinetic captions: the big outlined stage number drifts behind, title words slide up out of a mask,
// tag lines decode like incoming telemetry, and a hairline under the stage label shows how far into
// the shot you are. All of it is driven by scroll (--in = arrival, --t = progress through the shot).
const GLYPHS = '01<>/\\|#%+=*:·▮▯';
const beats = [...document.querySelectorAll('.panel .beat')].map((el) => {
  const s = +el.dataset.s;
  if (el.closest('.cap')) {
    el.dataset.num = String(s).padStart(2, '0');
    el.querySelectorAll('h1, h2').forEach((h) => {
      const words = h.textContent.trim().split(/\s+/);
      h.setAttribute('aria-label', h.textContent.trim());
      h.innerHTML = words.map((w, i) => `<span class="w" aria-hidden="true" style="--wi:${i}"><span>${w}</span></span>`).join(' ');
    });
  }
  const tags = [...el.querySelectorAll('.cap .tag')].filter((t) => t.children.length === 0).map((t) => ({ el: t, text: t.textContent, shown: '' }));
  return { el, a: P(s, +el.dataset.t0), b: P(s, +el.dataset.t1), last: -1, tags };
});
function decode(tag, k) {
  const n = tag.text.length, upto = Math.floor(n * clamp(k * 1.25));
  let out = tag.text.slice(0, upto);
  for (let i = upto; i < n; i++) { const c = tag.text[i]; out += c === ' ' || k <= 0 ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0]; }
  if (out !== tag.shown) { tag.el.textContent = out; tag.shown = out; }
}
const FADE = 0.004;
function updateBeats(p) {
  for (const B of beats) {
    const envIn = B.a <= 0 ? 1 : smooth(B.a, B.a + FADE, p);
    const envOut = B.b >= 0.999 ? 1 : 1 - smooth(B.b - FADE, B.b, p);
    const env = Math.min(envIn, envOut);
    const t = clamp((p - B.a) / (B.b - B.a));
    const inn = B.a <= 0 ? 1 : clamp((p - B.a) / (FADE * 2.6));
    if (B.tags.length && env > 0.005) B.tags.forEach((g) => decode(g, inn));
    const key = Math.round(env * 200) * 1e6 + Math.round(t * 400) * 1e3 + Math.round(inn * 100);
    if (key === B.last) continue; B.last = key;
    B.el.style.opacity = env.toFixed(3);
    B.el.style.visibility = env > 0.005 ? 'visible' : 'hidden';
    B.el.style.transform = `translateY(${((1 - env) * 14).toFixed(1)}px)`;
    B.el.style.setProperty('--t', t.toFixed(4));
    B.el.style.setProperty('--in', inn.toFixed(3));
  }
}

const ALT = () => [[0, 400000], [P(1, 0.6), 160000], [P(1, 1), 120000], [P(2, 0.4), 40000], [P(2, 0.45), 8000], [P(2, 0.47), 34], [P(2, 0.85), 0],
  [P(3, 0.08), 0], [P(3, 0.4), 3.2], [P(3, 0.7), 9], [P(3, 1), 9], [P(4, 0.44), 9], [P(4, 0.76), -12], [P(4, 1), -45], [P(5, 1), -60], [P(6, 1), -80],
  [P(7, 1), -95], [P(8, 1), -95], [P(9, 0.36), -50], [P(9, 0.56), 9], [P(9, 0.86), 3], [P(9, 0.95), 0], [1, 0]];
const RSSI = () => [[0, 100], [P(4, 0.6), 100], [P(4, 1), 70], [P(6, 1), 35], [P(7, 0.3), 5], [P(7, 0.62), 80], [P(7, 1), 85], [P(8, 1), 75], [P(9, 0.5), 100], [1, 100]];
const BAT = () => [[0, 100], [P(3, 0), 100], [P(3, 1), 96], [P(8, 1), 38], [P(9, 0.95), 36], [P(10, 0.5), 100], [1, 100]];
const hud = { tauR: $('#tau-row'), tauV: $('#tau-val'), tauB: $('#tau-bar'), concept: $('#concept-chip'), etaR: $('#eta-row'), etaV: $('#eta-val'), etaB: $('#eta-bar'), radV: $('#rad-val'), radB: $('#rad-bar'), radN: $('#rad-note'), altL: $('#alt-lbl'), altV: $('#alt-val'), altB: $('#alt-bar'), rV: $('#rssi-val'), rB: $('#rssi-bar'), bV: $('#bat-val'), bB: $('#bat-bar'), link: $('#hud-link'), alert: $('#hud-alert'), loc: $('#loc') };
let lastHud = '';
// ------------------------------------------------------------------ radiation dosimeter (SIM, physically reasoned)
// Cruise ≈ 1.8 mSv/day and Mars surface ≈ 0.67 mSv/day are the doses Curiosity's RAD measured. Underground,
// galactic cosmic rays only arrive through the open skylight: the dose scales with the fraction of the sky
// the drone can still see through the hole (radius ~7.4 m), falling further once it moves away from the
// opening under solid basalt, down to a small floor from the rock's own neutrons and radioactivity.
const DOSE = { cruise: 1.8, surface: 0.67, floor: 0.008 };
const LIGHT_TIME = 12 * 60 + 40;                                               // s, Mars → Earth at ~228 million km (varies 3–22 min)
let radShown = DOSE.cruise;
function radiationAt(p) {
  if (state.mode !== '3d') return keyed(p, [[0, DOSE.cruise], [P(2, 0.4), DOSE.cruise], [P(2, 0.47), DOSE.surface]]);
  const pos = drone.object.visible ? drone.object.position : W3.pad;
  const d = GROUND_Y - pos.y;
  if (d <= 0.5) return DOSE.surface;
  const hx = Math.hypot(pos.x - W3.pit.x, pos.z - W3.pit.z), R = surface.hole;
  const sky = 1 - d / Math.hypot(d, R);                                  // visible fraction of the upper hemisphere
  const away = hx > R ? Math.exp(-(hx - R) / 5) : 1;                    // behind the lip of the opening
  return DOSE.floor + (DOSE.surface - DOSE.floor) * Math.min(1, sky * 1.6) * away;
}
const fmtDose = (v) => (v >= 0.1 ? v.toFixed(2) : v.toFixed(3));

function updateHUD(p) {
  const alt = state.altOverride ?? keyed(p, ALT()), rssi = keyed(p, RSSI()), bat = keyed(p, BAT());
  const radT = radiationAt(p);
  radShown += (radT - radShown) * 0.12;                                       // a real dosimeter integrates; so does this
  if (Math.abs(radT - radShown) < 1e-4) radShown = radT;
  state.rad = radShown;
  const rad = fmtDose(radShown), radPct = Math.round((1 - radShown / DOSE.surface) * 100);
  let label, val, bar;
  if (alt >= 0) { label = 'ALTITUDE'; val = Math.abs(alt) >= 1000 ? `${(alt / 1000).toFixed(1)} KM` : `+${alt.toFixed(1)} M`; bar = Math.log10(alt + 1) / Math.log10(400001); }
  else { label = 'DEPTH'; val = `${alt.toFixed(1)} M`; bar = -alt / 95; }
  const eta = state.eta, etaTxt = eta ? (eta.received ? 'RECEIVED' : `${String(Math.floor(eta.remain / 60)).padStart(2, '0')}:${String(Math.floor(eta.remain % 60)).padStart(2, '0')}`) : '';
  // dust optical depth (SIM) while a storm is about; an honest "artist's concept" tag on every 3D shot
  const tau = state.mode === '3d' && state.under < 0.5 && state.tau ? state.tau : 0;
  const sid = stageOf(p) + 1;
  const concept = state.mode !== '3d' ? '' : [2, 3, 4, 9].includes(sid) ? "ARTIST'S CONCEPT · PIT DRAWN ~10× SMALLER" : "ARTIST'S CONCEPT";
  const sig = `${label}|${val}|${rssi.toFixed(0)}|${bat.toFixed(0)}|${state.alert}|${state.loc}|${rad}|${etaTxt}|${tau.toFixed(1)}|${concept}`;
  if (sig === lastHud) return; lastHud = sig;
  hud.altL.textContent = label; hud.altV.textContent = val; hud.altB.style.transform = `scaleX(${clamp(bar).toFixed(3)})`;
  hud.rV.textContent = `${rssi.toFixed(0)}%`; hud.rB.style.transform = `scaleX(${(rssi / 100).toFixed(3)})`; hud.rB.classList.toggle('low', rssi < 25);
  hud.etaR.style.display = eta ? '' : 'none';
  if (eta) {
    hud.etaV.textContent = etaTxt; hud.etaR.classList.toggle('done', eta.received);
    hud.etaB.style.transform = `scaleX(${eta.k.toFixed(3)})`;
  }
  hud.tauR.style.display = tau ? '' : 'none';
  if (tau) { hud.tauV.textContent = tau.toFixed(1); hud.tauB.style.transform = `scaleX(${clamp(tau / 4).toFixed(3)})`; }
  if (concept) hud.concept.textContent = concept;
  hud.concept.style.opacity = concept ? 0.9 : 0;
  hud.radV.textContent = `${rad} mSv/d`;
  hud.radB.style.transform = `scaleX(${clamp(Math.log10(radShown / 0.004) / Math.log10(2.5 / 0.004)).toFixed(3)})`;
  hud.radB.classList.toggle('hi', radShown > 1); hud.radB.classList.toggle('mid', radShown > 0.3 && radShown <= 1); hud.radB.classList.toggle('lo', radShown < 0.1);
  hud.radN.textContent = radShown > DOSE.surface * 1.05 ? 'INTERPLANETARY CRUISE' : radPct > 2 ? `${radPct}% BELOW THE SURFACE DOSE` : 'MARS SURFACE · NO SHIELDING';
  const roof = document.getElementById('rad-roof'); if (roof) roof.textContent = `${rad} mSv/d · −${Math.max(0, radPct)}%`;
  hud.bV.textContent = `${bat.toFixed(0)}%`; hud.bB.style.transform = `scaleX(${(bat / 100).toFixed(3)})`; hud.bB.classList.toggle('low', bat < 40);
  hud.link.classList.toggle('lost', rssi < 20);
  if (state.alert) hud.alert.textContent = state.alert;
  hud.alert.style.opacity = state.alert ? 1 : 0;
  if (state.loc) hud.loc.textContent = state.loc;
  hud.loc.style.opacity = state.loc ? 1 : 0;
  $('#charge-val').textContent = `${bat.toFixed(0)}%`;
  $('#charge-ring').setAttribute('stroke-dashoffset', (226.2 * (1 - bat / 100)).toFixed(1));
}

// Mission profile: the whole story as one altitude/depth line (orbit → surface → 95 m down → home),
// drawn on a log scale above ground and linear below it. The stage buttons sit over it, sized by stage length.
const PROFILE = { w: 300, h: 58, ground: 0.62 };
const profY = (alt) => (alt >= 0 ? PROFILE.ground - (Math.log10(alt + 1) / Math.log10(400001)) * PROFILE.ground * 0.92 : PROFILE.ground + (-alt / 95) * (1 - PROFILE.ground) * 0.86);
function buildScrubber() {
  const nav = $('#scrubber');
  nav.style.gridTemplateColumns = STAGES.map((st) => `${st[2]}fr`).join(' ');
  ST.forEach((st) => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', `Stage ${st.id}: ${st.name}`); b.title = `${String(st.id).padStart(2, '0')} · ${st.name}`;
    b.addEventListener('click', () => scrollTo({ top: P(st.id, 0.02) * maxScroll(), behavior: reduced ? 'auto' : 'smooth' }));
    nav.appendChild(b);
  });
  drawProfile();
}
let prof = null;
function drawProfile() {
  const svg = $('#profile'), r = svg.getBoundingClientRect();
  if (r.width < 10) return;
  const W2 = r.width, H2 = r.height, gy = PROFILE.ground * H2, N = 240, pts = [];
  for (let i = 0; i <= N; i++) { const q = i / N; pts.push([q * W2, profY(keyed(q, ALT())) * H2]); }
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const seps = ST.slice(1).map((st) => `<line class="sep" x1="${(st.start * W2).toFixed(1)}" x2="${(st.start * W2).toFixed(1)}" y1="2" y2="${H2 - 2}"/>`).join('');
  svg.setAttribute('viewBox', `0 0 ${W2} ${H2}`);
  svg.innerHTML = `<defs><clipPath id="prof-clip"><rect id="prof-rect" x="0" y="-10" width="0" height="${H2 + 20}"/></clipPath></defs>
    <rect class="under" x="0" y="${gy}" width="${W2}" height="${H2 - gy}"/>${seps}
    <line class="ground" x1="0" x2="${W2}" y1="${gy}" y2="${gy}"/>
    <text x="2" y="9">ORBIT</text><text x="2" y="${gy - 3}">SURFACE</text><text x="2" y="${H2 - 2}">−95 M</text>
    <path class="route" d="${d}"/><path class="done" d="${d}" clip-path="url(#prof-clip)"/>
    <circle class="halo" r="6"/><circle class="me" r="2.6"/>`;
  prof = { W2, H2, rect: svg.querySelector('#prof-rect'), me: svg.querySelector('.me'), halo: svg.querySelector('.halo') };
}
let lastStage = -1, lastAlert7 = null;
function updateScrubber(p) {
  if (prof) {
    const x = p * prof.W2, y = profY(keyed(p, ALT())) * prof.H2;
    prof.rect.setAttribute('width', x.toFixed(1));
    prof.me.setAttribute('cx', x.toFixed(1)); prof.me.setAttribute('cy', y.toFixed(1));
    prof.halo.setAttribute('cx', x.toFixed(1)); prof.halo.setAttribute('cy', y.toFixed(1));
    prof.halo.setAttribute('r', (5 + 3 * ((time * 1.3) % 1)).toFixed(2)); prof.halo.style.opacity = (0.7 * (1 - ((time * 1.3) % 1))).toFixed(2);
  }
  const i = stageOf(p), a7 = i === 6 && range(p, P(7, 0), P(7, 1)) < 0.333;
  if (i === lastStage && a7 === lastAlert7) return; lastStage = i; lastAlert7 = a7;
  [...$('#scrubber').children].forEach((b, k) => {
    b.classList.toggle('on', k === i); b.classList.toggle('done', k < i); b.classList.toggle('alert', k === 6 && a7);
    b.setAttribute('aria-current', k === i ? 'step' : 'false');
  });
  $('#stage-name').textContent = `${String(ST[i].id).padStart(2, '0')} · ${ST[i].name.toUpperCase()}`;
}

const fxEls = { flash: $('#fx-flash'), black: $('#fx-black'), heat: $('#fx-heat'), static: $('#fx-static') };
const fxLast = {};
function setFx(k, v) { const r = Math.round(v * 100) / 100; if (fxLast[k] === r) return; fxLast[k] = r; fxEls[k].style.opacity = r; }

const reticle = { svg: $('#reticle'), g: $('#reticle-g'), ring: $('#reticle-ring') };
const scanLine = Object.assign(document.createElement('div'), { className: 'fx' });
Object.assign(scanLine.style, { width: '2px', left: '0', right: 'auto', background: 'var(--lidar-cyan)', boxShadow: '0 0 16px 3px rgba(0,168,204,.75)', zIndex: 7 });
document.body.appendChild(scanLine);

// numbered markers on the drone; their names are listed in the panel (no text over the scene)
let callouts = [];
function buildCallouts() {
  const svg = $('#callouts');
  const defs = [
    () => drone.parts.lidar.localToWorld(new V3(0, 0.2, 0)),
    () => drone.parts.rotors[1].rotor.localToWorld(new V3(0, 0.02, 0)),
    () => drone.parts.camera.localToWorld(new V3(0, 0, 0.1)),
    () => drone.parts.node.localToWorld(new V3(0, 0, 0)),
    () => drone.body.localToWorld(new V3(-0.6, FOOT, 0.44)),
  ];
  const offs = [[34, -46], [40, -40], [-44, 30], [40, 40], [-44, 22]];
  callouts = defs.map((at, i) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = `<line stroke="#00A8CC" stroke-width="1.2"/><circle class="dot" r="3" fill="#00A8CC"/><circle class="badge" r="11" fill="rgba(0,168,204,0.9)"/><text>${i + 1}</text>`;
    svg.appendChild(g);
    return { g, at, off: offs[i], i };
  });
}
function updateCallouts() {
  const a = state.callouts;
  $('#callouts').style.opacity = a;
  if (a <= 0.01) return;
  drone.object.updateMatrixWorld(true);
  for (const c of callouts) {
    const p = projectPx(c.at());
    const k = smooth(c.i * 0.15, c.i * 0.15 + 0.35, state.calloutT);
    const ex = p.x + c.off[0] * k, ey = p.y + c.off[1] * k;
    const [line, dot, badge, text] = c.g.children;
    line.setAttribute('x1', p.x); line.setAttribute('y1', p.y); line.setAttribute('x2', ex); line.setAttribute('y2', ey);
    dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
    badge.setAttribute('cx', ex); badge.setAttribute('cy', ey);
    text.setAttribute('x', ex); text.setAttribute('y', ey);
    c.g.style.opacity = k;
  }
}
function updateOverlays() {
  if (state.reticle && state.reticle.a > 0.01) {
    reticle.g.setAttribute('transform', `translate(${state.reticle.x.toFixed(1)} ${state.reticle.y.toFixed(1)})`);
    reticle.ring.setAttribute('transform', `scale(${state.reticle.scale.toFixed(3)})`);
    reticle.svg.style.opacity = state.reticle.a;
  } else reticle.svg.style.opacity = 0;
  if (state.mola) { scanLine.style.transform = `translateX(${state.mola.x.toFixed(1)}px)`; scanLine.style.opacity = state.mola.a; }
  else scanLine.style.opacity = 0;
  updateCallouts();
}

// small neural-net graphic for the VANGUARD-AI card (activity animates while the planner runs)
let net = null;
function buildNet() {
  const svg = $('#ai-net'), layers = [5, 7, 7, 3], xs = [20, 110, 200, 280], nodes = [], edges = [];
  layers.forEach((n, li) => { for (let i = 0; i < n; i++) nodes.push({ li, x: xs[li], y: 12 + (i + 0.5) * (76 / n) }); });
  const byL = (l) => nodes.filter((n) => n.li === l);
  for (let l = 0; l < layers.length - 1; l++) for (const a of byL(l)) for (const b of byL(l + 1)) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    e.setAttribute('x1', a.x); e.setAttribute('y1', a.y); e.setAttribute('x2', b.x); e.setAttribute('y2', b.y);
    e.setAttribute('stroke', '#00A8CC'); e.setAttribute('stroke-width', '0.8'); svg.appendChild(e);
    edges.push({ e, ph: Math.random() * 6.28, sp: 2 + Math.random() * 4 });
  }
  for (const n of nodes) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', n.x); c.setAttribute('cy', n.y); c.setAttribute('r', 4); c.setAttribute('fill', n.li === 3 ? '#F0F6FC' : '#00A8CC'); svg.appendChild(c);
  }
  net = { edges };
}
let lastDom = '';
function updateWidgets(p) {
  if (p > P(6, 0) && p < P(6, 0.56) && net) for (const ed of net.edges) ed.e.setAttribute('opacity', (0.1 + 0.8 * Math.max(0, Math.sin(time * ed.sp + ed.ph))).toFixed(2));
  const s = state.droneS ?? 0, mapped = state.mapped ?? 0;
  const t7 = range(p, P(7, 0), P(7, 1)), t8beat = range(p, P(8, 0.03), P(8, 0.62));
  const sig = `${mapped.toFixed(3)}|${t7.toFixed(3)}|${t8beat.toFixed(3)}`;
  if (sig === lastDom) return; lastDom = sig;
  if (p > P(2, 0) && p < P(2, 0.45)) {
    const e = range(p, P(2, 0), P(2, 0.44));
    $('#edl-v').textContent = `${lerp(5.6, 0.45, Math.pow(e, 0.7)).toFixed(2)} KM/S`;
    $('#edl-g').textContent = `${(9.6 * Math.exp(-Math.pow((e - 0.32) / 0.16, 2)) + 0.38).toFixed(1)} g`;
    $('#edl-q').textContent = `${Math.round(1450 * Math.exp(-Math.pow((e - 0.26) / 0.15, 2)) + 40)} °C`;
  }
  if (state.slam) {
    const pts = Math.round(clamp(state.slam.mapped) * 1240000).toLocaleString('en-US');
    $('#pt-count').textContent = pts; $('#slam-pts').textContent = `${pts} PTS · ${Math.round(state.slam.mapped * 262)} M`;
  }
  if (t7 > 0 && t7 < 1) {
    const N = 60, pts = [];
    for (let i = 0; i <= N; i++) { const tt = (i / N) * t7; pts.push(`${(tt * 300).toFixed(1)},${(84 - keyed(P(7, tt), RSSI()) * 0.78).toFixed(1)}`); }
    $('#rssi-plot').setAttribute('points', pts.join(' '));
  }
  if (t8beat > 0 && t8beat < 1) {
    const h = (15 + 13 * t8beat) % 24, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    $('#thermal-clock').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    $('#bar-pit').style.width = `${lerp(34, 78, t8beat)}%`; $('#bar-surf').style.width = `${lerp(76, 30, t8beat)}%`;
  }
}

// ------------------------------------------------------------------ frame
const clock = new THREE.Clock();
let shadowTick = 0, slamTick = 0;
const lastShadowState = [false, false];
const tmpDir = new V3();
let time = 0;
function frame() {
  const raw = clock.getDelta(), dt = Math.min(raw, 0.05);
  qualityTick(raw);
  presentTick(dt);
  time += dt;
  pSmooth = reduced ? pTarget : pSmooth + (pTarget - pSmooth) * damp(7, dt);
  if (!(Math.abs(pTarget - pSmooth) >= 1e-5)) pSmooth = pTarget;               // also recovers from a NaN
  const p = pSmooth;

  const si = stageOf(p);
  const HOLD = [0.3, 0.5, 0.3, 0.25, 0.5, 0.35, 0.5, 0.5, 0.7, 0.6];
  const pv = reduced ? P(si + 1, si === 6 ? [0.15, 0.5, 0.85][Math.min(2, Math.floor(range(p, P(7, 0), P(7, 1)) * 3))] : HOLD[si]) : p;
  const id = stageOf(pv) + 1, t = range(pv, P(id, 0), P(id, 1));

  resetFrame();
  if (id === 1) S1(t);
  else if (id === 2) S2(t);
  else if (id === 3) S3(t);
  else if (id === 4) S4(t);
  else if (id >= 5 && id <= 8) caveStage(pv);
  else if (id === 9) S9(t);
  else S10(t);
  if (reduced) { state.flash = 0; state.static = 0; state.black = Math.min(state.black, 0.4); }

  // the dust storm: thicker air, a dimmer sun, the front rolling in over the mountains
  if (state.mode === '3d') {
    const k = state.storm, open = 1 - state.under;
    scene.fog.density += 0.0011 * k * open;                        // the horizon fades as dust optical depth rises
    sun.intensity *= 1 - 0.45 * k;                                 // less direct sunlight…
    hemi.intensity *= 1 + 0.3 * k;                                 // …more scattered, so shadows soften
    surface.setStorm(k, { time, sun: surface.skyMat.uniforms.uSun.value, light: lerp(1, 0.22, state.dusk), haze: scene.fog.color });
  }
  // the living surface: blowing sand, gusts, rotor downwash, stones dropping into the skylight
  const day = 1 - smooth(0.55, 0.95, state.dusk);
  env.update({ time, focus: state.focus, surfaceK: state.mode === '3d' ? (1 - state.under) * day : 0, light: lerp(1, 0.35, state.dusk),
    drone: drone.object.visible ? drone.object.position : null, rpm: state.rpm, shaftK: state.mode === '3d' && cave.group.visible ? 1 : 0,
    storm: state.storm, proj: innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))),
    top: smooth(0.45, 0.8, -camera.getWorldDirection(tmpDir).y) });
  drone.setRPM(state.rpm);
  drone.update(dt);
  followLamp();
  camera.updateMatrixWorld();
  // the lava tube is only drawn when the camera can see into it: underground, or looking steeply down into the pit
  if (state.mode === '3d' && cave.group.visible) {
    const cp = camera.position, dh = Math.hypot(cp.x - W3.pit.x, cp.z - W3.pit.z);
    camera.getWorldDirection(tmpDir);
    cave.applyInterior(cp.y < GROUND_Y - 1.5 || dh < surface.hole * 1.3 || (dh < 32 && tmpDir.y < -0.45));
  }
  // stones and gravel only near the camera: farther away they are smaller than a pixel
  if (state.mode === '3d') for (const c of surface.pebbles) {
    const bs = c.boundingSphere, far = c.name === 'gravel' ? 30 : 80;
    c.visible = camera.position.distanceTo(bs.center) - bs.radius < far;
  }
  stars.material.uniforms.uTime.value = time;
  lens.uniforms.uTime.value = time;
  lens.uniforms.uSat.value = state.mode === '3d' ? lerp(1.38, 1.05, state.under) : 1;
  lens.uniforms.uGrade.value = state.mode === '3d' ? 1 - state.under : 0;

  const intro = state.intro;
  drawIntro(intro ? intro.k : 0, intro ? intro.zoom : 1, intro ? intro.alpha : 0);
  setFx('flash', state.flash); setFx('black', state.black); setFx('heat', state.heat); setFx('static', state.static);
  updateBeats(p); updateHUD(p); updateScrubber(p); updateOverlays(); updateWidgets(p);
  updateLampHaze(); updateSlamBox(); updateAudio(p, id, t);
  // one feed window at a time on phones (the SLAM map wins in the cave)
  cvA = state.cv && state.mode === '3d' && !(isNarrow() && state.slam && state.slam.a > 0.01) ? state.cv.a : 0;
  if (Math.abs(cvA - cvShown) > 0.004) { cvBox.style.opacity = cvA.toFixed(3); cvShown = cvA; }
  $('#hint').style.opacity = present.on ? 1 : 1 - smooth(0.002, 0.02, p);

  if (intro && intro.alpha >= 0.999 && FR.count) return;   // the video frame covers everything
  if (state.mode === '3d') {
    renderer.shadowMap.autoUpdate = false;                          // shadows refresh at 30 Hz: half the shadow cost
    const lampOn = state.under > 0.01, sunOn = sun.shadow.autoUpdate;
    renderer.shadowMap.needsUpdate = RECORDING || (++shadowTick & 1) === 1 || lampOn !== lastShadowState[0] || sunOn !== lastShadowState[1];
    lastShadowState[0] = lampOn; lastShadowState[1] = sunOn;                // a light that just came on gets fresh shadows at once
    composer.render();
    if (state.overlay) { renderer.autoClear = false; renderer.clearDepth(); renderer.render(overlayScene, ortho); renderer.autoClear = true; }
    if (state.platesOver > 0.002) { renderer.autoClear = false; renderer.render(plateScene, ortho); renderer.autoClear = true; }
    if (cvA > 0.01) cv.render({ ...state.cv, time });
  } else {
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.render(plateScene, ortho);
  }
}
