// Merge every non-moving mesh under `root` into one mesh per material: hundreds of draw calls become a few dozen
// (each is paid again for shadows, ambient occlusion and the CV window). Moving parts stay untouched: pass `keep`
// to protect any object (and everything under it) that animates or is read by the choreography.
// Multi-material and transparent meshes are left as they are.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const ATTRS = ['position', 'normal', 'uv'];

function prepare(geo, matrix) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) if (!ATTRS.includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.clearGroups();
  g.applyMatrix4(matrix);
  if (matrix.determinant() < 0) {                         // a mirrored transform flips the winding: flip it back
    for (const name of ATTRS) {
      const a = g.attributes[name], n = a.itemSize, arr = a.array, tmp = new Float32Array(n);
      for (let t = 0; t < a.count; t += 3) {
        const i1 = (t + 1) * n, i2 = (t + 2) * n;
        tmp.set(arr.subarray(i1, i1 + n)); arr.copyWithin(i1, i2, i2 + n); arr.set(tmp, i2);
      }
    }
  }
  return g;
}

/** Returns how many meshes were merged away. */
export function mergeStatic(root, { keep = () => false, transparent = false } = {}) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map(), victims = [], rel = new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o === root) return;
    const m = o.material;
    if (!m || Array.isArray(m) || (m.transparent && !transparent)) return;
    for (let p = o; p && p !== root; p = p.parent) if (keep(p)) return;
    rel.multiplyMatrices(inv, o.matrixWorld);
    const key = `${m.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}`;
    if (!groups.has(key)) groups.set(key, { mat: m, cast: o.castShadow, recv: o.receiveShadow, order: o.renderOrder, geos: [] });
    groups.get(key).geos.push(prepare(o.geometry, rel));
    victims.push(o);
  });
  for (const v of victims) v.parent.remove(v);
  for (const g of groups.values()) {
    const geo = mergeGeometries(g.geos, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, g.mat);
    mesh.castShadow = g.cast; mesh.receiveShadow = g.recv; mesh.renderOrder = g.order; mesh.name = 'merged';
    root.add(mesh);
  }
  return victims.length - groups.size;
}
