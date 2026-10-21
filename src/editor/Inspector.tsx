// Right pane: properties of the selected state, the selected clip, or the pack itself.

import type { ClipDef, MotionRef, PetPack, StateAppearance, TransitionRef } from '../api/types';
import { resolveAppearance } from '../kernel/pack/resolve';
import { Slider } from '../settings/ui';
import { ensureMotion, fallbackText, motionChoices, refName, setClip, setState, usedClips, type TreeRow } from './model';
import { ClipThumb, Group, NumberInput, Row, TextInput } from './widgets';

export type Edit = (fn: (p: PetPack) => PetPack) => void;

// ---------- state ----------

export function StatePanel({ pack, baseUrl, row, edit, readOnly, onPickClip }: { pack: PetPack; baseUrl: string; row: TreeRow; edit: Edit; readOnly: boolean; onPickClip(id: string): void }) {
  const key = row.key;
  const a = pack.states[key];
  const own = !!a?.clips.length;
  const put = (next: StateAppearance) => edit((p) => setState(p, key, next));
  const head = (
    <div className="head">
      <div className="key">{key}</div>
      <div className="sub">
        {row.label || '（没有说明）'} · {row.source}
        {row.hint ? ` · ${row.hint}` : ''}
      </div>
    </div>
  );

  if (!own) {
    const fb = resolveAppearance(pack, key);
    return (
      <div className="insp">
        {head}
        <div className="callout">
          <span>{fallbackText(pack, key)}</span>
          {!readOnly && Object.keys(pack.clips).length > 0 && (
            <button className="btn small primary" onClick={() => put({ ...a, clips: [fb.appearance.clips[0] ?? Object.keys(pack.clips)[0]] })}>
              单独设置这个状态
            </button>
          )}
        </div>
      </div>
    );
  }

  const clipChoices = Object.keys(pack.clips).filter((c) => !a.clips.includes(c));
  const enterChoices = motionChoices(pack, 'enter');
  const loopChoices = motionChoices(pack, 'loop');
  const withMotion = (name: string, fn: (p: PetPack) => PetPack) => edit((p) => fn(ensureMotion(p, name)));
  const setRef = (field: 'enter' | 'exit', name: string) =>
    name ? withMotion(name, (p) => setState(p, key, { ...p.states[key], [field]: name })) : edit((p) => setState(p, key, { ...p.states[key], [field]: undefined }));
  const loops = (a.loop ?? []).map(refName);
  const toggleLoop = (name: string) =>
    loops.includes(name)
      ? edit((p) => setState(p, key, { ...p.states[key], loop: (p.states[key].loop ?? []).filter((r: MotionRef) => refName(r) !== name) }))
      : withMotion(name, (p) => setState(p, key, { ...p.states[key], loop: [...(p.states[key].loop ?? []), name] }));
  const tType = typeof a.transition === 'string' ? a.transition : (a.transition?.type ?? 'cut');
  const fadeMs = typeof a.transition === 'object' && typeof a.transition.durationMs === 'number' ? a.transition.durationMs : 200;
  const setTransition = (t: TransitionRef | undefined) => put({ ...a, transition: t });

  return (
    <div className="insp">
      {head}
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
        <Group title="画面">
          <div className="chips">
            {a.clips.map((c, i) => (
              <div className="chip" key={c}>
                <ClipThumb clip={pack.clips[c]} baseUrl={baseUrl} />
                <button className="btn quiet small n" style={{ textAlign: 'left' }} onClick={() => onPickClip(c)} title="编辑这个片段">
                  {c}
                </button>
                {a.clips.length > 1 && (
                  <>
                    <span className="note">权重</span>
                    <NumberInput value={a.weights?.[i] ?? 1} min={0} step={0.5} width={52} onChange={(v) => put({ ...a, weights: a.clips.map((_, j) => (j === i ? v : (a.weights?.[j] ?? 1))) })} />
                  </>
                )}
                <button className="btn quiet small" aria-label="移除" onClick={() => put({ ...a, clips: a.clips.filter((x) => x !== c), weights: a.weights?.filter((_, j) => j !== i) })}>
                  移除
                </button>
              </div>
            ))}
          </div>
          {clipChoices.length > 0 && (
            <select value="" onChange={(e) => e.target.value && put({ ...a, clips: [...a.clips, e.target.value] })}>
              <option value="">＋ 添加画面…</option>
              {clipChoices.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
          {a.clips.length > 1 && (
            <Row label="多张时">
              <select value={a.variant ?? 'random'} onChange={(e) => put({ ...a, variant: e.target.value as StateAppearance['variant'] })}>
                <option value="random">每次进入随机挑一张</option>
                <option value="cycle">定时轮换</option>
                <option value="sticky">同一回合保持同一张</option>
              </select>
              {a.variant === 'cycle' && <NumberInput value={(a.cycleMs ?? 8000) / 1000} min={0.5} step={0.5} width={60} onChange={(v) => put({ ...a, cycleMs: Math.round(v * 1000) })} />}
              {a.variant === 'cycle' && <span className="note">秒</span>}
            </Row>
          )}
        </Group>

        <Group title="动作">
          <Row label="进入时">
            <select value={refName(a.enter)} onChange={(e) => setRef('enter', e.target.value)}>
              <option value="">不动</option>
              {enterChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="持续">
            <div className="checks">
              {loopChoices.map((c) => (
                <span key={c.value} className={`check${loops.includes(c.value) ? ' on' : ''}`} role="checkbox" aria-checked={loops.includes(c.value)} tabIndex={0} onClick={() => toggleLoop(c.value)} onKeyDown={(e) => e.key === ' ' && toggleLoop(c.value)}>
                  {c.label}
                </span>
              ))}
            </div>
          </Row>
          <Row label="离开时">
            <select value={refName(a.exit)} onChange={(e) => setRef('exit', e.target.value)}>
              <option value="">不动</option>
              {enterChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="note">动作先换图再播（docs/03 §4）。想细调动作的形状，等 M3b 的动作编辑。</div>
        </Group>

        <Group title="切换">
          <Row label="换图方式">
            <select value={tType} onChange={(e) => setTransition(e.target.value === 'crossfade' ? { type: 'crossfade', durationMs: fadeMs } : e.target.value === 'cut' ? undefined : (e.target.value as TransitionRef))}>
              <option value="cut">直接换</option>
              <option value="crossfade">淡入淡出</option>
              <option value="afterLoop">等当前动画播完一轮</option>
            </select>
            {tType === 'crossfade' && <NumberInput value={fadeMs} min={0} max={2000} step={50} width={64} onChange={(v) => setTransition({ type: 'crossfade', durationMs: v })} />}
            {tType === 'crossfade' && <span className="note">ms</span>}
          </Row>
        </Group>

        {!readOnly && (
          <button className="btn small quiet danger" style={{ alignSelf: 'flex-start' }} onClick={() => edit((p) => setState(p, key, null))}>
            不再单独设置（回退到上级）
          </button>
        )}
      </fieldset>
    </div>
  );
}

// ---------- clip ----------

export function ClipPanel({ pack, baseUrl, id, edit, readOnly, aligning, setAligning }: { pack: PetPack; baseUrl: string; id: string; edit: Edit; readOnly: boolean; aligning: boolean; setAligning(v: boolean): void }) {
  const clip = pack.clips[id];
  if (!clip) return null;
  const put = (patch: Partial<ClipDef>) => edit((p) => setClip(p, id, { ...p.clips[id], ...patch }));
  const anchor = clip.anchor ?? { x: 0.5, y: 0.96 };
  const users = Object.entries(pack.states).filter(([, a]) => a.clips.includes(id)).map(([k]) => k);
  return (
    <div className="insp">
      <div className="head">
        <div className="key">{id}</div>
        <div className="sub">
          {clip.type === 'frames' ? `${clip.frames?.count ?? 1} 帧动画` : '静态图'} · {clip.source}
        </div>
      </div>
      <ClipThumb clip={clip} baseUrl={baseUrl} size={140} className="big" />
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
        {clip.type === 'frames' && (
          <Group title="播放">
            <Row label="帧率">
              <NumberInput value={clip.fps ?? 12} min={1} max={60} onChange={(v) => put({ fps: v })} />
              <span className="note">帧 / 秒</span>
            </Row>
          </Group>
        )}
        <Group title="对齐">
          <div className="note">脚底的位置决定宠物站在哪；不同图片之间脚底和大小对齐了，切换时人就不会跳。</div>
          <button className={`btn small${aligning ? ' primary' : ''}`} style={{ alignSelf: 'flex-start' }} onClick={() => setAligning(!aligning)}>
            {aligning ? '对齐中：在预览里拖动图片' : '在预览里拖动对齐'}
          </button>
          <Row label="脚底 横">
            <NumberInput value={anchor.x} step={0.01} min={-1} max={2} onChange={(v) => put({ anchor: { ...anchor, x: v } })} />
            <span className="note">竖</span>
            <NumberInput value={anchor.y} step={0.01} min={-1} max={2} onChange={(v) => put({ anchor: { ...anchor, y: v } })} />
          </Row>
          <Row label="大小">
            <Slider value={clip.scale ?? 1} min={0.2} max={3} step={0.01} compact onChange={(v) => put({ scale: v })} />
          </Row>
        </Group>
        <Group title="用在">
          <div className="note">{users.length ? users.join('、') : '还没有状态用到它'}</div>
        </Group>
        {!readOnly && (
          <button className="btn small quiet danger" style={{ alignSelf: 'flex-start' }} onClick={() => confirm(`删除片段 ${id}？用到它的状态会去掉这张图。`) && edit((p) => setClip(p, id, null))}>
            删除这个片段
          </button>
        )}
      </fieldset>
    </div>
  );
}

// ---------- pack ----------

export function PackPanel({ pack, edit, readOnly }: { pack: PetPack; edit: Edit; readOnly: boolean }) {
  const at = pack.attribution ?? {};
  const setAt = (patch: Partial<NonNullable<PetPack['attribution']>>) => edit((p) => ({ ...p, attribution: { ...p.attribution, ...patch } }));
  const unused = Object.keys(pack.clips).filter((c) => !usedClips(pack).has(c));
  return (
    <div className="insp">
      <div className="head">
        <div className="key">{pack.name || pack.id}</div>
        <div className="sub">id：{pack.id} · 格式 {pack.format}</div>
      </div>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, display: 'contents' }}>
        <Group title="基本">
          <Row label="名字">
            <TextInput value={pack.name} onChange={(v) => edit((p) => ({ ...p, name: v }))} />
          </Row>
          <Row label="整体大小">
            <Slider value={pack.scale ?? 1} min={0.1} max={3} step={0.01} compact onChange={(v) => edit((p) => ({ ...p, scale: v }))} />
          </Row>
        </Group>
        <Group title="署名">
          <Row label="作者">
            <TextInput value={(at.creators ?? []).join('、')} placeholder="多个用顿号分开" onChange={(v) => setAt({ creators: v.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })} />
          </Row>
          <Row label="许可">
            <TextInput value={at.license ?? ''} placeholder="如 CC-BY-4.0" onChange={(v) => setAt({ license: v || undefined })} />
          </Row>
          <Row label="来源">
            <TextInput value={at.sourceUrl ?? ''} placeholder="网址（可选）" onChange={(v) => setAt({ sourceUrl: v || undefined })} />
          </Row>
        </Group>
        <Group title="统计">
          <div className="note">
            {Object.keys(pack.clips).length} 个片段（{unused.length} 个没用上）· {Object.keys(pack.states).length} 个状态 · {Object.keys(pack.motions ?? {}).length} 个动作
          </div>
        </Group>
      </fieldset>
    </div>
  );
}
