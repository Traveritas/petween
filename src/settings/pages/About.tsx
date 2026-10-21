import { invoke } from '@tauri-apps/api/core';
import { call } from '../rpc';
import { Mark, useLoad, useToast } from '../ui';

/** What the user pastes into their own agent to have it make a pet (docs/10). */
const agentPrompt = (exe: string) =>
  `帮我做一只 Petween 桌宠。Petween 的命令行是：\n"${exe}" --pack <命令>\n先运行 "${exe}" --pack guide 读完制作指南，再按指南用我的生图工具做素材、导入、预览。每做完一个状态先让我看一眼。`;

export function About() {
  const k = useLoad(() => call('kernel.get'));
  // The pack CLI is this same exe (hook_command reports its path).
  const exe = useLoad(() => invoke<{ command: string }>('hook_command', { connectorId: 'pack', query: null }).then((c) => c.command));
  const toast = useToast();
  const copy = async () => {
    if (!exe.data) return;
    await navigator.clipboard.writeText(agentPrompt(exe.data));
    toast('已复制，粘贴给你的 agent 就行');
  };
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

      <h2>让 agent 帮你做宠物</h2>
      <div className="card">
        <div className="row">
          <div className="body">
            <div className="title">交给你自己的 agent</div>
            <div className="sub">Petween 不自带生图。复制下面这段给 Claude Code、Codex 等，它会用你的生图工具做素材，再用命令行导入、配置、在桌面上预览。</div>
            <div className="sub mono" style={{ marginTop: 6 }}>
              {exe.data ? `"${exe.data}" --pack guide` : '…'}
            </div>
          </div>
          <button className="btn primary" disabled={!exe.data} onClick={() => void copy()}>
            复制给 agent
          </button>
        </div>
      </div>
    </div>
  );
}
