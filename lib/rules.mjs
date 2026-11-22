/**
 * dsh-meta-theory — 纯逻辑层（无 IO，测试可直接调用）
 *
 * 把「元理论检索」技能里**可判定**的部分形式化，而不是把整篇提示词塞进插件：
 *   1) detectSkip : 豁免场景判定（只有四类）
 *   2) buildBrief : 开工前的理论树骨架与判别问题
 *   3) checkTree  : 按技能的 8 条翻车模式逐项校验，给出可修的问题列表
 *
 * 判定归判定，写作归模型：本模块不生成任何"看起来像理论"的内容。
 */

export const SKILL_NAME = 'meta-theory-routing'
export const SKILL_DIRNAME = '元理论检索'
export const RULES_VERSION = 1

/** 豁免场景（与技能正文一致，只有这四类；追问型由调用方传 followUp 判定） */
const SKIP_RULES = [
  { code: 'chitchat', reason: '纯闲聊或情绪表达', test: (t) => /^(你好|在吗|哈+|谢谢|晚安|早上好|晚上好|收到|好的|嗯+|在不在)[!！。.~\s]*$/.test(t) },
  { code: 'single-step', reason: '单步机械指令（翻译／改错别字／总结／格式转换）', test: (t) => /(翻译(一下|成|这|那|下|它|这个|这段)|改错别字|纠正错别字|总结(一下|这篇|这段|全文)|润色这句话|格式转换|转成(表格|json|markdown)|提取文字|列一下文件)/i.test(t) },
  { code: 'execute-only', reason: '用户明确要求只执行', test: (t) => /(只执行|不要理论|别讲理论|直接给结果|跳过理论|不用提示)/.test(t) },
]

/**
 * 判定是否应跳过理论前置。
 * @param {string} task 用户原话
 * @param {{followUp?: boolean}} [opts] followUp=true 表示同一问题已提示过理论树的追问
 * @returns {{skip: boolean, code?: string, reason?: string}}
 */
export function detectSkip(task, opts = {}) {
  const t = String(task ?? '').trim()
  if (opts.followUp) return { skip: true, code: 'follow-up', reason: '同一问题的追问，理论树已给过' }
  if (!t) return { skip: true, code: 'empty', reason: '没有可判定的任务描述' }
  for (const r of SKIP_RULES) if (r.test(t)) return { skip: true, code: r.code, reason: r.reason }
  return { skip: false }
}

/** 三条主理论判别问题（技能第 3 步） */
export const DISCRIMINANTS = [
  '谁最直接描述当前任务的核心对象或生成机制？',
  '谁离开对方仍能独立给出基本答案，谁必须先依赖另一个模型才能工作？',
  '谁决定答案或作品的整体结构，谁只帮助输入、计算、更新或验证？',
]

/** 辅助理论三道关（技能第 4 步） */
export const AUX_TESTS = [
  '缺口测试：它补足哪个尚未覆盖的必要环节？',
  '动作测试：它具体改变哪个执行步骤、参数或质量标准？',
  '删除测试：删掉它会出现什么明确问题？',
]

/** 输出模板（技能「输出格式要求」） */
export const OUTPUT_TEMPLATE = [
  '主理论（树干）：XX——它决定本次任务的核心框架',
  '辅助理论（枝叶）：',
  '- XX——补足……环节，在……阶段使用',
  '组合方式：先用……，再用……，最后用……',
  '使用前提／限制：……',
  '补充后的问题表述：……（保留用户原目标）',
].join('\n')

/** 8 条翻车自查（技能「常见翻车模式」） */
export const CHECKLIST = [
  '用户没提理论名，就只按字面接活，不检查更优方法',
  '把理论提醒拖到结果之后，用户在开工前看不到更优路线',
  '只有主理论，明明存在必要缺口却不补辅助理论',
  '为了显得完整而堆砌辅助理论，或把不同层的方法当成同层竞争',
  '按知名度或最先想到的顺序指定主理论，不说明主次依据',
  '理论之间没有组合链路，或正文中并未实际应用',
  '没有适用理论仍硬凑，或因理论介绍拖延交付',
  '把补充问题变成「你问错了」，擅自替换用户目标',
]

/**
 * 开工前的简报骨架。
 * @param {{task: string, domain?: string, followUp?: boolean}} input
 */
export function buildBrief({ task, domain, followUp } = {}) {
  const skip = detectSkip(task, { followUp })
  const t = String(task ?? '').trim()
  const d = String(domain ?? '').trim()
  return {
    task: t,
    domain: d || null,
    skip: skip.skip,
    skipReason: skip.reason ?? null,
    brief: skip.skip
      ? null
      : {
        domain: d || null,
        domainHint: d || '（未给出领域：先按任务判断它属于哪个成熟学科，再选理论）',
        mainRule: '默认 1 条；2 条必须说明二者是先后配合还是共同作用；不得按知名度挑',
        auxRule: '每条辅助理论都要过缺口／动作／删除三关；覆盖完整时辅助理论可以为 0 条',
        discriminants: DISCRIMINANTS,
        auxTests: AUX_TESTS,
        outputTemplate: OUTPUT_TEMPLATE,
        checklist: CHECKLIST,
        deliverRule: '提醒区块之后必须立刻交付用户原任务；不能只讲理论',
      },
  }
}

const ORDER_WORDS = ['先', '再', '然后', '最后', '之前', '之后', '阶段', '→', '->', 'before', 'then', 'after']
const LEVEL_WORDS = ['输入', '数据', '模型', '框架', '执行', '计算', '评估', '验证', '检验', '更新']

