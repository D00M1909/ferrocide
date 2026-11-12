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
  await joinIntoOneMesh(doc, b);
  await doc.transform(prune());
  await MeshoptEncoder.ready;
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const out = path.join(OUT, `${b.out}.glb`);
  await io.write(out, doc);
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  const tris = prims.reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
  console.log(`${b.out}: ${kb(out)}, ${tris} tris, ${prims.length} primitive(s), materials: ${root.listMaterials().map((m) => m.getName()).join(', ')}`);
}

/** sRGB byte for a linear colour channel. */
const toSrgb8 = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

/**
 * Bakes every material's colour into one atlas (square slots stacked vertically: textures keep their
 * own slot, flat-colour materials get a solid one) and merges all skinned parts into a single mesh
 * on the shared 65-bone skin, so a body costs one draw call and one bone texture instead of up to nine.
 * The game replaces the materials with Lambert ones that only read the colour map, so vertex colours
 * are dropped.
 */
async function joinIntoOneMesh(doc, b) {
  const root = doc.getRoot();
  const parts = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !node.getSkin()) continue;
    for (const prim of mesh.listPrimitives()) parts.push({ node, prim });
  }
  const slots = [];
  const slotOf = new Map();
  for (const { prim } of parts) {
    const mat = prim.getMaterial();
    if (slotOf.has(mat)) continue;
    slotOf.set(mat, slots.length);
    slots.push({ tex: mat.getBaseColorTexture(), color: mat.getBaseColorFactor() });
  }
  const T = b.tex, N = slots.length;
  const tiles = [];
  for (let i = 0; i < N; i++) {
    const s = slots[i];
    const input = s.tex
      ? await sharp(Buffer.from(s.tex.getImage())).resize(T, T, { kernel: 'lanczos3' }).flatten({ background: '#000' }).toBuffer()
      : await sharp({ create: { width: T, height: T, channels: 3, background: { r: toSrgb8(s.color[0]), g: toSrgb8(s.color[1]), b: toSrgb8(s.color[2]) } } }).png().toBuffer();
    tiles.push({ input, left: 0, top: i * T });
  }
  const jpg = await sharp({ create: { width: T, height: T * N, channels: 3, background: '#000' } }).composite(tiles).jpeg({ quality: 82 }).toBuffer();

  // all parts must share one skeleton: same joints in the same order, same inverse bind matrices
  const skin = parts[0].node.getSkin();
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices().getArray();
  for (const { node } of parts) {
    const sk = node.getSkin();
    const j = sk.listJoints();
    const same = j.length === joints.length && j.every((x, k) => x === joints[k]);
    const m = sk.getInverseBindMatrices().getArray();
    if (!same || m.length !== ibm.length || m.some((v, k) => Math.abs(v - ibm[k]) > 1e-5)) throw new Error(`${b.out}: ${node.getName()} has a different skeleton`);
  }

  let verts = 0, idx = 0;
  for (const { prim } of parts) { verts += prim.getAttribute('POSITION').getCount(); idx += prim.getIndices().getCount(); }
  const pos = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3), uv = new Float32Array(verts * 2);
  const jnt = new Uint16Array(verts * 4), wgt = new Float32Array(verts * 4), ind = new Uint32Array(idx);
  let v0 = 0, i0 = 0;
  const eP = [0, 0, 0], eN = [0, 0, 0], eU = [0, 0], eJ = [0, 0, 0, 0], eW = [0, 0, 0, 0];
  for (const { prim } of parts) {
    const P = prim.getAttribute('POSITION'), Nn = prim.getAttribute('NORMAL'), U = prim.getAttribute('TEXCOORD_0');
    const J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0'), I = prim.getIndices();
    const slot = slotOf.get(prim.getMaterial());
    for (let k = 0; k < P.getCount(); k++) {
      pos.set(P.getElement(k, eP), (v0 + k) * 3);
      nrm.set(Nn.getElement(k, eN), (v0 + k) * 3);
      if (U) {
        U.getElement(k, eU);
        uv[(v0 + k) * 2] = eU[0];
        uv[(v0 + k) * 2 + 1] = (slot + eU[1]) / N;
      } else {
        uv[(v0 + k) * 2] = 0.5;
        uv[(v0 + k) * 2 + 1] = (slot + 0.5) / N;
      }
      jnt.set(J.getElement(k, eJ), (v0 + k) * 4);
      wgt.set(W.getElement(k, eW), (v0 + k) * 4);
    }
    if (U) {
      for (let k = 0; k < U.getCount(); k++) {
        U.getElement(k, eU);
        if (eU[0] < -1e-4 || eU[0] > 1 + 1e-4 || eU[1] < -1e-4 || eU[1] > 1 + 1e-4) throw new Error(`${b.out}: UV outside 0..1 (${eU[0]}, ${eU[1]}), atlas would bleed`);
      }
    }
    for (let k = 0; k < I.getCount(); k++) ind[i0 + k] = I.getScalar(k) + v0;
    v0 += P.getCount();
    i0 += I.getCount();
  }

  const buf = root.listBuffers()[0];
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  const atlas = doc.createTexture(`${b.out}_atlas`).setImage(new Uint8Array(jpg)).setMimeType('image/jpeg');
  const mat = doc.createMaterial(`${b.out}_psx`).setBaseColorTexture(atlas).setMetallicFactor(0).setRoughnessFactor(1).setAlphaMode('OPAQUE');
  const prim = doc.createPrimitive().setMaterial(mat).setIndices(acc('SCALAR', ind))
    .setAttribute('POSITION', acc('VEC3', pos)).setAttribute('NORMAL', acc('VEC3', nrm)).setAttribute('TEXCOORD_0', acc('VEC2', uv))
    .setAttribute('JOINTS_0', acc('VEC4', jnt)).setAttribute('WEIGHTS_0', acc('VEC4', wgt));
  const mesh = doc.createMesh(b.out).addPrimitive(prim);
  const host = parts[0].node.getParentNode();
  const node = doc.createNode(`${b.out}_body`).setMesh(mesh).setSkin(skin);
  host.addChild(node);
  for (const n of new Set(parts.map((p) => p.node))) n.dispose();
  for (const n of root.listNodes()) if (n.getSkin() && !n.getMesh()) n.setSkin(null); // leftovers of dropped parts (hair)
  for (const m of root.listMeshes()) if (m !== mesh) m.dispose();
  for (const m of root.listMaterials()) if (m !== mat) m.dispose();
  for (const t of root.listTextures()) if (t !== atlas) t.dispose();
  console.log(`${b.out}: merged ${parts.length} primitives, atlas ${T}x${T * N}`);
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
