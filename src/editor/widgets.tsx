// Small pieces of the editor UI.

import { useEffect, useRef, type ReactNode } from 'react';
import type { ClipDef } from '../api/types';

/** First frame of a clip, fitted into a square (spritesheets included). */
export function ClipThumb({ clip, baseUrl, size = 56, className = '' }: { clip: ClipDef | undefined; baseUrl: string; size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const src = clip ? new URL(clip.source, baseUrl).href : '';
  const count = clip?.type === 'frames' ? Math.max(1, clip.frames?.count ?? 1) : 1;
  const columns = clip?.frames?.columns ?? count;
  useEffect(() => {
    const c = ref.current;
    if (!c || !src) return;
    let gone = false;
    const img = new Image();
    img.onload = () => {
      if (gone) return;
      const rows = Math.ceil(count / Math.max(1, columns));
      const fw = img.naturalWidth / Math.max(1, columns);
      const fh = img.naturalHeight / Math.max(1, rows);
      const px = size * devicePixelRatio;
      c.width = c.height = px;
      const g = c.getContext('2d')!;
      g.clearRect(0, 0, px, px);
      const k = Math.min(px / fw, px / fh);
      g.drawImage(img, 0, 0, fw, fh, (px - fw * k) / 2, (px - fh * k) / 2, fw * k, fh * k);
    };
    img.src = src;
    return () => {
      gone = true;
    };
  }, [src, count, columns, size]);
  return <canvas ref={ref} className={`cthumb checker ${className}`} style={{ width: size, height: size }} />;
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row2">
      <span className="l">{label}</span>
      {children}
    </div>
  );
}

export function Group({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="grp">
      <div className="t">
        {title}
        {extra}
      </div>
      {children}
    </div>
  );
}

/** A number input that commits on blur / Enter. */
export function NumberInput({ value, onChange, step = 1, min, max, width = 76 }: { value: number; onChange(v: number): void; step?: number; min?: number; max?: number; width?: number }) {
  return (
    <input
      key={value}
      className="input num"
      type="number"
      style={{ width }}
      defaultValue={value}
      step={step}
      min={min}
      max={max}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
    />
  );
  function commit(s: string) {
    const v = Number(s);
    if (!Number.isFinite(v)) return;
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    if (c !== value) onChange(c);
  }
}

/** A text input that commits on blur / Enter. */
export function TextInput({ value, onChange, placeholder }: { value: string; onChange(v: string): void; placeholder?: string }) {
  return (
    <input
      key={value}
      className="input"
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => e.target.value !== value && onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
