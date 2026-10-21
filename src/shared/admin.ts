// Settings window ⇄ kernel RPC (docs/01 §1: the settings UI never holds pet state, it asks the kernel).
// Transport: Tauri events — `admin-call` to stage-0, `admin-result` back to the caller's window.

import type { ConnectorStatus, PluginManifest, SettingSpec } from '../api/types';

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  builtin: boolean;
  enabled: boolean;
  status: 'inactive' | 'active' | 'failed';
  error?: string;
  permissions: string[];
  /** Registered extension points owned by this plugin (connectors, brains…), for the "替换了默认大脑" notes. */
  provides: string[];
  settings: SettingSpec[];
  /** URL of the plugin's own settings page module, if it has one. */
  settingsPage?: string;
  baseUrl?: string;
  manifest: PluginManifest;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  owner: string;
  status: ConnectorStatus | null;
  error?: string;
  sessions: number;
  lastEventAt: number | null;
}

export interface PetInfo {
  id: string;
  pack: string;
  packName: string;
  scale: number;
  stateKey: string;
}

export interface PackInfo {
  id: string;
  name: string;
  builtin: boolean;
  creators: string[];
  license?: string;
  /** URL of the idle picture for a thumbnail. */
  preview?: string;
  /** Spritesheet grid of the preview picture (show only its first frame). */
  previewGrid?: { columns: number; rows: number };
}

export interface ChannelEntry {
  owner: string;
  priority: number;
  value: string;
  active: boolean;
}

export interface InspectorPet {
  id: string;
  brain: string;
  stateKey: string;
  resolvedKey: string;
  clip: string;
  state: ChannelEntry[];
  clipChannel: ChannelEntry[];
  position: ChannelEntry[];
  bubble: { owner: string; text: string; priority: number; showing: boolean; group: string; kind: string }[];
  motions: { owner: string; layer: string; blend: string; weight: number }[];
}

export interface KernelSettings {
  devMode: boolean;
  brain: string;
  binding: string;
}

export interface AdminApi {
  'plugins.list'(): PluginInfo[];
  'plugins.setEnabled'(p: { id: string; enabled: boolean }): void;
  'settings.get'(p: { plugin: string }): Record<string, unknown>;
  'settings.set'(p: { plugin: string; key: string; value: unknown }): void;
  /** A plugin's settings page asking its running plugin (ctx.settingsPage.handle). */
  'plugins.call'(p: { plugin: string; method: string; params?: unknown }): unknown;
  'connectors.list'(): ConnectorInfo[];
  'connectors.install'(p: { id: string }): void;
  'connectors.uninstall'(p: { id: string }): void;
  'pets.list'(): PetInfo[];
  'pets.add'(p: { pack: string }): void;
  'pets.remove'(p: { id: string }): void;
  'pets.setPack'(p: { id: string; pack: string }): void;
  'pets.setScale'(p: { id: string; scale: number }): void;
  'packs.list'(): PackInfo[];
  /** The pack changed on disk (editor saved): pets wearing it pick it up in place. */
  'packs.reload'(p: { id: string }): void;
  /** Show an unsaved draft on a desktop pet until pets.tryEnd. `baseUrl` = where its clip files are. */
  'pets.tryPack'(p: { petId: string; pack: unknown; baseUrl: string }): void;
  'pets.tryEnd'(p: { petId: string }): void;
  /** Hold a pet in a state (editor preview); null lets go. */
  'pets.forceState'(p: { petId: string; key: string | null }): void;
  'packs.openFolder'(): void;
  'plugins.openFolder'(): void;
  'kernel.get'(): KernelSettings & { brains: string[]; bindings: string[]; version: string; dataDir: string };
  'kernel.set'(p: Partial<KernelSettings>): void;
  'inspector.snapshot'(): InspectorPet[];
}

export type AdminMethod = keyof AdminApi;

export interface AdminCall {
  id: number;
  from: string;
  method: AdminMethod;
  params?: unknown;
}

export interface AdminResult {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}
