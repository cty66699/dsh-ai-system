#!/usr/bin/env node
/**
 * Git 历史卫生（_check_git_history.cjs）—— 第 52 轮加
 * ============================================================================
 * ★ 它回答的问题：**这个仓库的**历史内容**里，有没有不该推出去的东西？**
 *
 * 为什么需要它（一个容易被跳过的区别）：
 *   「**当前文件干净**」与「**历史里干净**」是两件事 ——
 *   而 **推上去之后，历史是会跟着走的**：一个提交过的密钥，**删掉文件也仍然在历史里**。
 *   ⇒ 所以「我要推送」这件事，必须在**推之前**用历史的全量内容核一遍，而不是看当前工作区。
 *
 * ★ 它的做法（**只扫内容，不猜文件名**）：
 *   1. `git rev-list --objects --all` 列出**所有**对象；
 *   2. 用 `git cat-file -t` **逐个取类型**，**只保留 blob** ——
 *      这一步是**必须的**：`cat-file -p <tree>` 的输出长这样 `100644 blob <40位SHA>\t文件名`，
 *      如果不过滤，**每一个 tree 都会贡献一堆 40 位 hex**，
 *      于是「扫密钥」就变成了「扫 git 自己的哈希」
 *      （**实测：不过滤时 41 处误报，全是 tree 里的 blob SHA**）。
 *   3. 对每个**文本** blob（含 NUL 的当二进制跳过）跑一遍模式表；
 *   4. 打印命中的**文件 + 模式 + 片段**（片段截断）。
 *
 * ⚠️ 诚实边界（**它防什么、不防什么**）：
 *   · **只扫当前存在的对象**。若曾提交过又被 `rebase` / `filter-branch` 抹掉，它看不到 ——
 *     那种情况要查 `git reflog` 与「远端是否曾收到过推送」，**本脚本不做那件事**。
 *   · 模式表是**启发式**：**报出来的要人工判**（可能是误报，例如文档里举的假例子）；
 *     **没报的不等于绝对没有**（例如一段没有 `key=` 形式的裸密钥）。
 *   · 它**不判"这个仓库该不该公开"** —— 那是人的决定。
 *
 * 用法: node _check_git_history.cjs [--repo <路径>]
 * 退出码: 0 = 0 命中 / 1 = 有命中（**推送前必须逐条判读**） / 2 = 结构性错误 / 3 = 未配置 ⇒ 跳过
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HERE = __dirname
const argv = process.argv.slice(2)
const iRepo = argv.indexOf('--repo')
// 默认：本脚本所在目录（开发形态下就是 `核查/`，而 `public/` 是它的子目录；发布形态下就是仓库根）
const CANDIDATES = iRepo >= 0 ? [argv[iRepo + 1]]
  : [path.join(HERE, 'public'), HERE]
let REPO = null
for (const c of CANDIDATES) {
  if (!c || !fs.existsSync(c)) continue
  try {
    execFileSync('git', ['-C', c, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
    REPO = c
    break
  } catch { /* 试下一个 */ }
}
if (!REPO) {
  console.log('⏭️  找不到 git 仓库（试过 ' + CANDIDATES.join(' / ') + '）⇒ 本项**跳过**')
  console.log('   （**跳过 ≠ 通过** —— 这一项没查成。）')
  process.exit(3)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'githist-'))
const run = (args, outFile) => {
  const fd = fs.openSync(outFile, 'w')
  try { execFileSync('git', ['-C', REPO, ...args], { stdio: ['ignore', fd, fd] }) } catch { /* 非零正常 */ }
  fs.closeSync(fd)
  return fs.readFileSync(outFile, 'utf8')
}

const all = run(['rev-list', '--objects', '--all'], path.join(TMP, 'a.txt')).split('\n').filter(Boolean)
if (all.length === 0) {
  console.error('❌ 结构性错误：git 历史里 0 个对象 —— **集合为空时不能判「干净」**。')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(2)
}

