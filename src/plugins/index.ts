// Built-in plugins ship with the app but load through the same lifecycle as third-party ones (docs/01 §5).

import type { PluginManifest, PluginModule } from '../api/types';
import core, { manifest as coreManifest } from './core';
import physics, { manifest as physicsManifest } from './physics';

export const BUILTIN_PLUGINS: { manifest: PluginManifest; module: PluginModule }[] = [
  { manifest: coreManifest, module: core },
  { manifest: physicsManifest, module: physics },
];
