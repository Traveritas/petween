/**
 * client/settings/controls.tsx — small shared form controls for the settings
 * panels (Slider / NumberField / Toggle / SelectRow / FileImportButton).
 * Slider ranges mirror the host validation bounds (host/validation.ts).
 */
import { useRef, type JSX } from 'react'
import styles from './settings.module.css'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
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
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <span className={styles.value}>
        {props.value}
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
  return (
    <label className={props.disabled === true ? `${styles.row} ${styles.disabled}` : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <input
        type="number"
        className={styles.number}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) props.onChange(clamp(value, props.min, props.max))
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
 * Hidden file input + trigger button. Accept is limited to the formats the
 * host takes (§2.1: PNG/WebP/JPEG; SVG rejected); the host re-validates.
 */
export function FileImportButton(props: {
  label: string
  disabled?: boolean
  onFile: (file: File) => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <button
        type="button"
        className={styles.button}
        disabled={props.disabled}
        onClick={() => inputRef.current?.click()}
      >
        {props.label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/webp,image/jpeg"
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
