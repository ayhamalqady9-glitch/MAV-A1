// Procedural basalt / dust material: a MeshStandardMaterial whose colour, roughness and normal
// are generated per pixel from 3D noise in world space, plus a photographic basalt detail layer
// (NASA rock close-up, made seamless) mapped triplanar. Detail is computed, not stretched, so it
// stays sharp at any resolution or distance. Optionally drapes a HiRISE image (top-down) over the
// ground so the real orbital photo and the 3D terrain line up.
//
// Every rock material also carries the LiDAR scan: 32 laser channels drawn where they actually hit
// the rock (elevation rings from the sensor, a dot per azimuth step), coloured by range like real
// LiDAR viewers. The scan uniforms are shared (SCAN), so one update moves it on every rock surface.
import * as THREE from 'three';

export const GLSL_NOISE = /* glsl */`
float rk_hash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rk_noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rk_hash(i), rk_hash(i + vec3(1, 0, 0)), f.x), mix(rk_hash(i + vec3(0, 1, 0)), rk_hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(rk_hash(i + vec3(0, 0, 1)), rk_hash(i + vec3(1, 0, 1)), f.x), mix(rk_hash(i + vec3(0, 1, 1)), rk_hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float rk_fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * rk_noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
vec2 rk_hash2(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
// distance to the nearest cell border of a Voronoi pattern: the joints of fractured bedrock plates
float rk_cells(vec2 x) {
  vec2 n = floor(x), f = fract(x), mg = vec2(0.0), mr = vec2(0.0); float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), r = g + rk_hash2(n + g) - f; float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = mg + vec2(float(i), float(j)), r = g + rk_hash2(n + g) - f; vec2 e = r - mr;
    if (dot(e, e) > 1e-5) md = min(md, dot(0.5 * (mr + r), e / length(e)));
  }
  return md;
}
// band-limited fbm: foot = pixel footprint in noise units; octaves finer than ~a pixel fade to their mean
float rk_fbmA(vec3 p, int oct, float foot) {
  float a = 0.5, s = 0.0, f = 1.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float w = 1.0 - smoothstep(0.22, 0.55, f * foot);
    s += a * mix(0.5, rk_noise(p), w);
    p = p * 2.03 + 17.1; a *= 0.5; f *= 2.03;
  }
  return s;
}
// bump mapping from screen-space derivatives of a procedural height (Mikkelsen 2010)
vec3 rk_perturb(vec3 pos, vec3 nrm, float h) {
  vec3 dx = dFdx(pos), dy = dFdy(pos);
  vec3 r1 = cross(dy, nrm), r2 = cross(nrm, dx);
  float det = dot(dx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  vec3 n = abs(det) * nrm - grad;
  float l = length(n);
  return l > 1e-20 ? n / l : nrm;   // MSAA edge samples can make the derivatives degenerate
}
// triplanar sample of the photographic detail (0.5 = neutral)
float rk_detail(sampler2D t, vec3 p, vec3 n, float k) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z + 1e-5);
  return texture2D(t, p.zy * k).r * w.x + texture2D(t, p.xz * k).r * w.y + texture2D(t, p.xy * k).r * w.z;
}
float rk_detailSoft(sampler2D t, vec3 p, vec3 n, float k) {
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z + 1e-5);
  return texture2D(t, p.zy * k, 2.0).r * w.x + texture2D(t, p.xz * k, 2.0).r * w.y + texture2D(t, p.xy * k, 2.0).r * w.z;
}
// Turbo colormap (Google, polynomial fit) — the standard palette of LiDAR range images
vec3 rk_turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x); vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(
    dot(v4, vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234)) + dot(v2, vec2(-152.94239396, 59.28637943)),
    dot(v4, vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333)) + dot(v2, vec2(4.27729857, 2.82956604)),
    dot(v4, vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771)) + dot(v2, vec2(-89.90310912, 27.34824973))), 0.0, 1.0);
}
`;

/** Shared LiDAR scan state (sensor pose + strength), read by every rock material. */
export const SCAN = {
  rkScanOn: { value: 0 }, rkScanO: { value: new THREE.Vector3() }, rkScanUp: { value: new THREE.Vector3(0, 1, 0) },
  rkScanFwd: { value: new THREE.Vector3(0, 0, 1) }, rkScanSide: { value: new THREE.Vector3(1, 0, 0) },
  rkScanTime: { value: 0 }, rkScanRange: { value: 32 },
};

