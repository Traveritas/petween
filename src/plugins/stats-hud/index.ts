// `stats-hud` (docs/06 §6, L1): v0's stats bubbles, through the kernel's bubble channel.
//   思考  a status chip once a session has thought for a moment, ticking live
//   写入  a status chip per working stretch, adding up the lines as edits land (with a bump)
//   完成  a summary at turn end (thinking time, lines, wall time)
//   回复  the agent's last reply, quoted (read from the tail of its transcript, never stored)
// Each session speaks in its own lanes and is tagged with its session, so the `bubble` renderer
// gives it its own column; with per-session pets the bubbles go to that session's pet.
// Timing policy is v0's pure reducer (hud-logic.ts) over the ledger's event ring.

import { definePlugin, type AgentEvent, type BubbleHandle, type BubbleRequest, type PetHandle, type PluginContext, type PluginManifest } from '../../api/types';
import * as cc from './dialogue/claude-code';
import * as codex from './dialogue/codex';
import { isSafeSessionId, truncatePreview, type LastReply } from './dialogue/text';
import * as zcode from './dialogue/zcode';
import { formatDuration, formatLines } from './format';
import { createHudReducer, DEFAULT_HUD_OPTIONS, type HudCommand, type HudOptions } from './hud-logic';
import { createStatsLedger } from './ledger';

const SECONDS = 1000;

export const manifest: PluginManifest = {
  id: 'stats-hud',
  name: '统计气泡',
  version: '0.2.0',
  apiVersion: 1,
  permissions: ['fs:read'],
  contributes: {
    channels: ['bubble'],
    settings: [
      { key: 'multiSession', section: '显示什么', label: '每个会话单独一列', type: 'boolean', default: true, description: '关掉后只显示最近活动的那个会话' },
      { key: 'showReply', section: '显示什么', label: '回合结束时引用回复', type: 'boolean', default: true, description: '读取 agent 对话记录的末尾，只在本机显示，不保存' },
      { key: 'showSummary', section: '显示什么', label: '回合结束时显示本轮统计', type: 'boolean', default: true },
      { key: 'milestoneEveryLines', section: '显示什么', label: '每写满多少行宠物弹一下', type: 'number', default: 0, min: 0, max: 500, step: 10, unit: '行', description: '0 = 不弹' },
      { key: 'thinkingThresholdMs', section: '时间', label: '思考超过多久才显示', type: 'number', default: DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs, min: 0, max: 10000, step: 500, scale: SECONDS, unit: '秒' },
      { key: 'thinkingHoldMs', section: '时间', label: '思考气泡结束后停留', type: 'number', default: DEFAULT_HUD_OPTIONS.thinkingHoldMs, min: 0, max: 10000, step: 100, scale: SECONDS, unit: '秒' },
      { key: 'editHoldMs', section: '时间', label: '写入气泡结束后停留', type: 'number', default: DEFAULT_HUD_OPTIONS.editHoldMs, min: 0, max: 10000, step: 100, scale: SECONDS, unit: '秒' },
      { key: 'summaryHoldMs', section: '时间', label: '完成气泡停留', type: 'number', default: 4000, min: 1000, max: 30000, step: 500, scale: SECONDS, unit: '秒' },
      { key: 'replyHoldMs', section: '时间', label: '回复气泡停留', type: 'number', default: 7000, min: 1000, max: 30000, step: 500, scale: SECONDS, unit: '秒' },
    ],
  },
};

const TICK_MS = 250;
const MILESTONE_THROTTLE_MS = 10_000;
/** The agent may still be flushing its transcript when Stop fires. */
const REPLY_RETRIES = 3;
const REPLY_RETRY_MS = 700;

/** v0's click-pop, as an inline motion (played on a line milestone). */
const MILESTONE_POP = {
  type: 'keyframes',
  tracks: {
    scaleX: [{ t: 0, v: 1 }, { t: 90, v: 1.08, ease: 'out' }, { t: 220, v: 0.97, ease: 'inOut' }, { t: 320, v: 1, ease: 'inOut' }],
    scaleY: [{ t: 0, v: 1 }, { t: 90, v: 0.9, ease: 'out' }, { t: 220, v: 1.05, ease: 'inOut' }, { t: 320, v: 1, ease: 'inOut' }],
  },
};

