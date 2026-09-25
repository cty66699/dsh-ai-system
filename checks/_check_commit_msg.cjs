#!/usr/bin/env node
/**
 * 提交信息（_check_commit_msg.cjs）—— 第 55 轮加
 * ============================================================================
 * ★ 它回答：**这个提交说的话，和它实际做的事，对得上吗？**
 *
 * 为什么需要它（一个"没被任何东西守着"的环节）：
 *   到第 54 轮为止，整条发布链**每一环都有断言看着** ——
 *     改 → 生成（5 道闸）→ 提交 → 推送（发布同步）→ 访客能不能跑（干净环境验证）。
 *   **而"提交"这一环里，"提交信息"是唯一没人管的东西**：
 *     它是我手写的，**而它是"给人看的、最该一致"的那一份**。
 *   ⇒ 一条"说了 A 而实际改了 B"的提交信息，比没有提交信息更糟 ——
 *     它会让后来查历史的人**按错的方向找**。
 *
 * ★ 它判四件事（前三件是格式，第四件才是有牙齿的那件）：
 *   ① 首行非空、不过长（≤ 72 字符）、末尾没有句号；
 *   ② 改动大（≥3 个文件或 ≥50 行）时，**必须有正文**（body）说明做了什么；
 *   ③ 首行不能是"update"/"fix"/"改"这种**没有信息量**的词；
 *   ④ **信息里提到的文件名 / 脚本名，必须真的在本次改动里** ——
 *      这是"说的与做的对得上"的可机械判部分。
 *
 * ⚠️ 诚实边界（**它判不了什么，说清楚**）：
 *   · 它**判不了"这条信息说得**全不全**"** —— 漏提一个改动，它看不出来（那需要一个"改动清单"去比，
 *     而那正是它**不做**的事：本项目的分工是"检查点出可疑处，人来做判断"）。
 *   · 它**判不了"措辞好不好"** —— 那是人的事。
 *   · 只看**最近一个提交**（`HEAD`）；要看整段历史用 `--range <A..B>`。
 *
 * 用法: node _check_commit_msg.cjs [--repo <路径>] [--range <rev>] [--quiet]
 * 退出码: 0 = 合格 / 1 = 有发现（**逐条判读**） / 2 = 结构性错误 / 3 = 未配置 ⇒ 跳过
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
const iRange = argv.indexOf('--range')
const QUIET = argv.includes('--quiet')
const RANGE = iRange >= 0 ? argv[iRange + 1] : 'HEAD~1..HEAD'

// 默认找公开集（它是那个"会被推送"的仓库；提交信息最要紧）
const CANDIDATES = iRepo >= 0 ? [argv[iRepo + 1]] : [path.join(HERE, 'public'), HERE]
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
  console.log('   （**跳过 ≠ 通过**。）')
  process.exit(3)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'commitmsg-'))
const run = (args) => {
  const log = path.join(TMP, 'r.txt')
  const fd = fs.openSync(log, 'w')
  let code = 0
  try { execFileSync('git', ['-C', REPO, ...args], { stdio: ['ignore', fd, fd] }) }
  catch (e) { code = (typeof e.status === 'number' ? e.status : 99) }
  fs.closeSync(fd)
  return { code, out: fs.readFileSync(log, 'utf8') }
}

// 只有一个提交时 HEAD~1 不存在 ⇒ 退化成看 HEAD 本身
let range = RANGE
const probe = run(['rev-parse', '--verify', range.split('..')[0]])
if (probe.code !== 0) range = 'HEAD'
const list = run(['log', '--format=%H%x00%s%x00%b%x01', range])
if (list.code !== 0 || !list.out) {
  console.error('❌ 结构性错误：读不到提交信息（range=' + range + '）—— 集合为空时不能判"合格"。')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(2)
}
const commits = list.out.split('\x01').map(s => s.trim()).filter(Boolean).map(s => {
  const p = s.split('\x00')
  return { sha: (p[0] || '').trim(), subject: (p[1] || '').trim(), body: (p[2] || '').trim() }
})
if (commits.length === 0) {
  console.error('❌ 结构性错误：解析出 0 个提交 —— 不能判"合格"。')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(2)
}

// 本次改动涉及的文件（用于第 ④ 项对账）
const changed = new Set()
{
  const d = run(['diff', '--name-only', range])
  if (d.code === 0) d.out.split('\n').map(s => s.trim()).filter(Boolean).forEach(f => changed.add(f))
  // 也把"整棵树"收进来做后备判据（新文件在新提交里未必出现在 diff 的 name-only 之外）
  const d2 = run(['show', '--name-only', '--format=', range])
  if (d2.code === 0) d2.out.split('\n').map(s => s.trim()).filter(Boolean).forEach(f => changed.add(f))
}

const findings = []
const EMPTY_WORDS = /^(update|updates?|fix|fixes|fix bug|change[sd]?|wip|misc|patch|改|修改|更新|修复|提交)\.?$/i

for (const c of commits) {
  const tag = c.sha.slice(0, 8)
  // ① 首行
  if (!c.subject) {
    findings.push(tag + '：**首行是空的** —— 提交信息至少要有一句"做了什么"。')
  } else {
    if (c.subject.length > 72) {
      findings.push(tag + '：首行 **' + c.subject.length + ' 字符**（> 72）—— "`git log --oneline`" 会被截断，'
        + '而那正是大多数人看历史的方式。')
    }
    if (/[。．.]$/.test(c.subject)) {
      findings.push(tag + '：首行以句号结尾 —— 惯例上首行**不写句号**（它不是一句话，是一个标签）。')
    }
    // ③ 没有信息量
    if (EMPTY_WORDS.test(c.subject)) {
      findings.push(tag + '：首行是「' + c.subject + '」—— **它没有说出改了什么**；'
        + '查历史的人看到它会比看到空白更困惑（**空白至少不会指错方向**）。')
    }
  }
  // ② 改动大就要有正文
  if (!c.body) {
    const st = run(['show', '--stat', '--format=', c.sha])
    const lines = st.out.split('\n')
    const filesN = lines.filter(l => /\|\s+\d+/.test(l)).length
    const sumLine = lines.find(l => /files? changed/.test(l)) || ''
    const insN = Number((sumLine.match(/(\d+) insertions?/) || [])[1] || 0)
    if (filesN >= 3 || insN >= 50) {
      findings.push(tag + '：改了 **' + filesN + ' 个文件 / ' + insN + ' 行**，**却只有一行提交信息** —— '
        + '正文是给"以后来查的人"的（他会想知道"为什么"，而那从 diff 里读不出来）。')
    }
  }
  // ④ 说的与做的对得上吗（**这一条才是有牙齿的**）
  //   抠出信息里提到的"像文件名"的串（含扩展名，或反引号里带下划线/点的短串）
  const mentioned = new Set()
  for (const m of (c.subject + '\n' + c.body).matchAll(/`?([A-Za-z0-9_\-]+\.(?:cjs|js|mjs|ps1|md|json|ya?ml))`?/g)) mentioned.add(m[1])
  for (const m of (c.subject + '\n' + c.body).matchAll(/`(_[A-Za-z0-9_\-]+)`/g)) mentioned.add(m[1] + '.cjs')
  for (const name of mentioned) {
    const hit = [...changed].some(f => f.endsWith(name) || f.endsWith('/' + name) || path.basename(f) === name)
    if (!hit) {
      findings.push(tag + '：【说的与做的不一致】信息里提到 **' + name + '**，'
        + '而本次改动里**没有这个文件** —— 要么信息写错了（会让查历史的人按错方向找），'
        + '要么改动漏了（该改的没改）。')
    }
  }
}
fs.rmSync(TMP, { recursive: true, force: true })

if (!QUIET) {
  console.log('▶ 提交信息（说的与做的对得上吗）')
  console.log('  仓库：' + REPO + '　范围：' + range + '　提交数：' + commits.length)
  console.log('  本次改动涉及 ' + changed.size + ' 个文件')
  console.log('')
}

if (!findings.length) {
  console.log('✅ 提交信息合格（' + commits.length + ' 个提交：首行长度/句号/信息量/正文/提到的文件都在改动里）')
  console.log('   （检查强度说明：它判不了"说得**全不全**"，也判不了"措辞好不好" —— 那两件是人的事。）')
  process.exit(0)
}
console.log('⚠️ **有 ' + findings.length + ' 条关于提交信息的发现：**')
findings.forEach(f => console.log('   · ' + f))
console.log('')
console.log('   ⇒ 逐条判读：**多数是"以后查历史的人会吃亏"**，不是"代码坏了"。')
console.log('   ⇒ 而最后那条（说的与做的不一致）要认真看 —— 它可能是**改动漏了**，不只是信息写错。')
process.exit(1)