/** Shared photographic detail texture (set once it has loaded). */
export const DETAIL = { rkDetail: { value: null }, rkDetailOn: { value: 0 }, rkLite: { value: 0 } };   // rkLite: fewer noise octaves on slow GPUs

/**
 * Photo-scanned surface sets (CC0, Poly Haven): colour (diffuse × AO) and OpenGL normal maps, plus each set's mean
 * linear colour. Materials use them as a *ratio* to that mean, so the photo brings real grain, pebbles, cracks
 * and relief while the procedural Mars palette (dust, basalt, dark sand, HiRISE drape) keeps the colour honest.
 */
export const PHOTO = {
  phOn: { value: 0 },
  phGroundC: { value: null }, phGroundN: { value: null }, phGroundM: { value: new THREE.Vector3(0.1318, 0.0812, 0.0405) },
  phSandC: { value: null }, phSandN: { value: null }, phSandM: { value: new THREE.Vector3(0.3165, 0.2545, 0.1352) },
  phRockC: { value: null }, phRockN: { value: null }, phRockM: { value: new THREE.Vector3(0.2087, 0.1314, 0.0758) },
  phBasaltC: { value: null }, phBasaltN: { value: null }, phBasaltM: { value: new THREE.Vector3(0.1069, 0.0745, 0.0566) },
  phStrataC: { value: null }, phStrataN: { value: null }, phStrataM: { value: new THREE.Vector3(0.2012, 0.0869, 0.0319) },
};
export const GLSL_PHOTO = /* glsl */`
uniform float phOn;
uniform sampler2D phGroundC, phGroundN, phSandC, phSandN, phRockC, phRockN, phBasaltC, phBasaltN, phStrataC, phStrataN;
uniform vec3 phGroundM, phSandM, phRockM, phBasaltM, phStrataM;
vec3 ph_tri(sampler2D t, vec3 p, vec3 w, float k) {
  return texture2D(t, p.zy * k).rgb * w.x + texture2D(t, p.xz * k).rgb * w.y + texture2D(t, p.xy * k).rgb * w.z;
}
// triplanar normal map, "whiteout" blend (Golus): world-space normal out
vec3 ph_triN(sampler2D t, vec3 p, vec3 n, vec3 w, float k) {
  vec3 tx = texture2D(t, p.zy * k).xyz * 2.0 - 1.0, ty = texture2D(t, p.xz * k).xyz * 2.0 - 1.0, tz = texture2D(t, p.xy * k).xyz * 2.0 - 1.0;
  tx = vec3(tx.xy + n.zy, abs(tx.z) * n.x); ty = vec3(ty.xy + n.xz, abs(ty.z) * n.y); tz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
  vec3 r = tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z; float l = length(r);
  return l > 1e-5 ? r / l : n;
}
// a colour ratio with tamed chroma: real grain and pebbles, without Earth's hues
vec3 ph_ratio(vec3 c, vec3 m) { vec3 r = c / max(m, vec3(1e-3)); float l = dot(r, vec3(0.2126, 0.7152, 0.0722)); return max(mix(vec3(l), r, 0.55), 0.0); }
`;

/**
 * @param {object} o
 * @param {number} o.dust      0..1 how much reddish dust settles on up-facing surfaces
 * @param {number} o.scale     world → noise scale (bigger = finer features)
 * @param {number} o.bands     0..1 lava-tube "bathtub ring" banding on walls
 * @param {number} o.bump      bump strength
 * @param {number} o.photo     0..1 strength of the photographic basalt detail
 * @param {THREE.Texture} [o.hirise]  top-down image draped over x/z
 * @param {THREE.Vector4} [o.hiriseRect] centre x, centre z, width, depth of the image footprint
 */
