// Calls into the kernel (src/shared/admin.ts). The settings window owns no pet state.
// The window can open before the kernel is listening (cold start with --settings), so calls are
// queued behind a handshake: ping until the kernel answers once, then send.

import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { AdminApi, AdminCall, AdminMethod, AdminResult } from '../shared/admin';

// Used by the settings window and the editor; results are sent back to whichever window asked.
const self = getCurrentWebviewWindow();

let seq = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

const listening = listen<AdminResult>('admin-result', (e) => {
  const p = pending.get(e.payload.id);
  if (!p) return;
  pending.delete(e.payload.id);
  if (e.payload.ok) p.resolve(e.payload.value);
  else p.reject(new Error(e.payload.error ?? '失败'));
});

function send<M extends AdminMethod>(method: M, params: unknown, timeoutMs: number): Promise<unknown> {
  const id = ++seq;
  const msg: AdminCall = { id, from: self.label, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    void emitTo('stage-0', 'admin-call', msg);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('内核没有响应'));
    }, timeoutMs);
  });
}

const ready: Promise<void> = (async () => {
  await listening;
  for (;;) {
    try {
      await send('kernel.get', undefined, 600);
      return;
    } catch {
      /* kernel still booting: try again */
    }
  }
})();

export async function call<M extends AdminMethod>(method: M, ...params: Parameters<AdminApi[M]>): Promise<Awaited<ReturnType<AdminApi[M]>>> {
  await ready;
  return send(method, params[0], 15000) as Promise<Awaited<ReturnType<AdminApi[M]>>>;
}
