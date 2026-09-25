#!/usr/bin/env node
/**
 * 发布同步（_check_publish_sync.cjs）—— 第 54 轮加
 * ============================================================================
 * ★ 它回答三个问题（而这三个问题以前**全靠我记得**）：
 *   ① **公开集的工作区干净吗？** —— 有未提交改动 ⇒ 要么忘了提交，要么下次生成会把它盖掉；
 *   ② **本地 HEAD 与 `origin/master` 一致吗？** —— 不一致 ⇒ "有东西做了但没推"；
 *   ③ **那个差是不是我想改的？** —— 它**不判"该不该推"**（那是人的决定），
 *      它只把"差在哪、差多少"摆出来。
 *
 * ★ 为什么要它（这是**"产物仓库"的固有性质**）：
 *   公开集不是手写的，是 脱敏生成器 **原子替换**出来的。
 *   ⇒ 所以「推送到位」**不是一个一次性动作，而是一个状态** ——
 *     你推完之后 `git status` 是 0，但**下次生成又会让它变**（哪怕内容一字不差，也可能因
 *     换行符/BOM/顺序的差异产生真实 diff）。
 *   ⇒ 于是需要一道检查，**在你想起来的时候（和收尾的时候）告诉你"现在同步吗"**。
 *
 * ★ 与前几道的关系（不重复建设）：
 *   · 「生成物陈旧」问：**源比产物新吗**（该重新生成）
 *   · 「发布覆盖检查」问：**该发布的文件都在白名单里吗**（生成器内部）
 *   · 本项问：**生成完之后，那份产物同步到远端了吗**
 *
 * 用法：
 *   node _check_publish_sync.cjs            # 用本地缓存的 origin/master（不联网，快）
 *   node _check_publish_sync.cjs --fetch    # 先 git fetch 再判（联网，准）
 *   node _check_publish_sync.cjs --fast     # 同默认（供统一入口在 --fast 下调用）
 *
 * 退出码：0 = 干净且与远端一致 / 1 = 有未提交改动或有未推送提交 / 2 = 结构性错误 / 3 = 未配置 ⇒ 跳过
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HERE = __dirname
const argv = process.argv.slice(2)
const DO_FETCH = argv.includes('--fetch')

// 找公开集的 git 仓库：开发形态在 `核查/public/`；发布形态就在自己这一级。
const CANDIDATES = [path.join(HERE, 'public'), HERE]
let REPO = null
for (const c of CANDIDATES) {
  if (!fs.existsSync(c)) continue
  try {
    execFileSync('git', ['-C', c, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
    REPO = c
    break
  } catch { /* 试下一个 */ }
}
if (!REPO) {
  console.log('⏭️  找不到公开集的 git 仓库（试过 ' + CANDIDATES.join(' / ') + '）⇒ 本项**跳过**')
  console.log('   （**跳过 ≠ 通过** —— 这一项没查成。）')
  process.exit(3)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pubsync-'))
const run = (args) => {
  const log = path.join(TMP, 'r.txt')
  const fd = fs.openSync(log, 'w')
  let code = 0
  try { execFileSync('git', ['-C', REPO, ...args], { stdio: ['ignore', fd, fd] }) }
  catch (e) { code = (typeof e.status === 'number' ? e.status : 99) }
  fs.closeSync(fd)
  return { code, out: fs.readFileSync(log, 'utf8').trim() }
}

const findings = []

// ── ① 工作区干净吗 ────────────────────────────────────────────────────────────
const st = run(['status', '--porcelain'])
const dirty = st.out ? st.out.split('\n').filter(Boolean) : []
if (dirty.length) {
  findings.push('【工作区不干净】公开集里有 **' + dirty.length + '** 个未提交改动 —— '
    + '要么忘了提交，要么**下次生成会把它盖掉**（那正是"改了产物而不是源"的形态）。')
}

// ── ② 远程引用在不在 ────────────────────────────────────────────────────────
if (DO_FETCH) {
  const f = run(['fetch', 'origin', '--prune'])
  if (f.code !== 0) {
    console.log('⚠️  git fetch 失败（网络？）—— **本项这次用的是本地缓存的 origin/master**。')
    console.log('   ⇒ 读数可能不是最新的：**这不是"已同步"的证明**。')
  }
}
const localSha = run(['rev-parse', 'HEAD']).out
const remoteRef = run(['rev-parse', '--verify', 'origin/master']).out
if (!remoteRef) {
  console.log('⏭️  没有 `origin/master` 引用（从未 fetch/push 过？）⇒ 本项**跳过**')
  console.log('   （**跳过 ≠ 通过**。）')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(3)
}

let ahead = '', behind = ''
if (localSha !== remoteRef) {
  // 用 rev-list 数"本地领先/落后多少"（比只看 SHA 不等更有信息量）
  const ab = run(['rev-list', '--left-right', '--count', 'origin/master...HEAD'])
  if (ab.code === 0 && ab.out) {
    const p = ab.out.split(/\s+/)
    behind = p[0]; ahead = p[1]
  }
  findings.push('【与远端不一致】本地 HEAD `' + localSha.slice(0, 8) + '` ≠ `origin/master` `'
    + remoteRef.slice(0, 8) + '`'
    + (ahead || behind ? '（本地领先 **' + ahead + '** 个提交、落后 **' + behind + '** 个）' : '')
    + ' ⇒ **"推送到位"是一个状态，而现在不在那个状态上。**')
}

// ── ③ 未推送的提交（有 ahead 就列出来，让人知道"要推什么"）────────────────────
let unpushed = []
if (ahead && Number(ahead) > 0) {
  const lg = run(['log', '--oneline', 'origin/master..HEAD'])
  if (lg.code === 0 && lg.out) unpushed = lg.out.split('\n').filter(Boolean)
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log('▶ 发布同步（公开集 ↔ 远端）')
console.log('  仓库：' + REPO + '　远端引用：' + (DO_FETCH ? '**本次刚 fetch 过**' : '**本地缓存**（加 `--fetch` 会先联网拉一次）'))
console.log('  本地 HEAD：' + localSha.slice(0, 8) + '　origin/master：' + remoteRef.slice(0, 8))
console.log('  工作区：' + (dirty.length ? '**' + dirty.length + ' 个未提交改动**' : '干净'))
console.log('')

if (unpushed.length) {
  console.log('  ── 还没推上去的 ' + unpushed.length + ' 个提交：')
  unpushed.slice(0, 8).forEach(l => console.log('     ' + l))
  if (unpushed.length > 8) console.log('     …另有 ' + (unpushed.length - 8) + ' 个')
  console.log('')
}

console.log('—'.repeat(50))
if (!findings.length) {
  console.log('✅ 公开集工作区干净，且与 `origin/master` 一致（已同步）')
  console.log('   （检查强度说明：它**不判"该不该推"**，也不看你改的内容对不对 —— 那两件是人的事。）')
  process.exit(0)
}
for (const f of findings) console.log('⚠️ ' + f)
console.log('')
console.log('   ⇒ 两条出路（按本项目规矩，不许静默挂着）：')
console.log('      ① 真要发：`git add -A && git commit && git push origin master`；')
console.log('      ② 不打算发（还在改）：**明确知道"现在没同步"就行** —— 这一项会一直这么报，直到你推。')
console.log('   ⇒ 推完之后复跑一次本项（应当转绿）—— **那是"推到位了"的证据**。')
process.exit(1)
