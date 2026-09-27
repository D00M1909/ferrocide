// Loads GLB models and sprite textures once, then hands out re-skinned,
// correctly scaled clones with their own animation mixers.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { psxify, type PsxOptions } from './psx';

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

export interface InstanceOpts extends PsxOptions {
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
        map: s.map ?? null,
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
  inner.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const m = new THREE.MeshLambertMaterial({ map: src.map ?? null, color: src.color?.clone() ?? new THREE.Color(1, 1, 1) });
    if (m.map) m.map.magFilter = THREE.NearestFilter;
    mesh.material = psxify(m, { ...psx, snap: false });
  });
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
