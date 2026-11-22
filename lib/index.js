/**
 * dsh-meta-theory — 宿主半侧
 *
 * 把「元理论检索」从一篇提示词变成可调用的执行件：
 *   · meta_theory_brief  开工前生成理论树骨架（含豁免判定与三条判别问题）
 *   · meta_theory_check  把已写好的理论树按 8 条翻车模式逐项校验
 *   · meta_theory_status 插件／技能／规则三处落位状态
 *   · meta_theory_rule   输出规则文本，可选写入 AGENTS.md（备份 + 幂等）
 *
 * 契约要点（踩过的坑，勿删）：
 *   1. 工具必须带 output { schema, render }，否则 tools.register() 抛异常且被静默吞掉。
 *   2. apply() 时 'tools' 服务可能未就绪：监听 internal/service + 定时重试兜底。
 *   3. 工具返回值必须是 lossless JSON：undefined / BigInt / 循环引用会整条失败。
 *   4. 不声明 dsh.client —— 无浏览器半侧，避免 exports["./client"] 成对契约风险。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildBrief, checkTree, RULE_MARKDOWN, RULES_VERSION, SKILL_NAME, SKILL_DIRNAME, CHECKLIST } from './rules.mjs'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NS = 'dsh-meta-theory'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_SKILLS_DIR = path.join(DSH_HOME, 'skills')
const DEFAULT_DATA_DIR = path.join(DSH_HOME, 'meta-theory')
const DEFAULT_AGENTS = path.join(DSH_HOME, 'AGENTS.md')

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
})()

/* ── 通用 ─────────────────────────────────────────────────────────── */
function textBlock(text) { return [{ type: 'text', text }] }

function toLossless(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t === 'bigint') return value.toString()
  if (t === 'function' || t === 'symbol') return null
  if (t !== 'object') return String(value)
  if (seen.has(value)) return '[循环引用]'
  seen.add(value)
  if (Array.isArray(value)) { const out = value.map((v) => toLossless(v, seen)); seen.delete(value); return out }
  if (value instanceof Date) { seen.delete(value); return value.toISOString() }
  if (Buffer.isBuffer(value)) { seen.delete(value); return value.toString('utf8') }
  const out = {}
  for (const [k, v] of Object.entries(value)) { if (v === undefined) continue; out[k] = toLossless(v, seen) }
  seen.delete(value)
  return out
}

function renderResult(value) {
  try { return textBlock(typeof value === 'string' ? value : JSON.stringify(toLossless(value), null, 2)) } catch { return textBlock(String(value)) }
}

function withOutput(def) {
  if (def.output?.schema && typeof def.output.render === 'function') return def
  return { ...def, output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => renderResult(v) } }
}

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex') }
function nowIso() { return new Date().toISOString() }

/* ── 数据目录（原子写 + 有界日志）──────────────────────────────────── */
class Store {
  constructor(opts = {}) {
    this.dir = path.resolve(opts.dataDir || DEFAULT_DATA_DIR)
    this.skillsDir = path.resolve(opts.skillsDir || DEFAULT_SKILLS_DIR)
    this.agentsPath = path.resolve(opts.agentsPath || DEFAULT_AGENTS)
    this.logPath = path.join(this.dir, 'log.jsonl')
    this.markerPath = path.join(this.dir, 'state.json')
  }
  ensure() { try { fs.mkdirSync(this.dir, { recursive: true }) } catch { /* 只读环境不致命 */ } }
  readState() {
    try { return JSON.parse(fs.readFileSync(this.markerPath, 'utf8')) } catch { return {} }
  }
  writeState(patch) {
    this.ensure()
    const next = { ...this.readState(), ...patch, updatedAt: nowIso() }
    try { fs.writeFileSync(this.markerPath, JSON.stringify(next, null, 2), 'utf8') } catch { /* ignore */ }
    return next
  }
  log(entry) {
    this.ensure()
    const line = JSON.stringify({ at: nowIso(), version: VERSION, ...toLossless(entry) })
    try {
      fs.appendFileSync(this.logPath, line + '\n', 'utf8')
      const buf = fs.readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean)
      if (buf.length > 500) fs.writeFileSync(this.logPath, buf.slice(-300).join('\n') + '\n', 'utf8')
    } catch { /* 日志失败不影响主流程 */ }
  }
}

/* ── 技能投放（幂等；不覆盖用户手改）──────────────────────────────── */
function skillTarget(store) { return path.join(store.skillsDir, SKILL_DIRNAME, 'SKILL.md') }

function installSkill(store, { force = false } = {}) {
  const src = path.join(PKG_ROOT, 'assets', 'SKILL.md')
  let bundled = ''
  try { bundled = fs.readFileSync(src, 'utf8') } catch { return { ok: false, reason: 'bundle-missing', target: skillTarget(store) } }
  const target = skillTarget(store)
  const hash = sha256(bundled)
  const state = store.readState()
  const known = new Set([hash, state.skillHash].filter(Boolean))

  let existed = false
  let current = null
  try { current = fs.readFileSync(target, 'utf8'); existed = true } catch { existed = false }

  if (existed && !force) {
    const curHash = sha256(current)
    if (curHash === hash) return { ok: true, action: 'unchanged', target, hash }
    if (!known.has(curHash)) return { ok: true, action: 'skipped-user-modified', target, hash, currentHash: curHash }
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bundled, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String(e?.message ?? e), target }
  }
  store.writeState({ skillHash: hash, skillTarget: target, skillInstalledAt: nowIso() })
  return { ok: true, action: existed ? 'upgraded' : 'installed', target, hash }
}

