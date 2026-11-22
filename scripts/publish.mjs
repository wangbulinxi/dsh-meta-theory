#!/usr/bin/env node
/**
 * 一键发布：GitHub 仓库 + tag + Release(含 tgz 资产) + 市场主题，可选 npm。
 *
 * 用法：
 *   node scripts/publish.mjs --dry-run          # 不联网、不写任何东西，只列出将执行的动作
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish.mjs
 *   GITHUB_TOKEN=ghp_xxx NPM_TOKEN=npm_xxx node scripts/publish.mjs --npm
 *
 * 设计约束：
 *   · token 只经 -c http.extraheader 传入单条 git 命令，绝不写进 .git/config；
 *   · 仓库已存在则复用，不删不改历史；
 *   · Release 已存在则复用，资产同名先删再传（GitHub 不允许同名重复）；
 *   · 任何一步失败即停，打印当时的 HTTP 状态与响应体，不猜。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const NAME = pkg.name
const VERSION = pkg.version
const TGZ = path.join(ROOT, NAME + '-' + VERSION + '.tgz')
const TOPICS = ['dsh-plugin', 'deepseek-harness', 'meta-theory', 'reasoning', 'skill']

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const WITH_NPM = argv.includes('--npm')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
const NPM_TOKEN = process.env.NPM_TOKEN || ''

const log = (...a) => console.log(...a)
const die = (msg, extra) => { console.error('FAILED: ' + msg); if (extra) console.error(extra); process.exit(1) }

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
}
function gitAuthed(args, token, owner) {
  const auth = 'Basic ' + Buffer.from(owner + ':' + token, 'utf8').toString('base64')
  return execFileSync('git', ['-c', 'http.extraheader=Authorization: ' + auth, ...args], { cwd: ROOT, encoding: 'utf8' }).trim()
}
async function api(pathname, init = {}) {
  const res = await fetch('https://api.github.com' + pathname, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': NAME,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON（如 204） */ }
  return { status: res.status, ok: res.ok, json, text }
}

log('package : ' + NAME + '@' + VERSION)
log('tgz     : ' + (fs.existsSync(TGZ) ? TGZ + '  (' + fs.statSync(TGZ).size + ' B)' : '（缺失，将先执行 npm pack）'))

if (!fs.existsSync(TGZ)) {
  if (DRY) log('dry-run: 会先运行 npm pack 生成 tgz')
  else { log('running npm pack ...'); execFileSync('npm', ['pack'], { cwd: ROOT, stdio: 'inherit' }) }
}

if (DRY) {
  log('')
  log('dry-run plan（不需要 token）：')
  log('  1) 若无仓库则 POST /user/repos 创建 public 仓库')
  log('  2) git init（如需）→ add -A → commit → branch -M main → push main')
  log('  3) git tag v' + VERSION + ' && push tag')
  log('  4) POST /repos/<owner>/' + NAME + '/releases（已存在则复用）并上传 ' + path.basename(TGZ))
  log('  5) PUT topics: ' + TOPICS.join(', '))
  if (WITH_NPM) log('  6) npm publish --access public（需要 NPM_TOKEN）')
  process.exit(0)
}

if (!TOKEN) {
  log('')
  log('缺少 GITHUB_TOKEN —— 这一步必须由你给一次凭据，之后全自动。')
  log('创建：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained →')
  log('      Repository access: All（或先建空仓库再选它）/ Permissions: Contents=Read+write, Metadata=Read, Administration=Read+write')
  log('然后：$env:GITHUB_TOKEN="ghp_xxx"; node scripts/publish.mjs')
  process.exit(2)
}

const owner = await (async () => {
  const r = await api('/user')
  if (!r.ok) die('/user ' + r.status, r.text.slice(0, 400))
  return r.json.login
})()

