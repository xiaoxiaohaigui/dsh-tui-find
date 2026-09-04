/**
 * Plugin copy, zh/en, following the host's language contract WITHOUT
 * importing it: `lang` config → `DSH_TUI_LANG` env → `~/.dsh-tui/lang.json`
 * (mtime-cached) → OS locale → zh. A `/lang` switch therefore hot-swaps
 * this plugin's strings on the next render, exactly like the host's own
 * screens.
 *
 * Flat key → per-language string map; `t(key, params)` substitutes
 * `{{name}}` placeholders. Missing keys render the key itself so a typo is
 * visible instead of silently blank.
 *
 * @module dsh-tui-find/i18n
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Lang = 'zh' | 'en'

/** The dsh-tui prefs file this plugin mirrors (shared language contract). */
const LANG_FILE = join(homedir(), '.dsh-tui', 'lang.json')

let override: Lang | undefined
let cachedFileLang: Lang | undefined
let cachedFileMtime = 0
/** The lang file is probed at most once per this interval: `getLang()` runs
 *  on every `t()` call (dozens per frame while the list renders), and a
 *  statSync per call is a syscall tax on every render. A change to the file
 *  is still picked up within one probe interval — well inside the
 *  "next render" contract a `/lang` switch relies on. */
const FILE_PROBE_INTERVAL_MS = 1000
let lastProbeAt = 0

/** Pin the language (plugin config or a test); undefined reverts to auto. */
export function setLangOverride(lang: Lang | undefined): void {
  override = lang
}

function parseLang(value: unknown): Lang | undefined {
  return value === 'zh' || value === 'en' ? value : undefined
}

function fileLang(): Lang | undefined {
  const now = Date.now()
  if (now - lastProbeAt < FILE_PROBE_INTERVAL_MS) return cachedFileLang
  lastProbeAt = now
  try {
    const mtime = statSync(LANG_FILE).mtimeMs
    if (mtime !== cachedFileMtime) {
      cachedFileMtime = mtime
      try {
        const parsed: unknown = JSON.parse(readFileSync(LANG_FILE, 'utf8'))
        cachedFileLang = parseLang((parsed as Record<string, unknown>)['lang'])
      } catch {
        cachedFileLang = undefined
      }
    }
  } catch {
    cachedFileLang = undefined
  }
  return cachedFileLang
}

function localeLang(): Lang | undefined {
  const raw =
    process.env['LC_ALL'] ?? process.env['LC_MESSAGES'] ?? process.env['LANG'] ?? ''
  return raw.toLowerCase().startsWith('zh') ? 'zh' : raw.toLowerCase().startsWith('en') ? 'en' : undefined
}

/** The currently effective language. */
export function getLang(): Lang {
  return override ?? parseLang(process.env['DSH_TUI_LANG']) ?? fileLang() ?? localeLang() ?? 'zh'
}

