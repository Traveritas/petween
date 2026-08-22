/**
 * client/settings/state-labels.ts — the Chinese display labels for the six
 * pose/state slots. Single source of truth: StateList re-exports it for the
 * UI panels and the editor store references it for in-use notices, so the
 * copies can never drift apart again.
 */
import type { PoseKey } from '../../core/types'

export const STATE_LABELS: Record<PoseKey, string> = {
  idle: '待机',
  thinking: '思考',
  working: '工作',
  waiting: '等待',
  success: '成功',
  error: '错误',
}
