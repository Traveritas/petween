# 交接文档 — 宠物预设（Pet Presets）功能收尾

> 写于 2026-08-21（token 耗尽中断）。当前状态与剩余任务如下。读完本文件 + `docs/implementation-notes.md` 末尾两节即可无缝接手。

## 当前状态（已验证）

- 全仓：`pnpm vitest run` **43 文件 / 625 用例全绿**、`typecheck` 零错误、`build` 四产物通过（2026-08-21 主代理复验）。
- **宠物预设的 host 半已完成**（agent 实现 + 主代理复验）：
  - `src/host/pets.ts`：`PetsStore`（`$DSH_HOME/motion-pet/pets/<id>.json` 目录存储、原子写、串行队列、损坏跳过+warnings）。
  - config 新增 `activePetId: string | null`（默认 null，旧配置零迁移）。
  - **镜像同步**：`ConfigStore.update` 的 `onSaved` 钩子在 config 落盘后把 `{poses, states, scale}` 切片写入 active 预设（config 主、镜像从，镜像失败仅 warn）。
  - 配置由编辑器中的“保存修改”显式写入；`from=blank` 与 `apply` 不再创建隐式的「未命名宠物」。
  - **资产保护扩展**：删除资产时扫描全部预设的 poses，仅被非激活预设引用也 409。
  - API 全部可用（`GET/POST /api/motion-pet/pets`、`PUT/DELETE /pets/<id>`、`POST /pets/<id>/apply`），错误码协议与既有一致。
- 设计全貌见 implementation-notes 前一条记录与本文件下文「client 任务书」。
- **注意**：当前运行中的 `dsh web` 实例是 P1 验收时启动的，**尚未加载 pets 路由**——收尾时要先 `pnpm run build`（已构建，无需重复）再重启实例。

## 剩余任务 1：宠物预设 client 半（唯一的大块）

按以下任务书执行（与 host 半的契约已定型）：

### api.ts 新增
`getPets()` → `{pets, activePetId, warnings}`；`createPet({name, from:'current'|'blank'})` → `{pet, config}`；`renamePet(id, name)`；`deletePet(id)`；`applyPet(id)` → `{config}`。`PetPreset`/`PetSlice` 类型从 `src/core/types.ts` import。

### editor-store
- snapshot 增加 `pets: PetPreset[]`（load 时与 config 并行拉取；pet 相关动作后刷新）。
- 动作（直接 API 调用）：`createPetCurrent(name)` / `createPetBlank(name)` / `renamePet` / `deletePet` / `applyPet(id)`。存在未保存配置时，身份切换类动作会提示先保存。apply 成功后用返回的 config 替换本地 draft 并 hub.publish。删除 active 预设后 config 保留、activePetId 变 null，UI 显示「未保存的当前配置」。
- `activePetId` 已在 config 里，随既有 patch 链路自然流动，无需纳入 editor owned 字段（不要把它塞进 patchConfig 的写入集——它只经 pets API 改变）。

### UI（独立编辑器页）
- 顶部新增「宠物」卡片区（在全局设置之上）：当前宠物下拉（含「未保存的当前配置」项）+ 切换即 apply + 按钮组：新建副本（from=current）/ 新建空白（from=blank）/ 重命名 / 删除。重命名/删除/新建用小 prompt 或内联输入，删除要确认。
- 提示文案：「点击『保存修改』后，当前配置会写入所选宠物预设；有未保存修改时无法切换宠物。」
- 设置弹窗入口卡（MotionPetCard）可选加一行当前宠物名（不做也行）。
- 既有全部配置面板不变——它们编辑的就是当前激活预设的内容（host 镜像保证）。

### 测试（tests/client/）
- api 五方法（路径/方法/body/错误码）；store 动作（apply 后 draft 替换 + publish、delete-active 后的显示态）；UI 流（切换/新建空白/重命名/删除确认/未命名保护提示）；与 host 的端到端可放 tests/host/routes.test.ts 已覆盖处不再重复。

### 约束
只动 `src/client/**` 与 `tests/client/**`（若 typecheck 波及 tests/integration 的 fake，机械补齐即可）。不加依赖、不带扩展名 import、注释英文简洁、TS strict、UI 文案中文。完成标准：vitest 全绿 + typecheck 零错误 + build 通过。

## 剩余任务 2：收尾（主代理职责）

1. 复验三件套（vitest/typecheck/build）。
2. 重启 `dsh web`：`PID=$(netstat -ano | grep -E "127\.0\.0\.1:3080\s+.*LISTENING" | awk '{print $NF}' | head -1); [ -n "$PID" ] && taskkill //PID $PID //F`，然后后台 `dsh web`。
3. 真机验收：pets API curl 矩阵（建/列表/应用/重命名/删/资产 409）+ 编辑器「宠物」区目视（可用 CDP 截图）。
4. `docs/implementation-notes.md` 追加功能记录（设计决策：预设=poses+states+scale、镜像同步、防丢保护、资产 409 扩展）；根 `AGENTS.md` 头部进度与测试计数同步。
5. （可选）README「使用」一节补宠物预设说明。

## 环境备忘（新手必读坑位）

- Bash 工具每次调用都是新 shell，cwd 重置到 `D:\Documents\JustAnotherPetPlugin`——pnpm 命令必须 `cd dsh-motion-pet && …`。
- `/tmp` 双命名空间：bash 的 /tmp ≠ Write 工具的 /tmp（后者落到 `D:\tmp\`）；curl `-F` 传文件用 `$(cygpath -m …)` 转换路径。
- CDP 截图工具链在 `D:/tmp/cdp.mjs`（navigate/eval/shot/click-text/metrics/reload/drag/media 子命令）；Chrome headless 启动：`"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile --window-size=1600,1000 --no-first-run about:blank`。`Emulation.*` override 在最后一个 CDP 会话断开时被 Chrome 自动清除——模拟与探测必须在同一进程会话内。
- GitHub 仓库 `Traveritas/dsh-motion-pet`（私有）已建立；`.github/workflows/ci.yml` 因 gh token 缺 `workflow` scope 未推送——用户 `gh auth refresh -s workflow` 后补交。
- 用户live 配置里有真实数据（蓝毛女仆六图、terminalHold=until-interaction、changePoseWithinActive=true、activityTransition=state……），验收时别覆盖；动 config 前备份 `~/.dsh/motion-pet/`。

## 后续候选（用户已表态暂不做的）

- V1.1 P2：Motion Pack 导入导出、更多 ambient channel、Transition Matrix override。
- 用户自定义粒子效果（效果表开放 + registry 化）、动画自定义参数（parameters 开放命名参数 + 自动生成控件）、更多手势槽位（doubleClick 等）、文字气泡（规格 V1 排除项）、GIF 支持（动态 WebP/APNG 现已可用）。
- npm publish（等调优结束）。
