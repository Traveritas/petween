// `stats-hud` (docs/06 §6, L1 + L3): a live pill beside the main pet while the agent works
// (thinking time, changed lines), and at turn end a bubble with the reply preview plus a summary.
// Bubbles go through the kernel's bubble channel, so they queue with everyone else's.

import { definePlugin, type AgentEvent, type Disposable, type PetHandle, type PluginContext, type PluginManifest } from '../../api/types';
import * as cc from './dialogue/claude-code';
import * as codex from './dialogue/codex';
import { isSafeSessionId, truncatePreview, type LastReply } from './dialogue/text';
import * as zcode from './dialogue/zcode';
import { createStatsLedger, type LedgerSessionSummary } from './ledger';

export const manifest: PluginManifest = {
  id: 'stats-hud',
  name: '统计 HUD',
  version: '0.1.0',
  apiVersion: 1,
  permissions: ['fs:read'],
  contributes: {
    channels: ['bubble'],
    settings: [
      { key: 'showLive', label: '工作时显示实时统计', type: 'boolean', default: true },
      { key: 'showReply', label: '回合结束时显示回复摘要', type: 'boolean', default: true, description: '读取 agent 的对话记录末尾，只在本机显示，不保存' },
      { key: 'showSummary', label: '回合结束时显示本轮统计', type: 'boolean', default: true },
      { key: 'bubbleSeconds', label: '摘要气泡停留', type: 'number', default: 7, min: 2, max: 30, step: 1, unit: '秒' },
    ],
  },
};

const CSS = `
.pw-hud {
  position: absolute; left: 0; top: 0; display: flex; gap: 6px; align-items: center; white-space: nowrap;
  padding: 4px 10px 4px 8px; border-radius: 999px;
  font: 12px/1.3 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; font-variant-numeric: tabular-nums;
  color: #4a4352; background: rgba(248, 245, 240, 0.94); border: 1px solid rgba(70, 60, 90, 0.08);
  box-shadow: 0 3px 10px rgba(40, 30, 60, 0.12);
  opacity: 0; transition: opacity 180ms ease-out; will-change: transform;
}
.pw-hud.show { opacity: 1; }
.pw-hud .dot { width: 7px; height: 7px; border-radius: 50%; background: #a493bf; animation: pw-breathe 1.6s ease-in-out infinite; }
.pw-hud .dot.working { background: #8fae95; }
.pw-hud .dot.waiting { background: #d3a65f; animation-duration: 0.9s; }
.pw-hud .add { color: #5e8f68; } .pw-hud .del { color: #b0676a; }
.pw-hud .sep { opacity: 0.35; }
@keyframes pw-breathe { 0%, 100% { opacity: 0.45; scale: 0.85; } 50% { opacity: 1; scale: 1; } }
@media (prefers-color-scheme: dark) {
  .pw-hud { color: #ddd6e6; background: rgba(46, 42, 54, 0.94); border-color: rgba(255, 255, 255, 0.08); }
  .pw-hud .add { color: #93c79c; } .pw-hud .del { color: #e09a9d; }
}
@media (prefers-reduced-motion: reduce) { .pw-hud .dot { animation: none; } }
`;

const LABEL: Record<string, string> = { thinking: '思考', working: '动手', waiting: '等你' };

function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

const thinkingOf = (s: LedgerSessionSummary, now: number) => s.thinkingMs + (s.thinkingSince !== null ? now - s.thinkingSince : 0);

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

async function replyPreview(ctx: PluginContext, e: AgentEvent): Promise<string | null> {
  const t = transcriptFor(ctx, e);
  if (!t || !(await ctx.host.fs.exists(t.path))) return null;
  const lines = (await ctx.host.fs.readTail(t.path, TAIL_BYTES)).split('\n');
  const turnId = typeof e.extra?.turnId === 'string' ? e.extra.turnId : undefined;
  const r = t.parse(lines, turnId) ?? (turnId ? t.parse(lines) : null);
  return r ? truncatePreview(r.text) : null;
}

