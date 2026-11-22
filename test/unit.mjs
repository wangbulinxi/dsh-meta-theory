/**
 * 单元测试：只测纯逻辑层（lib/rules.mjs），无 IO。
 * 运行：node test/unit.mjs
 */
import assert from 'node:assert/strict'
import { detectSkip, buildBrief, checkTree, DISCRIMINANTS, AUX_TESTS, CHECKLIST, OUTPUT_TEMPLATE } from '../lib/rules.mjs'

let pass = 0
const t = (name, fn) => { fn(); pass += 1; console.log('  ok  ' + name) }

console.log('detectSkip')
t('闲聊跳过', () => {
  for (const s of ['你好', '在吗', '哈哈哈', '谢谢！', '晚安']) assert.equal(detectSkip(s).skip, true, s)
})
t('单步机械指令跳过', () => {
  for (const s of ['帮我翻译这段', '改错别字', '总结一下这篇', '格式转换一下', '转成表格']) assert.equal(detectSkip(s).skip, true, s)
})
t('只执行跳过', () => {
  assert.equal(detectSkip('这次只执行，直接给结果').skip, true)
  assert.equal(detectSkip('不要理论提示').skip, true)
})
t('追问跳过', () => { assert.equal(detectSkip('再算一下主胜赔率', { followUp: true }).skip, true) })
t('正常需求不跳过', () => {
  for (const s of ['帮我评估这个插件该不该装', '设计一套内容分发方案', '分析这周竞彩的胜率分布', '这个功能怎么做']) assert.equal(detectSkip(s).skip, false, s)
})
t('空输入跳过', () => { assert.equal(detectSkip('').skip, true) })

console.log('buildBrief')
t('跳过时不给骨架', () => { const b = buildBrief({ task: '你好' }); assert.equal(b.skip, true); assert.equal(b.brief, null) })
t('正常时给完整骨架', () => {
  const b = buildBrief({ task: '帮我设计一套用户增长方案', domain: '增长' })
  assert.equal(b.skip, false)
  assert.equal(b.brief.discriminants.length, 3)
  assert.equal(b.brief.checklist.length, 8)
  assert.ok(b.brief.outputTemplate.includes('主理论'))
  assert.equal(b.brief.domain, '增长')
})
t('常量与技能一致', () => {
  assert.equal(DISCRIMINANTS.length, 3)
  assert.equal(AUX_TESTS.length, 3)
  assert.equal(CHECKLIST.length, 8)
  assert.ok(OUTPUT_TEMPLATE.includes('组合方式'))
})

console.log('checkTree')
t('缺主理论报错', () => {
  const r = checkTree({})
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.code === 'E_MAIN_MISSING'))
})
t('只有主理论、无辅助也能通过', () => {
  const r = checkTree({ main: '金字塔原理', limits: '仅适用于结构化表达类任务' })
  assert.equal(r.ok, true)
  assert.equal(r.issues.filter((i) => i.level === 'error').length, 0)
})
t('竖线串齐全不报错', () => {
  const r = checkTree({
    main: '泊松分布',
    aux: ['蒙特卡洛|需要大量抽样时求解|主模型之后|无法直接积分时拿不到分布'],
    linkage: '先由数据定参数，再用泊松生成比分概率，最后用敏感性分析检查稳健性',
    limits: '进球相互独立且联赛均值稳定',
  })
  assert.equal(r.ok, true)
  assert.equal(r.issues.filter((i) => i.level === 'error').length, 0)
})
t('辅助理论缺三关各报一条', () => {
  const r = checkTree({ main: 'A', aux: ['B'] })
  const codes = r.issues.map((i) => i.code)
  assert.ok(codes.includes('E_AUX_MISSING_GAP'))
  assert.ok(codes.includes('E_AUX_MISSING_WHEN'))
  assert.ok(codes.includes('E_AUX_MISSING_LOSS'))
  assert.equal(r.ok, false)
})
t('对象形式与竖线串等价', () => {
  const a = checkTree({ main: 'A', aux: [{ name: 'B', gap: 'g', when: 'w', loss: 'l' }] })
  const b = checkTree({ main: 'A', aux: ['B|g|w|l'] })
  assert.deepEqual(a.issues.map((i) => i.code), b.issues.map((i) => i.code))
})
t('超过两条辅助给预算警告', () => {
  const r = checkTree({ main: 'A', aux: ['B|g1|w1|l1', 'C|g2|w2|l2', 'D|g3|w3|l3'], linkage: '先用B，再用C，最后用D', limits: 'x' })
  assert.ok(r.issues.some((i) => i.code === 'W_AUX_OVER_BUDGET'))
  assert.equal(r.ok, true, '预算警告不应把结论打成不通过')
})
t('辅助与主同名判为同层重复', () => {
  const r = checkTree({ main: 'A', aux: ['A|g|w|l'] })
  assert.ok(r.issues.some((i) => i.code === 'W_AUX_SAME_AS_MAIN'))
})
t('链路缺顺序词给警告', () => {
  const r = checkTree({ main: 'A', aux: ['B|g|w|l'], linkage: 'B 和 A 一起用', limits: 'x' })
  assert.ok(r.issues.some((i) => i.code === 'W_LINKAGE_NO_ORDER'))
})
t('两条以上理论无链路直接报错', () => {
  const r = checkTree({ main: 'A', aux: ['B|g1|w1|l1', 'C|g2|w2|l2'] })
  assert.ok(r.issues.some((i) => i.code === 'E_LINKAGE_MISSING'))
  assert.equal(r.ok, false)
})
t('缺限制只给警告', () => {
  const r = checkTree({ main: 'A' })
  assert.ok(r.issues.some((i) => i.code === 'W_LIMITS_MISSING'))
  assert.equal(r.ok, true)
})
t('得分随错误递减且有下界', () => {
  const good = checkTree({ main: 'A', limits: 'x' }).score
  const bad = checkTree({}).score
  assert.ok(good > bad)
  assert.ok(checkTree({}).score >= 0)
})
t('空串与 null 安全', () => {
  assert.doesNotThrow(() => checkTree({ main: null, aux: null, linkage: null, limits: null }))
})

console.log('\n单元测试全部通过：' + pass + ' 项')
