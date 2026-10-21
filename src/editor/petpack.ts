// .petpack = a pack folder, zipped (docs/04 §1). Export from any open pack; import unpacks into
// <app data>/pets/<id>/, renaming the id when it clashes. Only pet.json and the files its clips use
// are taken: a pack is pure data and nothing in it is ever run (AGENTS rule 4).

import type { PetPack } from '../api/types';
import { validatePack } from '../kernel/pack/resolve';
import { readZip, safeEntryPath, writeZip, type ZipEntry } from '../shared/zip';
import type { OpenPack } from './files';
import { packIdFrom } from './model';

export async function exportPetpack(o: OpenPack): Promise<Uint8Array<ArrayBuffer>> {
  const entries: ZipEntry[] = [{ path: 'pet.json', data: new TextEncoder().encode(`${JSON.stringify(o.pack, null, 2)}\n`) }];
  for (const src of new Set(Object.values(o.pack.clips).map((c) => c.source))) {
    const path = safeEntryPath(src);
    if (!path) continue;
    const res = await fetch(new URL(src, o.baseUrl));
    if (!res.ok) throw new Error(`读不到 ${src}`);
    entries.push({ path, data: new Uint8Array(await res.arrayBuffer()) });
  }
  return writeZip(entries);
}

export interface UnpackedPack {
  pack: PetPack;
  files: ZipEntry[];
  /** Set when the id had to change because a pack with that id exists. */
  renamedFrom?: string;
  warnings: string[];
}

export async function unpackPetpack(bytes: Uint8Array, taken: Set<string>): Promise<UnpackedPack> {
  const all = await readZip(bytes);
  // pet.json at the root, or inside a single top-level folder.
  const manifest = all.find((e) => e.path === 'pet.json') ?? all.find((e) => /^[^/]+\/pet\.json$/.test(e.path));
  if (!manifest) throw new Error('这个文件里没有 pet.json，不是宠物包');
  const prefix = manifest.path.slice(0, -'pet.json'.length);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(manifest.data));
  } catch {
    throw new Error('pet.json 不是合法的 JSON');
  }
  const { pack, warnings } = validatePack(raw);
  const byPath = new Map(all.filter((e) => e.path.startsWith(prefix)).map((e) => [e.path.slice(prefix.length), e.data]));
  const files: ZipEntry[] = [];
  for (const [id, clip] of Object.entries(pack.clips)) {
    const path = safeEntryPath(clip.source);
    const data = path && byPath.get(path);
    if (!path || !data) {
      warnings.push(`片段 ${id} 的文件 ${clip.source} 不在包里`);
      continue;
    }
    if (!files.some((f) => f.path === path)) files.push({ path, data });
  }
  let renamedFrom: string | undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pack.id) || taken.has(pack.id)) {
    renamedFrom = pack.id;
    pack.id = packIdFrom(/^[a-z0-9-]+$/.test(pack.id) ? pack.id : pack.name, taken);
  }
  return { pack, files, renamedFrom, warnings };
}