// ---------- plugin ----------

export default definePlugin({
  activate(ctx) {
    const ledger = createStatsLedger();
    const opt = <T,>(k: string, d: T) => ctx.settings.get<T>(k, d);

    const layer = ctx.stage.addLayer({ z: 15 });
    const style = document.createElement('style');
    style.textContent = CSS;
    layer.el.appendChild(style);
    const pill = document.createElement('div');
    pill.className = 'pw-hud';
    layer.el.appendChild(pill);

    let follow: Disposable | null = null;
    let tick: Disposable | null = null;
    const pet = (): PetHandle | undefined => ctx.pets.list()[0];

    const place = () => {
      const p = pet();
      if (!p) return;
      const b = p.opaqueBounds;
      const w = pill.offsetWidth;
      const screen = ctx.desktop.screens().find((r) => b.x >= r.x && b.x <= r.x + r.width) ?? ctx.desktop.screens()[0];
      // Right of the pet by default; flip left near the screen edge.
      let x = b.x + b.width + 6;
      if (screen && x + w > screen.x + screen.width - 6) x = b.x - w - 6;
      const l = layer.toLocal({ x, y: b.y + b.height * 0.3 });
      pill.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`;
    };

    const render = () => {
      const snap = ledger.snapshot(Number.MAX_SAFE_INTEGER);
      const id = snap.focusedSessionId;
      const s = id ? snap.sessions[id] : undefined;
      const live = opt('showLive', true) && !!s && s.state in LABEL;
      if (!live) {
        pill.classList.remove('show');
        tick?.dispose();
        follow?.dispose();
        tick = follow = null;
        return;
      }
      // The dot says what the agent is doing right now; the number is always accumulated thinking time.
      const parts = [`<span class="dot ${s.state}" title="${LABEL[s.state]}"></span><span>思考 ${fmtDuration(thinkingOf(s, Date.now()))}</span>`];
      if (s.linesAdded || s.linesRemoved) parts.push(`<span class="sep">·</span><span class="add">+${s.linesAdded}</span><span class="del">−${s.linesRemoved}</span>`);
      pill.innerHTML = parts.join('');
      place();
      pill.classList.add('show');
      tick ??= ctx.setInterval(render, 1000);
      follow ??= ctx.requestFrame(place);
    };

    const onTurnEnd = async (e: AgentEvent) => {
      const p = pet();
      if (!p) return;
      const ttlMs = Math.max(2, Math.min(30, opt('bubbleSeconds', 7))) * 1000;
      if (opt('showReply', true)) {
        // The agent may still be flushing its transcript when Stop fires.
        await new Promise((r) => setTimeout(r, 300));
        try {
          const text = await replyPreview(ctx, e);
          if (text) p.say(text, { priority: 50, ttlMs });
        } catch (err) {
          ctx.log.warn(`reply preview failed: ${err}`);
        }
      }
      if (opt('showSummary', true)) {
        const sum = ledger
          .snapshot()
          .events.filter((x) => x.type === 'turn-summary' && x.sessionId === e.sessionId)
          .at(-1)?.summary;
        if (sum && (sum.edits > 0 || sum.thinkingMs >= 3000)) {
          const bits = [`本轮 ${fmtDuration(sum.durationMs)}`];
          if (sum.thinkingMs >= 1000) bits.push(`思考 ${fmtDuration(sum.thinkingMs)}`);
          if (sum.edits > 0) bits.push(`改动 +${sum.linesAdded} −${sum.linesRemoved}`);
          p.say(bits.join(' · '), { priority: 45, ttlMs });
        }
      }
    };

    ctx.agent.on('event', (e) => {
      ledger.record(e);
      render();
      if (e.type === 'turn-end' && e.outcome !== 'interrupted' && !e.extra?.synthetic) void onTurnEnd(e);
    });
  },
});
