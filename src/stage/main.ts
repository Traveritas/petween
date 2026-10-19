// Stage entry: stage-0 runs the kernel, every other stage is a mirror.

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { tauriHost } from '../kernel/host';
import { Kernel } from '../kernel/kernel';
import { startMirror } from './mirror';

const label = getCurrentWebviewWindow().label;
const pets = document.getElementById('pets')!;
const layers = document.getElementById('layers')!;

addEventListener('error', (e) => tauriHost.log('error', `uncaught: ${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => tauriHost.log('error', `unhandled rejection: ${e.reason?.stack ?? e.reason}`));

if (label === 'stage-0') {
  const kernel = new Kernel(tauriHost, pets, layers);
  kernel.boot().catch((e) => tauriHost.log('error', `kernel boot failed: ${e?.stack ?? e}`));
} else {
  startMirror(tauriHost, label, pets).catch((e) => tauriHost.log('error', `mirror boot failed: ${e?.stack ?? e}`));
}
