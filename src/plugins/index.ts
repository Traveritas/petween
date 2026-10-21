// Built-in plugins ship with the app but load through the same lifecycle as third-party ones (docs/01 §5).

import type { PluginManifest, PluginModule } from '../api/types';
import bubble, { manifest as bubbleManifest } from './bubble';
import brainDefault, { manifest as brainDefaultManifest } from './brain-default';
import claudeCode, { manifest as claudeCodeManifest } from './claude-code';
import codex, { manifest as codexManifest } from './codex';
import core, { manifest as coreManifest } from './core';
import particles, { manifest as particlesManifest } from './particles';
import perSession, { manifest as perSessionManifest } from './per-session';
import physics, { manifest as physicsManifest } from './physics';
import statsHud, { manifest as statsHudManifest } from './stats-hud';
import zcode, { manifest as zcodeManifest } from './zcode';

export const BUILTIN_PLUGINS: { manifest: PluginManifest; module: PluginModule }[] = [
  { manifest: coreManifest, module: core },
  { manifest: brainDefaultManifest, module: brainDefault },
  { manifest: claudeCodeManifest, module: claudeCode },
  { manifest: codexManifest, module: codex },
  { manifest: zcodeManifest, module: zcode },
  { manifest: perSessionManifest, module: perSession },
  { manifest: physicsManifest, module: physics },
  { manifest: bubbleManifest, module: bubble },
  { manifest: statsHudManifest, module: statsHud },
  { manifest: particlesManifest, module: particles },
];
