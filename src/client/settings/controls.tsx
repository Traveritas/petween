/**
 * client/settings/controls.tsx — small shared form controls for the settings
 * panels (Slider / NumberField / Toggle / SelectRow / FileImportButton).
 * Slider ranges mirror the host validation bounds (host/validation.ts).
 */
import { useRef, useState, type JSX } from 'react'
import { ASSET_ACCEPT_ATTRIBUTE } from '../../core/assets-contract'
import styles from './settings.module.css'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Decimal places of the step (0.05 → 2, 10 → 0); steps here are plain notation. */
function stepDecimals(step: number): number {
  const text = String(step)
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

export function Slider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  const decimals = stepDecimals(props.step)
  // Snap the committed value to the min-anchored step grid: float math (and
  // jsdom-injected values) can hand us 0.35000000000000003 for step 0.05,
  // which would otherwise flow into the config verbatim. toFixed(round-trip)
  // lands on the nearest clean float; clamping keeps the min/max bounds.
  const snap = (value: number): number => {
    const stepped = props.min + Math.round((value - props.min) / props.step) * props.step
    return Number(clamp(stepped, props.min, props.max).toFixed(decimals))
  }
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(snap(Number(event.target.value)))}
      />
      <span className={styles.value}>
        {props.value.toFixed(decimals)}
        {props.unit ?? ''}
      </span>
    </label>
  )
}

export function NumberField(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  const { value, min, max, onChange } = props
  // UX: raw text is held locally while the user types — no clamping and no
  // commit per keystroke. Blur or Enter clamps and commits; an empty or
  // non-finite field reverts to the last committed value on commit. External
  // value updates apply whenever the field is not being edited (draft null).
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const trimmed = draft.trim()
    const parsed = trimmed === '' ? Number.NaN : Number(trimmed)
    const next = Number.isFinite(parsed) ? clamp(parsed, min, max) : value
    setDraft(null)
    if (next !== value) onChange(next)
  }
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <input
        type="number"
        className={styles.number}
        min={props.min}
        max={props.max}
        step={props.step}
        value={draft ?? String(value)}
        disabled={props.disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
      <span className={styles.unit}>{props.unit ?? ''}</span>
    </label>
  )
}

export function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className={`${styles.row} ${styles.toggle}`}>
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  )
}

/**
 * Free-text row (e.g. a pose-swap target), mirroring NumberField's layout.
 * `listId` + `listOptions` attach a datalist of suggestions — the input
 * stays free-form: not every legal value (user: pose ids) is enumerable.
 */
export function TextField(props: {
  label: string
  value: string
  placeholder?: string
  listId?: string
  listOptions?: readonly string[]
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <label className={styles.row}>
      <span className={styles.label}>{props.label}</span>
      <input
        type="text"
        className={styles.number}
        value={props.value}
        placeholder={props.placeholder}
        list={props.listId}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.listId !== undefined && props.listOptions !== undefined ? (
        <datalist id={props.listId}>
          {props.listOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
      <span className={styles.unit} />
    </label>
  )
}

export function SelectRow<T extends string>(props: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <select
        className={styles.select}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** SelectRow with <optgroup> sections (e.g. 内置 / 自定义 animation groups). */
export function GroupedSelectRow<T extends string>(props: {
  label: string
  value: T
  groups: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: T; label: string }> }>
  disabled?: boolean
  onChange: (value: T) => void
}): JSX.Element {
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <select
        className={styles.select}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value as T)}
      >
        {props.groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

/**
 * Hidden file input + trigger button. Accept defaults to the §2.1 image
 * formats (PNG/WebP/JPEG; SVG rejected — the host re-validates); the Motion
 * Pack importer passes a JSON accept. `busy` (UX-3) disables the trigger and
 * swaps the label to 上传中… while the store's upload is in flight.
 */
export function FileImportButton(props: {
  label: string
  disabled?: boolean
  busy?: boolean
  /** Defaults to the §2.1 image formats. */
  accept?: string
  onFile: (file: File) => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const busy = props.busy === true
  return (
    <>
      <button
        type="button"
        className={styles.button}
        disabled={props.disabled === true || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? '上传中…' : props.label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={props.accept ?? ASSET_ACCEPT_ATTRIBUTE}
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file !== undefined) props.onFile(file)
          event.target.value = '' // re-importing the same file must re-fire
        }}
      />
    </>
  )
}
