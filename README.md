# dsh-tui-find

**dsh-TUI 的跨会话全文搜索插件** —— 让"我记得哪次会话里聊过/生成过 X"在几秒内变成"找到了，能读、能复制、能接着做"。

[English](./README.en.md) · MIT · 零第三方运行时依赖

- 仓库：https://github.com/xiaoxiaohaigui/dsh-tui-find
- npm：https://www.npmjs.com/package/dsh-tui-find

## 这是什么

[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（`@deepseek-harness-tui/dsh-tui`）有 resume 浏览器、会话内 `/` 搜索、Ctrl+R 输入历史，但**没有跨会话内容检索**——一段对话滚出当前窗口后就成了不可搜索的档案。

`dsh-tui-find` 补上这一块：在 TUI 内对**本机全部 dsh 会话**（默认 zstd 帧链压缩、兼容明文 JSONL）做增量即时的内容搜索。命中后可以只读查看上下文、复制原文、或恢复会话。

## 安装

> **开发中提示**：项目处于 0.x 阶段，接口与配置项可能随版本调整。升级与卸载见下文。

**方式一：从 npm（已发布）**

```bash
dsh plugin --profile dsh-tui add -w dsh-tui-find@latest
```

`dsh plugin ... add` 会把参数转发给 profile 目录内的 pnpm（`--profile` 必填；`-w` 允许直接操作 profile 根），并读取包内 `cordis.patch.yml` 自动挂载为组合层——无需手动改配置。

**方式二：本地 tarball（开发/自用；不要直接安装源码目录）**

```bash
cd /path/to/dsh-tui-find
npm install        # 仅首次
npm pack           # prepack 钩子自动构建并跑全量测试
dsh plugin --profile dsh-tui add -w ./dsh-tui-find-<版本号>.tgz
```

`--profile` 名请换成你实际的 profile（`$DSH_HOME/profiles/` 下的目录名；未设置 `DSH_HOME` 时默认根为 `~/.dsh`）。

### 挂载机制

`dsh plugin ... add` 完成后 CLI 会把本包收录进 profile 的 `package.json → dsh.profile.bundles` 列表；本包自带的 `cordis.patch.yml` 作为组合层随 bundle 顺序自动应用，启动顺序为：`dsh-base → 其他 bundle → dsh-tui-find patch → 用户 profile patch`。正常情况下无需手动编辑任何配置。安装 / 升级 / 卸载改变的是 profile 的组合树，需要重启 dsh-TUI（或执行 `/restart`）后新代码才会加载或移除——宿主的 `/reload` 只重读偏好文件，不会重载插件代码。

## 升级

复用安装命令、显式指定 `@latest`（`dsh plugin ... add` 是幂等的）：

```bash
dsh plugin --profile dsh-tui add -w dsh-tui-find@latest
```

若 profile 内没有出现新版本，先刷新 npm 缓存再重试：`npm cache clean --force`。重启 dsh-TUI（或执行 `/restart`）加载新版本后，TUI 内执行 `/plugins`（或 `/plugins check`）验证已挂载插件及其版本。

## 卸载

三步，均可逆、不动宿主核心；操作后重启 dsh-TUI（或 `/restart`）生效：

1. **移除包本体**（同时会把 bundle 从解析树摘掉）：

```bash
dsh plugin --profile dsh-tui remove -w dsh-tui-find
```

2. **确认 bundle 列表已清理**：若 `$DSH_HOME/profiles/dsh-tui/package.json` 的 `dsh.profile.bundles` 数组里仍残留 `dsh-tui-find` 条目（CLI 版本行为差异），手动删除该条目即可。

3. **（可选）清理设置残留**：在 `/settings` 里保存过的插件设置落在宿主 settings 服务的用户层（settings.yaml），卸载后键值仍保留、重装后继续生效（层级覆盖规则不变）。想让状态完全归零，删除其中 `dsh-tui-find` 命名空间的键即可。

> 手动挂载的用户（直接向 profile 的 `cordis.patch.yml` 插入行）：先按第 1 步移除包本体，再删掉对应的 insert 行。

卸载只影响本插件：会话数据在 `~/.dsh` / `~/.dsh-tui` 下，插件全程只读，卸载后搜索历史自然消失，会话本身不受任何影响。唯一的落盘文件是水位日志（`~/.dsh-tui/dsh-tui-find/watermark.json`，仅文件元数据，见下节），想彻底清理可删除整个 `~/.dsh-tui/dsh-tui-find/` 目录。

## 使用

| 操作 | 说明 |
|---|---|
| `/find <关键词>` | 带参直接出结果（如 `/find 指数退避`） |
| `/find` | 空参进全屏搜索场景 |
| `Ctrl+Alt+F` | 全局入口快捷键（默认值；可用 `shortcut` 配置改键或关闭） |

场景内按键：

| 键 | 动作 |
|---|---|
| 任意字符 | 即时过滤（fzf 式，纯内存、零 IO）；空查询时列出最近会话 |
| `Tab` | 切换范围：本仓库 ⇄ 全部会话 |
| `Alt+R` | 切换正则匹配（JS 语法；无效正则显示提示、匹配为空） |
| `Alt+T` | 切换时间范围：全部 ⇄ 近 7 天 ⇄ 近 30 天（按会话最近修改时间） |
| `↑` `↓` / `PgUp` `PgDn` | 在条目间移动 / 翻页 |
| `Alt+P` | 只读预览（命中消息前后各 2 条 + 会话头部信息） |
| `Alt+C` | 复制命中消息原文（含角色与时间戳） |
| `Alt+E` | 展开 / 收起当前会话的全部命中 |
| `↵` | 恢复会话（**二次确认**；当前会话工作中会强警告） |
| `Esc` | 清空搜索 / 返回 / 退出场景 |

鼠标操作：

| 操作 | 动作 |
|---|---|
| 左键点击条目 | 选中并打开与 `↵` 相同的恢复确认 |
| 悬停条目 | 移动当前选择并高亮条目 |
| 滚轮 | 按条目上下移动选择 |

> 鼠标支持依赖 dsh-TUI 的全屏鼠标跟踪。dsh-TUI 0.9.3 发布包提供左键、悬停和滚轮事件，但未暴露右键 `onContextMenu` 事件，因此当前版本不显示右键菜单；键盘快捷键仍是完整操作入口。

> 预览与复制只走 `Alt+` 组合键：裸字母永远用于输入查询，不会误触快捷键。

> **为什么默认不是 `Ctrl+Shift+F`**：主流终端（Windows Terminal、VS Code、GNOME Terminal 等）把该键留给终端自身的"查找"功能，按键被终端截获、根本不会到达 dsh-TUI。`Ctrl+Alt+F` 与常见终端默认键及宿主 TUI 的保留键都不冲突；若你的终端恰好占用了它，用 `shortcut` 配置改成任意含 `Ctrl` 或 `Alt` 的组合键即可。

结果按会话分组、命中词高亮、每会话默认展示前 3 条命中（`(+N)` 提示），最近优先排序。

## 检索范围

- **索引内容**：用户消息、助手文本、会话标题、工具调用摘要（`[名称] 参数`）。
- **默认不索引**：thinking 文本（可在配置开启）。
- **匹配方式**：默认大小写不敏感子串（CJK 天然正确，无分词依赖）；`Alt+R` 可切换为 JS 正则模式（大小写敏感性跟随"大小写敏感"开关；无效、过长或可能导致灾难性回溯的模式会被拒绝并给出提示）。
- **时间过滤**：`Alt+T` 按会话最近修改时间过滤（全部 ⇄ 近 7 天 ⇄ 近 30 天），同时作用于搜索结果与空查询的最近列表；初始窗口由 `defaultTime` 配置决定（默认全部）。
- **默认范围**：本仓库（按会话 cwd 匹配当前工作目录，与 resume 浏览器同一套语义，含子目录会话）。

## 配置

在 `cordis.patch.yml` 的插件行上覆盖（全部可选）：

```yaml
- insert:
    - id: dsh-tui-find
      name: 'dsh-tui-find'
      defaultScope: 'all'        # 初始范围：repo(默认) | all
      defaultTime: 'all'         # 初始时间窗口：all(默认) | 7d | 30d
      caseSensitive: false       # 大小写敏感匹配（默认关）
      regex: false               # 默认启用正则匹配（默认关；场景内 Alt+R 即时切换）
      indexTools: true           # 索引工具调用摘要（默认开）
      indexThinking: false       # 索引 thinking 文本（默认关）
      sessionRoot: ''            # 手动指定会话根目录（默认自动探测）
      maxMessageChars: 4000      # 单条消息索引字符上限
      lang: 'auto'               # zh | en | auto(跟随宿主语言)
      shortcut: 'ctrl+alt+f'     # 全局入口组合键（必须含 ctrl 或 alt；'off' 关闭全局入口）
```

`lang: auto` 遵循 dsh-TUI 的语言链：`DSH_TUI_LANG` 环境变量 → `~/.dsh-tui/lang.json` → 系统locale → 中文。`/lang` 切换后插件文案即时跟随。

### 在 `/settings` 页面修改

除 `lang` 外的选项都可以在 TUI 内直接改：打开 `/settings`，进入 **dsh-tui-find（会话搜索）** 卡片。

| 选项 | 取值 |
|---|---|
| 默认搜索范围 | 本仓库（默认）⇄ 全部会话 |
| 默认搜索时间 | 全部时间（默认）⇄ 近 7 天 ⇄ 近 30 天 |
| 大小写敏感 | 开 / 关（默认关） |
| 正则匹配 | 开 / 关（默认关；场景内 `Alt+R` 即时切换） |
| 索引工具调用 | 开 / 关（默认开） |
| 索引 thinking 文本 | 开 / 关（默认关） |
| 会话目录覆盖 | 文本；留空时按下方探测链自动探测 |
| 单条消息索引字符上限 | 数值（200–65536，步进 100，默认 4000） |
| 全局快捷键 | 文本；组合键需含 `Ctrl` 或 `Alt`，`off` 禁用；默认 `Ctrl+Alt+F`（写错自动回退默认值并告警） |

修改即时保存（布尔 / 选择项一改就写入，文本项回车确认），落在宿主设置服务的用户层，按层级覆盖插件行配置的默认值；卡片文案跟随 TUI 的语言设置（zh / en）。

## 会话目录探测

按以下顺序探测会话根目录（发现第一个即用）：

1. 配置 `sessionRoot`（显式覆盖，排他）
2. `DSH_TUI_SESSION_ROOT` 环境变量
3. `$DSH_HOME || ~/.dsh` + `/sessions`
4. `~/.dsh-tui/sessions`

## 隐私与安全

- **全程只读**：只以读方式打开会话日志，绝不触碰 history lock，绝不改写会话历史。
- **落盘最小化**：对话内容只存内存（mtime+size 缓存），不落盘任何对话副本。唯一的例外是水位日志 `~/.dsh-tui/dsh-tui-find/watermark.json`——记录日志路径与字节数/修改时间/偏移量等文件元数据，绝无对话文本；0700 目录 / 0600 文件、tmp+rename 原子写，`DSH_TUI_FIND_WATERMARK=off` 可整体关闭。它只是增量解码的观测记录，冷启动仍全量解码、不参与解码决策。
- **增量解码**：会话日志追加后只解码新增帧（offset 水位 + 追加前缀边界证明），同尺寸触碰零解码；缩水、检测到的改写或编码翻转自动回退全量解码。前缀校验覆盖水位之前的全部字节。
- **容错**：正在写入的会话尾帧可能不完整（崩溃/中断），按 RFC 8878 帧结构校验判定后跳过，不崩溃、不残留；崩溃后补写的帧也能被增量路径接上、不重不漏。
- **恢复需确认**：恢复会话是丢弃当前上下文的破坏性切换，`↵` 需二次确认；当前会话仍在工作中时给出醒目警告。

## 开发

```bash
npm install        # 开发依赖（构建与测试）
npm run build      # tsc 编译到 dist/
npm run fixtures   # 生成合成会话 fixture（zstd 帧链 + 明文 + 损坏样本）
npm test           # vitest：帧链解析 / 扫描器 / 搜索 / 事件清洗 / 显示宽度 / 准入与挂载集成
```

测试覆盖（114 项）：

- **帧链解析**：多帧遍历、截断尾帧、magic 误判拒绝、保留块拒绝、RLE 块、单段/校验和帧头形态、64MB 解码上限、明文回退。
- **扫描器**：双格式（zstd/明文）内容一致、mtime 缓存复用（二次扫描零解码）、同尺寸触碰零解码（边界验证）、水位增量解码（zstd/明文追加只解新增帧、撕裂尾帧补全不重不漏、检测到的缩水与同边界等长改写全量回退、水位日志 0600/0700 姿态与冷启动全量解码）、损坏样本容错、indexTools/indexThinking 开关、AbortSignal 中止。
- **搜索**：大小写不敏感与高亮区间、CJK 子串、正则模式（逐命中区间、大小写敏感跟随、无效/过长/不安全模式拒绝、零宽样式安全）、`sinceMs` 时间窗（含边界）、工具摘要索引、repo/all 范围过滤（含子目录会话与容器边界）、结果幂等。
- **事件清洗**：终端控制字节与 C1/DEL 剥离、CR/tab 折叠、纯控制字符消息丢弃、头部 cwd 与会话标题清洗。
- **显示宽度**：CJK/emoji 双宽、头尾截断、两端对齐行、物理行滚动窗口（双行卡预算）、命中行压平/开窗/区间映射。
- **准入**：manifest 通过宿主同款 `@dsh-std/manifest` v0.15 解析器与投影、契约声明精确性；真实 cordis fiber 挂载（场景注册/open/close、settings 卡片、命令降级路径）、停用即复位语言链。
- **启动竞态防护**：seam 注册重试（重试落位、有界放弃、停用清理定时器）；真实宿主 `TuiSceneRuntime` 下强制冷启动交错——裸注册被活性门拒绝（金丝雀断言钉住竞态）而插件经重试落位场景、健康交错保持同步注册。

## 环境要求

- dsh-TUI v0.9+（v0.15 community-draft 插件体系）
- Node `^22.19 || >=24`
- Windows / macOS / Linux（帧遍历为纯 Buffer 操作，平台无关）

## 许可

MIT
