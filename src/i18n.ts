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

/** Pin the language (plugin config or a test); undefined reverts to auto. */
export function setLangOverride(lang: Lang | undefined): void {
  override = lang
}

function parseLang(value: unknown): Lang | undefined {
  return value === 'zh' || value === 'en' ? value : undefined
}

function fileLang(): Lang | undefined {
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
    return cachedFileLang
  } catch {
    return undefined
  }
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
  // ── scene chrome ─────────────────────────────────────────────────────
  'scene-title': { zh: '查找历史会话', en: 'Find in sessions' },
  'search-placeholder': { zh: '输入关键词…', en: 'Type to search…' },
  'scope-repo': { zh: '本仓库', en: 'This repo' },
  'scope-all': { zh: '全部会话', en: 'All sessions' },
  'scope-label': { zh: '范围', en: 'Scope' },
  'scanning': { zh: '扫描中 {{resolved}}/{{total}}…', en: 'Scanning {{resolved}}/{{total}}…' },
  'scanning-initial': { zh: '扫描中…', en: 'Scanning…' },
  'no-query-hint': {
    zh: '输入关键词搜索全部会话内容；↑↓选择，↵恢复，p预览，c复制',
    en: 'Type to search across all sessions; ↑↓ navigate, ↵ resume, p preview, c copy',
  },
  'no-results': { zh: '没有匹配的会话', en: 'No matching sessions' },
  'no-results-scope-hint': {
    zh: '当前范围是「{{scope}}」——按 Tab 切换范围试试',
    en: 'Scope is "{{scope}}" — press Tab to try all sessions',
  },

  // ── result rows ──────────────────────────────────────────────────────
  'role-user': { zh: '你', en: 'You' },
  'role-assistant': { zh: 'AI', en: 'AI' },
  'role-tool': { zh: '工具', en: 'Tool' },
  'more-hits': { zh: '(+{{count}})', en: '(+{{count}})' },
  'hit-count': { zh: '{{sessions}} 个会话 · {{hits}} 处命中', en: '{{sessions}} sessions · {{hits}} hits' },

  // ── footer ───────────────────────────────────────────────────────────
  'footer-main': {
    zh: '↵恢复会话  p预览  c复制  Tab切换范围  ↑↓导航  Esc退出',
    en: '↵ resume  p preview  c copy  Tab scope  ↑↓ navigate  Esc close',
  },
  'footer-main-typing': {
    zh: '↵恢复会话  alt+p预览  alt+c复制  Tab切换范围  Esc清空',
    en: '↵ resume  alt+p preview  alt+c copy  Tab scope  Esc clear',
  },
  'footer-preview': {
    zh: 'c复制选中  ↵恢复此会话  Esc返回列表',
    en: 'c copy selected  ↵ resume session  Esc back',
  },
  'footer-confirm': {
    zh: '↵确认恢复  Esc取消',
    en: '↵ confirm resume  Esc cancel',
  },

  // ── preview pane ─────────────────────────────────────────────────────
  'preview-title': { zh: '只读预览 · {{title}}', en: 'Read-only preview · {{title}}' },
  'preview-context-note': {
    zh: '命中消息前后各 {{count}} 条；恢复会话可见完整历史',
    en: '{{count}} messages of context around the hit; resume for the full history',
  },

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
  'scan-aborted': { zh: '扫描已中止（部分索引可用）', en: 'Scan aborted (partial index available)' },
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
