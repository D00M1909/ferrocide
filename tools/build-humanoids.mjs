// Builds the humanoid enemy models from the Quaternius Universal kits (CC0) in raw_assets/:
// one small GLB per body (colour texture only, downscaled for the PSX look, no clips) plus
// one shared skeleton-only GLB with just the animation clips the game uses. All of them share
// the same 65-bone rig, so any clip drives any body by bone name.
//   node tools/build-humanoids.mjs
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const Q = 'raw_assets/quaternius';
const OUT = 'client/public/assets/models';
const OUTFITS = `${Q}/OutfitsFantasy_Standard/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits`;
const BASES = `${Q}/BaseCharacters_Standard/Universal Base Characters[Standard]/Base Characters/Godot - UE`;
const UAL1 = `${Q}/UAL1_Standard/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb`;
const UAL2 = `${Q}/UAL2_Standard/Universal Animation Library 2[Standard]/Unreal-Godot/UAL2_Standard.glb`;

const BODIES = [
  { out: 'h_peasant', src: `${OUTFITS}/Male_Peasant.gltf`, tex: 512 },
  { out: 'h_ranger_m', src: `${OUTFITS}/Male_Ranger.gltf`, tex: 512 },
  { out: 'h_ranger_f', src: `${OUTFITS}/Female_Ranger.gltf`, tex: 512 },
  { out: 'h_hero', src: `${BASES}/Superhero_Male_FullBody.gltf`, tex: 256, dropMaterials: /hair/i },
];

const CLIPS = {
  [UAL1]: [
    'Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Crouch_Idle_Loop', 'Crouch_Fwd_Loop', 'Death01', 'Hit_Chest', 'Hit_Head',
    'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Punch_Cross', 'Punch_Jab', 'Spell_Simple_Enter', 'Spell_Simple_Shoot', 'Spell_Simple_Idle_Loop',
    'Roll', 'Sword_Attack',
  ],
  [UAL2]: [
    'Zombie_Idle_Loop', 'Zombie_Walk_Fwd_Loop', 'Zombie_Scratch', 'Hit_Knockback', 'Melee_Hook', 'OverhandThrow', 'Idle_FoldArms_Loop',
    'NinjaJump_Start', 'NinjaJump_Land', 'Sword_Dash', 'Shield_Dash', 'Idle_No_Loop',
  ],
};

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const kb = (p) => `${Math.round(fs.statSync(p).size / 1024)} KB`;

/** Some kit .gltf files reference texture names that aren't shipped (e.g. "X_png.png" for "X.png"). */
function fixedGltf(src) {
  const j = JSON.parse(fs.readFileSync(src, 'utf8'));
  const dir = path.dirname(src);
  let changed = false;
  for (const img of j.images ?? []) {
    if (!img.uri || fs.existsSync(path.join(dir, decodeURIComponent(img.uri)))) continue;
    const alt = img.uri.replace(/_png\.png$/, '.png');
    if (fs.existsSync(path.join(dir, decodeURIComponent(alt)))) { img.uri = alt; changed = true; }
  }
  if (!changed) return src;
  const out = src.replace(/\.gltf$/, '.fixed.gltf');
  fs.writeFileSync(out, JSON.stringify(j));
  return out;
}

