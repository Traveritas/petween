// Motion editing (docs/09 M3b): the motion list on the left, and the right pane for one motion —
// a form built from the type's paramsSchema, or the track-bar keyframe editor for `keyframes`.

import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PetPack } from '../api/types';
import { BUILTIN_MOTION_TYPES, PROPERTY_LABELS } from '../kernel/motion/builtin';
import { isProperty, PROPERTIES, restValue } from '../kernel/motion/compose';
import { Toggle } from '../settings/ui';
import type { Edit } from './Inspector';
import { MOTION_PRESETS, motionKind } from './model';
import {
  addTrack,
  kfEnd,
  markersOf,
  motionUsers,
  NEW_MOTIONS,
  repeatGap,
  rescaleTime,
  sameDef,
  scaleAmplitude,
  setMarkers,
  setRepeat,
  setTrack,
  tracksOf,
  valueAt,
  type Key,
  type MotionDef,
  type MotionLibrary,
} from './motions';
import { Group, NumberInput, Row, TextInput } from './widgets';

export type MotionSource = 'pack' | 'preset' | 'library';

export const TYPE_LABELS: Record<string, string> = { keyframes: 'K 帧', sine: '来回摆', noise: '随机晃', spring: '弹簧' };
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;
export const kindLabel = (def: MotionDef) => (motionKind(def) === 'loop' ? '持续' : '进入 / 离开');

const SHORT: Record<string, string> = { x: '左右', y: '上下', rotate: '旋转', skewX: '横斜切', skewY: '纵斜切', scaleX: '横缩放', scaleY: '纵缩放', opacity: '透明度' };
const EASES: { value: string; label: string }[] = [
  { value: 'linear', label: '匀速' },
  { value: 'in', label: '加速' },
  { value: 'out', label: '减速' },
  { value: 'inOut', label: '先加速后减速' },
  { value: 'outBack', label: '冲过头再回来' },
  { value: 'step', label: '最后一刻跳过去' },
];

// ---------- left: the list ----------

