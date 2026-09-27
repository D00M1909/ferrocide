// Copies the subset of raw third-party assets the game actually uses into
// client/public/assets with stable names. Run after (re)downloading raw_assets.
import fs from 'node:fs';
import path from 'node:path';

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

// Models (Quaternius via Poly Pizza, public domain)
for (const m of ['enemy_large', 'enemy_small', 'enemy_flying', 'robot_flying', 'mech', 'character_hazmat', 'revolver_a', 'shotgun_b', 'rocket_launcher']) {
  copy(`polypizza/${m}.glb`, `models/${m}.glb`);
}

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
  ['computerNoise_001', 'ui_blip'], ['doorOpen_001', 'door'], ['impactMetal_002', 'clank'],
]) copy(`${kScifi}/${src}.ogg`, `sfx/${dst}.ogg`);

// Sound effects (Pixabay, royalty free)
for (const s of ['revolver', 'revolver2', 'shotgun', 'shotgun_pump', 'rocket', 'explosion', 'explosion2', 'coin', 'parry', 'whoosh', 'gore', 'flesh', 'armorhit', 'glass']) {
  copy(`pixabay_sfx/${s}.mp3`, `sfx/${s}.mp3`);
}

// Music (Pixabay, royalty free)
for (const m of ['combat_heavy_industrial_metal', 'combat_industrial_jent_metal', 'boss_runaway_breakcore', 'menu_dark_ambient']) {
  copy(`music/${m}.mp3`, `music/${m}.mp3`);
}

// Fonts + crosshair (Kenney, CC0)
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Future.ttf', 'fonts/KenneyFuture.ttf');
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Future Narrow.ttf', 'fonts/KenneyFutureNarrow.ttf');
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Pixel Square.ttf', 'fonts/KenneyPixelSquare.ttf');
copy('kenney/kenney_kenney-fonts/Fonts/Kenney Blocks.ttf', 'fonts/KenneyBlocks.ttf');

console.log('assets prepared in', out);
