#!/usr/bin/env node
/**
 * 发布（_publish.cjs）—— 第 58 轮加
 * ============================================================================
 * ★ 它做的是"提交 + 推送"这两步里**机械的那部分**，而**判断留给人**。
 *
 * 为什么需要它（这是那条链上剩下的最后两步手工操作）：
 *   第 57 轮把"收尾"收敛成了一条命令（`_finish.cjs`），
 *   而**"提交 + 推送"仍然是我手工做的**：`git add -A && git commit && git push` ——
 *   其中 **push 还会因网络抖动失败，而我要自己重试三次**（第 57 轮实测两次）。
 *
 * ★ 它**不替人做**的部分（**这一条是设计原则，不是省事**）：
 *   **提交信息由人写** —— 它是"给以后查历史的人"的唯一线索，
 *   而"这次改动的意图是什么"**不是脚本能知道的**。
 *   ⇒ 所以本脚本**要么用你给的 `--msg` / `--msg-file`，要么停下来说"该写什么"**，
 *     **绝不自动生成"update"式的占位信息。**
 *
 * ★ 它的行为：
 *   ① 看公开集有没有未提交改动；没有 ⇒ 直接跳去推送（可能只是"提交过没推"）；
 *   ② 有改动 ⇒ **要提交信息**（`--msg` 或 `--msg-file`；都没有 ⇒ 停下并打印"改了什么"）；
 *   ③ 提交；
 *   ④ **推送（3 次重试，且只对网络类错误重试）**；
 *   ⑤ 复核：发布同步 + （可选）访客视角。
 *
 * 用法：
 *   node _publish.cjs --msg "第 N 轮：做了 X"        # 常见用法
 *   node _publish.cjs --msg-file /tmp/msg.txt        # 长信息（多行）
 *   node _publish.cjs --dry-run                      # 只看"会提交什么"，不动仓库
 *   node _publish.cjs --with-visitor                 # 推完顺便验访客视角
 *
 * 退出码：0 = 已提交并推送成功（或本来就无需提交且已同步）/ 1 = 有一步失败 / 2 = 结构性错误
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HERE = __dirname
const argv = process.argv.slice(2)
const iMsg = argv.indexOf('--msg')
const iMsgFile = argv.indexOf('--msg-file')
const DRY = argv.includes('--dry-run')
const WITH_VISITOR = argv.includes('--with-visitor')

let MSG = iMsg >= 0 ? argv[iMsg + 1] : ''
if (iMsgFile >= 0) MSG = fs.readFileSync(argv[iMsgFile + 1], 'utf8').trim()

// ── 找公开集仓库 ────────────────────────────────────────────────────────────
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
  console.error('❌ 结构性错误：找不到公开集的 git 仓库（试过 ' + CANDIDATES.join(' / ') + '）')
  process.exit(2)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'))
let seq = 0
/** 跑一条 git 命令；**用文件描述符**（本项目纪律：不用管道捕获子进程输出） */
const git = (args) => {
  seq++
  const log = path.join(TMP, 'g' + seq + '.txt')
  const fd = fs.openSync(log, 'w')
  let code = 0
  try { execFileSync('git', ['-C', REPO, ...args], { stdio: ['ignore', fd, fd], timeout: 600000 }) }
  catch (e) { code = (typeof e.status === 'number' ? e.status : 99) }
  fs.closeSync(fd)
  return { code, out: fs.readFileSync(log, 'utf8').trim() }
}

console.log('▶ 发布（提交 + 推送；**提交信息由人写**）')
console.log('  仓库：' + REPO)
console.log('')

// ── ① 有什么要提交 ──────────────────────────────────────────────────────────
const st = git(['status', '--porcelain'])
const dirty = st.out ? st.out.split('\n').filter(Boolean) : []
console.log('  未提交改动：' + (dirty.length ? '**' + dirty.length + ' 个**' : '0 个（干净）'))
if (dirty.length) {
  for (const l of dirty.slice(0, 10)) console.log('     ' + l)
  if (dirty.length > 10) console.log('     …另有 ' + (dirty.length - 10) + ' 个')
}

