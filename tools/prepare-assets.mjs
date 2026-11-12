// Copies the subset of raw third-party assets the game actually uses into
// client/public/assets with stable names. Run after (re)downloading raw_assets.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, join, meshopt, prune, resample } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const raw = path.join(root, 'raw_assets');
const out = path.join(root, 'client', 'public', 'assets');

function copy(src, dest) {
  const s = path.join(raw, src);
  const d = path.join(out, dest);
  if (!fs.existsSync(s)) {
    console.warn('missing', src);
    return;
  }
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
}

// Models (Quaternius via Poly Pizza, public domain), meshopt-compressed like the humanoids:
// the game only reads positions, normals, UVs, skin weights and clips, so unused vertex
// colours and second UV sets are dropped, animation keys are resampled and geometry is quantised.
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
/** sRGB byte for a linear colour channel. */
const toSrgb8 = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

/**
 * Merges the flat-coloured primitives of every skinned mesh into one primitive per mesh by moving the
 * colours into a shared one-row palette texture (each vertex points at its material's texel), so a
 * part with five materials costs one draw call. Parts with different bind poses stay separate meshes.
 */
async function paletteMerge(doc) {
  const root = doc.getRoot();
  const nodes = root.listNodes().filter((n) => n.getMesh() && n.getSkin() && n.getMesh().listPrimitives().length > 1);
  const mats = [];
  for (const n of nodes) for (const prim of n.getMesh().listPrimitives()) if (!mats.includes(prim.getMaterial())) mats.push(prim.getMaterial());
  if (!mats.length) return;
  const png = await sharp(Buffer.from(mats.flatMap((m) => m.getBaseColorFactor().slice(0, 3).map(toSrgb8))), { raw: { width: mats.length, height: 1, channels: 3 } }).png().toBuffer();
  const tex = doc.createTexture('palette').setImage(new Uint8Array(png)).setMimeType('image/png');
  const mat = doc.createMaterial('palette').setBaseColorTexture(tex).setMetallicFactor(0).setRoughnessFactor(1);
  const buf = root.listBuffers()[0];
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  for (const n of nodes) {
    const prims = n.getMesh().listPrimitives();
    const total = prims.reduce((t, q) => t + q.getAttribute('POSITION').getCount(), 0);
    const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3), uv = new Float32Array(total * 2);
    const jnt = new Uint16Array(total * 4), wgt = new Float32Array(total * 4);
    const ind = [];
    let v0 = 0;
    for (const q of prims) {
      const count = q.getAttribute('POSITION').getCount();
      const slot = mats.indexOf(q.getMaterial());
      const el = [0, 0, 0, 0];
      for (let k = 0; k < count; k++) {
        pos.set(q.getAttribute('POSITION').getElement(k, el).slice(0, 3), (v0 + k) * 3);
        nrm.set(q.getAttribute('NORMAL').getElement(k, el).slice(0, 3), (v0 + k) * 3);
        jnt.set(q.getAttribute('JOINTS_0').getElement(k, el), (v0 + k) * 4);
        wgt.set(q.getAttribute('WEIGHTS_0').getElement(k, el), (v0 + k) * 4);
        uv.set([(slot + 0.5) / mats.length, 0.5], (v0 + k) * 2);
      }
      const I = q.getIndices();
      for (let k = 0; k < I.getCount(); k++) ind.push(I.getScalar(k) + v0);
      v0 += count;
    }
    const merged = doc.createPrimitive().setMaterial(mat).setIndices(acc('SCALAR', new Uint32Array(ind)))
      .setAttribute('POSITION', acc('VEC3', pos)).setAttribute('NORMAL', acc('VEC3', nrm)).setAttribute('TEXCOORD_0', acc('VEC2', uv))
      .setAttribute('JOINTS_0', acc('VEC4', jnt)).setAttribute('WEIGHTS_0', acc('VEC4', wgt));
    const mesh = n.getMesh();
    for (const q of prims) mesh.removePrimitive(q);
    mesh.addPrimitive(merged);
  }
}

