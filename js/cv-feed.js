// "What MAV-A1 sees": a live machine-vision feed. The main 3D scene is rendered a second time from a
// camera on the vehicle (or the lander's descent camera) into the feed window, shown in grayscale like
// a real navigation camera, and the computer-vision layer is drawn on top from the actual scene:
//   hazard  · landing: every 2.5 m ground cell scored for rocks, slope and the pit; the safe cell is locked
//   obstacles · flight: rock detections with range and size, the skylight as the target, tracked features
//   trn     · over the pit: features matched to the HiRISE orbital image (terrain-relative navigation)
//   descent · in the shaft: wall features and range to the floor
//   cave    · lava tube: visual-inertial odometry tracks, boulders, hazards, relay nodes, ice
//   dock    · return: the induction pad's ring fitted as an ellipse, alignment error
// Every box, range and track comes from real geometry in the scene; confidences are simulated.
import * as THREE from 'three';

const V3 = THREE.Vector3;
const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export function createCvFeed({ box, canvas, renderer, scene, cave, surface, pit, pitImage, groundY, beforeRender, afterRender }) {
  const ctx = canvas.getContext('2d');
  const cam = new THREE.PerspectiveCamera(64, 16 / 9, 0.12, 1600);
  const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4();
  let havePrev = false, rect = null, cw = 0, chh = 0, dpr = 1;

  // ---- what the detector knows about the world (instance transforms from the scene itself)
  const collect = (sets) => {
    const out = [], m4 = new THREE.Matrix4(), p = new V3(), q = new THREE.Quaternion(), s = new V3();
    for (const set of sets) for (let i = 0; i < set.count; i++) { set.getMatrixAt(i, m4); m4.decompose(p, q, s); out.push({ p: p.clone(), r: Math.max(s.x, s.z), h: s.y, id: out.length }); }
    return out;
  };
  const rocks = collect(surface.rockSets);
  const boulders = collect(cave.boulders);
  const P0 = surface.pitCenter, L0 = surface.landerPos.clone().setY(groundY);
  const gFeat = [];
  for (let i = 0; gFeat.length < 1400 && i < 4000; i++) {
    const c = i % 2 ? L0 : P0, a = Math.random() * Math.PI * 2, r = 2 + Math.sqrt(Math.random()) * 64;
    const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
    if (Math.hypot(x - P0.x, z - P0.z) < surface.hole * 1.05) continue;
    gFeat.push(new V3(x, surface.height(x, z) + 0.03, z));
  }
  const rimFeat = [];                                                     // dense texture around the rim, for map matching
  for (let i = 0; i < 700; i++) {
    const a = Math.random() * Math.PI * 2, r = surface.hole * 1.08 + Math.random() * 11;
    const x = P0.x + Math.cos(a) * r, z = P0.z + Math.sin(a) * r;
    rimFeat.push(new V3(x, surface.height(x, z) + 0.03, z));
  }
  const cp = cave.cloudGeo.attributes.position.array, cFeat = [];
  for (let i = 0; i < 5000; i++) { const k = (Math.random() * (cp.length / 3)) | 0; cFeat.push(new V3(cp[k * 3], cp[k * 3 + 1], cp[k * 3 + 2])); }
  const sFeat = [], sc = cave.shaftCenter;
  for (let i = 0; i < 700; i++) { const a = Math.random() * Math.PI * 2, y = 3 + Math.random() * (groundY - 5); sFeat.push(new V3(sc.x + Math.cos(a) * 7.3, y, sc.z + Math.sin(a) * 7.3)); }
  // hazard grid for the landing camera
  const CS = 2.5, HZ = [];
  for (let gx = -11; gx <= 11; gx++) for (let gz = -11; gz <= 11; gz++) {
    const x = L0.x + gx * CS, z = L0.z + gz * CS;
    const sl = Math.hypot(surface.height(x + 1, z) - surface.height(x - 1, z), surface.height(x, z + 1) - surface.height(x, z - 1)) / 2;
    let rk = 0; for (const r of rocks) if (r.r > 0.25 && Math.hypot(r.p.x - x, r.p.z - z) < CS * 0.75 + r.r) rk += r.r;
    const inPit = Math.hypot(x - P0.x, z - P0.z) < surface.hole + 3;
    const score = Math.min(1, sl * 3.5 + rk * 0.9 + (inPit ? 1 : 0));
    const ys = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => new V3(x + u * CS / 2, surface.height(x + u * CS / 2, z + v * CS / 2) + 0.05, z + v * CS / 2));
    HZ.push({ x, z, score, inPit, corners: ys, slopeDeg: Math.atan(sl) * 57.3 });
  }
  // HiRISE image coordinates of a world point (for the terrain-relative navigation matches)
  const imgCx = P0.x + (0.5 - pit.u) * surface.imgW, imgCz = P0.z + (0.5 - pit.v) * surface.imgH;
  const toImg = (p) => [0.5 + (p.x - imgCx) / surface.imgW, 0.5 + (p.z - imgCz) / surface.imgH];

  // ---- projection helpers
  const tmp = new V3();
  function proj(p, m = curVP) {
    tmp.copy(p).applyMatrix4(m);
    if (tmp.z < -1 || tmp.z > 1) return null;
    return [(tmp.x * 0.5 + 0.5) * cw, (0.5 - tmp.y * 0.5) * chh, tmp.z];
  }
  const inView = (q, pad = 0) => q && q[0] > -pad && q[0] < cw + pad && q[1] > -pad && q[1] < chh + pad;
  function bbox(center, rx, ry, rz) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const q = proj(new V3(center.x + sx * rx, center.y + sy * ry, center.z + sz * rz));
      if (!q) continue; n++;
      x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
    }
    return n === 8 ? [x0, y0, x1, y1] : null;
  }

  // ---- drawing kit
  const C = { cyan: '#00E0FF', ok: '#3CFF9E', warn: '#FFC23D', bad: '#FF4B1F', white: 'rgba(240,246,252,0.92)', dim: 'rgba(240,246,252,0.55)' };
  const fs = () => Math.min(1, Math.max(0.74, (rect ? rect.width : 300) / 300));   // smaller labels in the narrow phone window
  const font = (px) => `600 ${px * fs() * dpr}px Saira, 'Space Grotesk', sans-serif`;
  function label(x, y, text, color, px = 9) {
    ctx.font = font(px); const w = ctx.measureText(text).width + 6 * dpr, h = (px + 4) * dpr;
    const lx = Math.min(Math.max(x, 0), cw - w), ly = Math.max(y - h, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(lx, ly, w, h);
    ctx.fillStyle = color; ctx.fillText(text, lx + 3 * dpr, ly + (px + 1) * dpr);
  }
  function boxed(b, color, text, dash = false) {
    const [x0, y0, x1, y1] = b, L = Math.min(10 * dpr, (x1 - x0) / 3, (y1 - y0) / 3);
    ctx.strokeStyle = color; ctx.lineWidth = 1.3 * dpr; ctx.setLineDash(dash ? [4 * dpr, 3 * dpr] : []);
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) { ctx.moveTo(cx + dx * L, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * L); }
    ctx.stroke(); ctx.setLineDash([]);
    if (text) label(x0, y0 - 1 * dpr, text, color);
  }
  function features(list, maxRange, color, limit = 140) {
    let n = 0; ctx.lineWidth = 1 * dpr;
    for (let i = 0; i < list.length && n < limit; i++) {
      const p = list[i]; if (p.distanceToSquared(cam.position) > maxRange * maxRange) continue;
      const q = proj(p); if (!inView(q, -4)) continue;
      n++;
      const r = 2.2 * dpr;
      ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(q[0] - r, q[1]); ctx.lineTo(q[0] + r, q[1]); ctx.moveTo(q[0], q[1] - r); ctx.lineTo(q[0], q[1] + r); ctx.stroke();
      if (havePrev) { const o = proj(p, prevVP); if (o && Math.hypot(o[0] - q[0], o[1] - q[1]) < 60 * dpr) { ctx.strokeStyle = 'rgba(255,194,61,0.8)'; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); } }
    }
    return n;
  }
  function detect(list, maxRange, kind, color, max = 6, minPx = 7) {
    const cand = [];
    for (const r of list) {
      const d = r.p.distanceTo(cam.position); if (d > maxRange || d < 1.5 || r.r < 0.3) continue;
      const q = proj(r.p); if (!inView(q)) continue;
      cand.push({ r, d });
    }
    cand.sort((a, b) => a.d - b.d);
    let n = 0;
    for (const { r, d } of cand) {
      if (n >= max) break;
      const b = bbox(r.p.clone().add(new V3(0, r.h * 0.3, 0)), r.r * 0.95, r.h * 0.55, r.r * 0.95);
      if (!b || b[2] - b[0] < minPx * dpr) continue;
      n++;
      boxed(b, color, `${kind} ${(0.84 + hash(r.id) * 0.15).toFixed(2)} · ${d.toFixed(1)} M · Ø${(r.r * 1.8).toFixed(1)}`);
    }
    return n;
  }
  function chrome(title, meta, lines) {
    // corner brackets + centre reticle, like a camera HUD
    const m = 8 * dpr, L = 14 * dpr;
    ctx.strokeStyle = 'rgba(240,246,252,0.55)'; ctx.lineWidth = 1 * dpr; ctx.beginPath();
    for (const [x, y, dx, dy] of [[m, m, 1, 1], [cw - m, m, -1, 1], [cw - m, chh - m, -1, -1], [m, chh - m, 1, -1]]) { ctx.moveTo(x + dx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * L); }
    const cx = cw / 2, cy = chh / 2, r = 7 * dpr;
    ctx.moveTo(cx - 2 * r, cy); ctx.lineTo(cx - r, cy); ctx.moveTo(cx + r, cy); ctx.lineTo(cx + 2 * r, cy);
    ctx.moveTo(cx, cy - 2 * r); ctx.lineTo(cx, cy - r); ctx.moveTo(cx, cy + r); ctx.lineTo(cx, cy + 2 * r); ctx.stroke();
    box.querySelector('#cv-title').textContent = title;
    box.querySelector('#cv-meta').textContent = meta;
    ctx.font = font(9);
    lines.forEach(([t, col], i) => { ctx.fillStyle = 'rgba(0,0,0,0.55)'; const w = ctx.measureText(t).width + 6 * dpr; ctx.fillRect(m, chh - m - (lines.length - i) * 13 * dpr - 2 * dpr, w, 12 * dpr); ctx.fillStyle = col; ctx.fillText(t, m + 3 * dpr, chh - m - (lines.length - i - 1) * 13 * dpr - 5 * dpr); });
  }

  function measure() {
    const r = box.getBoundingClientRect();
    rect = r; dpr = Math.min(devicePixelRatio, 2);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    cw = w; chh = h;
    cam.aspect = r.width / r.height; cam.updateProjectionMatrix();
  }

  // the camera image lives in its own render target, refreshed ~20 times a second (a real nav cam's rate) and
  // copied into the window every frame: the full scene is drawn a third as often
  let rt = null, lastT = -1, lastMode = '';
  const blitScene = new THREE.Scene(), blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitMat = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false });
  blitMat.onBeforeCompile = (sh) => {                                 // a monochrome nav-cam look, after tone mapping
    sh.fragmentShader = sh.fragmentShader.replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
      float cvL = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      gl_FragColor.rgb = vec3(clamp(((cvL - 0.5) * 1.2 + 0.5) * 1.1, 0.0, 1.0));`);
  };
  blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat));
  function blit(Hh) {
    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    renderer.setScissor(rect.left, Hh - rect.bottom, rect.width, rect.height);
    renderer.setViewport(rect.left, Hh - rect.bottom, rect.width, rect.height);
    renderer.render(blitScene, blitCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, Hh);
  }

  /** Render the feed: o = { mode, from, look, up, fov, info, time } */
  function render(o) {
    measure();
    if (rect.width < 4) return;
    const Hh = renderer.domElement.clientHeight;
    const fresh = o.mode !== lastMode || o.time < lastT || o.time - lastT >= 0.05;
    if (!fresh && rt) {
      const ac = renderer.autoClear; renderer.autoClear = false; blit(Hh); renderer.autoClear = ac;
      return;
    }
    lastT = o.time; lastMode = o.mode;
    const pr = renderer.getPixelRatio(), rw = Math.max(2, Math.round(rect.width * pr)), rh = Math.max(2, Math.round(rect.height * pr));
    if (!rt) { rt = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType, samples: 2 }); blitMat.map = rt.texture; }
    else if (rt.width !== rw || rt.height !== rh) rt.setSize(rw, rh);
    cam.fov = o.fov || 64; cam.updateProjectionMatrix();
    cam.position.copy(o.from); cam.up.copy(o.up || new V3(0, 1, 0)); cam.lookAt(o.look); cam.updateMatrixWorld();
    curVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    // 1) the camera image: the real scene, rendered into the feed's own target, then copied into the window
    beforeRender();
    const ac = renderer.autoClear, su = renderer.shadowMap.autoUpdate, nu = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(rt); renderer.autoClear = true;
    renderer.render(scene, cam);
    renderer.autoClear = false; blit(Hh);
    renderer.autoClear = ac; renderer.shadowMap.autoUpdate = su; renderer.shadowMap.needsUpdate = nu;
    afterRender();

    // 2) the computer-vision layer
    ctx.clearRect(0, 0, cw, chh);
    const t = o.time, I = o.info || {};
    const stamp = `T+${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(Math.floor(t) % 60).padStart(2, '0')}.${String(Math.floor((t % 1) * 10))}`;
    if (o.mode === 'hazard') {
      let safe = 0;
      for (const c of HZ) {
        const q = c.corners.map((p) => proj(p)); if (q.some((v) => !v)) continue;
        const col = c.score < 0.22 ? 'rgba(60,255,158,' : c.score < 0.55 ? 'rgba(255,194,61,' : 'rgba(255,75,31,';
        if (c.score < 0.22) safe++;
        ctx.fillStyle = col + (c.score < 0.22 ? 0.12 : 0.2) + ')'; ctx.strokeStyle = col + '0.45)'; ctx.lineWidth = 0.8 * dpr;
        ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      const pq = bbox(P0, surface.hole, 0.5, surface.hole); if (pq) boxed(pq, C.bad, 'NO-GO · SKYLIGHT PIT', true);
      const tb = bbox(L0.clone().add(new V3(0, 0.2, 0)), 3.2, 0.3, 3.2); if (tb) boxed(tb, C.ok, `SAFE CELL ${(0.97).toFixed(2)} · SLOPE ${HZ[(HZ.length / 2) | 0].slopeDeg.toFixed(1)}°`);
      chrome('LANDER DESCENT CAM · HAZARD DETECTION', `${stamp} · 10 FPS`, [
        [`ALT ${I.alt.toFixed(1)} M · ${safe} SAFE CELLS / ${HZ.length}`, C.white],
        ['ROCKS > 0.5 M AND SLOPES > 8° FLAGGED', C.dim]]);
    } else if (o.mode === 'obstacles') {
      const nf = features(gFeat, 70, C.cyan, 120);
      const nr = detect(rocks, 40, 'ROCK', C.warn, 4, 12);
      let tgt = null;
      if (I.target) { const b = bbox(I.target, surface.hole, 0.6, surface.hole); if (b) { boxed(b, C.cyan, `TARGET · SKYLIGHT · ${I.target.distanceTo(cam.position).toFixed(0)} M`, true); tgt = 1; } }
      if (I.lander) { const b = bbox(I.lander.clone().add(new V3(0, 2.4, 0)), 3.2, 2.4, 3.2); if (b) boxed(b, C.ok, `LANDER · ${I.lander.distanceTo(cam.position).toFixed(0)} M`); }
      chrome('MAV-A1 NAV CAM · OBSTACLE DETECTION', `${stamp} · 30 FPS`, [
        [`${nr} ROCKS · ${nf} TRACKED FEATURES${tgt ? ' · TARGET IN VIEW' : ''}`, C.white],
        [`STEREO RANGE ±${(0.02 + (I.speed || 0) * 0.01).toFixed(2)} M · g = 3.71 M/S²`, C.dim]]);
    } else if (o.mode === 'trn') {
      // inset: the HiRISE chip around the pit; lines join the same features in orbit and in the live view
      const iw = cw * 0.36, ih = iw * 0.75, ix = 8 * dpr, iy = chh - ih - 34 * dpr;
      const half = 16 / surface.imgW, img = pitImage, uC = pit.u, vC = pit.v;
      const sx = (uC - half) * img.width, sy = (vC - half * 0.75 * surface.imgW / surface.imgH) * img.height;
      const sw = half * 2 * img.width, sh = half * 2 * 0.75 * surface.imgW / surface.imgH * img.height;
      ctx.drawImage(img, sx, sy, sw, sh, ix, iy, iw, ih);
      ctx.strokeStyle = 'rgba(240,246,252,0.6)'; ctx.lineWidth = 1 * dpr; ctx.strokeRect(ix, iy, iw, ih);
      let n = 0, inl = 0;
      for (let i = 0; i < rimFeat.length && n < 60; i++) {
        const p = rimFeat[i];
        const q = proj(p); if (!inView(q, -6)) continue;
        const [u, v] = toImg(p), a = ix + ((u - (uC - half)) / (half * 2)) * iw, b = iy + ((v - (vC - half * 0.75 * surface.imgW / surface.imgH)) / (half * 2 * 0.75 * surface.imgW / surface.imgH)) * ih;
        if (a < ix || a > ix + iw || b < iy || b > iy + ih) continue;
        n++; const good = hash(i) > 0.12; if (good) inl++;
        ctx.strokeStyle = good ? 'rgba(60,255,158,0.55)' : 'rgba(255,75,31,0.6)'; ctx.lineWidth = 0.8 * dpr;
        ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(q[0], q[1]); ctx.stroke();
        ctx.fillStyle = good ? C.ok : C.bad; ctx.fillRect(q[0] - 1.5 * dpr, q[1] - 1.5 * dpr, 3 * dpr, 3 * dpr); ctx.fillRect(a - 1.5 * dpr, b - 1.5 * dpr, 3 * dpr, 3 * dpr);
      }
      label(ix, iy - 2 * dpr, 'HiRISE ORBITAL MAP', C.dim);
      const pb = bbox(P0, surface.hole, 0.4, surface.hole); if (pb) boxed(pb, C.cyan, 'SKYLIGHT · LOCKED');
      chrome('DOWN CAM · TERRAIN-RELATIVE NAVIGATION', `${stamp} · 10 FPS`, [
        [`HiRISE MATCH · ${inl}/${n} INLIERS · POSE ERR ${(0.18 + hash(Math.floor(t * 2)) * 0.09).toFixed(2)} M`, C.white],
        [`HOVER +${I.alt.toFixed(1)} M · HEADING HOLD`, C.dim]]);
    } else if (o.mode === 'descent') {
      const nf = features(sFeat, 40, C.cyan, 160);
      let near = null;
      for (const s of I.spurs || []) {                                      // chockstones in the shaft: boxed, with the clearance plan
        const d = s.tipPoint.distanceTo(cam.position);
        if (d > 24) continue;
        const R = Math.max(s.L, s.W), b = bbox(s.center, R, s.H, R); if (!b) continue;
        const close = Math.abs(s.y - cam.position.y) < s.H + 4.5;
        boxed(b, close ? C.bad : C.warn, `CHOCKSTONE · ${d.toFixed(1)} M${close ? ' · AVOID' : ''}`);
        if (close) near = s;
      }
      chrome(I.climb ? 'UP CAM · SHAFT CLIMB' : 'DOWN CAM · SHAFT DESCENT', `${stamp} · 30 FPS`, [
        [`${I.climb ? 'RIM' : 'FLOOR'} ${Math.max(0, I.floor).toFixed(1)} M · WALLS ${I.wall.toFixed(1)} M · ${nf} TRACKS`, C.white],
        near && I.avoid > 0.2 ? [`LATERAL OFFSET ${I.avoid.toFixed(1)} M · CLEARANCE 0.7 M`, C.warn] : [I.climb ? 'LIGHT LEVEL RISING · EXPOSURE AUTO' : 'LIGHT LEVEL FALLING · EXPOSURE AUTO', C.dim]]);
    } else if (o.mode === 'cave') {
      const nf = features(cFeat, 22, C.cyan, 170);
      const nb = detect(boulders, 22, 'BOULDER', C.warn, I.hazards ? 2 : 4, 10);
      let nh = 0;
      const near = I.hazards ? cave.obstacles.map((ob) => ({ ob, d: ob.center.distanceTo(cam.position) })).filter((x) => x.d < 26).sort((x, y) => x.d - y.d).slice(0, 4) : [];
      for (const { ob, d } of near) {
        const b = new THREE.Box3().setFromObject(ob.mesh), sz = b.getSize(new V3());
        const bb = bbox(ob.center, sz.x / 2, sz.y / 2, sz.z / 2); if (!bb) continue;
        nh++; boxed(bb, ob.hazard ? C.bad : C.warn, `${ob.center.y > cam.position.y ? 'LAVACICLE' : 'ROCKFALL'} · ${d.toFixed(1)} M${ob.hazard ? ' · NO-GO' : ''}`);
      }
      if (I.node) { const b = bbox(I.node, 0.6, 0.6, 0.6); if (b) boxed(b, C.ok, `RELAY NODE_04 · −${(52 + hash(Math.floor(t)) * 6).toFixed(0)} dBm`); }
      if (I.ice) { const b = bbox(I.ice, 3.2, 1.2, 3.2); if (b) boxed(b, C.cyan, 'ICE? CANDIDATE · CONF 0.81', true); }
      if (I.zone) {
        const q = I.zone.footprint.map((p) => proj(p));
        if (q.every((v) => v)) {
          ctx.strokeStyle = C.ok; ctx.lineWidth = 1.4 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
          ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(60,255,158,0.08)'; ctx.fill();
          const top = q.reduce((m, v) => (v[1] < m[1] ? v : m), q[0]);
          label(top[0], top[1] - 2 * dpr, 'HABITAT ZONE · 31 × 14 M · SLOPE 2° · ROOF STABLE', C.ok);
        }
      }
      chrome('MAV-A1 NAV CAM · VISUAL-INERTIAL ODOMETRY', `${stamp} · 30 FPS`, [
        [`${nf} TRACKS · ${nb} BOULDERS${nh ? ` · ${nh} HAZARDS` : ''} · LAMP ON`, C.white],
        [`DRIFT ${(0.11 + (I.s || 0) * 0.3).toFixed(2)} % OF DISTANCE · LOOP CLOSURE ${I.loop ? 'YES' : 'PENDING'}`, C.dim]]);
    } else if (o.mode === 'dock') {
      const ring = [];
      for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; const q = proj(new V3(I.pad.x + Math.cos(a) * 1.55, I.pad.y, I.pad.z + Math.sin(a) * 1.55)); if (q) ring.push(q); }
      if (ring.length > 10) {
        ctx.strokeStyle = C.ok; ctx.lineWidth = 1.6 * dpr; ctx.beginPath(); ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        const cx = ring.reduce((a, q) => a + q[0], 0) / ring.length, cy = ring.reduce((a, q) => a + q[1], 0) / ring.length;
        ctx.strokeStyle = C.warn; ctx.beginPath(); ctx.moveTo(cw / 2, chh / 2); ctx.lineTo(cx, cy); ctx.stroke();
        ctx.fillStyle = C.ok; ctx.fillRect(cx - 2 * dpr, cy - 2 * dpr, 4 * dpr, 4 * dpr);
        label(cx + 8 * dpr, cy - 4 * dpr, 'PAD FIDUCIAL · ELLIPSE FIT', C.ok);
      }
      chrome('DOWN CAM · PRECISION DOCKING', `${stamp} · 30 FPS`, [
        [`Δ ${I.err.toFixed(2)} M · YAW ${(I.err * 3.1).toFixed(1)}° · ALT ${I.alt.toFixed(1)} M`, C.white],
        ['INDUCTIVE COUPLING READY WHEN Δ < 0.05 M', C.dim]]);
    }
    prevVP.copy(curVP); havePrev = true;
  }
  return { render, camera: cam, resetTracks() { havePrev = false; } };
}
