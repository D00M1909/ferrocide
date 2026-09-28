// Loads GLB models and sprite textures once, then hands out re-skinned,
// correctly scaled clones with their own animation mixers.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { psxify, Textures, type PsxOptions } from './psx';

export const MODEL_FILES = [
  'enemy_large', 'enemy_small', 'robot_flying', 'mech', 'character_hazmat', 'revolver_a', 'shotgun_b', 'rocket_launcher',
] as const;
export type ModelName = (typeof MODEL_FILES)[number];

export const SPRITE_FILES = [
  'muzzle_01', 'muzzle_02', 'muzzle_04', 'spark_01', 'spark_04', 'spark_05', 'spark_06', 'smoke_01', 'smoke_04', 'smoke_07',
  'fire_01', 'fire_02', 'flame_01', 'flame_03', 'scorch_01', 'scorch_02', 'circle_05', 'light_01', 'flare_01', 'dirt_02',
  'dirt_03', 'trace_01', 'star_04', 'magic_01', 'twirl_01', 'slash_02',
] as const;
export type SpriteName = (typeof SPRITE_FILES)[number];

const models = new Map<ModelName, GLTF>();
const sprites = new Map<SpriteName, THREE.Texture>();

export async function loadAssets(onProgress: (f: number) => void): Promise<void> {
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const total = MODEL_FILES.length + SPRITE_FILES.length;
  let done = 0;
  const tick = () => onProgress(++done / total);
  await Promise.all([
    ...MODEL_FILES.map(async (m) => {
      try {
        models.set(m, await loader.loadAsync(`/assets/models/${m}.glb`));
      } catch (e) {
        console.warn('model failed', m, e);
      }
      tick();
    }),
    ...SPRITE_FILES.map(async (s) => {
      try {
        const t = await texLoader.loadAsync(`/assets/sprites/${s}.png`);
        t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        sprites.set(s, t);
      } catch (e) {
        console.warn('sprite failed', s, e);
      }
      tick();
    }),
  ]);
}

export function sprite(name: SpriteName): THREE.Texture {
  return sprites.get(name) ?? new THREE.Texture();
}

export interface ModelInstance {
  root: THREE.Object3D; // positioned by the game (feet / centre at origin)
  inner: THREE.Object3D; // scaled model
  mixer: THREE.AnimationMixer | null;
  clips: Map<string, THREE.AnimationClip>;
  flash: { value: number };
  materials: THREE.Material[];
  height: number;
}

const socketCache = new Map<THREE.Texture, THREE.Texture>();

/**
 * Paints the stock cartoon eyes out of a texture atlas: bright, unsaturated texels
 * (sclera) become dark scorched sockets so the glowing eyes we add are what reads.
 */
function eyeless(src: THREE.Texture): THREE.Texture {
  const cached = socketCache.get(src);
  if (cached) return cached;
  const img = src.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  if (!img || !img.width) return src;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 200 && max - min < 40) {
      d[i] = 26; d[i + 1] = 8; d[i + 2] = 8;
    }
  }
  ctx.putImageData(data, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.flipY = src.flipY;
  t.colorSpace = src.colorSpace;
  t.wrapS = src.wrapS;
  t.wrapT = src.wrapT;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapNearestFilter;
  socketCache.set(src, t);
  return t;
}

export interface InstanceOpts extends PsxOptions {
  eyeless?: boolean;
  height: number;
  center?: boolean; // centre vertically instead of standing on the origin
  emissive?: THREE.Color;
  yawOffset?: number;
}