async function buildBody(b) {
  const doc = await io.read(fixedGltf(b.src));
  const root = doc.getRoot();
  for (const a of root.listAnimations()) { for (const smp of a.listSamplers()) smp.dispose(); a.dispose(); }
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (b.dropMaterials && mat && b.dropMaterials.test(mat.getName())) prim.dispose();
    }
  }
  for (const mat of root.listMaterials()) {
    // Lambert in-game: only the colour map matters
    mat.setNormalTexture(null).setOcclusionTexture(null).setMetallicRoughnessTexture(null).setEmissiveTexture(null);
    mat.setMetallicFactor(0).setAlphaMode('OPAQUE');
    if (/eye/i.test(mat.getName())) { mat.setBaseColorTexture(null).setBaseColorFactor([0.05, 0.02, 0.02, 1]); }
  }
  // halve the triangle count: invisible at PSX resolution, and a wave can field a dozen of these
  await MeshoptSimplifier.ready;
  await doc.transform(prune(), dedup(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.002 }));
  for (const t of root.listTextures()) {
    const img = t.getImage();
    if (!img) continue;
    const jpg = await sharp(Buffer.from(img)).resize(b.tex, b.tex, { kernel: 'lanczos3' }).flatten({ background: '#000' }).jpeg({ quality: 82 }).toBuffer();
    t.setImage(new Uint8Array(jpg)).setMimeType('image/jpeg').setURI('');
  }
  await MeshoptEncoder.ready;
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const out = path.join(OUT, `${b.out}.glb`);
  await io.write(out, doc);
  const tris = root.listMeshes().flatMap((m) => m.listPrimitives()).reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
  console.log(`${b.out}: ${kb(out)}, ${tris} tris, materials: ${root.listMaterials().map((m) => m.getName()).join(', ')}`);
}

async function buildAnims() {
  const base = await io.read(UAL1);
  const root = base.getRoot();
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const buf = root.listBuffers()[0];
  const keep = new Set(CLIPS[UAL1]);
  // disposing an animation leaves its samplers (and their data) alive, so free them explicitly
  const kill = (a) => { for (const smp of a.listSamplers()) smp.dispose(); for (const c of a.listChannels()) c.dispose(); a.dispose(); };
  for (const a of root.listAnimations()) if (!keep.has(a.getName())) kill(a);
  // copy the wanted UAL2 clips onto UAL1's (identical) skeleton by bone name
  const other = await io.read(UAL2);
  const want = new Set(CLIPS[UAL2]);
  for (const a of other.getRoot().listAnimations()) {
    if (!want.has(a.getName())) continue;
    const na = base.createAnimation(a.getName());
    const samplers = new Map();
    for (const s of a.listSamplers()) {
      const copy = (acc) => base.createAccessor().setType(acc.getType()).setArray(acc.getArray().slice()).setBuffer(buf);
      samplers.set(s, base.createAnimationSampler().setInput(copy(s.getInput())).setOutput(copy(s.getOutput())).setInterpolation(s.getInterpolation()));
      na.addSampler(samplers.get(s));
    }
    for (const c of a.listChannels()) {
      const target = byName.get(c.getTargetNode()?.getName());
      if (!target) continue;
      na.addChannel(base.createAnimationChannel().setTargetNode(target).setTargetPath(c.getTargetPath()).setSampler(samplers.get(c.getSampler())));
    }
  }
  // fingers don't read at PSX resolution: dropping their tracks removes ~60% of the data
  const FINGER = /^(index|middle|pinky|ring|thumb)_/;
  // retarget-friendly: rotations only (plus the pelvis position for bob/crouch). Bone translation
  // tracks would force the mannequin's bone lengths onto every body; scale tracks are all 1.
  const drop = (c) => {
    const bone = c.getTargetNode()?.getName() ?? '';
    return FINGER.test(bone) || c.getTargetPath() === 'scale' || (c.getTargetPath() === 'translation' && bone !== 'pelvis');
  };
  for (const a of root.listAnimations()) for (const c of a.listChannels()) if (drop(c)) { const smp = c.getSampler(); c.dispose(); smp?.dispose(); }
  // skeleton only: drop the mannequin mesh
  for (const n of root.listNodes()) { if (n.getMesh()) n.setMesh(null); n.setSkin(null); }
  await MeshoptEncoder.ready;
  await base.transform(resample({ tolerance: 1e-3 }), dedup(), prune({ keepLeaves: true }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const out = path.join(OUT, 'h_anims.glb');
  await io.write(out, base);
  const got = root.listAnimations().map((a) => a.getName());
  const missing = [...keep, ...want].filter((n) => !got.includes(n));
  console.log(`h_anims: ${kb(out)}, ${got.length} clips${missing.length ? `, MISSING: ${missing.join(', ')}` : ''}`);
}

for (const b of BODIES) await buildBody(b);
await buildAnims();
