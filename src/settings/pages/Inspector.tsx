// Channel inspector (docs/02 §5): who holds what on every pet, live.

import type { ChannelEntry, InspectorPet } from '../../shared/admin';
import { call } from '../rpc';
import { usePoll } from '../ui';

function Table({ caption, rows }: { caption: string; rows: ChannelEntry[] }) {
  return (
    <div className="tbl">
      <div className="cap">{caption}</div>
      {rows.length === 0 ? (
        <div className="empty">空</div>
      ) : (
        <table>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.active ? 'active' : undefined}>
                <td>{r.owner}</td>
                <td className="mono">{r.value}</td>
                <td className="p">{r.priority}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Pet({ p }: { p: InspectorPet }) {
  return (
    <div className="card insp">
      <div className="head">
        <strong>{p.id}</strong>
        <div className="flow">
          <span className="pill">{p.stateKey}</span>
          <span className="arrow">→ 宠物包里的</span>
          <span className="pill plain">{p.resolvedKey}</span>
          <span className="arrow">→ 片段</span>
          <span className="pill plain">{p.clip || '—'}</span>
        </div>
        <span className="note">大脑：{p.brain || '无'}</span>
      </div>
      <div className="grid2">
        <Table caption="state 通道" rows={p.state} />
        <Table caption="position 通道" rows={p.position} />
        <Table caption="clip 通道" rows={p.clipChannel} />
        <Table caption="bubble 队列" rows={p.bubble.map((b) => ({ owner: b.owner, value: b.text, priority: b.priority, active: b.showing }))} />
      </div>
      <div className="tbl" style={{ marginTop: 10 }}>
        <div className="cap">动作（按层叠加）</div>
        {p.motions.length === 0 ? (
          <div className="empty">没有动作在运行</div>
        ) : (
          <table>
            <tbody>
              {p.motions.map((m, i) => (
                <tr key={i}>
                  <td>{m.owner}</td>
                  <td className="mono">{m.layer}</td>
                  <td className="mono">
                    {m.blend} × {m.weight}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function Inspector() {
  const pets = usePoll(() => call('inspector.snapshot'), 400);
  return (
    <div className="page">
      <h1>检查器</h1>
      <p className="lead">每只宠物每个通道现在是谁说了算。高亮的一行是生效中的；优先级越大越靠前。插件打架时先来这里看。</p>
      {pets?.map((p) => <Pet key={p.id} p={p} />)}
    </div>
  );
}
