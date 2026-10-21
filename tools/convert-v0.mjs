#!/usr/bin/env node
// One-time conversion of v0 (petween-desktop) pets into v1 pet packs (docs/07 "v0 数据导入工具").
// Usage: node tools/convert-v0.mjs [--v0 <petween-home>] [--out <pets dir>] [--v0-src <vendor/petween/src>] [--main]
//   --main  also point the main pet in instances.json at v0's active pet.
// Needs ImageMagick 7 (`magick`) on PATH. Reads v0's preset tables straight from its source via esbuild.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, d) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : d;
};
const APPDATA = process.env.APPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Roaming');
const V0 = arg('--v0', join(APPDATA, 'petween-desktop', 'petween-home'));
const OUT = arg('--out', join(APPDATA, 'com.petween.app', 'pets'));
const V0_SRC = arg('--v0-src', join(here, '..', '..', 'petween-desktop', 'vendor', 'petween', 'src'));
const MAKE_MAIN = process.argv.includes('--main');

/** v0 drew poses contain-fit into a 160px box (pet-stage.ts DEFAULT_STAGE_SIZE). */
const V0_BOX = 160;
const MAX_EDGE = 512;

// ---------- v0 preset tables ----------

async function loadPresets() {
  const esbuild = await import(pathToFileURL(join(here, '..', 'node_modules', 'esbuild', 'lib', 'main.js')).href);
  const out = join(tmpdir(), `petween-v0-presets-${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [join(V0_SRC, 'core', 'transition-presets.ts')], bundle: true, format: 'esm', outfile: out, logLevel: 'error' });
  const mod = await import(pathToFileURL(out).href);
  rmSync(out);
  const byPreset = {};
  for (const d of mod.BUILTIN_TRANSITION_DEFINITIONS) byPreset[d.id.replace(/^builtin:/, '')] = d;
  return byPreset;
}

const PROP = { scaleX: 'scaleX', scaleY: 'scaleY', y: 'y', x: 'x', rotation: 'rotate', opacity: 'opacity' };
const EASE = { 'ease-in': 'in', 'ease-out': 'out', 'ease-in-out': 'inOut', linear: 'linear' };

function value(v, strength) {
  if (typeof v === 'number') return v;
  return v.base + v.amount * (v.parameter === 'strength' ? strength : 1);
}

/**
 * v0 AnimationDefinition → v1 keyframes motion. v0's pose-swap timing is dropped on purpose: v1
 * packs switch the picture first and let the enter motion play as a reaction (docs/03 §4).
 */
function toKeyframes(def, strength, durationMs) {
  const dur = durationMs ?? def.durationMs;
  const tracks = {};
  for (const tr of def.tracks) {
    const prop = PROP[tr.property.split('.').pop()];
    if (!prop) continue;
    const keys = tr.keyframes.map((k, i) => ({
      t: Math.round(k.at * dur),
      v: +value(k.value, strength).toFixed(4),
      // v0 easing belongs to the segment leaving a key; v1 puts it on the arriving key.
      ...(i > 0 && tr.keyframes[i - 1].easing && EASE[tr.keyframes[i - 1].easing] !== 'linear' ? { ease: EASE[tr.keyframes[i - 1].easing] } : {}),
    }));
    tracks[prop] = keys;
  }
  return { type: 'keyframes', tracks, durationMs: dur };
}

// ---------- conversion ----------

const STATE_MAP = { idle: 'idle', thinking: 'active.thinking', working: 'active', waiting: 'waiting', success: 'success', error: 'error' };

function slug(name, fallback) {
  const s = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || fallback;
}

function convertImage(src, dest) {
  execFileSync('magick', [src, '-resize', `${MAX_EDGE}x${MAX_EDGE}>`, '-define', 'webp:lossless=true', dest]);
  const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', dest]).toString().trim().split(' ').map(Number);
  return Math.max(w, h);
}

function convertPet(v0pet, assets, config, presets, report) {
  const id = slug(v0pet.name, `v0-${v0pet.id.replace(/^pet_/, '').slice(0, 6)}`);
  const dir = join(OUT, id);
  mkdirSync(join(dir, 'clips'), { recursive: true });

  const clips = {};
  const fileFor = new Map();
  for (const [pose, p] of Object.entries(v0pet.poses ?? {})) {
    const asset = assets[p.assetId];
    if (!asset) {
      report.push(`${id}: pose ${pose} 引用了不存在的图片 ${p.assetId}，已跳过`);
      continue;
    }
    let entry = fileFor.get(p.assetId);
    if (!entry) {
      const file = `clips/${p.assetId}.webp`;
      entry = { file, edge: convertImage(join(V0, 'assets', asset.fileName), join(dir, file)) };
      fileFor.set(p.assetId, entry);
    }
    clips[pose] = { type: 'still', source: entry.file, anchor: p.anchor ?? { x: 0.5, y: 0.96 }, scale: +((V0_BOX / entry.edge) * (p.zoom ?? 1)).toFixed(4) };
  }

  const motions = {};
  const states = {};
  const g = config.global?.transition ?? { preset: 'comic-pop', strength: 1, durationMs: 260 };
  for (const [v0key, s] of Object.entries(v0pet.states ?? {})) {
    const key = STATE_MAP[v0key];
    if (!key || !clips[s.pose]) continue;
    const st = { clips: [s.pose] };

    const enter = s.enter?.preset === 'global' ? { ...g, durationMs: s.enter.durationMs ?? g.durationMs } : s.enter;
    if (enter && enter.preset && enter.preset !== 'none') {
      const def = presets[enter.preset];
      if (def) {
        const name = `enter-${v0key}`;
        motions[name] = toKeyframes(def, enter.strength ?? 1, enter.durationMs);
        st.enter = name;
      } else report.push(`${id}: 未知的进入预设 ${enter.preset}（${v0key}），已忽略`);
    }
    if (s.enter?.animationId) report.push(`${id}: ${v0key} 的自定义进入动画 ${s.enter.animationId} 未转换`);

    const loop = [];
    const a = s.ambient ?? {};
    if (a.breathe?.enabled) {
      const k = a.breathe.strength ?? 0.25;
      motions[`breathe-${v0key}`] = { type: 'sine', property: 'scaleY', amplitude: +(0.009 * k).toFixed(4), periodMs: a.breathe.periodMs ?? 2800 };
      loop.push(`breathe-${v0key}`);
    }
    if (a.sway?.enabled) {
      motions[`sway-${v0key}`] = { type: 'sine', property: 'rotate', amplitude: a.sway.angleDeg ?? 1, periodMs: a.sway.periodMs ?? 3600, phase: -0.25 };
      loop.push(`sway-${v0key}`);
    }
    if (a.bounce?.enabled) {
      // v0 bounce is a random-interval hop; the closest loop is noise on y (docs/07).
      const every = ((a.bounce.intervalMinMs ?? 800) + (a.bounce.intervalMaxMs ?? 1300)) / 2;
      motions[`bounce-${v0key}`] = { type: 'noise', property: 'y', amplitude: +(4.5 * (a.bounce.strength ?? 0.35)).toFixed(2), frequency: +(1000 / every).toFixed(3) };
      loop.push(`bounce-${v0key}`);
      report.push(`${id}: ${v0key} 的 bounce（随机间隔跳动）近似为 noise`);
    }
    if (loop.length) st.loop = loop;
    states[key] = st;
  }

  const pack = {
    format: 1,
    id,
    name: v0pet.name ?? id,
    ...(v0pet.attribution ? { attribution: v0pet.attribution } : {}),
    scale: v0pet.scale ?? 1,
    clips,
    motions,
    states,
  };
  writeFileSync(join(dir, 'pet.json'), JSON.stringify(pack, null, 2));
  return id;
}

// ---------- main ----------

const presets = await loadPresets();
const assets = JSON.parse(readFileSync(join(V0, 'assets.json'), 'utf8'));
const config = existsSync(join(V0, 'config.json')) ? JSON.parse(readFileSync(join(V0, 'config.json'), 'utf8')) : {};
const report = [];
const converted = {};
for (const f of readdirSync(join(V0, 'pets')).filter((f) => f.endsWith('.json'))) {
  const v0pet = JSON.parse(readFileSync(join(V0, 'pets', f), 'utf8'));
  converted[v0pet.id] = convertPet(v0pet, assets, config, presets, report);
  console.log(`✓ ${v0pet.name} → ${join(OUT, converted[v0pet.id])}`);
}

const user = readdirSync(join(V0, 'animations')).filter((f) => f.startsWith('user_'));
if (user.length) report.push(`未转换 ${user.length} 个 v0 动画（roamer / physics 出厂动画，M1/M2 由对应插件重新提供）：${user.join(', ')}`);

if (MAKE_MAIN && config.activePetId && converted[config.activePetId]) {
  const instFile = join(OUT, '..', 'instances.json');
  const inst = existsSync(instFile) ? JSON.parse(readFileSync(instFile, 'utf8')) : { pets: [] };
  if (inst.pets[0]) inst.pets[0].pack = converted[config.activePetId];
  else inst.pets.push({ id: 'pet-1', pack: converted[config.activePetId], x: 1600, y: 1100, scale: 1 });
  writeFileSync(instFile, JSON.stringify(inst, null, 2));
  console.log(`✓ 主宠物改为 ${converted[config.activePetId]}`);
}

console.log('\n导入报告：');
for (const r of report) console.log(`  - ${r}`);
