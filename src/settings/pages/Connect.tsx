import { call } from '../rpc';
import { timeAgo, useAction, useLoad } from '../ui';

const BRAIN_LABEL: Record<string, string> = { default: '默认大脑' };
const BINDING_LABEL: Record<string, string> = { single: '所有会话 → 第一只宠物', perSession: '每个会话一只宠物' };

export function Connect() {
  const list = useLoad(() => call('connectors.list'));
  const kernel = useLoad(() => call('kernel.get'));
  const { busy, run } = useAction();

  return (
    <div className="page">
      <h1>接入</h1>
      <p className="lead">让宠物跟着 AI 编程 agent 的状态变表情。接入只会在 agent 的配置里加上 Petween 自己的条目，断开时只删这些。</p>

      <div className="card">
        {list.data?.map((c) => {
          const on = !!c.status?.installed;
          return (
            <div className="row" key={c.id}>
              <div className="body">
                <div className="title">
                  {c.name}
                  {c.error ? (
                    <span className="pill bad">配置读不了</span>
                  ) : on ? (
                    <span className="pill ok">
                      <span className="d" />
                      已接入
                    </span>
                  ) : (
                    <span className="pill plain">未接入</span>
                  )}
                  {c.sessions > 0 && <span className="pill">{c.sessions} 个会话进行中</span>}
                </div>
                <div className="sub">
                  {on ? timeAgo(c.lastEventAt) : '还没接入'}
                  {on && c.status?.detail && ` · ${c.status.detail}`}
                  {c.owner && c.owner !== c.id && ` · 由插件 ${c.owner} 提供`}
                </div>
                {c.error && <div className="err">{c.error}</div>}
              </div>
              {on ? (
                <button className="btn" disabled={busy} onClick={() => void run(() => call('connectors.uninstall', { id: c.id }), `已断开 ${c.name}`).then(list.reload)}>
                  断开
                </button>
              ) : (
                <button className="btn primary" disabled={busy || !!c.error} onClick={() => void run(() => call('connectors.install', { id: c.id }), `已接入 ${c.name}`).then(list.reload)}>
                  接入
                </button>
              )}
            </div>
          );
        })}
        {list.data?.length === 0 && <div className="row note">没有可用的接入插件。</div>}
        {list.error && <div className="row err">{list.error}</div>}
      </div>

      <h2>信号怎么变成表情</h2>
      <div className="card">
        <div className="row">
          <div className="body">
            <div className="title">大脑</div>
            <div className="sub">把 agent 的事件变成宠物状态。细节在「插件 → 默认大脑」里调。</div>
          </div>
          <select
            aria-label="大脑"
            value={kernel.data?.brain ?? ''}
            onChange={(e) => void run(() => call('kernel.set', { brain: e.target.value })).then(kernel.reload)}
          >
            {kernel.data?.brains.map((b) => (
              <option key={b} value={b}>
                {BRAIN_LABEL[b] ?? b}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div className="body">
            <div className="title">会话绑定</div>
            <div className="sub">哪些会话驱动哪只宠物。</div>
          </div>
          <select
            aria-label="会话绑定"
            value={kernel.data?.binding ?? ''}
            onChange={(e) => void run(() => call('kernel.set', { binding: e.target.value })).then(kernel.reload)}
          >
            {kernel.data?.bindings.map((b) => (
              <option key={b} value={b}>
                {BINDING_LABEL[b] ?? b}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