/* ── 规则注入（备份 + 幂等，绝不静默改写用户文件）──────────────────── */
function ruleInstalled(store) {
  try { return fs.readFileSync(store.agentsPath, 'utf8').includes('## 11. 理论前置') } catch { return false }
}

function installRule(store) {
  if (ruleInstalled(store)) return { ok: true, action: 'already-present', path: store.agentsPath }
  let existing = ''
  try { existing = fs.readFileSync(store.agentsPath, 'utf8') } catch { existing = '' }
  const backup = existing ? store.agentsPath + '.bak-' + nowIso().replace(/[:.]/g, '-') : null
  try {
    if (backup) fs.writeFileSync(backup, existing, 'utf8')
    fs.mkdirSync(path.dirname(store.agentsPath), { recursive: true })
    const body = (existing.endsWith('\n') || !existing ? existing : existing + '\n') + '\n' + RULE_MARKDOWN + '\n'
    fs.writeFileSync(store.agentsPath, body, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String(e?.message ?? e), path: store.agentsPath }
  }
  store.writeState({ ruleInjectedAt: nowIso(), rulePath: store.agentsPath, ruleBackup: backup })
  return { ok: true, action: 'appended', path: store.agentsPath, backup }
}

/* ── 工具定义 ─────────────────────────────────────────────────────── */
export function buildTools(store) {
  const tools = []
  const add = (name, description, properties, required, execute) => {
    tools.push(withOutput({
      name,
      description,
      parameters: { type: 'object', properties, required: required ?? [], additionalProperties: false },
      execute: async (args = {}) => {
        const result = await execute(args)
        store.log({ tool: name, args: { task: args.task, main: args.main }, result: result?.ok ?? null })
        return result
      },
    }))
  }

  add('meta_theory_brief',
    '开工前的理论树骨架：判定是否该跳过（纯闲聊／单步指令／已提示过的追问／只执行），不跳过则返回主理论判别问题、辅助理论三关、输出模板与 8 条自查。用于把「先点理论、再施工」落到本次任务。',
    { task: { type: 'string', description: '用户原话或任务摘要' }, domain: { type: 'string', description: '可选：你判断它属于哪个成熟领域' }, followUp: { type: 'boolean', description: '是否为同一问题、理论树已给过的追问' } },
    ['task'],
    async (args) => ({ ok: true, cmd: 'brief', ...buildBrief({ task: args.task, domain: args.domain, followUp: args.followUp === true }) }))

  add('meta_theory_check',
    '按「元理论检索」的规则校验一棵理论树：主理论数量与判据、辅助理论是否过缺口／动作／删除三关、组合链路是否成链、前提限制是否写明。返回逐条问题与得分，ok=false 表示必须改。辅助理论可传对象，也可传 "名|补足缺口|使用阶段|不用会漏什么"。',
    { main: { type: 'string', description: '主理论名' }, aux: { type: 'array', items: { type: 'string' }, description: '辅助理论，竖线串或对象' }, linkage: { type: 'string', description: '组合链路，如「先用 A 建框架，再用 B 补环节，最后用 C 检查」' }, limits: { type: 'string', description: '使用前提／限制' } },
    [],
    async (args) => {
      const r = checkTree({ main: args.main, aux: args.aux, linkage: args.linkage, limits: args.limits })
      return { ok: r.ok, cmd: 'check', score: r.score, issues: r.issues, normalized: r.normalized, checklist: CHECKLIST }
    })

  add('meta_theory_status', '查看插件、技能文件、AGENTS.md 规则三处的真实落位状态（含文件 hash 与版本），用于排查「装了但没生效」。',
    {},
    [],
    async () => {
      const target = skillTarget(store)
      let skill = { exists: false }
      try { const c = fs.readFileSync(target, 'utf8'); skill = { exists: true, bytes: Buffer.byteLength(c, 'utf8'), hash: sha256(c).slice(0, 16), nameLine: (/^name:\s*(.+)$/m.exec(c) || [])[1] ?? null } } catch { /* 未安装 */ }
      return { ok: true, cmd: 'status', plugin: { name: 'dsh-meta-theory', version: VERSION, rulesVersion: RULES_VERSION, skillName: SKILL_NAME }, skill, rule: { installed: ruleInstalled(store), path: store.agentsPath }, paths: { skillsDir: store.skillsDir, dataDir: store.dir, log: store.logPath } }
    })

  add('meta_theory_rule', '输出「理论前置」规则文本（AGENTS.md 第 11 节）。write=true 时写入 AGENTS.md：先备份原文件、已存在则不重复追加。',
    { write: { type: 'boolean', description: '是否写入 AGENTS.md' } },
    [],
    async (args) => {
      if (args.write !== true) return { ok: true, cmd: 'rule', written: false, markdown: RULE_MARKDOWN, path: store.agentsPath }
      const r = installRule(store)
      return { ok: r.ok, cmd: 'rule', written: r.ok, action: r.action ?? null, path: r.path, backup: r.backup ?? null, error: r.error ?? null, markdown: RULE_MARKDOWN }
    })

  return tools
}