if (dirty.length && !MSG) {
  console.log('')
  console.log('❌ **要提交，但没给提交信息** —— 而它是"给以后查历史的人"的唯一线索。')
  console.log('   ⇒ 用法：`node _publish.cjs --msg "第 N 轮：做了 X"`')
  console.log('          或 `node _publish.cjs --msg-file <文件>`（长信息、多行）')
  console.log('   ⇒ **本脚本不替你生成** —— 因为"这次改动的意图是什么"不是脚本能知道的，')
  console.log('     而一条"update"式的占位信息**比空白更糟**（它会让查历史的人按错方向找）。')
  console.log('')
  console.log('   要看清"改了什么"，可以先跑：`git -C ' + REPO + ' diff --stat`')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

if (DRY) {
  console.log('')
  console.log('（--dry-run：到此为止，**仓库没有任何改动**。）')
  if (MSG) console.log('  将要用的提交信息首行：' + MSG.split('\n')[0])
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

// ── ② 提交 ──────────────────────────────────────────────────────────────────
if (dirty.length) {
  git(['add', '-A'])
  const mf = path.join(TMP, 'msg.txt')
  fs.writeFileSync(mf, MSG.endsWith('\n') ? MSG : MSG + '\n', 'utf8')
  // ★ `-c core.autocrlf=false`：不让 git 在提交时改换行符（本项目踩过"生成物陈旧"那一类）
  const c = git(['-c', 'core.autocrlf=false', 'commit', '-q', '-F', mf])
  console.log('')
  console.log('  提交：' + (c.code === 0 ? '✅ 成功' : '❌ 失败（exit ' + c.code + '）'))
  if (c.code !== 0) {
    console.log(c.out.split('\n').slice(-8).map(l => '     ' + l).join('\n'))
    fs.rmSync(TMP, { recursive: true, force: true })
    process.exit(1)
  }
  const head = git(['log', '-1', '--oneline']).out
  console.log('     ' + head)
}

// ── ③ 推送（**3 次重试，只对网络类错误**）────────────────────────────────────
let pushed = false
let lastOut = ''
for (let i = 1; i <= 3; i++) {
  const p = git(['-c', 'core.autocrlf=false', 'push', 'origin', 'master'])
  lastOut = p.out
  if (p.code === 0) {
    console.log('')
    console.log('  推送：✅ 成功' + (i > 1 ? '（第 ' + i + ' 次尝试）' : ''))
    const line = p.out.split('\n').find(l => /master ->/.test(l))
    if (line) console.log('     ' + line.trim())
    pushed = true
    break
  }
  // ★ 「读取失败」与「读到了但不对」是两件事 —— 前者值得重试，后者不该
  const transient = /Connection reset|Could not read from remote|timed out|TLS|EOF|broken pipe|kex_exchange/i.test(p.out)
  console.log('')
  console.log('  推送：第 ' + i + ' 次失败（' + (transient ? '**像是网络抖动**' : '**非网络原因**') + '）')
  if (!transient) {
    console.log(lastOut.split('\n').slice(-6).map(l => '     ' + l).join('\n'))
    console.log('   ⇒ **不是网络问题就不重试**（重试只会把同样的错误再跑一遍）。')
    break
  }
  if (i < 3) console.log('     ↳ 3 秒后重试…')
}
if (!pushed) {
  console.log('')
  console.log('  ⚠️ **推送没成功** —— 而上面那条报错**可能是网络**。')
  console.log('     那句话（`Please make sure you have the correct access rights…`）**会把人引向错的方向**；')
  console.log('     要确认认证是否正常：`ssh -T git@ssh.github.com`（能打印你的用户名就是正常）。')
  console.log('     **提交已经做完了**（改动不会丢），所以可以稍后重跑本脚本。')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

fs.rmSync(TMP, { recursive: true, force: true })

// ── ④ 复核 ──────────────────────────────────────────────────────────────────
console.log('')
console.log('  复核：')
const sync = path.join(HERE, '_check_publish_sync.cjs')
if (fs.existsSync(sync)) {
  let code = 0
  const log = path.join(os.tmpdir(), 'pub-sync-' + Date.now() + '.txt')
  const fd = fs.openSync(log, 'w')
  try { execFileSync(process.execPath, [sync], { cwd: HERE, stdio: ['ignore', fd, fd], timeout: 300000 }) }
  catch (e) { code = (typeof e.status === 'number' ? e.status : 99) }
  fs.closeSync(fd)
  console.log('     发布同步 … ' + (code === 0 ? '✅ exit 0' : '❌ exit ' + code))
  try { fs.rmSync(log, { force: true }) } catch { /* 忽略 */ }
}
if (WITH_VISITOR) {
  const vis = path.join(HERE, '_check_remote_visitor.cjs')
  if (fs.existsSync(vis)) {
    let code = 0
    const log = path.join(os.tmpdir(), 'pub-vis-' + Date.now() + '.txt')
    const fd = fs.openSync(log, 'w')
    try { execFileSync(process.execPath, [vis], { cwd: HERE, stdio: ['ignore', fd, fd], timeout: 900000 }) }
    catch (e) { code = (typeof e.status === 'number' ? e.status : 99) }
    fs.closeSync(fd)
    console.log('     访客视角 … ' + (code === 0 ? '✅ exit 0' : '❌ exit ' + code))
    try { fs.rmSync(log, { force: true }) } catch { /* 忽略 */ }
  }
}
console.log('')
console.log('✅ 发布完成（提交 + 推送）')
process.exit(0)
