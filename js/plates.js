// Image plates for the MAV-A1 site: full-screen "cover" photos and the nested zoom chain
// (globe → Olympus Mons → Arsia skylight). Everything lives in one orthographic scene whose
// visible height is 1 unit. Zoom-chain rectangles are computed on the CPU in doubles and
// re-based on the camera every frame, so very deep zooms never hit float precision limits.
import * as THREE from 'three';

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const fragmentShader = /* glsl */`
  uniform sampler2D map;
  uniform float opacity, lift, sat, brightness, vignette, mirror, wipeOn, wipe, edge;
  uniform vec2 uvScale, uvOffset;
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv * uvScale + uvOffset;
    if (mirror > 0.5) uv.x = 1.0 - abs(mod(uv.x, 2.0) - 1.0);
    vec4 c = texture2D(map, uv);
    vec3 col = c.rgb * brightness;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, sat);
    vec3 liftCol = vec3(0.028, 0.008, 0.075);              // shadows lean toward cosmic purple
    col = mix(col, liftCol + col * (1.0 - liftCol), lift);
    vec2 q = vUv - 0.5;
    col *= 1.0 - vignette * dot(q, q) * 2.2;
    float a = c.a * opacity;
    if (edge > 0.0) a *= smoothstep(0.0, edge, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
    if (wipeOn > 0.5) a *= step(gl_FragCoord.x, wipe);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }
`;

export class Plate {
  constructor(texture, { lift = 0, sat = 1, order = 0, name = '' } = {}) {
    this.texture = texture;
    this.aspect = texture.image.width / texture.image.height;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture }, opacity: { value: 1 }, lift: { value: lift }, sat: { value: sat },
        brightness: { value: 1 }, vignette: { value: 0 }, mirror: { value: 0 }, edge: { value: 0 },
        wipeOn: { value: 0 }, wipe: { value: 0 },
        uvScale: { value: new THREE.Vector2(1, 1) }, uvOffset: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
  }
  get u() { return this.material.uniforms; }
  set opacity(v) { this.u.opacity.value = v; this.mesh.visible = v > 0.003; }
  get opacity() { return this.u.opacity.value; }
  setRect(x, y, w, h) {
    this.mesh.position.set(x, y, 0);
    this.mesh.scale.set(w, h, 1);
    this.u.uvScale.value.set(1, 1); this.u.uvOffset.value.set(0, 0);
  }
  /** Fill the screen like CSS background-size: cover, zoomed by `zoom` around focus (fx, fy from top-left). */
  cover(screenAspect, zoom = 1, fx = 0.5, fy = 0.5, panX = 0) {
    this.mesh.position.set(0, 0, 0);
    this.mesh.scale.set(screenAspect, 1, 1);
    let sx = 1, sy = 1;
    if (screenAspect > this.aspect) sy = this.aspect / screenAspect; else sx = screenAspect / this.aspect;
    sx /= zoom; sy /= zoom;
    let ox = fx - sx / 2 + panX, oy = (1 - fy) - sy / 2;
    if (this.u.mirror.value < 0.5) ox = Math.min(Math.max(ox, 0), 1 - sx);
    oy = Math.min(Math.max(oy, 0), 1 - sy);
    this.u.uvScale.value.set(sx, sy); this.u.uvOffset.value.set(ox, oy);
  }
  /** Centered at (x, y) in screen units, `w` wide, keeping the image aspect. */
  place(x, y, w) { this.setRect(x, y, w, w / this.aspect); }
}

/**
 * Nested zoom chain. layers[0] is the root (1 unit wide). Each further layer is attached by
 * mapping its own point `childPt` onto `parentPt` of the previous layer, at `k` × parent width.
 * Points are normalized image coordinates from the top-left.
 */
export class ZoomChain {
  constructor(layers) {
    this.layers = [];
    layers.forEach((L, i) => {
      const w = i === 0 ? 1 : L.k * this.layers[i - 1].w;
      const h = w / L.plate.aspect;
      let left, top;
      if (i === 0) { left = -w / 2; top = h / 2; } else {
        const P = this.point(i - 1, ...L.parentPt);
        left = P.x - L.childPt[0] * w; top = P.y + L.childPt[1] * h;
      }
      this.layers.push({ ...L, w, h, left, top });
    });
  }
  point(i, u, v) { const L = this.layers[i]; return { x: L.left + u * L.w, y: L.top - v * L.h }; }
  /** Position every plate for a view centred on (cx, cy) showing H world units vertically. */
  apply(view) {
    const s = 1 / view.H;
    for (const L of this.layers) {
      L.plate.setRect((L.left + L.w / 2 - view.cx) * s, (L.top - L.h / 2 - view.cy) * s, L.w * s, L.h * s);
    }
  }
}

/** Interpolate zoom views: H log-linear (constant perceived speed), centre pinned to the zoom target. */
export function zoomBetween(a, b, t) {
  const e = t * t * (3 - 2 * t);
  const H = Math.exp(Math.log(a.H) + (Math.log(b.H) - Math.log(a.H)) * e);
  const r = Math.abs(b.H - a.H) < 1e-9 ? e : (H - a.H) / (b.H - a.H);
  return { cx: a.cx + (b.cx - a.cx) * r, cy: a.cy + (b.cy - a.cy) * r, H };
}

/** Twinkling star field in screen space. */
export function createStars(count = 900) {
  const pos = new Float32Array(count * 3), seed = new Float32Array(count), size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 4; pos[i * 3 + 1] = (Math.random() - 0.5) * 2.2; pos[i * 3 + 2] = 0;
    seed[i] = Math.random() * 100; size[i] = Math.random() < 0.07 ? 3.4 : 1.2 + Math.random() * 1.4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 }, uScale: { value: 1 }, uPx: { value: 1 } },
    vertexShader: /* glsl */`
      attribute float aSeed, aSize; uniform float uTime, uScale, uPx; varying float vTw;
      void main() {
        vTw = 0.55 + 0.45 * sin(uTime * (0.6 + fract(aSeed) * 1.8) + aSeed);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * uScale, 0.0, 1.0);
        gl_PointSize = aSize * uPx;
      }`,
    fragmentShader: /* glsl */`
      uniform float uOpacity; varying float vTw;
      void main() { vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard;
        gl_FragColor = vec4(vec3(0.94, 0.96, 0.99), (1.0 - d * 4.0) * vTw * uOpacity); }`,
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.renderOrder = -10;
  pts.frustumCulled = false;
  return pts;
}
