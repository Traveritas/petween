// A plugin's own settings page (docs/06 §8): its `settings` module is imported from the plugin
// folder and mounted into a shadow root, so its styles can't leak into the rest of the window.
// Our stylesheet is copied into the shadow root to give pages the native controls for free.

import { useEffect, useRef, useState } from 'react';
import type { SettingsPageApi, SettingsPageModule } from '../api/types';
import type { PluginInfo } from '../shared/admin';
import { call } from './rpc';
import css from './styles.css?inline';
import { useToast } from './ui';

export function PluginPage({ p }: { p: PluginInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !p.settingsPage) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = `${css}\n:host { display: block; }`;
    const box = document.createElement('div');
    root.append(style, box);

    const api: SettingsPageApi = {
      pluginId: p.id,
      baseUrl: p.baseUrl ?? '',
      settings: {
        all: () => call('settings.get', { plugin: p.id }),
        set: (key, value) => call('settings.set', { plugin: p.id, key, value }),
      },
      call: (method, params) => call('plugins.call', { plugin: p.id, method, params }) as Promise<never>,
      toast,
    };

    let cleanup: (() => void) | void;
    let gone = false;
    setError(null);
    // Fresh import every time the page opens, so edits show up without restarting.
    import(/* @vite-ignore */ `${p.settingsPage}?v=${Date.now()}`)
      .then(async (mod: Partial<SettingsPageModule> & { default?: Partial<SettingsPageModule> }) => {
        const mount = mod.mount ?? mod.default?.mount;
        if (typeof mount !== 'function') throw new Error('设置页没有导出 mount');
        const c = await mount(box, api);
        if (gone) c?.();
        else cleanup = c;
      })
      .catch((e) => !gone && setError(`设置页加载失败：${e instanceof Error ? e.message : e}`));
    return () => {
      gone = true;
      try {
        cleanup?.();
      } catch (e) {
        console.error(e);
      }
      root.replaceChildren();
    };
  }, [p.id, p.settingsPage, p.baseUrl, toast]);

  return (
    <div className="plugin-page">
      <div ref={host} />
      {error && <div className="err">{error}</div>}
    </div>
  );
}
