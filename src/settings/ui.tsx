// Small shared pieces for the settings window.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SettingSpec } from '../api/types';
import type { PackInfo } from '../shared/admin';

// ---------- data ----------

/** Load once (and on `reload()`); `deps` re-run it. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    load().then(
      (v) => {
        setData(v);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export function usePoll<T>(load: () => Promise<T>, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () =>
      load()
        .then((v) => live.current && setData(v))
        .catch(() => {})
        .finally(() => {
          if (live.current) timer = setTimeout(tick, document.hidden ? ms * 4 : ms);
        });
    tick();
    return () => {
      live.current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return data;
}

// ---------- toast ----------

const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; bad: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((msg: string, bad = false) => {
    setT({ msg, bad });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setT(null), bad ? 5000 : 2200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast${t.bad ? ' bad' : ''}`} role="status">
          {t.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/** Run an action with busy state; errors become a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      setBusy(true);
      try {
        await fn();
        if (ok) toast(ok);
        return true;
      } catch (e) {
        toast((e as Error).message, true);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---------- controls ----------

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange(v: boolean): void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Slider({ value, min = 0, max = 100, step = 1, unit, compact, onChange }: { value: number; min?: number; max?: number; step?: number; unit?: string; compact?: boolean; onChange(v: number): void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = (x: number) => {
    const c = Math.min(max, Math.max(min, x));
    setV(c);
    if (c !== value) onChange(c);
  };
  return (
    <div className={`slider${compact ? ' compact' : ''}`}>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} onPointerUp={() => commit(v)} onKeyUp={() => commit(v)} />
      <input className="input num" type="number" min={min} max={max} step={step} value={v} onChange={(e) => setV(Number(e.target.value))} onBlur={() => commit(v)} onKeyDown={(e) => e.key === 'Enter' && commit(v)} />
      <span className="unit">{unit}</span>
    </div>
  );
}

function ListEditor({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  const [items, setItems] = useState(value);
  useEffect(() => setItems(value), [value]);
  const save = (next: string[]) => {
    setItems(next);
    onChange(next.map((s) => s.trim()).filter(Boolean));
  };
  return (
    <div className="list">
      {items.map((it, i) => (
        <div className="item" key={i}>
          <input className="input mono" value={it} onChange={(e) => setItems(items.map((x, j) => (j === i ? e.target.value : x)))} onBlur={() => save(items)} />
          <button className="btn quiet small" onClick={() => save(items.filter((_, j) => j !== i))} aria-label="删除">
            删除
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => setItems([...items, ''])}>
        添加一项
      </button>
    </div>
  );
}

/** One auto-generated settings field (manifest contributes.settings). */
export function Field({ spec, value, onChange }: { spec: SettingSpec; value: unknown; onChange(v: unknown): void }) {
  const v = value ?? spec.default;
  let control: ReactNode;
  switch (spec.type) {
    case 'boolean':
      control = <Toggle on={!!v} onChange={onChange} label={spec.label} />;
      break;
    case 'number':
      {
        const k = spec.scale ?? 1;
        const r = (x: number | undefined) => (x === undefined ? undefined : Math.round((x / k) * 1000) / 1000);
        control = <Slider value={r(Number(v ?? 0))!} min={r(spec.min)} max={r(spec.max)} step={r(spec.step)} unit={spec.unit} onChange={(x) => onChange(Math.round(x * k * 1000) / 1000)} />;
      }
      break;
    case 'select':
      control = (
        <select value={String(v ?? '')} onChange={(e) => onChange(e.target.value)}>
          {spec.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'list':
      control = <ListEditor value={Array.isArray(v) ? (v as string[]) : []} onChange={onChange} />;
      break;
    default:
      control = <input className="input" defaultValue={String(v ?? '')} onBlur={(e) => e.target.value !== v && onChange(e.target.value)} />;
  }
  return (
    <div className="field" style={spec.type === 'list' ? { alignItems: 'flex-start' } : undefined}>
      <div className="label">
        <div>{spec.label}</div>
        {spec.description && <div className="sub">{spec.description}</div>}
      </div>
      {control}
    </div>
  );
}

// ---------- pictures ----------

export function Thumb({ pack, size = 44 }: { pack?: PackInfo; size?: number }) {
  if (!pack?.preview) return <div className="thumb" />;
  const g = pack.previewGrid;
  return (
    <div className="thumb">
      {g ? (
        // First frame of a spritesheet.
        <div className="sheet" style={{ width: size, height: size, backgroundImage: `url("${pack.preview}")`, backgroundSize: `${g.columns * 100}% ${g.rows * 100}%` }} />
      ) : (
        <img src={pack.preview} alt="" />
      )}
    </div>
  );
}

export const timeAgo = (t: number | null) => {
  if (!t) return '还没有收到事件';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s} 秒前有活动`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前有活动`;
  return `${Math.round(s / 3600)} 小时前有活动`;
};

// ---------- icons (1.6px strokes, 18px) ----------

const I = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
export const Icons = {
  pets: () => <I d="M12 20c-4.4 0-7-2.4-7-6s3.1-7 7-7 7 3.4 7 7-2.6 6-7 6zM9.5 13v.5M14.5 13v.5M8 20.5l-.5 1M16 20.5l.5 1" />,
  link: () => <I d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  puzzle: () => <I d="M5 8h3a2 2 0 1 1 4 0h3v3a2 2 0 1 1 0 4v3h-3a2 2 0 1 0-4 0H5v-3a2 2 0 1 0 0-4z" />,
  scope: () => <I d="M4 6h16M4 12h10M4 18h7M17 15l3 3M15.5 16.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" />,
  info: () => <I d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01" />,
};

export function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <ellipse cx="16" cy="18" rx="12" ry="10.5" fill="#b9aec9" />
      <ellipse cx="11.5" cy="17" rx="1.4" ry="2" fill="#3f3848" />
      <ellipse cx="20.5" cy="17" rx="1.4" ry="2" fill="#3f3848" />
      <ellipse cx="8.5" cy="20.5" rx="2" ry="1.1" fill="#d9b8c4" />
      <ellipse cx="23.5" cy="20.5" rx="2" ry="1.1" fill="#d9b8c4" />
    </svg>
  );
}
