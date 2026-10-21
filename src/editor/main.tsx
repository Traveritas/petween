// Pet pack editor (docs/09 M3a). Left: state tree + clip library. Middle: live preview (the real
// renderer). Right: properties. Edits are a draft until 保存; 在桌面上试 shows the draft on a desktop pet.

import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClipDef, PetPack } from '../api/types';
import type { PackInfo, PluginInfo } from '../shared/admin';
import { call } from '../settings/rpc';
import '../settings/styles.css';
import { Mark, Slider, ToastHost, useToast } from '../settings/ui';
import './editor.css';
import { copyPack, openFolder, openPack, packExists, savePack, writePackFile, type OpenPack } from './files';
import { importFile } from './import/importer';
import { ClipPanel, PackPanel, StatePanel, type Edit } from './Inspector';
import { checkPack, emptyPack, packIdFrom, setClip, stateTree, usedClips, type TreeRow } from './model';
import { Preview } from './preview';
import { ClipThumb } from './widgets';

type Selection = { kind: 'state'; key: string } | { kind: 'clip'; id: string } | { kind: 'pack' };

function App() {
  const toast = useToast();
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [open, setOpen] = useState<OpenPack | null>(null);
  const [draft, setDraft] = useState<PetPack | null>(null);
  const [saved, setSaved] = useState('');
  const [sel, setSel] = useState<Selection>({ kind: 'state', key: 'idle' });
  const [extraKeys, setExtraKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [trying, setTrying] = useState<string | null>(null);
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const readOnly = !!open?.builtin;

  const refreshPacks = useCallback(async () => setPacks(await call('packs.list')), []);

  const load = useCallback(
    async (id: string, builtin?: boolean, force = false) => {
      if (!force && dirtyRef.current && !confirm('当前宠物包有改动没保存，确定切换？')) return;
      const info = builtin ?? (await call('packs.list')).find((p) => p.id === id)?.builtin ?? false;
      try {
        const o = await openPack(id, info);
        setOpen(o);
        setDraft(o.pack);
        setSaved(JSON.stringify(o.pack));
        setSel({ kind: 'state', key: 'idle' });
        history.replaceState(null, '', `?pack=${encodeURIComponent(id)}`);
      } catch (e) {
        toast(String(e instanceof Error ? e.message : e), true);
      }
    },
    [toast],
  );

  // First load: packs, plugin state keys, and the pack asked for (or the main pet's).
  useEffect(() => {
    void (async () => {
      const list = await call('packs.list');
      setPacks(list);
      setPlugins(await call('plugins.list'));
      const want = new URLSearchParams(location.search).get('pack') ?? (await call('pets.list'))[0]?.pack ?? list[0]?.id;
      if (want) await load(want, list.find((p) => p.id === want)?.builtin);
    })();
    const un = listen<string>('editor-open', (e) => void load(e.payload));
    const unClose = getCurrentWindow().onCloseRequested((e) => {
      if (dirtyRef.current && !confirm('有改动没保存，确定关闭编辑器？')) e.preventDefault();
    });
    return () => {
      void un.then((f) => f());
      void unClose.then((f) => f());
    };
  }, [load]);

  const edit: Edit = useCallback((fn) => setDraft((d) => (d ? fn(d) : d)), []);

  const tree = useMemo(() => {
    if (!draft) return [];
    const pluginKeys = plugins.map((p) => ({ name: p.name, stateKeys: p.manifest.contributes?.stateKeys }));
    return stateTree(draft, [...pluginKeys, { name: '自己加的', stateKeys: extraKeys.map((k) => ({ key: k, label: '' })) }]);
  }, [draft, plugins, extraKeys]);
  const issues = useMemo(() => (draft ? checkPack(draft) : []), [draft]);

  // ---------- preview ----------

  const stageRef = useRef<HTMLDivElement>(null);
  const petsRef = useRef<HTMLDivElement>(null);
  const preview = useRef<Preview | null>(null);
  const [zoom, setZoom] = useState(1);
  const [from, setFrom] = useState('');
  const [aligning, setAligning] = useState(false);
  const [ghostId, setGhostId] = useState('');
  const [feet, setFeet] = useState<{ x: number; y: number } | null>(null);

  // The stage only exists once a pack is open; the effects below rely on this one running first.
  const ready = !!draft && !!open;
  useEffect(() => {
    if (!ready || !petsRef.current) return;
    const p = new Preview(petsRef.current);
    preview.current = p;
    const t = setInterval(() => setFeet(p.feet()), 250);
    return () => {
      clearInterval(t);
      p.dispose();
      preview.current = null;
    };
  }, [ready]);

  useEffect(() => {
    if (draft && open) preview.current?.setPack(draft, open.baseUrl);
  }, [draft, open]);

  useEffect(() => {
    const p = preview.current;
    if (!p) return;
    if (sel.kind === 'clip') p.showClip(sel.id);
    else if (sel.kind === 'state') p.showState(sel.key);
  }, [sel, draft]);

  useEffect(() => preview.current?.setZoom(zoom), [zoom]);

  // Reference picture while aligning: the chosen clip, else idle's first picture.
  useEffect(() => {
    const p = preview.current;
    if (!p || !draft || !open) return;
    const refId = ghostId || draft.states.idle?.clips[0] || '';
    const clip = aligning && sel.kind === 'clip' && refId !== sel.id ? draft.clips[refId] : undefined;
    p.setGhost(clip ? { clip, baseUrl: open.baseUrl } : null);
  }, [aligning, ghostId, sel, draft, open]);

  // Drag the selected clip to move its feet point (anchor).
  const drag = useRef<{ x: number; y: number; anchor: { x: number; y: number }; w: number; h: number } | null>(null);
  const onDown = (e: RPointerEvent) => {
    if (!aligning || sel.kind !== 'clip' || !draft || readOnly) return;
    const b = preview.current?.bounds();
    if (!b || !b.width) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, anchor: draft.clips[sel.id].anchor ?? { x: 0.5, y: 0.96 }, w: b.width, h: b.height };
  };
  const anchorAt = (e: RPointerEvent) => {
    const d = drag.current!;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return { x: r(d.anchor.x - (e.clientX - d.x) / d.w), y: r(d.anchor.y - (e.clientY - d.y) / d.h) };
  };
  const onMove = (e: RPointerEvent) => {
    if (drag.current && sel.kind === 'clip') preview.current?.patchClip(sel.id, { anchor: anchorAt(e) });
  };
  const onUp = (e: RPointerEvent) => {
    if (!drag.current || sel.kind !== 'clip') return;
    const anchor = anchorAt(e);
    drag.current = null;
    const id = sel.id;
    edit((p) => setClip(p, id, { ...p.clips[id], anchor }));
  };

  // ---------- desktop try-on ----------

  useEffect(() => {
    if (!trying || !draft || !open) return;
    const t = setTimeout(() => void call('pets.tryPack', { petId: trying, pack: draft, baseUrl: open.baseUrl }).catch((e) => toast(String(e.message ?? e), true)), 300);
    return () => clearTimeout(t);
  }, [trying, draft, open, toast]);

  useEffect(() => {
    if (trying) void call('pets.forceState', { petId: trying, key: sel.kind === 'state' ? sel.key : null });
  }, [trying, sel]);

  const toggleTry = async () => {
    if (trying) {
      await call('pets.tryEnd', { petId: trying });
      setTrying(null);
      return;
    }
    const pets = await call('pets.list');
    const pet = pets.find((p) => p.pack === draft?.id) ?? pets[0];
    if (!pet) return toast('桌面上没有宠物', true);
    setTrying(pet.id);
    toast(`在桌面的 ${pet.packName} 身上试穿（不会保存）`);
  };

  // ---------- files ----------

  const save = useCallback(async () => {
    if (!draft || readOnly) return;
    const errors = checkPack(draft).filter((i) => i.level === 'error');
    if (errors.length) return toast(errors[0].text, true);
    setBusy('保存中…');
    try {
      await savePack(draft);
      setSaved(JSON.stringify(draft));
      await call('packs.reload', { id: draft.id });
      await refreshPacks();
      toast('已保存');
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : e}`, true);
    } finally {
      setBusy('');
    }
  }, [draft, readOnly, toast, refreshPacks]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save();
      }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [save]);

  const newPack = async () => {
    if (dirty && !confirm('当前宠物包有改动没保存，确定新建？')) return;
    const name = prompt('新宠物包叫什么名字？')?.trim();
    if (!name) return;
    const id = packIdFrom(name, new Set(packs.map((p) => p.id)));
    if (await packExists(id)) return toast(`宠物包 ${id} 已经存在`, true);
    await savePack(emptyPack(id, name));
    await refreshPacks();
    await load(id, false, true);
  };

  const duplicate = async () => {
    if (!open || !draft) return;
    if (dirty && !open.builtin && !confirm('复制的是已保存的版本，当前改动不会带过去。继续？')) return;
    const name = prompt('复制出来的宠物包叫什么？', `${draft.name} 的副本`)?.trim();
    if (!name) return;
    const id = packIdFrom(name, new Set(packs.map((p) => p.id)));
    setBusy('复制中…');
    try {
      await copyPack({ ...open, pack: open.builtin ? draft : JSON.parse(saved) }, id, name);
      await refreshPacks();
      await load(id, false, true);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), true);
    } finally {
      setBusy('');
    }
  };

  // ---------- import ----------

  const fileInput = useRef<HTMLInputElement>(null);
  const [removeBg, setRemoveBg] = useState(false);
  const [dropping, setDropping] = useState(false);
  const importFiles = async (files: File[]) => {
    if (!draft || !files.length) return;
    if (readOnly) return toast('内置宠物包不能改，先「复制一份」', true);
    let pack = draft;
    for (const [i, f] of files.entries()) {
      setBusy(`导入 ${i + 1}/${files.length}：${f.name}`);
      try {
        const r = await importFile(f, new Set(Object.keys(pack.clips)), { removeBackground: removeBg });
        await writePackFile(pack.id, r.path, r.bytes);
        pack = setClip(pack, r.id, r.clip);
        setDraft(pack);
        setSel({ kind: 'clip', id: r.id });
        if (r.warnings.length) toast(`${f.name}：${r.warnings.join('；')}`, true);
      } catch (e) {
        toast(`${f.name} 导入失败：${e instanceof Error ? e.message : e}`, true);
      }
    }
    setBusy('');
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    void importFiles([...e.dataTransfer.files]);
  };

  // ---------- render ----------

  if (!draft || !open) {
    return (
      <div className="welcome">
        <div className="card">
          <b>宠物编辑器</b>
          <span className="note">正在读取宠物包…</span>
        </div>
      </div>
    );
  }

  const row = sel.kind === 'state' ? (tree.find((r) => r.key === sel.key) ?? { key: sel.key, label: '', source: '自己加的', depth: 0, own: false, fallsBackTo: 'idle' }) : null;
  const clipIds = Object.keys(draft.clips);
  const used = usedClips(draft);
  const selClip: ClipDef | undefined = sel.kind === 'clip' ? draft.clips[sel.id] : undefined;
  const stateKeys = tree.map((r) => r.key);
  const stageH = stageRef.current?.clientHeight ?? 0;

  return (
    <div className="ed">
      <header className="ed-top">
        <Mark />
        <div className="title">
          <b>{draft.name || draft.id}</b>
          {dirty && <span className="dirty-dot" title="有改动没保存" />}
          {readOnly && <span className="pill plain">内置 · 只读</span>}
        </div>
        <select value={`${open.builtin ? 'b' : 'u'}:${draft.id}`} onChange={(e) => void load(e.target.value.slice(2), e.target.value.startsWith('b:'))} aria-label="选择宠物包">
          {packs.map((p) => (
            <option key={`${p.builtin}:${p.id}`} value={`${p.builtin ? 'b' : 'u'}:${p.id}`}>
              {p.name}
              {p.builtin ? '（内置）' : ''}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={() => void newPack()}>
          新建
        </button>
        <button className="btn small" onClick={() => void duplicate()}>
          复制一份
        </button>
        {!readOnly && (
          <button className="btn small quiet" onClick={() => void openFolder(draft.id)}>
            打开文件夹
          </button>
        )}
        <div className="grow" />
        {busy && <span className="note">{busy}</span>}
        <button className={`btn small${trying ? ' primary' : ''}`} onClick={() => void toggleTry()}>
          {trying ? '停止桌面试穿' : '在桌面上试'}
        </button>
        {!readOnly && (
          <>
            <button className="btn small" disabled={!dirty} onClick={() => confirm('放弃所有没保存的改动？') && setDraft(JSON.parse(saved))}>
              放弃改动
            </button>
            <button className="btn small primary" disabled={!dirty || !!busy} onClick={() => void save()}>
              保存
            </button>
          </>
        )}
      </header>

      <div className="ed-main">
        {/* ---------- left: states + clips ---------- */}
        <aside className="pane pane-left">
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <h3>
              状态<span className="grow" />
              <button className={`btn quiet small${sel.kind === 'pack' ? ' primary' : ''}`} onClick={() => setSel({ kind: 'pack' })}>
                宠物包信息
              </button>
            </h3>
            <div className="tree">
              {tree.map((r: TreeRow) => (
                <button key={r.key} className={`tree-row${sel.kind === 'state' && sel.key === r.key ? ' on' : ''}`} style={{ paddingLeft: 8 + r.depth * 14 }} onClick={() => setSel({ kind: 'state', key: r.key })} title={r.hint ?? r.source}>
                  <span className={`mark${r.own ? ' own' : ''}`} />
                  <span className="key">{r.key.split('.').pop()}</span>
                  {r.label && <span className="lbl">{r.label}</span>}
                  {!r.own && r.fallsBackTo && <span className="fb">→ {r.fallsBackTo}</span>}
                </button>
              ))}
              <form
                className="tree-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = (e.target as HTMLFormElement).elements.namedItem('k') as HTMLInputElement;
                  const k = input.value.trim();
                  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(k)) return toast('状态键用字母、数字，用点分层，如 active.command.Bash', true);
                  setExtraKeys((x) => (x.includes(k) ? x : [...x, k]));
                  setSel({ kind: 'state', key: k });
                  input.value = '';
                }}
              >
                <input name="k" className="input mono" placeholder="其他状态键，如 active.command.Bash" />
              </form>
            </div>
          </div>

          <section className={`lib${dropping ? ' drop' : ''}`} onDragOver={(e) => (e.preventDefault(), setDropping(true))} onDragLeave={() => setDropping(false)} onDrop={onDrop}>
            <h3>
              片段 <span className="note">{clipIds.length}</span>
              <span className="grow" />
              {!readOnly && (
                <button className="btn small" onClick={() => fileInput.current?.click()}>
                  导入素材
                </button>
              )}
            </h3>
            {!readOnly && (
              <label className="lib-opts">
                <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} /> 导入时去掉纯色背景
              </label>
            )}
            <input ref={fileInput} type="file" multiple accept="image/*,video/*,.apng" hidden onChange={(e) => (void importFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />
            {clipIds.length === 0 ? (
              <div className="lib-empty">把图片、GIF 或短视频拖到这里，或点「导入素材」。</div>
            ) : (
              <div className="lib-grid">
                {clipIds.map((id) => (
                  <button key={id} className={`lib-item${sel.kind === 'clip' && sel.id === id ? ' on' : ''}${used.has(id) ? '' : ' unused'}`} onClick={() => setSel({ kind: 'clip', id })} title={used.has(id) ? id : `${id}（还没有状态用到）`}>
                    <ClipThumb clip={draft.clips[id]} baseUrl={open.baseUrl} size={56} />
                    <span className="name">{id}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </aside>

        {/* ---------- middle: preview ---------- */}
        <main className="pane-center">
          <div className="pv-bar">
            <span className="label">{sel.kind === 'state' ? sel.key : sel.kind === 'clip' ? `片段 ${sel.id}` : draft.name}</span>
            {sel.kind === 'state' && (
              <>
                <button className="btn small" onClick={() => preview.current?.replay(from || undefined)}>
                  ▶ 重播切换
                </button>
                <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="从哪个状态切过来">
                  <option value="">从头开始</option>
                  {stateKeys
                    .filter((k) => k !== sel.key)
                    .map((k) => (
                      <option key={k} value={k}>
                        从 {k} 切过来
                      </option>
                    ))}
                </select>
              </>
            )}
            {sel.kind === 'clip' && aligning && (
              <select value={ghostId} onChange={(e) => setGhostId(e.target.value)} aria-label="对齐参照">
                <option value="">参照：idle 的图</option>
                {clipIds
                  .filter((c) => c !== sel.id)
                  .map((c) => (
                    <option key={c} value={c}>
                      参照：{c}
                    </option>
                  ))}
              </select>
            )}
            <span className="grow" />
            <span className="note">缩放</span>
            <Slider value={zoom} min={0.3} max={3} step={0.1} compact onChange={setZoom} />
          </div>
          <div ref={stageRef} className={`pv-stage checker${aligning && sel.kind === 'clip' ? ' aligning' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
            <div ref={petsRef} className="pets" />
            {stageH > 0 && <div className="ground" style={{ top: stageH * 0.8 }} />}
            {feet && <div className="feet" style={{ left: feet.x, top: feet.y }} />}
            {aligning && sel.kind === 'clip' && <div className="pv-hint">拖动图片，让脚底落在红色十字上；半透明的是参照图</div>}
          </div>
          <div className="pv-foot">
            {issues.length === 0 ? (
              <span className="note">没有发现问题</span>
            ) : (
              issues.slice(0, 3).map((i) => (
                <div key={i.text} className={`issue ${i.level}`}>
                  {i.level === 'error' ? '✕' : '!'} {i.text}
                </div>
              ))
            )}
          </div>
        </main>

        {/* ---------- right: properties ---------- */}
        <aside className="pane pane-right">
          {sel.kind === 'state' && row && <StatePanel pack={draft} baseUrl={open.baseUrl} row={row} edit={edit} readOnly={readOnly} onPickClip={(id) => setSel({ kind: 'clip', id })} />}
          {sel.kind === 'clip' && selClip && <ClipPanel pack={draft} baseUrl={open.baseUrl} id={sel.id} edit={edit} readOnly={readOnly} aligning={aligning} setAligning={setAligning} />}
          {sel.kind === 'pack' && <PackPanel pack={draft} edit={edit} readOnly={readOnly} />}
          {readOnly && (
            <div className="insp">
              <div className="callout">
                内置宠物包不能直接改。
                <button className="btn small primary" onClick={() => void duplicate()}>
                  复制一份来改
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ToastHost>
    <App />
  </ToastHost>,
);
