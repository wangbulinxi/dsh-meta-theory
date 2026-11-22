/**
 * 冒烟测试：清单一致性 + 用 mock ctx 真加载插件，确认工具/命令真的注册上了。
 * 运行：node test/smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
let pass = 0
const t = async (name, fn) => { await fn(); pass += 1; console.log('  ok  ' + name) }

console.log('清单一致性（事故 1 的回归守卫）')
await t('dsh.bundle.patch 已声明且文件存在', () => {
  const rel = pkg.dsh?.bundle?.patch
  assert.ok(rel, 'package.json 缺少 dsh.bundle.patch')
  const abs = path.resolve(PKG_ROOT, rel)
  assert.ok(fs.existsSync(abs), 'patch 文件不存在: ' + rel)
  const body = fs.readFileSync(abs, 'utf8')
  const meaningful = body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  assert.ok(meaningful[0].trim().startsWith('- '), 'patch 必须是顶层 YAML 数组')
  assert.ok(body.includes(pkg.name), 'patch 里 insert 的 name 应等于包名')
})
await t('未声明 dsh.client 时不该有 exports["./client"] 依赖', () => {
  if (pkg.dsh?.client) {
    assert.ok(pkg.exports?.['./client'], 'dsh.client 已声明但 exports 缺 "./client"')
  } else {
    assert.equal(pkg.exports?.['./client'], undefined)
  }
})
await t('files 白名单含关键件', () => {
  for (const f of ['lib', 'assets', 'cordis.patch.yml', 'README.md', 'LICENSE']) assert.ok(pkg.files.includes(f), 'files 缺 ' + f)
})

console.log('真实加载（mock ctx）')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-meta-theory-'))
const skillsDir = path.join(tmpRoot, 'skills')
const dataDir = path.join(tmpRoot, 'data')
const agentsPath = path.join(tmpRoot, 'AGENTS.md')

const registeredTools = []
const registeredCommands = []
const ctx = {
  get: (key) => (key === 'tools' ? { register: (tool) => { registeredTools.push(tool); return () => {} } } : undefined),
  effect: (fn) => fn(),
  on: () => {},
  logger: { info: () => {}, warn: () => {} },
  commands: { register: (c) => { registeredCommands.push(c) } },
}

const mod = await import('../lib/index.js')
const result = mod.apply(ctx, { skillsDir, dataDir, agentsPath })

await t('apply 返回注册计数', () => {
  assert.equal(result.totalTools, 4)
  assert.equal(result.registered, 4)
})
await t('四个工具都带 output 契约', () => {
  const names = registeredTools.map((x) => x.name).sort()
  assert.deepEqual(names, ['meta_theory_brief', 'meta_theory_check', 'meta_theory_rule', 'meta_theory_status'])
  for (const tool of registeredTools) {
    assert.ok(tool.output?.schema, tool.name + ' 缺 output.schema')
    assert.equal(typeof tool.output.render, 'function', tool.name + ' 缺 output.render')
    assert.equal(typeof tool.execute, 'function')
  }
})
await t('命令已注册', () => {
  const names = registeredCommands.map((c) => c.name).sort()
  assert.deepEqual(names, ['meta', 'meta-rule', 'meta-skill'])
})
await t('技能被投放到指定目录，且 name 与本插件一致', () => {
  const target = path.join(skillsDir, '元理论检索', 'SKILL.md')
  assert.ok(fs.existsSync(target), '技能文件未投放')
  const body = fs.readFileSync(target, 'utf8')
  assert.ok(body.includes('name: meta-theory-routing'))
  assert.ok(body.includes('## 与已装技能的分工'))
})
await t('二次 apply 不覆盖已存在的技能文件', () => {
  const target = path.join(skillsDir, '元理论检索', 'SKILL.md')
  fs.writeFileSync(target, body2(), 'utf8')
  const again = mod.apply(ctx, { skillsDir, dataDir, agentsPath })
  assert.equal(again.skill.action, 'skipped-user-modified')
  assert.equal(fs.readFileSync(target, 'utf8'), body2())
})
function body2() {
  return fs.readFileSync(path.join(PKG_ROOT, 'assets', 'SKILL.md'), 'utf8').replace('元理论检索', '元理论检索（手改）')
}
await t('meta_theory_check 返回可判定的结论', async () => {
  const tool = registeredTools.find((x) => x.name === 'meta_theory_check')
  const r = await tool.execute({ main: 'A', aux: ['B|g|w|l'], linkage: '先用A，再用B', limits: 'x' })
  assert.equal(typeof r.ok, 'boolean')
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.issues))
})
await t('meta_theory_brief 对闲聊给出跳过', async () => {
  const tool = registeredTools.find((x) => x.name === 'meta_theory_brief')
  const r = await tool.execute({ task: '你好' })
  assert.equal(r.skip, true)
})
await t('meta_theory_rule write 会备份并追加，二次调用幂等', async () => {
  const tool = registeredTools.find((x) => x.name === 'meta_theory_rule')
  const r1 = await tool.execute({ write: true })
  assert.equal(r1.written, true)
  assert.equal(r1.action, 'appended')
  assert.ok(r1.backup === null || fs.existsSync(r1.backup))
  const r2 = await tool.execute({ write: true })
  assert.equal(r2.action, 'already-present')
  const text = fs.readFileSync(agentsPath, 'utf8')
  assert.equal(text.split('## 11. 理论前置').length - 1, 1, '规则不应重复追加')
})

console.log('\n冒烟测试全部通过：' + pass + ' 项')
fs.rmSync(tmpRoot, { recursive: true, force: true })
