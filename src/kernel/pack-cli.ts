// `petween --pack <command>` (docs/10): pack tooling for scripts and agents. The host relays the
// arguments here; everything is done with the same code the editor uses (files, model, import
// pipeline), so a pack made from the command line is the same as one made by hand.

import type { MotionRef, PetPack, StateAppearance, TransitionRef } from '../api/types';
import { exportPath, openPack, packExists, savePack, userBase, writePackFile } from '../editor/files';
import { importFile } from '../editor/import/importer';
import { checkPack, emptyPack, ensureMotion, MOTION_PRESETS, motionKind, setClip, setState, stateTree } from '../editor/model';
import { exportPetpack, unpackPetpack } from '../editor/petpack';
import type { AdminApi, AdminMethod, PackInfo } from '../shared/admin';
import { BRAIN_STATE_KEYS } from '../shared/state-keys';
import { tauriHost } from './host';
import GUIDE from '../../docs/10-agent-guide.md?raw';

export type Admin = <M extends AdminMethod>(method: M, params?: Parameters<AdminApi[M]>[0]) => Promise<Awaited<ReturnType<AdminApi[M]>>>;
export type CliResult = { ok: boolean } & Record<string, unknown>;

export const USAGE = `petween --pack <命令> [参数]      所有输出都是 JSON；完整说明见 docs/10-agent-guide.md

  help                                  这段说明
  guide                                 给 agent 的完整制作指南（先读它）
  list                                  所有宠物包
  info                                  可用的状态键、动作预设、切换方式
  new <id> [--name 名字]                新建空宠物包（id：小写字母、数字、短横线）
  show <id>                             pet.json + 每个状态显示什么 + 检查结果
  check <id>                            只看检查结果
  import <id> <文件…> [--state 键] [--add] [--remove-bg] [--tolerance 0-255] [--fps N]
                                        导入图片 / GIF / APNG / 动态 WebP / 短视频为片段；
                                        给了 --state 就把这些片段设为该状态的画面（--add 追加）
  set-state <id> <键> [--clips a,b] [--enter 动作|none] [--loop a,b|none] [--exit 动作|none]
            [--transition cut|crossfade|afterLoop] [--variant random|cycle|sticky] [--remove]
  set <id> [--name 名字] [--scale 倍数] [--creators a,b] [--license 许可] [--source 网址]
  clip <id> <片段> [--anchor x,y] [--scale 倍数] [--fps N] [--remove]
  preview <id> <键> [--seconds N]       在桌面宠物身上临时显示（不保存，N 秒后恢复，默认 6）
  export <id> [输出路径]                导出 .petpack（默认放到「下载」）
  install <文件.petpack>                安装一个 .petpack
  reload <id>                           直接改了 pet.json 之后，让桌面上的宠物重新读取`;

// ---------- arguments ----------

export interface Parsed {
  pos: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['add', 'remove-bg', 'remove']);

export function parseArgs(args: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) flags[k] = v;
      else if (BOOLEAN_FLAGS.has(k) || i + 1 >= args.length || args[i + 1].startsWith('--')) flags[k] = true;
      else flags[k] = args[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

export function resolvePath(p: string, cwd: string): string {
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(p)) return p.replace(/\\/g, '/');
  return `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${p.replace(/\\/g, '/')}`;
}

const list = (v: string | true | undefined) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const none = (v: string | true | undefined) => v === 'none' || v === '';

// ---------- commands ----------

class CliError extends Error {}
const fail = (msg: string): never => {
  throw new CliError(msg);
};