export const dict = {
  // ── scene chrome (mirrors the /resume browser's regions) ────────────
  'scene-title': { zh: '查找历史会话', en: 'Find in sessions' },
  'search-placeholder': { zh: '输入以搜索 · {{scope}}', en: 'Type to search · {{scope}}' },
  'scope-repo': { zh: '本仓库', en: 'This repo' },
  'scope-all': { zh: '全部会话', en: 'All sessions' },
  'scope-switched': { zh: '范围已切换为「{{scope}}」', en: 'Scope switched to "{{scope}}"' },
  'time-all': { zh: '全部时间', en: 'All time' },
  'time-7d': { zh: '近 7 天', en: 'Last 7 days' },
  'time-30d': { zh: '近 30 天', en: 'Last 30 days' },
  'time-switched': { zh: '时间范围：{{range}}', en: 'Time range: {{range}}' },
  'badge-regex': { zh: '正则', en: 'regex' },
  'regex-on': { zh: '正则匹配：开', en: 'Regex matching: on' },
  'regex-off': { zh: '正则匹配：关', en: 'Regex matching: off' },
  'regex-invalid': { zh: ' 无效的正则表达式', en: ' Invalid regular expression' },
  'scanning': { zh: '扫描中 {{resolved}}/{{total}}…', en: 'Scanning {{resolved}}/{{total}}…' },
  'scanning-initial': { zh: '扫描中…', en: 'Scanning…' },
  'reading-sessions': { zh: '正在读取会话…', en: 'Reading sessions…' },
  'session-count': { zh: '{{n}} 个会话', en: '{{n}} sessions' },
  'no-results': { zh: ' 没有匹配的会话', en: ' No matching sessions' },
  'no-results-scope-hint': {
    zh: ' 当前范围是「{{scope}}」——按 Tab 切换范围试试',
    en: ' Scope is "{{scope}}" — press Tab to try all sessions',
  },
  'no-sessions': { zh: ' 没有可搜索的会话内容', en: ' No searchable session content' },

  // ── relative time (mirrors the host's session-when-* strings) ───────
  'when-now': { zh: '刚刚', en: 'just now' },
  'when-minutes': { zh: '{{n}} 分钟前', en: '{{n}}m ago' },
  'when-hours': { zh: '{{n}} 小时前', en: '{{n}}h ago' },
  'when-days': { zh: '{{n}} 天前', en: '{{n}}d ago' },
  'when-date': { zh: '{{m}}月{{d}}日', en: '{{m}}/{{d}}' },
  'msgs-count': { zh: '{{n}} 条', en: '{{n}} msgs' },

  // ── result rows ──────────────────────────────────────────────────────
  'role-user': { zh: '你', en: 'You' },
  'role-assistant': { zh: 'AI', en: 'AI' },
  'role-tool': { zh: '工具', en: 'Tool' },
  'role-title': { zh: '标题', en: 'Title' },
  'more-hits': { zh: ' (+{{count}})', en: ' (+{{count}})' },
  'hit-count': { zh: '{{sessions}} 个会话 · {{hits}} 处命中', en: '{{sessions}} sessions · {{hits}} hits' },

  // ── hint lines (HintLine style: **key** spans render bold) ─────────────
  // The list hint is composed per width from these segments (scene.tsx):
  // leading/trailing segments always render, middle ones drop when the
  // viewport is too narrow for the full line.
  'hint-seg-resume': { zh: '**Enter** 恢复', en: '**Enter** resume' },
  'hint-seg-scope': { zh: 'Tab 范围', en: 'Tab scope' },
  'hint-seg-preview': { zh: 'Alt+P 预览', en: 'Alt+P preview' },
  'hint-seg-copy': { zh: 'Alt+C 复制', en: 'Alt+C copy' },
  'hint-seg-expand': { zh: 'Alt+E 展开', en: 'Alt+E expand' },
  'hint-seg-regex': { zh: 'Alt+R 正则', en: 'Alt+R regex' },
  'hint-seg-time': { zh: 'Alt+T 时间', en: 'Alt+T time' },
  'hint-seg-navigate': { zh: '↑↓ 选择', en: '↑↓ select' },
  'hint-seg-esc': { zh: 'Esc 清空/退出', en: 'Esc clear/exit' },
  'hint-preview': {
    zh: '**↑↓** 逐段 · **n/N** 命中 · **Enter** 恢复 · **Alt+C** 复制 · **Esc** 返回',
    en: '**↑↓** step messages · **n/N** hit · **Enter** resume · **Alt+C** copy · **Esc** back',
  },
  'hint-confirm': {
    zh: '**Enter** 确认恢复 · Esc 取消',
    en: '**Enter** confirm resume · Esc cancel',
  },

  // ── preview pane ─────────────────────────────────────────────────────
  'preview-title': { zh: '只读预览 · {{title}}', en: 'Read-only preview · {{title}}' },
  // n/N jump feedback in the reader's status row: the 1-based ordinal of
  // the hit just landed on, over the session's hit total.
  'preview-hit-jump': { zh: '命中 {{index}}/{{total}}', en: 'Hit {{index}}/{{total}}' },
  'preview-hit-end': { zh: '没有更多命中', en: 'No more hits' },

  // ── resume confirm ───────────────────────────────────────────────────
  'confirm-title': { zh: '恢复该会话？', en: 'Resume this session?' },
  'confirm-warning-working': {
    zh: '当前会话正在工作中，恢复会中断当前任务！',
    en: 'The current session is still working — resuming will interrupt it!',
  },
  'confirm-warning-context': {
    zh: '恢复会离开当前会话上下文（当前对话窗口保留在会话列表中，可随时找回）。',
    en: 'Resuming leaves the current conversation context (it stays in the session list and can be found again).',
  },
  'confirm-target': { zh: '目标：{{title}}', en: 'Target: {{title}}' },

  // ── toasts & failures ────────────────────────────────────────────────
  'copied': { zh: '已复制 {{chars}} 字符到剪贴板', en: 'Copied {{chars}} chars to clipboard' },
  'copy-failed': { zh: '复制失败', en: 'Copy failed' },
  'resume-working': { zh: '恢复失败：当前会话仍在工作中', en: 'Resume failed: the current session is still working' },
  'resume-unavailable': { zh: '恢复失败：会话存储不可用', en: 'Resume failed: session store unavailable' },
  'resume-cancelled': { zh: '已取消恢复', en: 'Resume cancelled' },
  'resume-failed': { zh: '恢复失败：{{error}}', en: 'Resume failed: {{error}}' },
  'resumed': { zh: '已恢复会话', en: 'Session resumed' },
  'scan-failed': { zh: '扫描失败：{{error}}', en: 'Scan failed: {{error}}' },

  // ── help overlay (Alt+H) ─────────────────────────────────────────────
  // The keys column of the help sheet is language-free (src/help.tsx owns
  // those strings); only the action column is localized here.
  'help-title': { zh: '键位帮助', en: 'Keyboard help' },
  'help-section-list': { zh: '列表', en: 'List' },
  'help-section-preview': { zh: '预览', en: 'Preview' },
  'help-section-mouse': { zh: '鼠标', en: 'Mouse' },
  'help-list-type': { zh: '输入查询（任意字符）', en: 'Type to search (any character)' },
  'help-list-scope': { zh: '切换范围（本仓库 / 全部会话）', en: 'Toggle scope (this repo / all sessions)' },
  'help-list-regex': { zh: '切换正则匹配', en: 'Toggle regex matching' },
  'help-list-time': { zh: '切换时间范围', en: 'Cycle the time window' },
  'help-list-preview': { zh: '打开只读预览', en: 'Open the read-only preview' },
  'help-list-copy': { zh: '复制选中的命中消息', en: 'Copy the selected hit message' },
  'help-list-expand': { zh: '展开 / 收起全部命中', en: 'Expand / collapse all hits' },
  'help-list-resume': { zh: '恢复选中的会话（进入确认）', en: 'Resume the selected session (confirm)' },
  'help-list-select': { zh: '移动选择', en: 'Move the selection' },
  'help-list-page': { zh: '翻页', en: 'Page up / down' },
  'help-list-esc': { zh: '清空查询 / 退出', en: 'Clear the query / exit' },
  'help-list-help': { zh: '打开 / 关闭本帮助', en: 'Toggle this help' },
  'help-list-global': { zh: '全局打开 /find（shortcut 配置可改键）', en: 'Open /find globally (remap via shortcut config)' },
  'help-preview-scroll': { zh: '按消息段滚动', en: 'Step through messages' },
  'help-preview-page': { zh: '翻页滚动', en: 'Scroll by page' },
  'help-preview-hits': { zh: '跳转下 / 上一个命中', en: 'Jump to the next / previous hit' },
  'help-preview-resume': { zh: '恢复该会话（进入确认）', en: 'Resume this session (confirm)' },
  'help-preview-copy': { zh: '复制光标所在消息', en: 'Copy the message under the cursor' },
  'help-preview-esc': { zh: '返回列表', en: 'Back to the list' },
  'help-mouse-click': { zh: '选中并打开确认', en: 'Select and open the confirm' },
  'help-mouse-hover': { zh: '移动选择', en: 'Move the selection' },
  'help-mouse-wheel': { zh: '按条目移动（预览内按行滚动）', en: 'Move by row (scroll by line in the preview)' },
  // The overlay's own footer hint (HintLine `**key**` vocabulary).
  'help-footer': { zh: '**Esc** 返回', en: '**Esc** back' },
  // New list hint segment for the main scene's hint line (Alt+H wiring).
  'hint-seg-help': { zh: '**Alt+H** 帮助', en: '**Alt+H** help' },
} as const satisfies Record<string, { zh: string; en: string }>

export type I18nKey = keyof typeof dict
export type I18nParams = Record<string, string | number>

/** Translate a key into the effective language, substituting `{{name}}`. */
export function t(key: I18nKey, params: I18nParams = {}): string {
  const entry = dict[key]
  const template = entry[getLang()] ?? entry.zh ?? key
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}
