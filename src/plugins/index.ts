// Built-in plugins ship with the app but load through the same lifecycle as third-party ones (docs/01 §5).

import type { PluginManifest, PluginModule } from '../api/types';
import brainDefault, { manifest as brainDefaultManifest } from './brain-default';
import claudeCode, { manifest as claudeCodeManifest } from './claude-code';
import codex, { manifest as codexManifest } from './codex';
import core, { manifest as coreManifest } from './core';
import physics, { manifest as physicsManifest } from './physics';
import zcode, { manifest as zcodeManifest } from './zcode';

export const BUILTIN_PLUGINS: { manifest: PluginManifest; module: PluginModule }[] = [
  { manifest: coreManifest, module: core },
  { manifest: brainDefaultManifest, module: brainDefault },
  { manifest: claudeCodeManifest, module: claudeCode },
  { manifest: codexManifest, module: codex },
  { manifest: zcodeManifest, module: zcode },
  { manifest: physicsManifest, module: physics },
];