/** 辅助理论既接受对象，也接受 "名|缺口|阶段|删除后果" 的竖线串 */
function normalizeAux(item, index) {
  if (item && typeof item === 'object') {
    return {
      index,
      name: String(item.name ?? '').trim(),
      gap: String(item.gap ?? '').trim(),
      when: String(item.when ?? '').trim(),
      loss: String(item.loss ?? '').trim(),
    }
  }
  const parts = String(item ?? '').split('|').map((s) => s.trim())
  return { index, name: parts[0] ?? '', gap: parts[1] ?? '', when: parts[2] ?? '', loss: parts[3] ?? '' }
}

/**
 * 按技能规则校验一棵理论树。
 * @param {{main?: any, aux?: any[], linkage?: string, limits?: string, task?: string}} input
 * @returns {{ok: boolean, score: number, issues: Array<object>, normalized: object}}
 */
export function checkTree(input = {}) {
  const issues = []
  const add = (level, code, message, extra = {}) => issues.push({ level, code, message, ...extra })

  const mainName = typeof input.main === 'string' ? input.main.trim() : String(input.main?.name ?? '').trim()
  const rawAux = Array.isArray(input.aux) ? input.aux : input.aux ? [input.aux] : []
  const aux = rawAux.map(normalizeAux).filter((a) => a.name || a.gap || a.when || a.loss)
  const linkage = String(input.linkage ?? '').trim()
  const limits = String(input.limits ?? '').trim()

  if (!mainName) add('error', 'E_MAIN_MISSING', '缺主理论：先回答三条判别问题，定一条决定核心结构的理论')
  if (mainName && aux.some((a) => a.name === mainName)) add('warning', 'W_AUX_SAME_AS_MAIN', '辅助理论与主理论同名，属于同层重复', { name: mainName })
  if (aux.length > 2) add('warning', 'W_AUX_OVER_BUDGET', `辅助理论 ${aux.length} 条，前台默认只展示最影响路线的 1～2 条；其余留到「理论地图」`)

  const seen = new Map()
  for (const a of aux) {
    if (!a.name) add('error', 'E_AUX_NAME_MISSING', `第 ${a.index + 1} 条辅助理论缺名称`, { index: a.index })
    if (!a.gap) add('error', 'E_AUX_MISSING_GAP', `${a.name || '第' + (a.index + 1) + '条'}：缺「补足哪个缺口」，过不了缺口测试`, { index: a.index })
    if (!a.when) add('error', 'E_AUX_MISSING_WHEN', `${a.name || '第' + (a.index + 1) + '条'}：缺「在主理论之前／中／之后使用」，无法排链路`, { index: a.index })
    if (!a.loss) add('error', 'E_AUX_MISSING_LOSS', `${a.name || '第' + (a.index + 1) + '条'}：缺「不用它会漏什么」，过不了删除测试`, { index: a.index })
    if (a.name && seen.has(a.name)) add('warning', 'W_AUX_DUPLICATE', `辅助理论「${a.name}」重复出现`, { index: a.index })
    if (a.name) seen.set(a.name, true)
  }

  if (aux.length >= 2 && !linkage) add('error', 'E_LINKAGE_MISSING', '两条以上理论必须给组合链路，否则只是名词清单')
  else if (linkage && !ORDER_WORDS.some((w) => linkage.includes(w))) add('warning', 'W_LINKAGE_NO_ORDER', '组合链路里没有顺序词（先／再／最后／阶段），读者看不出先后')

  if (linkage && LEVEL_WORDS.some((w) => linkage.includes(w)) === false && aux.length) {
    add('info', 'I_LINKAGE_NO_LAYER', '链路里没出现输入／模型／执行／验证之类的层名，建议写清每条理论落在哪一层')
  }

  if (!limits) add('warning', 'W_LIMITS_MISSING', '缺使用前提／限制：说明这条路线在什么情况下不成立')

  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.filter((i) => i.level === 'warning').length
  const score = Math.max(0, 100 - errors * 20 - warnings * 5)

  return {
    ok: errors === 0,
    score,
    issues,
    normalized: { main: mainName || null, aux, linkage: linkage || null, limits: limits || null },
  }
}

/** 规则文本（写进 AGENTS.md 的那一节，供 meta_theory_rule 输出） */
export const RULE_MARKDOWN = `## 11. 理论前置（默认开启）

非机械任务（求助、评估、创作、决策、规划、方案、诊断）正式执行前，先 \`skill\` 加载 \`meta-theory-routing\`，按其流程走：定位领域 → 定 1 条主理论 → 用 0～2 条辅助理论补缺口 → 开头用简短区块给出理论树 → 立即把理论用回原任务并交付。

- **默认不做例外**：用户没点名理论，不等于不需要。只满足字面指令、不主动给出更专业的方法，正是这条规则要修的失败模式。
- **跳过条件只有四条**：纯闲聊或情绪表达；单步机械指令（翻译、改错别字、总结、格式转换）；同一问题已提示过理论树的追问；用户明确说「只执行」「不要理论提示」。
- **不硬凑**：没有可靠且能实质改善任务的理论时直接执行，不编造理论名，不为凑数堆砌辅助理论。
- **自查**：发现自己在没给前置提示的情况下直接开工，停下补一句再继续。长对话中段该规则的权重会衰减（见第 8 节），这不是忽略它的理由。`
