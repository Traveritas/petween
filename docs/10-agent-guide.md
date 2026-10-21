# 10 · 给 agent 的宠物包制作指南

> 读者：帮用户做桌宠的 AI agent（Claude Code、Codex 等）。人也可以读。
> 这份文档会被打包进 Petween：`petween --pack guide` 打印全文。
> 状态：M3a（2026-10-21）。

## 1. 你要做的事

用户想要一只自己的桌宠。Petween 不自带生图功能：**你用用户自己的生图 / 生视频工具做素材，再用 `petween --pack` 命令导入、配置、检查、预览**。整个过程不需要打开任何界面；做完后用户可以在「宠物编辑器」里继续手调。

一个宠物包 = 一组图（或动画），每张图对应 agent 的一种状态（空闲、思考、改文件、成功……）。

## 2. 先问用户的事（问一次，别反复问）

1. 角色是什么样（一句话描述，或给一张参考图）。
2. 想要静态图就够，还是要动起来（GIF / 短视频）。动的更好看，但更费生成额度。
3. 用哪个生图 / 生视频工具（用户已有的；你不要替用户注册或付费）。

## 3. 需要哪些图

状态键按点号分层；**没做图的状态自动用上一级的图**（`active.command.Bash` → `active.command` → `active` → `idle`）。所以从上往下做，做多少都能用。

| 优先级 | 状态键 | 什么时候出现 | 图的建议 |
|---|---|---|---|
| 必须 | `idle` | 没有 agent 在干活 | 放松站立、自然表情 |
| 推荐 | `active` | agent 在干活（下面几种的共同上级） | 专注、认真 |
| 推荐 | `success` | 一轮做完、成功 | 开心、庆祝 |
| 推荐 | `error` | 出错 | 沮丧、困惑、捂脸 |
| 推荐 | `waiting` | 等用户确认 | 看向镜头、举手、歪头 |
| 可选 | `active.thinking` | 在想 | 托腮、思考 |
| 可选 | `active.edit` | 在改文件 | 写字、敲键盘 |
| 可选 | `active.command` | 在跑命令 | 操作电脑、拿工具 |
| 可选 | `active.other` | 读文件、搜索、联网 | 翻书、看东西 |
| 可选 | `idle.long` | 空闲很久 | 打瞌睡 |

`petween --pack info` 会列出当前可用的全部状态键（包括已安装插件的，如 `physics.hit` 撞墙）。

## 4. 生成素材的要求（最重要）

切换状态时图会直接换掉，所以**所有图必须看起来是同一个角色、同一个机位**，否则切换时人会「跳」：

- **同一角色**：每次生成都带上同一段角色描述；工具支持参考图 / 角色一致性就用上。
- **同一机位和大小**：全身、正面或同一侧面、同样的景别；角色占画面高度相近（约 80%），脚在画面下部。
- **背景**：最好透明 PNG。做不到就用**纯色背景**（纯白或纯绿，不要渐变、不要阴影地面），导入时加 `--remove-bg`。
- **尺寸**：边长 512–1024 就够，导入会缩到 512 以内。
- **动画**（可选）：GIF / APNG / 动态 WebP / 短视频（≤ 10 秒，超出截断）。最好是**首尾相接的循环**；视频要透明只能用带 alpha 的 WebM，否则用纯色背景 + `--remove-bg`。

示例提示词骨架（按用户的工具改写）：

```
<角色描述>，全身，正面，站在画面中央，脚在下方，<该状态的动作/表情>，
干净的纯白背景，无阴影，无文字，扁平插画风格
```

## 5. 命令

所有命令输出 JSON；`ok: false` 时看 `error`。退出码 0 成功、1 失败、2 Petween 没在运行（让用户先启动 Petween）。Windows 上命令是 Petween 安装目录里的 `petween.exe`（hook 用的也是它）。

```bash
petween --pack info                                   # 状态键、动作预设、切换方式
petween --pack new my-cat --name "小猫"                # 新建空宠物包（id 用小写字母、数字、短横线）
petween --pack import my-cat idle.png --state idle --remove-bg
petween --pack import my-cat happy.gif --state success
petween --pack import my-cat think1.png think2.png --state active.thinking   # 两张图：每次随机挑一张
petween --pack set-state my-cat success --enter hop --loop breathe          # 进入时蹦一下，之后呼吸
petween --pack set-state my-cat idle --loop breathe,sway
petween --pack show my-cat                            # 每个状态现在显示什么 + 检查结果
petween --pack preview my-cat success --seconds 6     # 在用户桌面的宠物身上临时显示 6 秒（不保存）
petween --pack set my-cat --creators "用户名" --license "仅个人使用"
petween --pack export my-cat                          # 导出 .petpack 到「下载」
```

其余：`set-state … --clips a,b`（换画面）、`--variant random|cycle|sticky`（多张时怎么挑）、`--transition crossfade`（淡入淡出）、`--remove`（不再单独设置）；`clip <id> <片段> --anchor x,y --scale s --fps n`（调片段）；`install 文件.petpack`；`reload <id>`（直接改了 pet.json 后让桌面重新读取）。`petween --pack help` 有完整列表。

**动作预设**：进入 / 离开用 `pop`（弹一下）、`hop`（蹦一下）、`shake`（抖一下）；持续用 `breathe`（呼吸）、`sway`（摇摆）、`busy`（上下忙碌）、`ponder`（随机晃）。画面会先换、再播进入动作。

## 6. 推荐流程

1. `petween --pack info`，`petween --pack new <id> --name <名字>`。
2. 先只做 `idle`：生成 → `import … --state idle` → `preview <id> idle`，**让用户看一眼确认角色和大小**再继续。别一口气生成全部。
3. 按第 3 节的优先级逐个状态生成、导入。每导入一张看返回的 `warnings`（如「图片没有透明背景」）。
4. `show <id>`：确认每个状态的 `showsAs`，`issues` 为空或只剩可以接受的提醒。
5. 逐个 `preview`，重点看切换时人有没有跳。跳的话：
   - 大小不一：`clip <id> <片段> --scale 1.08` 之类微调；
   - 位置不一：导入会自动把锚点放在脚底，个别图的脚被遮挡 / 有影子时会偏，用 `--anchor 0.5,0.95` 修正。
6. 告诉用户：可以在 托盘 →「宠物编辑器」里继续手调；要用这只宠物：设置 →「宠物」→ 换装。

## 7. 你不需要、也不应该做的

- 不要往宠物包里放任何脚本或可执行文件：宠物包是纯数据，Petween 只读 pet.json 和图片。
- 不要手写精灵图：`import` 会把 GIF / 视频拆帧、裁边、拼成精灵图。
- 可以直接改 `pet.json`（在 `%APPDATA%/com.petween.app/pets/<id>/`），改完 `reload`；格式见 docs/04。但优先用命令，命令会帮你检查。