/** Clones a loaded model, normalises its size, and swaps in PSX materials. */
export function instance(name: ModelName, o: InstanceOpts): ModelInstance {
  const gltf = models.get(name);
  const root = new THREE.Object3D();
  const flash = o.flash ?? { value: 0 };
  if (!gltf) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, o.height, 0.6), psxify(new THREE.MeshLambertMaterial({ color: 0x884444 }), { flash }));
    m.position.y = o.center ? 0 : o.height / 2;
    root.add(m);
    return { root, inner: m, mixer: null, clips: new Map(), flash, materials: [m.material], height: o.height };
  }
  const inner = SkeletonUtils.clone(gltf.scene);
  const materials: THREE.Material[] = [];
  const matCache = new Map<THREE.Material, THREE.Material>();
  inner.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false; // skinned bounds are unreliable after rescaling
    const swap = (src: THREE.Material): THREE.Material => {
      const cached = matCache.get(src);
      if (cached) return cached;
      const s = src as THREE.MeshStandardMaterial;
      const m = new THREE.MeshLambertMaterial({
        map: s.map ? (o.eyeless ? eyeless(s.map) : s.map) : null,
        color: s.color ? s.color.clone() : new THREE.Color(1, 1, 1),
        emissive: o.emissive ?? (s.emissive ? s.emissive.clone() : new THREE.Color(0, 0, 0)),
        emissiveMap: s.emissiveMap ?? null,
        transparent: false,
      });
      if (m.map) {
        m.map.magFilter = THREE.NearestFilter;
        m.map.minFilter = THREE.NearestMipmapNearestFilter;
      }
      psxify(m, { ...o, flash });
      matCache.set(src, m);
      materials.push(m);
      return m;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  // normalise scale using the bind-pose bounds
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner, true);
  const size = box.getSize(new THREE.Vector3());
  const s = o.height / Math.max(size.y, 1e-4);
  inner.scale.multiplyScalar(s);
  inner.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(inner, true);
  const c = box2.getCenter(new THREE.Vector3());
  inner.position.x -= c.x;
  inner.position.z -= c.z;
  inner.position.y -= o.center ? c.y : box2.min.y;
  const pivot = new THREE.Object3D();
  pivot.rotation.y = o.yawOffset ?? 0;
  pivot.add(inner);
  root.add(pivot);
  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of gltf.animations) clips.set(clip.name.split('|').pop()!, clip);
  const mixer = gltf.animations.length ? new THREE.AnimationMixer(inner) : null;
  return { root, inner, mixer, clips, flash, materials, height: o.height };
}

/** Plays a clip by (partial) name with a cross-fade; returns the action. */
export function playClip(
  inst: ModelInstance,
  names: string[],
  opts: { loop?: boolean; fade?: number; speed?: number; restart?: boolean; current?: THREE.AnimationAction | null } = {},
): THREE.AnimationAction | null {
  if (!inst.mixer) return null;
  let clip: THREE.AnimationClip | undefined;
  for (const n of names) {
    clip = inst.clips.get(n);
    if (clip) break;
  }
  if (!clip) return opts.current ?? null;
  const action = inst.mixer.clipAction(clip);
  action.setEffectiveTimeScale(opts.speed ?? 1);
  if (opts.current === action && !opts.restart) return action;
  action.reset();
  action.setLoop(opts.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = opts.loop === false;
  action.enabled = true;
  action.setEffectiveWeight(1);
  if (opts.current && opts.current !== action) {
    action.crossFadeFrom(opts.current, opts.fade ?? 0.15, false);
  }
  action.play();
  return action;
}

/** Plain clone of a static model's meshes (used for viewmodels). */
export function staticModel(name: ModelName, length: number, psx: PsxOptions = {}): THREE.Object3D {
  const gltf = models.get(name);
  const holder = new THREE.Object3D();
  if (!gltf) {
    holder.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, length), new THREE.MeshLambertMaterial({ color: 0x555555 })));
    return holder;
  }
  const inner = gltf.scene.clone(true);
  inner.updateMatrixWorld(true);
  const rawSize = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3());
  const texel = Math.max(rawSize.x, rawSize.y, rawSize.z) / 3; // ~3 texture repeats along the gun
  const wear = gunTexture();
  inner.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    // the stock guns are flat-coloured: give them box-projected UVs and a worn-steel map
    let map = src.map ?? null;
    if (!map) {
      mesh.geometry = boxProjectUVs(mesh.geometry.clone(), mesh.matrixWorld, texel);
      map = wear;
    }
    const m = new THREE.MeshLambertMaterial({ map, color: src.color?.clone() ?? new THREE.Color(1, 1, 1) });
    if (m.map) m.map.magFilter = THREE.NearestFilter;
    mesh.material = psxify(m, { ...psx, snap: false });
  });
  inner.updateMatrixWorld(true);
  inner.quaternion.premultiply(gunOrientation(inner));
  const fix = GUN_FIX[name];
  if (fix) inner.quaternion.premultiply(new THREE.Quaternion().setFromEuler(fix));
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  inner.scale.multiplyScalar(length / longest);
  inner.updateMatrixWorld(true);
  const c = new THREE.Box3().setFromObject(inner).getCenter(new THREE.Vector3());
  inner.position.sub(c);
  holder.add(inner);
  return holder;
}

