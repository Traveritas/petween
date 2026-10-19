import { call } from '../rpc';
import { Mark, useLoad } from '../ui';

export function About() {
  const k = useLoad(() => call('kernel.get'));
  return (
    <div className="page">
      <h1>关于</h1>
      <div className="card">
        <div className="row">
          <Mark />
          <div className="body">
            <div className="title">Petween {k.data?.version}</div>
            <div className="sub">陪你看 AI agent 干活的桌面宠物。AGPL-3.0-or-later。</div>
          </div>
        </div>
        <div className="row">
          <div className="body">
            <div className="title">数据目录</div>
            <div className="sub mono">{k.data?.dataDir}</div>
          </div>
        </div>
        <div className="row">
          <div className="body">
            <div className="title">找不到宠物？</div>
            <div className="sub">托盘菜单「找回宠物」或对应的快捷键：宠物会显示虚线框，跑出屏幕的会被拉回来。</div>
          </div>
        </div>
      </div>
    </div>
  );
}
