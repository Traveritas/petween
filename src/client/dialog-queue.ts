/**
 * client/dialog-queue.ts — the React-free half of the C2 editor modals. The
 * embedded browser DSH ships in (IAB) has no working window.prompt/confirm,
 * so every editor confirmation / name-asking goes through in-page modals:
 * callers await these promise APIs, and the <ModalHost/> component
 * (settings/modals.tsx) renders the queue head as an overlay dialog.
 *
 * Semantics mirror the native calls: confirmDialog resolves true (确定) or
 * false (取消 / Escape); promptDialog resolves the entered text or null.
 * Requests queue FIFO and show one at a time.
 *
 * Safety when no ModalHost is mounted (headless tests, a surface torn down
 * mid-dialog): the request settles IMMEDIATELY with the cancel answer — a
 * destructive flow must never proceed on an unanswered confirmation. The
 * same drain happens when the last host unmounts while requests are pending.
 */

export interface ConfirmDialogOptions {
  message: string
  /** Button labels default to 确定 / 取消. */
  confirmLabel?: string
  cancelLabel?: string
}

export interface PromptDialogOptions {
  title: string
  initial?: string
  confirmLabel?: string
  cancelLabel?: string
}

interface DialogRequestBase {
  id: number
  confirmLabel: string
  cancelLabel: string
  /** Settle with the cancel answer (取消 / Escape / host gone). */
  cancel: () => void
}

export interface ConfirmDialogRequest extends DialogRequestBase {
  kind: 'confirm'
  message: string
  confirm: () => void
}

export interface PromptDialogRequest extends DialogRequestBase {
  kind: 'prompt'
  title: string
  initial: string
  confirm: (value: string) => void
}

export type DialogRequest = ConfirmDialogRequest | PromptDialogRequest

const listeners = new Set<() => void>()
let queue: DialogRequest[] = []
let nextId = 1
let hostCount = 0

const emit = (): void => {
  for (const listener of listeners) listener()
}

const remove = (request: DialogRequest): void => {
  const index = queue.indexOf(request)
  if (index === -1) return
  queue = [...queue.slice(0, index), ...queue.slice(index + 1)]
  emit()
}

/**
 * useSyncExternalStore glue for ModalHost. Each mounted host counts once; when the
 * last host goes away mid-dialog, every pending request settles with the cancel answer
 * so no caller is left awaiting a promise that can never be answered.
 */
export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener)
  hostCount += 1
  return () => {
    listeners.delete(listener)
    hostCount -= 1
    if (hostCount === 0 && queue.length > 0) {
      for (const request of queue.slice()) request.cancel()
    }
  }
}

/** The visible dialog (queue head), or null while nothing asks. */
export function getPendingDialog(): DialogRequest | null {
  return queue[0] ?? null
}

function enqueue(request: DialogRequest, cancelAnswer: () => void): void {
  if (hostCount === 0) {
    // No ModalHost anywhere (headless caller / torn-down surface): settle
    // with the cancel answer — never proceed on an unanswered confirm.
    cancelAnswer()
    return
  }
  queue = [...queue, request]
  emit()
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request: ConfirmDialogRequest = {
      id: nextId,
      kind: 'confirm',
      message: options.message,
      confirmLabel: options.confirmLabel ?? '确定',
      cancelLabel: options.cancelLabel ?? '取消',
      confirm: () => {
        remove(request)
        resolve(true)
      },
      cancel: () => {
        remove(request)
        resolve(false)
      },
    }
    nextId += 1
    enqueue(request, () => resolve(false))
  })
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const request: PromptDialogRequest = {
      id: nextId,
      kind: 'prompt',
      title: options.title,
      initial: options.initial ?? '',
      confirmLabel: options.confirmLabel ?? '确定',
      cancelLabel: options.cancelLabel ?? '取消',
      confirm: (value) => {
        remove(request)
        resolve(value)
      },
      cancel: () => {
        remove(request)
        resolve(null)
      },
    }
    nextId += 1
    enqueue(request, () => resolve(null))
  })
}
