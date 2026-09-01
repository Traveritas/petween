/**
 * client/settings/modals.tsx — the visual half of the C2 editor modals.
 * <ModalHost/> renders the head of the shared dialog queue
 * (client/dialog-queue.ts) as an in-page overlay; the promise APIs
 * (confirmDialog / promptDialog) live in that module so non-React callers
 * (the editor store) can await them too.
 *
 * Mount contract: EVERY editor surface that can trigger a dialog mounts one
 * host — PetweenSettings in all of its gates (the empty state's pet card can
 * still prompt for a name) and PetweenCard (its SaveIndicator offers the
 * revert confirmation). The two surfaces live in separate browsing contexts
 * (the DSH settings dialog vs the standalone editor page), so neither can
 * rely on the other's host; with no host mounted the queue settles requests
 * with the cancel answer (see dialog-queue.ts).
 *
 * Keys: Enter confirms, Escape cancels. Enter is handled EXPLICITLY on
 * keydown (except when a button is the target — buttons activate natively)
 * because the prompt input has no surrounding form's implicit submission.
 * The overlay blocks pointer interaction with the background; the prompt
 * input / the confirm button is autofocused. No focus trap (basic a11y only).
 */
import { useState, useSyncExternalStore, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  getPendingDialog,
  subscribeDialogs,
  type ConfirmDialogRequest,
  type DialogRequest,
  type PromptDialogRequest,
} from '../dialog-queue'
import styles from './settings.module.css'

export function ModalHost(): JSX.Element | null {
  const request = useSyncExternalStore(subscribeDialogs, getPendingDialog)
  if (request === null) return null
  return (
    <div className={styles.modalOverlay}>
      {request.kind === 'confirm' ? (
        <ConfirmDialogView key={request.id} request={request} />
      ) : (
        <PromptDialogView key={request.id} request={request} />
      )}
    </div>
  )
}

/**
 * Shared key handling: Escape cancels; Enter confirms unless it landed on a
 * button (native activation covers that — handling it too would settle
 * twice). Handled keys stop here so editor-level shortcuts never see them.
 */
function dialogKeyDown(event: ReactKeyboardEvent, request: DialogRequest, confirm: () => void): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    request.cancel()
    return
  }
  if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
    event.stopPropagation()
    confirm()
  }
}

function ConfirmDialogView(props: { request: ConfirmDialogRequest }): JSX.Element {
  const { request } = props
  return (
    <div
      className={styles.modal}
      role="dialog"
      aria-modal="true"
      aria-label={request.message}
      onKeyDown={(event) => dialogKeyDown(event, request, request.confirm)}
    >
      <p className={styles.modalMessage}>{request.message}</p>
      <div className={styles.modalActions}>
        <button type="button" className={styles.button} onClick={() => request.cancel()}>
          {request.cancelLabel}
        </button>
        {/* Autofocus: Enter confirms without a document-level key handler. */}
        <button type="button" className={styles.button} autoFocus onClick={() => request.confirm()}>
          {request.confirmLabel}
        </button>
      </div>
    </div>
  )
}

function PromptDialogView(props: { request: PromptDialogRequest }): JSX.Element {
  const { request } = props
  const [value, setValue] = useState(request.initial)
  // An empty/blank name can never proceed — same outcome as the native
  // prompt returning '' (the callers map it to "cancelled"), but explicit.
  const confirm = (): void => {
    if (value.trim() !== '') request.confirm(value)
  }
  return (
    <div
      className={styles.modal}
      role="dialog"
      aria-modal="true"
      aria-label={request.title}
      onKeyDown={(event) => dialogKeyDown(event, request, confirm)}
    >
      <label className={styles.modalField}>
        <span className={styles.modalTitle}>{request.title}</span>
        <input
          type="text"
          className={styles.textInput}
          value={value}
          autoFocus
          onFocus={(event) => event.target.select()} // native prompt preselects the default
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <div className={styles.modalActions}>
        <button type="button" className={styles.button} onClick={() => request.cancel()}>
          {request.cancelLabel}
        </button>
        <button type="button" className={styles.button} disabled={value.trim() === ''} onClick={confirm}>
          {request.confirmLabel}
        </button>
      </div>
    </div>
  )
}
