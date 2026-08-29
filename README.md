# dsh-tui-find

**dsh-TUI 的跨会话全文搜索插件** —— 让"我记得哪次会话里聊过/生成过 X"在几秒内变成"找到了，能读、能复制、能接着做"。

[English](./README.en.md) · MIT · 零第三方运行时依赖

- 仓库：https://github.com/xiaoxiaohaigui/dsh-tui-find
- npm：https://www.npmjs.com/package/dsh-tui-find

## 这是什么

dsh-TUI（`@deepseek-harness-tui/dsh-tui`）有 resume 浏览器、会话内 `/` 搜索、Ctrl+R 输入历史，但**没有跨会话内容检索**——一段对话滚出当前窗口后就成了不可搜索的档案。

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
npm run build
npm pack
dsh plugin --profile dsh-tui add -w ./dsh-tui-find-<版本号>.tgz
```

`--profile` 名请换成你实际的 profile（`$DSH_HOME/profiles/` 下的目录名；未设置 `DSH_HOME` 时默认根为 `~/.dsh`）。

### 挂载机制

`dsh plugin ... add` 完成后 CLI 会把本包收录进 profile 的 `package.json → dsh.profile.bundles` 列表；本包自带的 `cordis.patch.yml` 作为组合层随 bundle 顺序自动应用，启动顺序为：`dsh-base → 其他 bundle → dsh-tui-find patch → 用户 profile patch`。正常情况下无需手动编辑任何配置。

## 升级

复用安装命令、显式指定 `@latest`（`dsh plugin ... add` 是幂等的）：

```bash
dsh plugin --profile dsh-tui add -w dsh-tui-find@latest
```

若 profile 内没有出现新版本，先刷新 npm 缓存再重试：`npm cache clean --force`。验证版本：TUI 内执行 `/plugins`（或 `/plugins check`）查看已挂载插件及其版本。

## 卸载

两步，均可逆、不动宿主核心：

1. **移除包本体**（同时会把 bundle 从解析树摘掉）：

```bash
dsh plugin --profile dsh-tui remove -w dsh-tui-find
```

2. **确认 bundle 列表已清理**：若 `$DSH_HOME/profiles/dsh-tui/package.json` 的 `dsh.profile.bundles` 数组里仍残留 `dsh-tui-find` 条目（CLI 版本行为差异），手动删除该条目即可。

卸载只影响本插件：会话数据在 `~/.dsh` / `~/.dsh-tui` 下，插件全程只读、无落盘索引，卸载后搜索历史自然消失，会话本身不受任何影响。

## 使用

| 操作 | 说明 |
|---|---|
| `/find <关键词>` | 带参直接出结果（如 `/find 指数退避`） |
| `/find` | 空参进全屏搜索场景 |
| `Ctrl+Shift+F` | 全局入口快捷键 |

场景内按键：

| 键 | 动作 |
|---|---|
| 任意字符 | 即时过滤（fzf 式，纯内存、零 IO） |
| `Tab` | 切换范围：本仓库 ⇄ 全部会话 |
| `↑` `↓` / `PgUp` `PgDn` | 在命中条目间移动 / 翻页 |
| `p` | 只读预览（命中消息前后各 2 条 + 会话头部信息） |
| `c` | 复制命中消息原文（含角色与时间戳） |
| `↵` | 恢复会话（**二次确认**；当前会话工作中会强警告） |
| `Esc` | 清空搜索 / 返回 / 退出场景 |

结果按会话分组、命中词高亮、每会话默认展示前 3 条命中（`(+N)` 提示），最近优先排序。

## 检索范围

- **索引内容**：用户消息、助手文本、会话标题、工具调用摘要（`[名称] 参数`）。
- **默认不索引**：thinking 文本（可在配置开启）。
- **匹配方式**：大小写不敏感子串（CJK 天然正确，无分词依赖）。
- **默认范围**：本仓库（按会话 cwd 匹配当前工作目录，与 resume 浏览器同一套语义，含子目录会话）。

## 配置

在 `cordis.patch.yml` 的插件行上覆盖（全部可选）：

```yaml
- insert:
    - id: dsh-tui-find
      name: 'dsh-tui-find'
      defaultScope: 'all'        # 初始范围：repo(默认) | all
      caseSensitive: false       # 大小写敏感匹配（默认关）
      indexTools: true           # 索引工具调用摘要（默认开）
      indexThinking: false       # 索引 thinking 文本（默认关）
      sessionRoot: ''            # 手动指定会话根目录（默认自动探测）
      maxMessageChars: 4000      # 单条消息索引字符上限
      lang: 'auto'               # zh | en | auto(跟随宿主语言)
```

`lang: auto` 遵循 dsh-TUI 的语言链：`DSH_TUI_LANG` 环境变量 → `~/.dsh-tui/lang.json` → 系统locale → 中文。`/lang` 切换后插件文案即时跟随。

## 会话目录探测

按以下顺序探测会话根目录（发现第一个即用）：

1. 配置 `sessionRoot`（显式覆盖，排他）
2. `DSH_TUI_SESSION_ROOT` 环境变量
3. `$DSH_HOME || ~/.dsh` + `/sessions`
4. `~/.dsh-tui/sessions`

## 隐私与安全

- **全程只读**：只以读方式打开会话日志，绝不触碰 history lock，绝不改写会话历史。
- **无常驻索引落盘**：扫描结果只存内存（mtime+size 缓存），不在磁盘上新建任何对话副本。
- **容错**：正在写入的会话尾帧可能不完整（崩溃/中断），按 RFC 8878 帧结构校验判定后跳过，不崩溃、不残留。
- **恢复需确认**：恢复会话是丢弃当前上下文的破坏性切换，`↵` 需二次确认；当前会话仍在工作中时给出醒目警告。

## 开发

```bash
npm install        # 开发依赖（构建与测试）
npm run build      # tsc 编译到 dist/
npm test           # vitest：帧链解析 / 扫描器 / 搜索 / manifest 准入 / 挂载集成
npm run fixtures   # 生成合成会话 fixture（zstd 帧链 + 明文 + 损坏样本）
```

测试覆盖（37 项）：

- **帧链解析**：多帧遍历、截断尾帧、magic 误判拒绝、保留块拒绝、RLE 块、单段/校验和帧头形态、64MB 解码上限、明文回退。
- **扫描器**：双格式（zstd/明文）内容一致、mtime 缓存复用（二次扫描零解码）、追加后增量重扫、损坏样本容错、indexTools 开关、AbortSignal 中止。
- **搜索**：大小写不敏感与高亮区间、CJK 子串、工具摘要索引、repo/all 范围过滤（含子目录会话与容器边界）。
- **准入**：manifest 通过宿主同款 `@dsh-std/manifest` v0.15 解析器与投影、契约声明精确性；真实 cordis fiber 挂载（场景注册/open/close、settings 卡片、命令降级路径）。

## 环境要求

- dsh-TUI v0.9+（v0.15 community-draft 插件体系）
- Node `^22.19 || >=24`
- Windows / macOS / Linux（帧遍历为纯 Buffer 操作，平台无关）

## 许可

MIT
