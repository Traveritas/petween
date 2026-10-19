# 04 · 宠物包格式

> 状态：已定（2026-10-19）

宠物包是**纯数据**：图、动作参数、状态映射、署名。不含任何代码。

## 1. 文件结构

```
my-cat/                     （导出时打包为 my-cat.petpack = zip）
├─ pet.json                 清单
├─ clips/                   导入管线处理后的素材（spritesheet、静态图、视频）
├─ source/                  （可选）原始素材，便于以后重新导入
└─ thumbnail.webp
```

## 2. pet.json

```jsonc
{
  "format": 1,
  "id": "my-cat",                       // 导入时冲突则改名
  "name": "小猫",
  "attribution": { "creators": ["..."], "license": "CC-BY-4.0", "sourceUrl": "..." },
  "scale": 1,

  "clips": {
    "sit":      { "type": "still",  "source": "clips/sit.webp", "anchor": { "x": 0.5, "y": 0.96 } },
    "type":     { "type": "frames", "source": "clips/type.webp", "fps": 12,
                  "segments": { "loop": [0, 23] } },
    "cheer":    { "type": "frames", "source": "clips/cheer.webp", "fps": 15,
                  "segments": { "enter": [0, 9], "loop": [10, 29] }, "markers": { "9": "peak" } }
  },

  "motions": {                           // 具名动作，供多个状态复用
    "breathe":  { "type": "sine", "property": "scaleY", "amplitude": 0.02, "periodMs": 3200 },
    "pop-in":   { "type": "keyframes", "tracks": { /* ... */ }, "markers": { "120": "swap" } }
  },

  "states": {
    "idle":                 { "clips": ["sit"], "loop": ["breathe"] },
    "active":               { "clips": ["type"], "enter": "pop-in" },
    "active.command":       { "clips": ["type", "type-fast"], "variant": "random" },
    "active.command.Bash":  { "clips": ["terminal"] },
    "success":              { "clips": ["cheer"], "enter": "pop-in", "transition": "crossfade" },
    "roamer.doze":          { "clips": ["sleep"] }      // 插件声明的状态键
  }
}
```

## 3. 状态外观

```ts
interface StateAppearance {
  /** 一个或多个片段 id；多于一个时按 variant 选 */
  clips: string[]
  /** random = 每次进入随机；cycle = 状态内定时轮换；sticky = 同一回合保持首选 */
  variant?: 'random' | 'cycle' | 'sticky'
  cycleMs?: number
  weights?: number[]
  /** 进入时的一次性动作（transition 层）：具名动作 id 或内联定义 */
  enter?: MotionRef
  /** 状态保持期间的循环动作（base 层），可多个 */
  loop?: MotionRef[]
  /** 离开时的一次性动作 */
  exit?: MotionRef
  /** 片段切换方式，见 03 §4 */
  transition?: 'cut' | 'crossfade' | 'onMarker' | 'afterLoop' | { type: string; [k: string]: unknown }
}
type MotionRef = string | { type: string; [param: string]: unknown }
```

## 4. 状态键与回退

状态键是点分路径。查外观时从最具体的键逐级去掉末段，直到命中；最终兜底 `idle`。

```
active.command.Bash → active.command → active → idle
roamer.doze         → roamer         → idle
```

- **最小可用宠物包只需要一个 `idle`。** 其他状态全部回退到它。
- 回退是**按整条外观**进行的：命中 `active.command` 就用它的全部字段，不和 `active` 的字段混合。（混合会让创作者难以预测结果。）

### 谁产生状态键

| 来源 | 键 | 文档位置 |
|---|---|---|
| 默认大脑 | `idle`、`idle.long`、`active`、`active.thinking`、`active.edit`、`active.command`、`active.command.<工具名>`、`active.other`、`waiting`、`success`、`error` | 05 §4 |
| 插件 | 插件在 manifest 里声明的键，必须以插件 id 开头（如 `roamer.doze`） | 06 §3 |

编辑器展示「当前所有可能出现的状态键」= 默认大脑的键 + 已安装插件声明的键，按树形展示；没配的键显示它会回退到哪里。

## 5. 宠物包里的插件配置

宠物包可以附带插件配置（例如漫游插件的「这只猫走得慢一点」）：

```jsonc
"plugins": {
  "roamer": { "walkSpeed": 0.6 }
}
```

内核只校验大小和 JSON 合法性，**内容由对应插件解释**。插件未安装时原样保留，不丢弃。

## 6. 版本

- `format` 只在不兼容变更时递增；加可选字段不递增。
- 新版本软件必须能导入所有旧 `format`。
- 旧版本软件遇到新 `format` 明确报「需要升级」，不静默丢字段。
- v0（petween-desktop）宠物包通过一次性导入工具转换（见 07）。