for (const m of ['enemy_small', 'robot_flying', 'mech', 'character_hazmat', 'revolver_a', 'shotgun_b', 'rocket_launcher']) {
  const src = path.join(raw, 'polypizza', `${m}.glb`);
  if (!fs.existsSync(src)) { console.warn('missing', src); continue; }
  const doc = await io.read(src);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) for (const sem of ['COLOR_0', 'TEXCOORD_1']) prim.setAttribute(sem, null);
  }
  if (m === 'robot_flying') await paletteMerge(doc);
  await doc.transform(dedup(), join(), prune(), resample(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const dest = path.join(out, 'models', `${m}.glb`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await io.write(dest, doc);
  console.log(`${m}: ${fs.statSync(src).size} -> ${fs.statSync(dest).size} bytes`);
}
if (process.argv.includes('models')) process.exit(0); // `node tools/prepare-assets.mjs models`: models only

// Particle sprites (Kenney Particle Pack, CC0)
const particles = [
  'muzzle_01', 'muzzle_02', 'muzzle_04', 'spark_01', 'spark_04', 'spark_05', 'spark_06', 'smoke_01', 'smoke_04', 'smoke_07',
  'fire_01', 'fire_02', 'flame_01', 'flame_03', 'scorch_01', 'scorch_02', 'circle_05', 'light_01', 'flare_01', 'dirt_02',
  'dirt_03', 'trace_01', 'star_04', 'magic_01', 'twirl_01', 'slash_02',
];
for (const p of particles) copy(`kenney/kenney_particle-pack/PNG (Transparent)/${p}.png`, `sprites/${p}.png`);

// Sound effects (Kenney Impact + Sci-Fi Sounds, CC0)
const kImpact = 'kenney/kenney_impact-sounds/Audio';
const kScifi = 'kenney/kenney_sci-fi-sounds/Audio';
for (let i = 0; i < 5; i++) {
  const n = String(i).padStart(3, '0');
  copy(`${kImpact}/impactMetal_heavy_${n}.ogg`, `sfx/metal_heavy_${i}.ogg`);
  copy(`${kImpact}/impactMetal_light_${n}.ogg`, `sfx/metal_light_${i}.ogg`);
  copy(`${kImpact}/impactPlate_heavy_${n}.ogg`, `sfx/plate_heavy_${i}.ogg`);
  copy(`${kImpact}/footstep_concrete_${n}.ogg`, `sfx/step_${i}.ogg`);
}
for (const [src, dst] of [
  ['explosionCrunch_000', 'explosion_crunch_0'], ['explosionCrunch_002', 'explosion_crunch_1'],
  ['lowFrequency_explosion_000', 'explosion_low'], ['laserLarge_001', 'laser_large'], ['laserSmall_002', 'laser_small'],
  ['laserRetro_003', 'laser_retro'], ['forceField_001', 'forcefield'], ['forceField_003', 'spawn'], ['thrusterFire_002', 'thruster'],
  ['doorOpen_001', 'door'], ['impactMetal_002', 'clank'],
]) copy(`${kScifi}/${src}.ogg`, `sfx/${dst}.ogg`);

// Sound effects (Pixabay, royalty free)
for (const s of ['revolver', 'revolver2', 'shotgun', 'shotgun_pump', 'rocket', 'explosion', 'explosion2', 'coin', 'parry', 'whoosh', 'gore', 'flesh', 'armorhit', 'glass', 'growl1', 'growl2', 'growl3', 'growl4', 'scream1', 'roar1', 'death1', 'death2', 'ping', 'ricochet']) {
  copy(`pixabay_sfx/${s}.mp3`, `sfx/${s}.mp3`);
}

// Music: none — the soundtrack is composed and synthesised live (client/src/engine/music.ts)

// Fonts + crosshair (Kenney, CC0)
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Future.ttf', 'fonts/KenneyFuture.ttf');
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Future Narrow.ttf', 'fonts/KenneyFutureNarrow.ttf');
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Pixel Square.ttf', 'fonts/KenneyPixelSquare.ttf');
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Blocks.ttf', 'fonts/KenneyBlocks.ttf');

console.log('assets prepared in', out);
