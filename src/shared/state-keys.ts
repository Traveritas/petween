// The default brain's state keys (docs/04 §4, docs/05 §4), with labels for editors.
// `active.command.<tool>` is open-ended: any tool name can appear.

export const BRAIN_STATE_KEYS: { key: string; label: string; hint?: string }[] = [
  { key: 'idle', label: '空闲', hint: '没有 agent 在干活时；所有状态最后都会回退到这里' },
  { key: 'idle.long', label: '久闲', hint: '空闲了很久' },
  { key: 'active', label: '工作中', hint: 'agent 在干活（下面几种的共同上级）' },
  { key: 'active.thinking', label: '思考' },
  { key: 'active.edit', label: '改文件' },
  { key: 'active.command', label: '跑命令', hint: '可以再按工具名细分，如 active.command.Bash' },
  { key: 'active.other', label: '其他工具', hint: '读文件、搜索、联网等' },
  { key: 'waiting', label: '等你确认' },
  { key: 'success', label: '成功' },
  { key: 'error', label: '出错' },
];
