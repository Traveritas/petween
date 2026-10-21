// Where packs live and how the editor reads / writes them. User packs: <app data>/pets/<id>/;
// built-in packs ship with the app and are read-only (copy one to change it).

import type { PetPack } from '../api/types';
import { joinPath, PACK_BASE, tauriHost as host, type HostPaths } from '../kernel/host';

let paths: Promise<HostPaths> | null = null;
const P = () => (paths ??= host.paths());

export interface OpenPack {
  pack: PetPack;
  /** Where clip sources resolve (ends with '/'). */
  baseUrl: string;
  builtin: boolean;
}

export const userBase = (id: string) => `${PACK_BASE}/${encodeURIComponent(id)}/`;

export async function packDir(id: string) {
  return joinPath((await P()).pets, id);
}

export async function openPack(id: string, builtin: boolean): Promise<OpenPack> {
  if (builtin) {
    const baseUrl = new URL(`packs/${id}/`, location.href).href;
    const res = await fetch(new URL('pet.json', baseUrl));
    if (!res.ok) throw new Error(`读不到内置宠物包 ${id}`);
    return { pack: await res.json(), baseUrl, builtin };
  }
  const pack = JSON.parse(await host.readText(joinPath(await packDir(id), 'pet.json'))) as PetPack;
  return { pack, baseUrl: userBase(id), builtin };
}

export async function savePack(pack: PetPack) {
  await host.writeText(joinPath(await packDir(pack.id), 'pet.json'), `${JSON.stringify(pack, null, 2)}\n`);
}

/** A file inside a user pack (e.g. an imported clip). */
export async function writePackFile(packId: string, rel: string, bytes: Uint8Array) {
  await host.writeBytes(joinPath(await packDir(packId), rel), bytes);
}

export async function packExists(id: string) {
  return host.exists(joinPath(await packDir(id), 'pet.json'));
}

/** Copy a pack (built-in or user) into a new user pack: every clip file, then pet.json. */
export async function copyPack(from: OpenPack, id: string, name: string): Promise<OpenPack> {
  const sources = new Set(Object.values(from.pack.clips).map((c) => c.source));
  for (const src of sources) {
    const res = await fetch(new URL(src, from.baseUrl));
    if (!res.ok) throw new Error(`复制 ${src} 失败`);
    await writePackFile(id, src, new Uint8Array(await res.arrayBuffer()));
  }
  const pack: PetPack = { ...structuredClone(from.pack), id, name };
  await savePack(pack);
  return { pack, baseUrl: userBase(id), builtin: false };
}

export async function openFolder(id: string) {
  await host.exec('explorer', [(await packDir(id)).replace(/\//g, '\\')]);
}