const typeFile = path.join(TMP, 't.txt')
const blobs = []
for (const line of all) {
  const sp = line.indexOf(' ')
  if (sp < 0) continue
  const sha = line.slice(0, sp)
  let t = ''
  try { t = run(['cat-file', '-t', sha], typeFile).trim() } catch { continue }
  if (t === 'blob') blobs.push([sha, line.slice(sp + 1)])
}
if (blobs.length === 0) {
  console.error('❌ 结构性错误：52 个对象里一个 blob 都没有 —— 这不像一个正常仓库，先查扫描方式。')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(2)
}

// ── 模式表。★ 加一条之前先问：「它会误报多少？」（误报多了，这条检查就会被无视）──────────
const PATTERNS = [
  ['OpenAI 风格 key', /sk-[A-Za-z0-9_-]{16,}/],
  ['Anthropic 风格 key', /sk-ant-[A-Za-z0-9_-]{16,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{16,}/],
  ['Authorization 头', /Bearer\s+[A-Za-z0-9_.-]{20,}/],
  ['key 赋值', /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}/i],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['邮箱', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['含用户名的绝对路径', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._-]+/],
  ['内网 IP', /\b(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/],
]
// ★ 刻意**不放进**上表的（它们会大量误报，加了这条检查就没人看）：
//   · 40 位 hex —— 那是 **git 自己的 blob SHA**（尤其不过滤 tree 时）；
//   · 长 base64 / 长十六进制 —— 压缩数据与图片里到处都是。

const hits = []
let scanned = 0
const oneBin = path.join(TMP, 'one.bin')
for (const [sha, name] of blobs) {
  const fd = fs.openSync(oneBin, 'w')
  try { execFileSync('git', ['-C', REPO, 'cat-file', '-p', sha], { stdio: ['ignore', fd, 'ignore'] }) } catch { fs.closeSync(fd); continue }
  fs.closeSync(fd)
  const buf = fs.readFileSync(oneBin)
  if (buf.includes(0)) continue                 // 二进制跳过（在二进制里找文本模式只会误报）
  scanned++
  const t = buf.toString('utf8')
  for (const [label, re] of PATTERNS) {
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g'))) {
      hits.push([name, label, m[0].slice(0, 70)])
    }
  }
}
fs.rmSync(TMP, { recursive: true, force: true })

console.log('▶ Git 历史卫生（**扫历史内容，不靠文件名猜**）')
console.log('  仓库：' + REPO)
console.log('  git 对象 ' + all.length + ' 个 ⇒ 其中 **blob ' + blobs.length + ' 个**'
  + '（tree/commit 已排除 —— 不排除的话每个 tree 都会贡献一堆 40 位 hex，全是误报）')
console.log('  其中文本 blob ' + scanned + ' 个（含 NUL 的当二进制跳过）')
console.log('')

if (!hits.length) {
  console.log('✅ 历史内容 0 命中（' + PATTERNS.length + ' 类模式）')
  console.log('   （检查强度说明：模式表是**启发式** —— **没报 ≠ 绝对没有**；报了的也要人工判读。）')
  process.exit(0)
}

const byLabel = {}
for (const [n, l, v] of hits) (byLabel[l] = byLabel[l] || []).push([n, v])
console.log('⚠️ **历史内容里有 ' + hits.length + ' 处命中，分 ' + Object.keys(byLabel).length + ' 类：**')
for (const [l, arr] of Object.entries(byLabel)) {
  console.log('')
  console.log('   ── ' + l + '（' + arr.length + ' 处）')
  const seen = new Set()
  for (const [n, v] of arr) {
    const key = n + '|' + v
    if (seen.has(key)) continue
    seen.add(key)
    if (seen.size > 6) { console.log('        …另有 ' + (arr.length - 6) + ' 处'); break }
    console.log('        ' + n + '  ⇒  ' + v)
  }
}
console.log('')
console.log('   ⇒ **推送前必须逐条判读**（可能是误报，例如文档里举的假例子）。')
console.log('   ⇒ 如果是真的：**删掉文件不够** —— 历史里仍然有，要用 `git filter-repo` 之类重写历史，')
console.log('      而**重写之后必须重新核一遍**（本脚本就是那个「核」）。')
process.exit(1)