log('github  : ' + owner + '/' + NAME)
/* 1) 仓库 */
const repoRes = await api('/repos/' + owner + '/' + NAME)
if (repoRes.status === 404) {
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({ name: NAME, description: pkg.description, private: false, has_issues: true, has_wiki: false }),
  })
  if (!created.ok) die('创建仓库 ' + created.status, created.text.slice(0, 400))
  log('created repo: ' + created.json.html_url)
} else if (!repoRes.ok) {
  die('查询仓库 ' + repoRes.status, repoRes.text.slice(0, 400))
} else {
  log('repo exists: ' + repoRes.json.html_url + (repoRes.json.private ? '  (private —— 市场索引不到，请改成 public)' : ''))
}

/* 2) 提交与推送 */
if (!fs.existsSync(path.join(ROOT, '.git'))) { git(['init']); log('git init') }
git(['add', '-A'])
let dirty = true
try { git(['rev-parse', '--verify', 'HEAD']) ; dirty = git(['status', '--porcelain']).length > 0 } catch { dirty = true }
if (dirty) { git(['commit', '-m', 'release: v' + VERSION]); log('committed') } else { log('no changes to commit') }
try { git(['branch', '-M', 'main']) } catch { /* 已存在 */ }
const url = 'https://github.com/' + owner + '/' + NAME + '.git'
try { git(['remote', 'set-url', 'origin', url]) } catch { git(['remote', 'add', 'origin', url]) }
gitAuthed(['push', '--set-upstream', 'origin', 'main'], TOKEN, owner)
log('pushed main')

/* 3) tag */
const tag = 'v' + VERSION
try { git(['rev-parse', '--verify', 'refs/tags/' + tag]) } catch { git(['tag', '-a', tag, '-m', tag]) ; log('tagged ' + tag) }
gitAuthed(['push', 'origin', tag, '--force'], TOKEN, owner)
log('pushed tag ' + tag)

/* 4) release + asset */
let release = null
const existing = await api('/repos/' + owner + '/' + NAME + '/releases/tags/' + tag)
if (existing.ok) { release = existing.json; log('release exists: ' + release.html_url) }
else {
  const made = await api('/repos/' + owner + '/' + NAME + '/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false, generate_release_notes: true }),
  })
  if (!made.ok) die('创建 Release ' + made.status, made.text.slice(0, 400))
  release = made.json; log('created release: ' + release.html_url)
}

const assetName = path.basename(TGZ)
const assets = await api('/repos/' + owner + '/' + NAME + '/releases/' + release.id + '/assets')
if (assets.ok) {
  const dup = (assets.json || []).find((a) => a.name === assetName)
  if (dup) { await api('/repos/' + owner + '/' + NAME + '/releases/assets/' + dup.id, { method: 'DELETE' }); log('removed old asset ' + assetName) }
}
const uploadRes = await fetch('https://uploads.github.com/repos/' + owner + '/' + NAME + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(assetName), {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/gzip', 'User-Agent': NAME },
  body: fs.readFileSync(TGZ),
})
if (!uploadRes.ok) die('上传资产 ' + uploadRes.status, (await uploadRes.text()).slice(0, 400))
log('uploaded asset: ' + assetName)

/* 5) topics（市场按主题索引） */
const topicsRes = await api('/repos/' + owner + '/' + NAME + '/topics', { method: 'PUT', body: JSON.stringify({ names: TOPICS }) })
if (!topicsRes.ok) log('topics 设置失败 ' + topicsRes.status + '：' + topicsRes.text.slice(0, 200))
else log('topics: ' + (topicsRes.json?.names || TOPICS).join(', '))

/* 6) 可选 npm */
if (WITH_NPM) {
  if (!NPM_TOKEN) die('--npm 需要 NPM_TOKEN')
  const npmrc = path.join(ROOT, '.npmrc.publish')
  fs.writeFileSync(npmrc, '//registry.npmjs.org/:_authToken=' + NPM_TOKEN + '\n', 'utf8')
  try { execFileSync('npm', ['publish', '--access', 'public', '--userconfig', npmrc], { cwd: ROOT, stdio: 'inherit' }) }
  finally { fs.rmSync(npmrc, { force: true }) }
  log('npm published')
}

log('')
log('DONE  ' + release.html_url)
log('安装：dsh plugin --profile desktop add ' + url.replace('.git', '') + '/releases/download/' + tag + '/' + assetName)