// ---------- reply preview ----------

const TAIL_BYTES = 2 * 1024 * 1024;

/** Locate the transcript, bound to the session (a forged hook must not turn this into "read any file"). */
function transcriptFor(ctx: PluginContext, e: AgentEvent): { path: string; parse: (lines: string[], turnId?: string) => LastReply | null } | null {
  if (!isSafeSessionId(e.sessionId)) return null;
  const tp = typeof e.extra?.transcriptPath === 'string' ? e.extra.transcriptPath.replace(/\\/g, '/') : '';
  const file = tp.split('/').pop() ?? '';
  if (e.agent === 'claude-code' && tp && file === cc.transcriptFileName(e.sessionId)) return { path: tp, parse: cc.lastReply };
  if (e.agent === 'codex' && tp && codex.isRolloutFileFor(file, e.sessionId)) return { path: tp, parse: codex.lastReply };
  if (e.agent === 'zcode') {
    const name = zcode.rolloutFileName(e.sessionId);
    if (name) return { path: `${ctx.host.paths.home}/.zcode/cli/rollout/${name}`, parse: zcode.lastReply };
  }
  return null;
}

/** The reply for this turn; null when the transcript has not caught up with the turn yet. */
async function replyPreview(ctx: PluginContext, e: AgentEvent, exact: boolean): Promise<string | null> {
  const t = transcriptFor(ctx, e);
  if (!t || !(await ctx.host.fs.exists(t.path))) return null;
  const lines = (await ctx.host.fs.readTail(t.path, TAIL_BYTES)).split('\n');
  const turnId = typeof e.extra?.turnId === 'string' ? e.extra.turnId : undefined;
  const r = t.parse(lines, turnId) ?? (turnId && !exact ? t.parse(lines) : null);
  return r ? truncatePreview(r.text) : null;
}

// ---------- plugin ----------