/* ── 注册 ─────────────────────────────────────────────────────────── */
function registerTools(ctx, defs, state) {
  const toolsService = (typeof ctx.get === 'function' ? ctx.get('tools') : undefined) || ctx.tools
  if (!toolsService || typeof toolsService.register !== 'function') return 0
  if (state.done) return defs.length
  let count = 0
  for (const raw of defs) {
    const tool = withOutput(raw)
    const rawExec = tool.execute
    if (typeof rawExec === 'function') tool.execute = async (args = {}) => toLossless(await rawExec(args))
    if (!tool.output?.schema || typeof tool.output.render !== 'function') {
      try { ctx.logger?.warn?.(`[${NS}] 工具 ${tool.name} 缺少 output，跳过`) } catch {}
      continue
    }
    try { ctx.effect(() => toolsService.register(tool)); count += 1 } catch (e) {
      try { ctx.logger?.warn?.(`[${NS}] 工具 ${tool.name} 注册失败: ${String(e?.message ?? e)}`) } catch {}
    }
  }
  if (count > 0) state.done = true
  return count
}

function registerCommand(ctx, name, description, run) {
  try { if (ctx.commands?.register) { ctx.commands.register({ name, description, run }); return true } } catch {}
  try { if (ctx.commands?.add) { ctx.commands.add({ name, description, run }); return true } } catch {}
  return false
}

/** cordis 插件入口 */
export function apply(ctx, config = {}) {
  const store = new Store({ dataDir: config.dataDir, skillsDir: config.skillsDir, agentsPath: config.agentsPath })
  store.ensure()

  const defs = buildTools(store)
  const state = { done: false }

  let skillResult = { ok: false, reason: 'skipped-by-config' }
  if (config.autoInstallSkill !== false) {
    try { skillResult = installSkill(store) } catch (e) { skillResult = { ok: false, reason: 'exception', error: String(e?.message ?? e) } }
  }

  let registered = registerTools(ctx, defs, state)
  const retry = () => {
    if (state.done) return true
    const n = registerTools(ctx, defs, state)
    if (n) registered = n
    return state.done
  }
  try { ctx.on?.('internal/service', () => retry()) } catch {}
  let tries = 0
  const timer = setInterval(() => { tries += 1; if (retry() || tries >= 12) clearInterval(timer) }, 1500)
  try { if (typeof timer.unref === 'function') timer.unref() } catch {}

  registerCommand(ctx, 'meta', '元理论：查看插件／技能／规则三处落位状态', async () => {
    const r = await buildTools(store).find((t) => t.name === 'meta_theory_status').execute({})
    const lines = [
      `元理论检索 · dsh-meta-theory v${VERSION}`,
      `插件工具: ${registered}/${defs.length} 个已注册`,
      `技能文件: ${r.skill.exists ? '已装 (' + r.skill.bytes + ' B, ' + r.skill.nameLine + ')' : '未安装'}`,
      `规则注入: ${r.rule.installed ? '已在 AGENTS.md' : '未写入（运行 /meta-rule 落位）'}`,
      `技能目录: ${r.paths.skillsDir}`,
    ]
    return { ok: true, text: lines.join('\n') }
  })

  registerCommand(ctx, 'meta-skill', '元理论：重装技能文件（force，覆盖手改前会先备份）', async () => {
    const target = skillTarget(store)
    let backup = null
    try { const cur = fs.readFileSync(target, 'utf8'); backup = target + '.bak-' + nowIso().replace(/[:.]/g, '-'); fs.writeFileSync(backup, cur, 'utf8') } catch {}
    const r = installSkill(store, { force: true })
    return { ok: r.ok, text: `技能文件: ${r.action ?? r.reason}\n目标: ${r.target ?? target}${backup ? '\n备份: ' + backup : ''}` }
  })

  registerCommand(ctx, 'meta-rule', '元理论：把第 11 节规则写入 ~/.dsh/AGENTS.md（先备份、已存在则跳过）', async () => {
    const r = installRule(store)
    return { ok: r.ok, text: r.ok ? `规则: ${r.action}\n文件: ${r.path}${r.backup ? '\n备份: ' + r.backup : ''}` : `规则写入失败: ${r.error ?? r.reason}` }
  })

  try {
    ctx.logger?.info?.(`[${NS}] v${VERSION} 已加载：工具 ${registered}/${defs.length}，技能 ${skillResult.action ?? skillResult.reason ?? 'n/a'}，数据 ${store.dir}`)
  } catch {}

  return { store, registered, totalTools: defs.length, skill: skillResult }
}

export default { name: NS, apply }