export function MotionList({
  pack,
  library,
  sel,
  onPick,
  onNew,
  readOnly,
}: {
  pack: PetPack;
  library: MotionLibrary;
  sel: { name: string; from: MotionSource } | null;
  onPick(name: string, from: MotionSource): void;
  onNew(template: string): void;
  readOnly: boolean;
}) {
  const own = Object.entries(pack.motions ?? {});
  const presets = Object.entries(MOTION_PRESETS).filter(([n]) => !pack.motions?.[n]);
  const lib = Object.entries(library.motions).sort((a, b) => b[1].savedAt - a[1].savedAt);
  const item = (name: string, from: MotionSource, def: MotionDef, label = name) => {
    const users = from === 'pack' ? motionUsers(pack, name).length : 0;
    return (
      <button key={`${from}:${name}`} className={`mot-row${sel?.from === from && sel.name === name ? ' on' : ''}`} onClick={() => onPick(name, from)}>
        <span className="n">{label}</span>
        <span className="k">{kindLabel(def)}</span>
        {from === 'pack' && <span className={`u${users ? '' : ' none'}`}>{users ? `${users} 处` : '未用'}</span>}
      </button>
    );
  };
  return (
    <div className="mot-list">
      <div className="mot-h">
        这个宠物包 <span className="note">{own.length}</span>
        <span className="grow" />
        {!readOnly && (
          <select className="mot-new" value="" onChange={(e) => e.target.value && onNew(e.target.value)} aria-label="新建动作">
            <option value="">＋ 新动作…</option>
            {NEW_MOTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {own.length === 0 && <div className="lib-empty">还没有动作。从下面的预设或动作库里挑一个，或新建。</div>}
      {own.map(([n, d]) => item(n, 'pack', d, MOTION_PRESETS[n] ? `${MOTION_PRESETS[n].label}（${n}）` : n))}
      <div className="mot-h">我的动作库 <span className="note">{lib.length}</span></div>
      {lib.length === 0 && <div className="lib-empty">在一个动作上点「存到我的动作库」，就能在别的宠物包里用。</div>}
      {lib.map(([n, e]) => item(n, 'library', e.def))}
      {presets.length > 0 && <div className="mot-h">内置预设</div>}
      {presets.map(([n, p]) => item(n, 'preset', p.def, p.label))}
    </div>
  );
}

// ---------- right: one motion ----------

export function MotionPanel({
  pack,
  name,
  from,
  def,
  edit,
  readOnly,
  library,
  effects,
  onRename,
  onAddToPack,
  onSaveToLibrary,
  onRemoveFromLibrary,
  onDuplicate,
  onDelete,
  onPickState,
}: {
  pack: PetPack;
  name: string;
  from: MotionSource;
  def: MotionDef;
  edit: Edit;
  readOnly: boolean;
  library: MotionLibrary;
  effects: { value: string; label: string }[];
  onRename(to: string): void;
  onAddToPack(): void;
  onSaveToLibrary(): void;
  onRemoveFromLibrary(): void;
  onDuplicate(): void;
  onDelete(): void;
  onPickState(key: string): void;
}) {
  const editable = from === 'pack' && !readOnly;
  const put = (next: MotionDef) => edit((p) => ({ ...p, motions: { ...p.motions, [name]: next } }));
  const users = from === 'pack' ? motionUsers(pack, name) : [];
  const inLib = library.motions[name];
  const title = from === 'preset' ? `${MOTION_PRESETS[name]?.label ?? name}` : name;
  const FIELD = { enter: '进入', loop: '持续', exit: '离开' } as const;

  return (
    <div className="insp">
      <div className="head">
        <div className="key">{title}</div>
        <div className="sub">
          {typeLabel(def.type)} · {kindLabel(def)} · {from === 'pack' ? '这个宠物包里的' : from === 'library' ? '我的动作库（只读，加到宠物包后再改）' : '内置预设（只读，加到宠物包后再改）'}
        </div>
      </div>

      {from !== 'pack' && (
        <div className="callout">
          <span>{pack.motions?.[name] ? `这个宠物包里已经有叫「${name}」的动作，加进去会改名。` : '加到宠物包后，就能在状态里选它，也能改它。'}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn small primary" disabled={readOnly} onClick={onAddToPack}>
              加到这个宠物包
            </button>
            {from === 'library' && (
              <button className="btn small quiet danger" onClick={() => confirm(`从动作库里删除「${name}」？已经加到宠物包里的不受影响。`) && onRemoveFromLibrary()}>
                从库里删除
              </button>
            )}
          </div>
        </div>
      )}

      {from === 'pack' && (
        <>
          <Group title="名字">
            <TextInput value={name} onChange={(v) => editable && onRename(v)} />
          </Group>
          <Group title="用在">
            {users.length ? (
              <div className="checks">
                {users.map((u) => (
                  <button key={`${u.key}:${u.field}`} className="check" onClick={() => onPickState(u.key)}>
                    {u.key} · {FIELD[u.field]}
                  </button>
                ))}
              </div>
            ) : (
              <div className="note">还没有状态用它：选一个状态，在「动作」里挑它。</div>
            )}
            {users.length > 1 && <div className="note">改这个动作会影响上面所有状态；只想改其中一个，先「复制一份」。</div>}
          </Group>
        </>
      )}

      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
        {def.type === 'keyframes' ? <KeyframePanel def={def} onChange={put} readOnly={!editable} effects={effects} /> : <ParamsPanel def={def} onChange={put} />}
      </fieldset>

      {from === 'pack' && (
        <Group title="动作库">
          <div className="note">
            {!inLib ? '库里没有叫这个名字的动作。' : sameDef(inLib.def, def) ? '库里有一份一样的。' : '库里有同名的动作，但和这里的不一样；存进去会覆盖库里的。'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn small" disabled={!!inLib && sameDef(inLib.def, def)} onClick={() => (!inLib || confirm(`覆盖动作库里的「${name}」？`)) && onSaveToLibrary()}>
              {inLib ? '存到我的动作库（覆盖）' : '存到我的动作库'}
            </button>
          </div>
        </Group>
      )}

      {editable && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn small" onClick={onDuplicate}>
            复制一份
          </button>
          <button className="btn small quiet danger" onClick={() => confirm(users.length ? `删除「${name}」？${users.length} 处用到它的状态会不再播它。` : `删除「${name}」？`) && onDelete()}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- params from paramsSchema ----------

interface FieldSchema {
  type?: string;
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  enum?: unknown[];
  oneOf?: { const: unknown; title?: string }[];
}

function ParamsPanel({ def, onChange }: { def: MotionDef; onChange(d: MotionDef): void }) {
  const schema = BUILTIN_MOTION_TYPES.find((t) => t.id === def.type)?.paramsSchema as { properties?: Record<string, FieldSchema> } | undefined;
  if (!schema?.properties) return <JsonPanel def={def} onChange={onChange} />;
  const set = (k: string, v: unknown) => onChange({ ...def, [k]: v });
  return (
    <Group title="参数">
      {Object.entries(schema.properties).map(([k, s]) => {
        const value = def[k] ?? s.default;
        const options = s.oneOf?.map((o) => ({ value: o.const, label: o.title ?? String(o.const) })) ?? s.enum?.map((v) => ({ value: v, label: String(v) }));
        let control;
        if (options) {
          control = (
            <select value={String(value ?? '')} onChange={(e) => set(k, options.find((o) => String(o.value) === e.target.value)?.value)}>
              {options.map((o) => (
                <option key={String(o.value)} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          );
        } else if (s.type === 'number') {
          const n = typeof value === 'number' ? value : 0;
          control = <NumberInput value={n} min={s.minimum} max={s.maximum} step={stepFor(n)} width={96} onChange={(v) => set(k, v)} />;
        } else if (s.type === 'boolean') {
          control = <Toggle on={!!value} label={s.title ?? k} onChange={(v) => set(k, v)} />;
        } else control = <TextInput value={String(value ?? '')} onChange={(v) => set(k, v)} />;
        return (
          <div key={k} className="param">
            <Row label={s.title ?? k}>{control}</Row>
            {s.description && <div className="note hint">{s.description}</div>}
          </div>
        );
      })}
    </Group>
  );
}

const stepFor = (v: number) => (Math.abs(v) < 0.2 ? 0.005 : Math.abs(v) < 5 ? 0.1 : 1);

/** Types the editor knows nothing about (a plugin's): edit the raw parameters. */
function JsonPanel({ def, onChange }: { def: MotionDef; onChange(d: MotionDef): void }) {
  const [text, setText] = useState(JSON.stringify(def, null, 2));
  const [err, setErr] = useState('');
  return (
    <Group title="参数（JSON）">
      <div className="note">这个动作类型来自插件，编辑器不认识它的参数，只能直接改。</div>
      <textarea
        className="input mono json"
        rows={10}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const d = JSON.parse(text);
            if (!d || typeof d.type !== 'string') throw new Error('需要 type 字段');
            setErr('');
            onChange(d);
          } catch (e) {
            setErr(String(e instanceof Error ? e.message : e));
          }
        }}
      />
      {err && <div className="issue error">✕ {err}</div>}
    </Group>
  );
}

// ---------- keyframes ----------

type KfSel = { kind: 'key'; prop: string; i: number } | { kind: 'marker'; t: string } | null;

function KeyframePanel({ def, onChange, readOnly, effects }: { def: MotionDef; onChange(d: MotionDef): void; readOnly: boolean; effects: { value: string; label: string }[] }) {
  const [sel, setSel] = useState<KfSel>(null);
  const tracks = tracksOf(def);
  const markers = markersOf(def);
  const gap = repeatGap(def);
  const end = kfEnd(def);
  const span = Math.ceil(Math.max(300, end * 1.15) / 100) * 100;
  const tick = span <= 600 ? 100 : span <= 1500 ? 250 : 500;
  const props = Object.keys(tracks);
  const missing = PROPERTIES.filter((p) => !tracks[p]);

  // Dragging: the moved item shows at `drag.t` until the pointer is released.
  const [drag, setDrag] = useState<{ sel: NonNullable<KfSel>; t: number } | null>(null);
  const start = useRef<{ x: number; t: number; w: number; moved: boolean } | null>(null);
  const snap = (t: number) => Math.max(0, Math.round(t / 10) * 10);
  const lane = (e: { currentTarget: Element }) => (e.currentTarget.closest('.kf-lane') as HTMLElement).getBoundingClientRect();
  const timeAt = (e: { clientX: number; currentTarget: Element }) => {
    const r = lane(e);
    return snap(((e.clientX - r.left) / r.width) * span);
  };

  const onDown = (e: RPointerEvent, s: NonNullable<KfSel>, t: number) => {
    e.stopPropagation();
    setSel(s);
    if (readOnly) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, t, w: lane(e).width, moved: false };
  };
  const onMove = (e: RPointerEvent, s: NonNullable<KfSel>) => {
    const st = start.current;
    if (!st) return;
    if (Math.abs(e.clientX - st.x) > 2) st.moved = true;
    if (st.moved) setDrag({ sel: s, t: snap(st.t + ((e.clientX - st.x) / st.w) * span) });
  };
  const onUp = () => {
    const d = drag;
    start.current = null;
    setDrag(null);
    if (d) moveTo(d.sel, d.t);
  };

  function moveTo(s: NonNullable<KfSel>, t: number) {
    if (s.kind === 'key') {
      const keys = tracks[s.prop];
      const moved = { ...keys[s.i], t };
      const next = keys.map((k, j) => (j === s.i ? moved : k)).sort((a, b) => a.t - b.t);
      onChange(setTrack(def, s.prop, next));
      setSel({ kind: 'key', prop: s.prop, i: next.indexOf(moved) });
    } else {
      const name = markers[s.t];
      const rest = { ...markers };
      delete rest[s.t];
      let at = t;
      while (rest[String(at)] !== undefined) at += 1;
      onChange(setMarkers(def, { ...rest, [String(at)]: name }));
      setSel({ kind: 'marker', t: String(at) });
    }
  }

  const addKey = (prop: string, t: number) => {
    const keys = tracks[prop];
    const k: Key = { t, v: valueAt(keys, t), ease: 'inOut' };
    const next = [...keys.filter((x) => x.t !== t), k].sort((a, b) => a.t - b.t);
    onChange(setTrack(def, prop, next));
    setSel({ kind: 'key', prop, i: next.indexOf(k) });
  };
  const addMarker = (t: number) => {
    let at = t;
    while (markers[String(at)] !== undefined) at += 1;
    const name = Object.values(markers).includes('swap') ? (effects[0] ? `particle:${effects[0].value}` : 'mark') : 'swap';
    onChange(setMarkers(def, { ...markers, [String(at)]: name }));
    setSel({ kind: 'marker', t: String(at) });
  };

  const posOf = (s: NonNullable<KfSel>, t: number) => {
    const same = drag && drag.sel.kind === s.kind && (s.kind === 'key' ? drag.sel.kind === 'key' && drag.sel.prop === s.prop && drag.sel.i === s.i : drag.sel.kind === 'marker' && drag.sel.t === s.t);
    return `${(Math.min(span, same ? drag!.t : t) / span) * 100}%`;
  };
  const isSel = (s: NonNullable<KfSel>) =>
    !!sel && sel.kind === s.kind && (s.kind === 'key' ? sel.kind === 'key' && sel.prop === s.prop && sel.i === s.i : sel.kind === 'marker' && sel.t === s.t);

  const ticks = [];
  for (let t = 0; t <= span; t += tick) ticks.push(t);

  const selKey = sel?.kind === 'key' ? tracks[sel.prop]?.[sel.i] : undefined;
  const selMarker = sel?.kind === 'marker' ? markers[sel.t] : undefined;
  const isScale = (p: string) => p === 'scaleX' || p === 'scaleY' || p === 'opacity';

  return (
    <>
      <Group title="整体">
        <Row label="播放方式">
          <select
            value={!gap ? 'once' : gap[1] === 0 ? 'loop' : 'gap'}
            onChange={(e) => onChange(setRepeat(def, e.target.value === 'once' ? null : e.target.value === 'loop' ? true : { gapMs: [800, 1600] }))}
          >
            <option value="once">播一次（进入 / 离开用）</option>
            <option value="gap">隔一阵播一次（持续用）</option>
            <option value="loop">首尾相接一直播（持续用）</option>
          </select>
        </Row>
        {gap && gap[1] > 0 && (
          <Row label="间隔">
            <NumberInput value={gap[0]} min={0} step={100} width={70} onChange={(v) => onChange(setRepeat(def, { gapMs: [v, Math.max(v, gap[1])] }))} />
            <span className="note">到</span>
            <NumberInput value={gap[1]} min={0} step={100} width={70} onChange={(v) => onChange(setRepeat(def, { gapMs: [Math.min(v, gap[0]), v] }))} />
            <span className="note">ms 随机</span>
          </Row>
        )}
        <Row label="时长">
          <NumberInput value={end} min={20} step={10} width={70} onChange={(v) => onChange(rescaleTime(def, v))} />
          <span className="note">ms（改它会等比拉伸所有关键帧）</span>
        </Row>
        <Row label="幅度">
          <button className="btn small" onClick={() => onChange(scaleAmplitude(def, 0.8))}>
            减弱
          </button>
          <button className="btn small" onClick={() => onChange(scaleAmplitude(def, 1.25))}>
            增强
          </button>
        </Row>
      </Group>

      <Group title="关键帧">
        <div className="kf">
          <div className="kf-row kf-ruler">
            <span className="kf-name" />
            <div className="kf-lane">
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: `${(t / span) * 100}%` }}>
                  {t}
                </span>
              ))}
            </div>
            <span className="kf-x" />
          </div>
          {props.map((p) => (
            <div key={p} className="kf-row">
              <span className="kf-name" title={isProperty(p) ? PROPERTY_LABELS[p] : p}>
                {SHORT[p] ?? p}
              </span>
              <div className="kf-lane" onDoubleClick={(e) => !readOnly && addKey(p, timeAt(e))}>
                {tracks[p].map((k, i) => {
                  const s = { kind: 'key', prop: p, i } as const;
                  return (
                    <span
                      key={i}
                      className={`kf-dot${isSel(s) ? ' on' : ''}`}
                      style={{ left: posOf(s, k.t) }}
                      title={`${k.t}ms · ${k.v}`}
                      onPointerDown={(e) => onDown(e, s, k.t)}
                      onPointerMove={(e) => onMove(e, s)}
                      onPointerUp={onUp}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  );
                })}
              </div>
              {!readOnly ? (
                <button className="btn quiet small kf-x" title="删除这条轨道" onClick={() => (setSel(null), onChange(setTrack(def, p, [])))}>
                  ×
                </button>
              ) : (
                <span className="kf-x" />
              )}
            </div>
          ))}
          {!gap && (
            <div className="kf-row">
              <span className="kf-name">标记</span>
              <div className="kf-lane marks" onDoubleClick={(e) => !readOnly && addMarker(timeAt(e))}>
                {Object.entries(markers).map(([t, m]) => {
                  const s = { kind: 'marker', t } as const;
                  return (
                    <span
                      key={t}
                      className={`kf-mark${isSel(s) ? ' on' : ''}${m === 'swap' ? ' swap' : ''}`}
                      style={{ left: posOf(s, Number(t)) }}
                      title={`${t}ms · ${m}`}
                      onPointerDown={(e) => onDown(e, s, Number(t))}
                      onPointerMove={(e) => onMove(e, s)}
                      onPointerUp={onUp}
                      onDoubleClick={(e) => e.stopPropagation()}
                    />
                  );
                })}
              </div>
              <span className="kf-x" />
            </div>
          )}
        </div>
        {!readOnly && <div className="note">双击轨道加关键帧，双击「标记」行加标记；左右拖动改时间（10ms 一格）。</div>}

        {selKey && sel?.kind === 'key' && (
          <div className="kf-sel">
            <Row label="时间">
              <NumberInput value={selKey.t} min={0} step={10} width={70} onChange={(t) => moveTo(sel, t)} />
              <span className="note">ms</span>
            </Row>
            <Row label={`${SHORT[sel.prop] ?? sel.prop}`}>
              <NumberInput
                value={selKey.v}
                step={isScale(sel.prop) ? 0.01 : 0.5}
                width={70}
                onChange={(v) => onChange(setTrack(def, sel.prop, tracks[sel.prop].map((k, j) => (j === sel.i ? { ...k, v } : k))))}
              />
              <span className="note">静止 = {isProperty(sel.prop) ? restValue(sel.prop) : 0}</span>
            </Row>
            <Row label="过渡">
              <select
                value={typeof selKey.ease === 'string' ? selKey.ease : 'linear'}
                disabled={sel.i === 0}
                onChange={(e) => onChange(setTrack(def, sel.prop, tracks[sel.prop].map((k, j) => (j === sel.i ? { ...k, ease: e.target.value === 'linear' ? undefined : e.target.value } : k))))}
              >
                {EASES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <div className="note">{sel.i === 0 ? '第一帧是起点，没有过渡。' : '「过渡」指从上一帧变到这一帧的方式。'}</div>
            <button className="btn small quiet danger" style={{ alignSelf: 'flex-start' }} onClick={() => (setSel(null), onChange(setTrack(def, sel.prop, tracks[sel.prop].filter((_, j) => j !== sel.i))))}>
              删除这一帧
            </button>
          </div>
        )}
        {selMarker !== undefined && sel?.kind === 'marker' && (
          <MarkerEditor
            at={Number(sel.t)}
            name={selMarker}
            effects={effects}
            onTime={(t) => moveTo(sel, t)}
            onName={(n) => onChange(setMarkers(def, { ...markers, [sel.t]: n }))}
            onDelete={() => {
              const rest = { ...markers };
              delete rest[sel.t];
              setSel(null);
              onChange(setMarkers(def, rest));
            }}
          />
        )}

        {!readOnly && missing.length > 0 && (
          <select value="" onChange={(e) => e.target.value && onChange(addTrack(def, e.target.value))}>
            <option value="">＋ 加一条轨道…</option>
            {missing.map((p) => (
              <option key={p} value={p}>
                {PROPERTY_LABELS[p]}
              </option>
            ))}
          </select>
        )}
      </Group>
    </>
  );
}

function MarkerEditor({ at, name, effects, onTime, onName, onDelete }: { at: number; name: string; effects: { value: string; label: string }[]; onTime(t: number): void; onName(n: string): void; onDelete(): void }) {
  const known = name === 'swap' || (name.startsWith('particle:') && effects.some((e) => `particle:${e.value}` === name));
  const [custom, setCustom] = useState(!known);
  return (
    <div className="kf-sel">
      <Row label="时间">
        <NumberInput value={at} min={0} step={10} width={70} onChange={onTime} />
        <span className="note">ms</span>
      </Row>
      <Row label="做什么">
        <select
          value={custom ? '__custom' : name}
          onChange={(e) => {
            if (e.target.value === '__custom') return setCustom(true);
            setCustom(false);
            onName(e.target.value);
          }}
        >
          <option value="swap">换图（新画面在这一刻换上）</option>
          {effects.map((e) => (
            <option key={e.value} value={`particle:${e.value}`}>
              放粒子：{e.label}
            </option>
          ))}
          <option value="__custom">自定义（给插件用）…</option>
        </select>
      </Row>
      {custom && (
        <Row label="标记名">
          <TextInput value={name} onChange={(v) => v.trim() && onName(v.trim())} />
        </Row>
      )}
      <div className="note">
        {name === 'swap' ? '没有 swap 标记时，进入动作一开始就换图。' : name.startsWith('particle:') ? '需要启用「粒子」插件。' : '插件可以通过 motionMarker 事件收到它。'}
      </div>
      <button className="btn small quiet danger" style={{ alignSelf: 'flex-start' }} onClick={onDelete}>
        删除这个标记
      </button>
    </div>
  );
}