export function createRockMaterial({ dust = 0.4, scale = 1, bands = 0, bump = 1, tint = 1, photo = 0.8, ripples = 0, hirise = null, hiriseRect = null,
  region = null, regionRect = null, wind = null, photoSet = null, photoScale = 0.5 } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0 });
  const uniforms = {
    rkScale: { value: scale }, rkDust: { value: dust }, rkBands: { value: bands }, rkBump: { value: bump }, rkTint: { value: tint },
    rkPhoto: { value: photo }, rkRipples: { value: ripples },
    rkHirise: { value: hirise }, rkHiriseOn: { value: hirise ? 1 : 0 },
    rkRect: { value: hiriseRect || new THREE.Vector4(0, 0, 1, 1) },
    // terrain regions (R dark sand, G bedrock, B fresh ejecta) baked from the same functions as the height field
    rkRegion: { value: region }, rkRegionOn: { value: region ? 1 : 0 }, rkReg: { value: regionRect || new THREE.Vector4(0, 0, 1, 0) },
    rkWind: { value: wind || new THREE.Vector2(0.83, 0.56) },
  };
  mat.userData.rock = uniforms;
  const PH = photoSet ? `PH_${photoSet.toUpperCase()}` : null;
  if (PH) mat.defines = { [PH]: '', PH_ON: '', PH_K: photoScale.toFixed(4) };
  mat.customProgramCacheKey = () => `mav-rock-5-${photoSet || 'none'}`;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, SCAN, DETAIL, PHOTO);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 rkW;\nvarying vec3 rkN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        #ifdef USE_INSTANCING
          rkW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          rkN = mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal;
        #else
          rkW = (modelMatrix * vec4(transformed, 1.0)).xyz;
          rkN = mat3(modelMatrix) * objectNormal;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 rkW; varying vec3 rkN;
        uniform float rkScale, rkDust, rkBands, rkBump, rkTint, rkHiriseOn, rkPhoto, rkDetailOn, rkRipples, rkLite;
        uniform sampler2D rkHirise, rkDetail, rkRegion; uniform vec4 rkRect, rkReg; uniform float rkRegionOn; uniform vec2 rkWind;
        uniform float rkScanOn, rkScanTime, rkScanRange; uniform vec3 rkScanO, rkScanUp, rkScanFwd, rkScanSide;
        ${GLSL_NOISE}
        ${GLSL_PHOTO}
        #ifdef PH_ON
          #define RK_OCT_MID 3
          #define RK_OCT_FINE 2
          #define RK_OCT_H 3
          #define RK_OCT_RIP 2
        #else
          #define RK_OCT_MID 4
          #define RK_OCT_FINE 3
          #define RK_OCT_H 5
          #define RK_OCT_RIP 3
        #endif`)
      .replace('#include <map_fragment>', `
        vec3 rkP = rkW * rkScale;
        float rkNl = length(rkN);
        float rkFace = gl_FrontFacing ? 1.0 : -1.0;
        vec3 rkNn = (rkNl > 1e-6 ? rkN / rkNl : vec3(0.0, 1.0, 0.0)) * rkFace;
        vec3 rkPhR = vec3(1.0), rkPhD = vec3(0.0);                                    // photo colour ratio, photo normal offset (world)
        float rkSteep = 0.0;
        // pixel footprint in metres: detail finer than this is faded, never aliased
        float rkFoot = max(length(fwidth(rkW)), 1e-5);
        float rkLod = 1.0 - smoothstep(0.03, 0.16, rkFoot);
        float rkF = rkFoot * rkScale;
        float rkBig = rk_fbmA(rkP * 0.07, 3, rkF * 0.07);
        int rkO = int(rkLite + 0.5);
        float rkMid = rk_fbmA(rkP * 0.55, RK_OCT_MID - rkO, rkF * 0.55);   // the photo carries the fine detail when present
        float rkFine = rk_fbmA(rkP * 3.2, max(RK_OCT_FINE - rkO, 1), rkF * 3.2);
        float rkPh = 0.5, rkPhB = 0.5;
        #if defined(PH_ROCK) || defined(PH_BASALT)
        if (phOn > 0.5) {
          vec3 phW = pow(abs(rkNn), vec3(4.0)); phW /= (phW.x + phW.y + phW.z + 1e-5);
          #ifdef PH_ROCK
            rkPhR = ph_ratio(ph_tri(phRockC, rkW, phW, PH_K), phRockM);
            rkPhD = ph_triN(phRockN, rkW, rkNn, phW, PH_K) - rkNn;
          #else
            rkPhR = ph_ratio(ph_tri(phBasaltC, rkW, phW, PH_K), phBasaltM);
            rkPhD = ph_triN(phBasaltN, rkW, rkNn, phW, PH_K) - rkNn;
          #endif
          rkPh = clamp(0.5 + (dot(rkPhR, vec3(0.333)) - 1.0) * 0.3, 0.0, 1.0);
        } else
        #endif
        #ifdef PH_GROUND
        if (phOn > 0.5) {
          // two scales, the second turned and shifted, so the photo never visibly repeats
          vec2 g1 = rkW.xz * PH_K, g2 = mat2(0.8, -0.6, 0.6, 0.8) * (rkW.xz * PH_K * 0.23) + vec2(0.37, 0.71);
          rkPhR = ph_ratio(mix(texture2D(phGroundC, g1).rgb, texture2D(phGroundC, g2).rgb, 0.4), phGroundM);
          vec3 gn = texture2D(phGroundN, g1).xyz * 2.0 - 1.0;
          rkPhD = vec3(gn.x, 0.0, gn.y);
          // steep ground (hill flanks, the pit's rim): layered rock, projected sideways so it never stretches
          rkSteep = 1.0 - smoothstep(0.6, 0.88, rkNn.y);
          if (rkSteep > 0.01) {
            vec3 sw = pow(abs(rkNn), vec3(4.0)); sw.y = 0.0; sw /= (sw.x + sw.z + 1e-5);
            vec3 stC = texture2D(phStrataC, rkW.zy * 0.06).rgb * sw.x + texture2D(phStrataC, rkW.xy * 0.06).rgb * sw.z;
            rkPhR = mix(rkPhR, ph_ratio(stC, phStrataM), rkSteep);
            rkPhD *= 1.0 - rkSteep;
          }
          rkPh = clamp(0.5 + (dot(rkPhR, vec3(0.333)) - 1.0) * 0.3, 0.0, 1.0);
        } else
        #endif
        if (rkDetailOn > 0.5 && rkPhoto > 0.0) {
          rkPh = mix(0.5, rk_detail(rkDetail, rkW, rkNn, 0.55), rkPhoto * (0.35 + 0.65 * rkLod));
          rkPhB = mix(0.5, rk_detailSoft(rkDetail, rkW, rkNn, 0.55), rkPhoto * rkLod);
        }
        rkFine = mix(0.5, rkFine, 0.4 + 0.6 * rkLod);
        float rkUp = clamp(rkNn.y, 0.0, 1.0);
        vec3 basalt = mix(vec3(0.04, 0.036, 0.034), vec3(0.15, 0.125, 0.11), rkMid) * (0.7 + 0.45 * rkFine) * (0.55 + 0.9 * rkPh);
        float band = rkBands * smoothstep(0.6, 0.95, 0.5 + 0.5 * sin(rkW.y * 2.4 + rkBig * 7.0));
        basalt = mix(basalt, vec3(0.22, 0.15, 0.115), band * 0.5);
        float dustAmt = clamp(rkDust * (0.25 + 0.85 * smoothstep(0.3, 0.92, rkUp)) + (rkBig - 0.5) * 0.7 - (rkPh - 0.5) * 0.6, 0.0, 1.0);
        vec3 dustC = mix(vec3(0.36, 0.17, 0.085), vec3(0.6, 0.35, 0.2), rkFine) * (0.85 + 0.3 * rkPh);
        vec3 rkCol = mix(basalt, dustC, dustAmt);
        float rkSand = 0.0, rkOut = 0.0, rkEj = 0.0, rkCrack = 0.0;
        if (rkRegionOn > 0.5) {
          vec2 ruv = (rkW.xz - rkReg.xy) / rkReg.z + 0.5;
          float inR = smoothstep(0.0, 0.06, min(min(ruv.x, 1.0 - ruv.x), min(ruv.y, 1.0 - ruv.y)));
          vec3 rg = texture2D(rkRegion, clamp(ruv, 0.0, 1.0)).rgb * inR;
          rkSand = rg.r; rkOut = rg.g; rkEj = rg.b;
          float flatG = smoothstep(0.72, 0.93, rkUp);
          // bright fresh ejecta and dust mantle around young craters
          rkCol = mix(rkCol, dustC * 1.2, rkEj * 0.45 * flatG);
          #ifdef PH_GROUND
          if (phOn > 0.5) {
            // dark basaltic sand and bedrock slabs, each with its own photo grain and relief
            if (rkSand > 0.01) {
              vec2 s1 = rkW.xz * PH_K * 1.3; vec3 sn = texture2D(phSandN, s1).xyz * 2.0 - 1.0;
              rkPhR = mix(rkPhR, ph_ratio(texture2D(phSandC, s1).rgb, phSandM), rkSand);
              rkPhD = mix(rkPhD, vec3(sn.x, 0.0, sn.y) * 0.5, rkSand);
            }
            if (rkOut > 0.01) {
              vec2 b1 = rkW.xz * PH_K * 0.9; vec3 bn = texture2D(phRockN, b1).xyz * 2.0 - 1.0;
              float k = rkOut * flatG;
              rkCol = mix(rkCol, mix(basalt * (1.25 + 0.35 * rkMid), dustC, 0.18 * smoothstep(0.4, 0.8, rkFine)), k * 0.85);
              rkPhR = mix(rkPhR, ph_ratio(texture2D(phRockC, b1).rgb, phRockM), k);
              rkPhD = mix(rkPhD, vec3(bn.x, 0.0, bn.y) * 1.1, k);
            }
          } else
          #endif
          // bedrock: fractured basalt plates, dust and sand caught in the joints
          if (rkOut > 0.01) {
            float e = rk_cells(rkW.xz * 0.55 + (rkBig - 0.5) * 1.5);
            float ew = max(fwidth(e), 1e-4);
            rkCrack = (1.0 - smoothstep(0.015, 0.05 + 1.5 * ew, e)) * (1.0 - smoothstep(0.08, 0.3, rkFoot));
            vec3 bed = basalt * (1.15 + 0.35 * rkMid);
            vec3 o = mix(bed, dustC * 0.85, rkCrack * 0.9);
            o = mix(o, dustC, 0.22 * smoothstep(0.4, 0.8, rkFine));
            rkCol = mix(rkCol, o, rkOut * 0.85 * flatG);
          }
          // dark basaltic sand: grey-brown, very fine (like the Bagnold dunes Curiosity drove through)
          vec3 sandC = mix(vec3(0.085, 0.058, 0.045), vec3(0.15, 0.1, 0.072), rkFine) * (0.9 + 0.2 * rkPh);
          rkCol = mix(rkCol, sandC, rkSand * 0.85 * flatG * (1.0 - 0.6 * smoothstep(0.04, 0.4, rkFoot)));   // far away it reads as a tint, not a hole
        }
        if (rkHiriseOn > 0.5) {
          vec2 huv = vec2((rkW.x - rkRect.x) / rkRect.z + 0.5, 0.5 - (rkW.z - rkRect.y) / rkRect.w);
          float inside = smoothstep(0.0, 0.07, min(min(huv.x, 1.0 - huv.x), min(huv.y, 1.0 - huv.y)));
          float lum = texture2D(rkHirise, clamp(huv, 0.0, 1.0)).r;
          vec3 hc = mix(vec3(0.07, 0.035, 0.02), vec3(0.72, 0.45, 0.28), smoothstep(0.0, 0.85, lum));
          rkCol = mix(rkCol, hc * (0.8 + 0.3 * rkFine) * (0.8 + 0.4 * rkPh), inside * 0.9);
        }
        #ifdef PH_ON
          rkCol = mix(rkCol, mix(basalt * 1.2, dustC, 0.25), rkSteep * 0.55);      // flow fronts and pit walls: dark stacked basalt
          rkCol *= clamp(mix(vec3(1.0), rkPhR, phOn * 0.92), 0.0, 4.0);
          rkPhB = 0.5;
        #endif
        diffuseColor.rgb *= rkCol * rkTint;
        // aeolian ripples: wind-built sand waves (~0.7 m) in the dusty, flat parts of the ground
        float rkRip = 0.0;
        if (rkRipples > 0.0 && rkLite < 0.5) {
          vec2 wd = rkWind;
          float ph = dot(rkW.xz, wd) * 9.0 + rk_fbmA(vec3(rkW.xz * 0.35, 2.0), RK_OCT_RIP, rkFoot * 0.35) * 14.0 + rk_fbmA(vec3(rkW.xz * 0.06, 5.0), 2, rkFoot * 0.06) * 18.0;
          float crest = pow(0.5 + 0.5 * sin(ph), 2.2);
          float flat_ = smoothstep(0.86, 0.97, rkUp) * max(smoothstep(0.35, 0.75, dustAmt), rkSand);
          float patchy = max(smoothstep(0.35, 0.65, rk_fbmA(vec3(rkW.xz * 0.045, 9.0), 2, rkFoot * 0.045)), rkSand);   // ripples in some fields, always on sand
          rkRip = crest * flat_ * rkRipples * patchy * (1.0 - smoothstep(0.02, 0.09, rkFoot));
          diffuseColor.rgb *= 1.0 + (crest - 0.45) * 0.1 * flat_ * rkRipples * patchy;
        }
        float rkH = rk_fbmA(rkP * 1.5, RK_OCT_H - rkO, rkF * 1.5) * 0.5 + rkFine * 0.35 + band * 0.25 + (rkPhB - 0.5) * 0.45 + rkRip * 0.45;
        rkH += rkOut * (1.0 - rkCrack) * 0.3;                                       // plates stand proud of their joints
        rkH = mix(rkH, rkRip * 0.5 + rkFine * 0.06, rkSand * 0.8);                  // sand is smooth apart from its ripples
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * (0.8 + 0.22 * rkFine) * (1.05 - 0.12 * rkPh);')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef PH_ON
          if (phOn > 0.5) normal = normalize(normal + mat3(viewMatrix) * rkPhD * 0.95);   // the photo's own relief
          normal = rk_perturb(-vViewPosition, normal, rkH * rkBump * mix(0.55, 0.28, phOn));
        #else
          normal = rk_perturb(-vViewPosition, normal, rkH * rkBump * 0.55);
        #endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (rkScanOn > 0.001) {
          vec3 sv = rkW - rkScanO; float sd = length(sv);
          if (sd > 0.4 && sd < rkScanRange) {
            vec3 sn = sv / sd;
            float sel = asin(clamp(dot(sn, rkScanUp), -1.0, 1.0));
            float saz = atan(dot(sn, rkScanSide), dot(sn, rkScanFwd) + 1e-6);
            // the spinning head: how long ago (in turns) the beam last passed this azimuth
            float head = fract(rkScanTime * 0.42);
            float age = fract(head - (saz / 6.2831853 + 0.5));
            float persist = exp(-age * 3.4);                                  // returns fade as the head moves on
            float fade = 1.0 - smoothstep(rkScanRange * 0.65, rkScanRange, sd);
            float inFov = 1.0 - smoothstep(0.37, 0.41, abs(sel));
            float ch = (sel + 0.3927) / 0.7854 * 31.0;                       // 32 channels over ±22.5°
            if (ch > -0.5 && ch < 31.5) {
              float fc = abs(ch - floor(ch + 0.5)), wc = max(fwidth(ch), 1e-4);
              float ring = 1.0 - smoothstep(0.35 * wc, 1.25 * wc, fc);
              // individual returns: one dot per 0.35° of azimuth, round on screen when close
              float an = saz / 6.2831853 * 1024.0, fa = abs(an - floor(an + 0.5)), wa = max(fwidth(an), 1e-4);
              float dotv = 1.0 - smoothstep(0.45 * wa + 0.1, 1.3 * wa + 0.16, fa);
              float dotted = mix(1.0, dotv, clamp(1.1 - wa * 1.6, 0.0, 1.0));
              vec3 sc = rk_turbo(1.0 - sd / rkScanRange);
              totalEmissiveRadiance += pow(sc, vec3(2.2)) * ring * dotted * persist * fade * rkScanOn * 2.2;
            }
            // the beam itself: a thin bright arc on the rock where the head points right now
            float lead = exp(-age * 140.0);
            totalEmissiveRadiance += vec3(0.7, 0.95, 1.0) * lead * inFov * fade * rkScanOn * 1.6;
          }
        }`);
  };
  return mat;
}