// The auto-orientation guesses wrong on these (checked by rendering each gun side-on):
// the revolver came out grip-up, the launcher grip-up with its rocket noses facing the player.
const GUN_FIX: Partial<Record<ModelName, THREE.Euler>> = {
  revolver_a: new THREE.Euler(0, 0, Math.PI),
  rocket_launcher: new THREE.Euler(Math.PI, 0, 0),
};

let gunTex: THREE.Texture | null = null;
function gunTexture(): THREE.Texture {
  if (!gunTex) gunTex = Textures.gunmetal();
  return gunTex;
}

/** Tri-planar-ish UVs: each vertex is projected along its dominant normal axis. */
function boxProjectUVs(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, texel: number): THREE.BufferGeometry {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(matrix);
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    n.fromBufferAttribute(nrm, i).applyMatrix3(nm);
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    const [u, v] = ax >= ay && ax >= az ? [p.z, p.y] : ay >= az ? [p.x, p.z] : [p.x, p.y];
    uv[i * 2] = u / texel;
    uv[i * 2 + 1] = v / texel;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Works out how to rotate an arbitrary gun model so the barrel points down -Z and
 * the grip hangs toward -Y: the longest axis is the barrel line, its thinner end is
 * the muzzle, and the mass below the bore line is the grip/stock.
 */
function gunOrientation(obj: THREE.Object3D): THREE.Quaternion {
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position as THREE.BufferAttribute;
    const step = Math.max(1, Math.floor(pos.count / 1500));
    for (let i = 0; i < pos.count; i += step) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone());
  });
  if (pts.length < 4) return new THREE.Quaternion();
  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const axes = ['x', 'y', 'z'] as const;
  const order = [...axes].sort((a, b) => size[b] - size[a]);
  const long = order[0];
  // cross-section area of each end slice: the muzzle is the thinner end
  const slice = (sign: number) => {
    const lim = centre[long] + sign * size[long] * 0.35;
    const sel = pts.filter((p) => (sign > 0 ? p[long] > lim : p[long] < lim));
    if (!sel.length) return Infinity;
    const b = new THREE.Box3().setFromPoints(sel).getSize(new THREE.Vector3());
    return axes.filter((a) => a !== long).reduce((acc, a) => acc * Math.max(b[a], 1e-4), 1);
  };
  const muzzleSign = slice(1) < slice(-1) ? 1 : -1;
  // "up" is the larger of the remaining axes; the side with the centroid is the grip (down)
  const upAxis = order[1];
  const mean = pts.reduce((acc, p) => acc + p[upAxis], 0) / pts.length;
  const downSign = mean < centre[upAxis] ? -1 : 1;
  const fwd = new THREE.Vector3(); fwd[long] = muzzleSign;
  const down = new THREE.Vector3(); down[upAxis] = downSign;
  // basis mapping: fwd -> -Z, down -> -Y
  const from = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(down.clone().negate(), fwd.clone().negate()), down.clone().negate(), fwd.clone().negate());
  const q = new THREE.Quaternion().setFromRotationMatrix(from).invert();
  return q;
}