export default definePlugin({
  activate(ctx) {
    const ledger = createStatsLedger();
    const opt = <T,>(k: string, d: T) => ctx.settings.get<T>(k, d);
    const hudOptions = (): Partial<HudOptions> => ({
      multiSession: opt('multiSession', true),
      turnSummary: opt('showSummary', true),
      milestoneEveryLines: Math.max(0, opt('milestoneEveryLines', 0)),
      thinkingShowThresholdMs: Math.max(0, opt('thinkingThresholdMs', DEFAULT_HUD_OPTIONS.thinkingShowThresholdMs)),
      thinkingHoldMs: Math.max(0, opt('thinkingHoldMs', DEFAULT_HUD_OPTIONS.thinkingHoldMs)),
      editHoldMs: Math.max(0, opt('editHoldMs', DEFAULT_HUD_OPTIONS.editHoldMs)),
    });
    const reducer = createHudReducer(hudOptions);
    let cursor = 0;

    /** agent per ledger session (the ledger keys by raw session id). */
    const agentOf = new Map<string, string>();
    /** The last turn-end event per session, for the reply preview. */
    const lastTurnEnd = new Map<string, AgentEvent>();
    const thinking = new Map<string, { handle: BubbleHandle; startedAt: number; done: boolean }>();
    const edits = new Map<string, BubbleHandle>();
    const lastMilestone = new Map<string, number>();

    const petFor = (sessionId: string): PetHandle | undefined => {
      const agent = agentOf.get(sessionId);
      return (agent ? ctx.agent.petsFor(agent, sessionId)[0] : undefined) ?? ctx.pets.list()[0];
    };
    const say = (sessionId: string, lane: string, req: Omit<BubbleRequest, 'group' | 'session'>): BubbleHandle | null => {
      const pet = petFor(sessionId);
      return pet ? pet.say(req.text, { ...req, group: `${lane}:${sessionId}`, session: `${agentOf.get(sessionId) ?? ''}:${sessionId}` }) : null;
    };
    const later = (fn: () => void, ms: number) => ctx.setTimeout(fn, ms);

    const quoteReply = (sessionId: string) => {
      const e = lastTurnEnd.get(sessionId);
      if (!e || !opt('showReply', true)) return;
      const attempt = async (left: number) => {
        try {
          const text = await replyPreview(ctx, e, left > 0);
          if (text) say(sessionId, 'reply', { kind: 'reply', label: '回复', text, ttlMs: Math.max(1000, opt('replyHoldMs', 7000)) });
          else if (left > 0) later(() => void attempt(left - 1), REPLY_RETRY_MS);
        } catch (err) {
          ctx.log.warn(`reply preview failed: ${err}`);
        }
      };
      later(() => void attempt(REPLY_RETRIES), 300);
    };

    const execute = (c: HudCommand) => {
      switch (c.type) {
        case 'thinking-show': {
          const value = formatDuration(Date.now() - c.startedAt);
          const handle = say(c.sessionId, 'thinking', { kind: 'status', label: '思考', value, text: `思考 ${value}`, ttlMs: 0 });
          if (handle) thinking.set(c.sessionId, { handle, startedAt: c.startedAt, done: false });
          break;
        }
        case 'thinking-hide': {
          const live = thinking.get(c.sessionId);
          if (!live) break;
          // Freeze at the final total, then let it go after the hold.
          live.done = true;
          const value = formatDuration(c.totalMs || Date.now() - live.startedAt);
          live.handle.update({ value, text: `思考 ${value}` });
          later(() => {
            live.handle.dispose();
            if (thinking.get(c.sessionId) === live) thinking.delete(c.sessionId);
          }, c.holdMs);
          break;
        }
        case 'edit-show':
        case 'edit-update': {
          const value = formatLines(c.added, c.removed);
          const note = c.files > 1 ? `${c.files} 个文件` : undefined;
          const live = edits.get(c.sessionId);
          if (live && c.type === 'edit-update') live.update({ value, note, text: `写入 ${value}` }, { pulse: true });
          else {
            const handle = say(c.sessionId, 'edit', { kind: 'status', label: '写入', value, note, text: `写入 ${value}`, ttlMs: 0 });
            if (handle) edits.set(c.sessionId, handle);
          }
          break;
        }
        case 'edit-hide': {
          const handle = edits.get(c.sessionId);
          if (!handle) break;
          edits.delete(c.sessionId);
          later(() => handle.dispose(), c.holdMs);
          break;
        }
        case 'turn-show': {
          const parts: string[] = [];
          if (c.thinkingMs > 0) parts.push(`思考 ${formatDuration(c.thinkingMs)}`);
          if (c.linesAdded !== 0 || c.linesRemoved !== 0) parts.push(formatLines(c.linesAdded, c.linesRemoved));
          else if (c.edits > 0) parts.push(`${c.edits} 次编辑`);
          if (parts.length === 0) parts.push('回合结束');
          parts.push(formatDuration(c.durationMs));
          say(c.sessionId, 'turn', { kind: 'summary', label: '完成', text: parts.join(' · '), ttlMs: Math.max(1000, opt('summaryHoldMs', 4000)) });
          quoteReply(c.sessionId);
          break;
        }
        case 'edit-milestone': {
          const last = lastMilestone.get(c.sessionId) ?? -Infinity;
          if (Date.now() - last < MILESTONE_THROTTLE_MS) break;
          lastMilestone.set(c.sessionId, Date.now());
          petFor(c.sessionId)?.play(MILESTONE_POP);
          break;
        }
      }
    };

    const step = () => {
      const snap = ledger.snapshot(cursor);
      cursor = snap.cursor;
      for (const c of reducer.apply(snap, Date.now())) execute(c);
    };

    ctx.agent.on('event', (e) => {
      if (e.type === 'session-end') agentOf.delete(e.sessionId);
      else agentOf.set(e.sessionId, e.agent);
      ledger.record(e);
      // Reply previews only follow turns that ended normally (no reply to quote otherwise).
      if (e.type === 'turn-end') {
        if (e.outcome === 'success' && !e.extra?.synthetic) lastTurnEnd.set(e.sessionId, e);
        else lastTurnEnd.delete(e.sessionId);
      }
      // A tick later, so the kernel has routed the event and petsFor() knows the session's pet.
      ctx.setTimeout(step, 0);
    });

    // Reconcile (thinking threshold, runaway episodes) and keep live timers ticking.
    ctx.setInterval(() => {
      step();
      for (const live of thinking.values()) {
        if (live.done) continue;
        const value = formatDuration(Date.now() - live.startedAt);
        live.handle.update({ value, text: `思考 ${value}` });
      }
    }, TICK_MS);
  },
});
