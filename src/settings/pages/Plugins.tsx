import { useState } from 'react';
import type { PluginInfo } from '../../shared/admin';
import { PluginPage } from '../PluginPage';
import { call } from '../rpc';
import { Field, Toggle, useAction, useLoad } from '../ui';

const PERMISSION: Record<string, string> = { 'fs:read': '读文件', 'fs:write': '写文件', shell: '运行命令', http: '联网' };
const PROVIDES: Record<string, string> = { connector: '接入', brain: '大脑', binding: '绑定规则', motion: '动作类型', transition: '过渡类型' };

function Settings({ p }: { p: PluginInfo }) {
  const values = useLoad(() => call('settings.get', { plugin: p.id }), [p.id]);
  const { run } = useAction();
  return (
    <>
      {p.settingsPage && <PluginPage p={p} />}
      {values.data && p.settings.length > 0 && (
        <div className="fields">
          {p.settings.map((s) => (
            <Field key={s.key} spec={s} value={values.data![s.key]} onChange={(v) => void run(() => call('settings.set', { plugin: p.id, key: s.key, value: v })).then(values.reload)} />
          ))}
        </div>
      )}
    </>
  );
}

function provides(p: PluginInfo) {
  // Built-in motion/transition types are plumbing; only surface what a user would care about.
  const shown = p.provides.filter((x) => !x.startsWith('motion:') && !x.startsWith('transition:'));
  return shown.map((x) => {
    const [kind, id] = x.split(':');
    return `${PROVIDES[kind] ?? kind} ${id}`;
  });
}

export function Plugins() {
  const list = useLoad(() => call('plugins.list'));
  const kernel = useLoad(() => call('kernel.get'));
  const { busy, run } = useAction();
  const [open, setOpen] = useState<string | null>(null);

  const section = (title: string, items: PluginInfo[]) =>
    items.length > 0 && (
      <>
        <h2>{title}</h2>
        {items.map((p) => (
          <div className="card" key={p.id}>
            <div className="row">
              <div className="body">
                <div className="title">
                  {p.name}
                  <span className="note mono">
                    {p.id} {p.version}
                  </span>
                  {p.status === 'failed' && <span className="pill bad">没能启动</span>}
                  {p.enabled && p.status === 'inactive' && <span className="pill warn">未运行</span>}
                </div>
                <div className="sub">
                  {[...provides(p), ...p.permissions.map((x) => PERMISSION[x] ?? x)].join(' · ') || ' '}
                </div>
                {p.error && <div className="err">{p.error}</div>}
              </div>
              {(p.settings.length > 0 || p.settingsPage) && (
                <button className="btn small" onClick={() => setOpen(open === p.id ? null : p.id)} aria-expanded={open === p.id}>
                  {open === p.id ? '收起' : '设置'}
                </button>
              )}
              <Toggle
                label={`启用 ${p.name}`}
                on={p.enabled}
                disabled={busy || p.id === 'core'}
                onChange={(on) => void run(() => call('plugins.setEnabled', { id: p.id, enabled: on })).then(list.reload)}
              />
            </div>
            {open === p.id && <Settings p={p} />}
          </div>
        ))}
      </>
    );

  return (
    <div className="page">
      <h1>插件</h1>
      <p className="lead">Petween 的功能几乎都是插件，内置的也一样。装第三方插件等于信任它的作者。</p>
      {list.error && <div className="err">{list.error}</div>}
      {list.data && section('内置', list.data.filter((p) => p.builtin))}
      {list.data && section('第三方', list.data.filter((p) => !p.builtin))}

      <h2>开发</h2>
      <div className="card">
        <div className="row">
          <div className="body">
            <div className="title">插件开发模式</div>
            <div className="sub">插件文件夹里的文件一保存就自动重新加载。</div>
          </div>
          <Toggle label="插件开发模式" on={!!kernel.data?.devMode} onChange={(on) => void run(() => call('kernel.set', { devMode: on })).then(kernel.reload)} />
        </div>
      </div>
      <div className="toolbar">
        <button className="btn" onClick={() => void run(() => call('plugins.openFolder'))}>
          打开插件文件夹
        </button>
        <span className="note">新装的插件重启 Petween 后加载（开发模式下自动加载）。</span>
      </div>
    </div>
  );
}