export async function runPackCli(args: string[], cwd: string, admin: Admin): Promise<CliResult> {
  const { pos, flags } = parseArgs(args);
  const [cmd, ...rest] = pos;
  try {
    switch (cmd) {
      case undefined:
      case 'help':
        return { ok: true, usage: USAGE };
      case 'guide':
        return { ok: true, guide: GUIDE };
      case 'list':
        return { ok: true, packs: (await admin('packs.list')).map((p) => ({ id: p.id, name: p.name, builtin: p.builtin })) };
      case 'info':
        return {
          ok: true,
          stateKeys: [...BRAIN_STATE_KEYS, ...(await admin('plugins.list')).flatMap((p) => (p.manifest.contributes?.stateKeys ?? []).map((k) => ({ ...k, hint: `插件 ${p.name}` })))],
          motionPresets: Object.entries(MOTION_PRESETS).map(([name, p]) => ({ name, label: p.label, use: p.kind === 'enter' ? 'enter / exit' : 'loop' })),
          transitions: ['cut', 'crossfade', 'afterLoop'],
          fallback: '没配的状态按点号逐级回退到上级，最后回退到 idle（active.command.Bash → active.command → active → idle）',
        };
      case 'new':
        return await cmdNew(rest[0], flags, admin);
      case 'show':
        return await cmdShow(await editable(rest[0], admin, true), admin);
      case 'check': {
        const o = await editable(rest[0], admin, true);
        const issues = checkPack(o.pack);
        return { ok: true, issues };
      }
      case 'import':
        return await cmdImport(rest[0], rest.slice(1), flags, cwd, admin);
      case 'set-state':
        return await cmdSetState(rest[0], rest[1], flags, admin);
      case 'set':
        return await cmdSet(rest[0], flags, admin);
      case 'clip':
        return await cmdClip(rest[0], rest[1], flags, admin);
      case 'preview':
        return await cmdPreview(rest[0], rest[1], flags, admin);
      case 'export': {
        const o = await editable(rest[0], admin, true);
        const out = rest[1] ? resolvePath(rest[1], cwd) : await exportPath(`${o.pack.id}.petpack`);
        await tauriHost.writeBytes(out, await exportPetpack(o));
        return { ok: true, file: out };
      }
      case 'install': {
        if (!rest[0]) fail('要给出 .petpack 文件');
        const u = await unpackPetpack(await tauriHost.readBytes(resolvePath(rest[0], cwd)), new Set((await admin('packs.list')).map((p) => p.id)));
        for (const f of u.files) await writePackFile(u.pack.id, f.path, f.data);
        await savePack(u.pack);
        return { ok: true, id: u.pack.id, renamedFrom: u.renamedFrom, warnings: u.warnings };
      }
      case 'reload':
        await editable(rest[0], admin, true);
        await admin('packs.reload', { id: rest[0] });
        return { ok: true };
      default:
        return { ok: false, error: `不认识的命令 ${cmd}`, usage: USAGE };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Open a pack, refusing built-in ones unless reading is all we do. */
async function editable(id: string | undefined, admin: Admin, readOnly = false) {
  if (!id) fail('要给出宠物包 id（petween --pack list 查看）');
  const info: PackInfo | undefined = (await admin('packs.list')).find((p) => p.id === id);
  if (!info) fail(`没有宠物包 ${id}`);
  if (info!.builtin && !readOnly) fail(`${id} 是内置宠物包，不能改；先在编辑器里「复制一份」，或用 new 新建`);
  return openPack(id!, info!.builtin);
}

async function commit(pack: PetPack, admin: Admin, extra: Record<string, unknown> = {}): Promise<CliResult> {
  await savePack(pack);
  await admin('packs.reload', { id: pack.id });
  const issues = checkPack(pack);
  return { ok: true, ...extra, issues };
}

async function cmdNew(id: string | undefined, flags: Parsed['flags'], admin: Admin): Promise<CliResult> {
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('id 只能用小写字母、数字和短横线，并以字母或数字开头');
  if ((await admin('packs.list')).some((p) => p.id === id) || (await packExists(id!))) fail(`宠物包 ${id} 已经存在`);
  const pack = emptyPack(id!, typeof flags.name === 'string' ? flags.name : id!);
  await savePack(pack);
  return { ok: true, id, dir: `pets/${id}` };
}

async function cmdShow(o: Awaited<ReturnType<typeof editable>>, admin: Admin): Promise<CliResult> {
  const plugins = (await admin('plugins.list')).map((p) => ({ name: p.name, stateKeys: p.manifest.contributes?.stateKeys }));
  const states = stateTree(o.pack, plugins).map((r) => ({ key: r.key, label: r.label || undefined, own: r.own, showsAs: r.own ? r.key : r.fallsBackTo }));
  return { ok: true, builtin: o.builtin, pack: o.pack, states, issues: checkPack(o.pack) };
}

async function cmdImport(id: string | undefined, files: string[], flags: Parsed['flags'], cwd: string, admin: Admin): Promise<CliResult> {
  const o = await editable(id, admin);
  if (!files.length) fail('要给出至少一个文件');
  let pack = o.pack;
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    const path = resolvePath(f, cwd);
    const name = path.split('/').pop()!;
    const file = new File([await tauriHost.readBytes(path)], name);
    const tol = Number(flags.tolerance);
    const r = await importFile(file, new Set(Object.keys(pack.clips)), {
      removeBackground: flags['remove-bg'] === true,
      tolerance: Number.isFinite(tol) ? tol : undefined,
      videoFps: Number(flags.fps) || undefined,
    });
    await writePackFile(pack.id, r.path, r.bytes);
    pack = setClip(pack, r.id, r.clip);
    out.push({ file: f, clip: r.id, path: r.path, type: r.clip.type, frames: r.clip.frames?.count ?? 1, fps: r.clip.fps, width: r.width, height: r.height, anchor: r.clip.anchor, warnings: r.warnings });
  }
  if (typeof flags.state === 'string') {
    const key = flags.state;
    const ids = out.map((x) => x.clip as string);
    const cur = pack.states[key];
    pack = setState(pack, key, { ...cur, clips: flags.add === true && cur ? [...cur.clips, ...ids] : ids });
  }
  return commit(pack, admin, { clips: out });
}

async function cmdSetState(id: string | undefined, key: string | undefined, flags: Parsed['flags'], admin: Admin): Promise<CliResult> {
  const o = await editable(id, admin);
  if (!key) fail('要给出状态键，如 success 或 active.command.Bash');
  let pack = o.pack;
  if (flags.remove === true) return commit(setState(pack, key!, null), admin);
  const a: StateAppearance = { ...(pack.states[key!] ?? { clips: [] }) };
  if (flags.clips !== undefined) {
    const clips = list(flags.clips);
    const missing = clips.filter((c) => !pack.clips[c]);
    if (missing.length) fail(`没有这些片段：${missing.join(', ')}`);
    a.clips = clips;
  }
  const motion = (name: string, kind: 'enter' | 'loop'): MotionRef => {
    pack = ensureMotion(pack, name);
    const def = pack.motions?.[name];
    if (!def) fail(`没有动作 ${name}（预设见 petween --pack info）`);
    if (motionKind(def!) !== kind) fail(`动作 ${name} 是${kind === 'loop' ? '一次性的，不能当持续动作' : '持续的，不能当进入 / 离开动作'}`);
    return name;
  };
  if (flags.enter !== undefined) a.enter = none(flags.enter) ? undefined : motion(String(flags.enter), 'enter');
  if (flags.exit !== undefined) a.exit = none(flags.exit) ? undefined : motion(String(flags.exit), 'enter');
  if (flags.loop !== undefined) a.loop = none(flags.loop) ? undefined : list(flags.loop).map((n) => motion(n, 'loop'));
  if (typeof flags.transition === 'string') {
    const t = flags.transition;
    if (!['cut', 'crossfade', 'afterLoop'].includes(t)) fail('transition 只能是 cut / crossfade / afterLoop');
    a.transition = t === 'cut' ? undefined : t === 'crossfade' ? ({ type: 'crossfade', durationMs: Number(flags['fade-ms']) || 200 } as TransitionRef) : (t as TransitionRef);
  }
  if (typeof flags.variant === 'string') {
    if (!['random', 'cycle', 'sticky'].includes(flags.variant)) fail('variant 只能是 random / cycle / sticky');
    a.variant = flags.variant as StateAppearance['variant'];
  }
  if (!a.clips.length) fail(`状态 ${key} 还没有画面：加 --clips`);
  return commit(setState(pack, key!, a), admin, { state: key, appearance: a });
}

async function cmdSet(id: string | undefined, flags: Parsed['flags'], admin: Admin): Promise<CliResult> {
  const o = await editable(id, admin);
  const p: PetPack = { ...o.pack, attribution: { ...o.pack.attribution } };
  if (typeof flags.name === 'string') p.name = flags.name;
  if (flags.scale !== undefined) {
    const s = Number(flags.scale);
    if (!(s > 0)) fail('scale 要是正数');
    p.scale = s;
  }
  if (flags.creators !== undefined) p.attribution!.creators = list(flags.creators);
  if (typeof flags.license === 'string') p.attribution!.license = flags.license;
  if (typeof flags.source === 'string') p.attribution!.sourceUrl = flags.source;
  return commit(p, admin);
}

async function cmdClip(id: string | undefined, clipId: string | undefined, flags: Parsed['flags'], admin: Admin): Promise<CliResult> {
  const o = await editable(id, admin);
  if (!clipId || !o.pack.clips[clipId]) fail(`没有片段 ${clipId}`);
  if (flags.remove === true) return commit(setClip(o.pack, clipId!, null), admin);
  const c = { ...o.pack.clips[clipId!] };
  if (typeof flags.anchor === 'string') {
    const [x, y] = flags.anchor.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail('anchor 写成 x,y，如 0.5,0.96');
    c.anchor = { x, y };
  }
  if (flags.scale !== undefined) c.scale = Number(flags.scale) || 1;
  if (flags.fps !== undefined) c.fps = Math.max(1, Math.min(60, Number(flags.fps) || 12));
  return commit(setClip(o.pack, clipId!, c), admin, { clip: clipId, def: c });
}

async function cmdPreview(id: string | undefined, key: string | undefined, flags: Parsed['flags'], admin: Admin): Promise<CliResult> {
  const o = await editable(id, admin, true);
  if (!key) fail('要给出状态键');
  const pets = await admin('pets.list');
  const pet = pets.find((p) => p.pack === o.pack.id) ?? pets[0];
  if (!pet) fail('桌面上没有宠物');
  const seconds = Math.max(1, Math.min(60, Number(flags.seconds) || 6));
  await admin('pets.tryPack', { petId: pet!.id, pack: o.pack, baseUrl: o.builtin ? o.baseUrl : userBase(o.pack.id) });
  await admin('pets.forceState', { petId: pet!.id, key: key! });
  setTimeout(() => void admin('pets.tryEnd', { petId: pet!.id }), seconds * 1000);
  return { ok: true, pet: pet!.id, state: key, seconds };
}
