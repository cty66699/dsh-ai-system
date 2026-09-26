#!/usr/bin/env node
/**
 * 访客视角（_check_remote_visitor.cjs）—— 第 56 轮加
 * ============================================================================
 * ★ 它回答：**一个陌生人从 GitHub clone 下来，能不能跑起来？**
 *
 * 为什么需要它（它是那条链上**最后一个手工环节**）：
 *   到第 55 轮为止，发布链每一环都有断言看着 —— 只有**"访客能不能跑"**这一步，
 *   一直是**我手工 clone 一份、跑一遍、看读数**。
 *   而它恰恰是**最重要的那一个**：「**别人拿得到、跑得起来**」。
 *
 * ★ 它的判据（**这个设计比"报个通过数"强**）：
 *   **「远端 clone 的读数」必须等于「本地公开仓的读数」**。
 *   两者都是"带 `.git`"的形态 ⇒ **它们的通过数必须一致**。
 *   ⇒ 这就同时验了两件事：
 *     · **推送到位**（远端那份就是本地这份）；
 *     · **访客能跑**（clone 下来第一步就有结果，不是报错）。
 *   ⚠️ 若不等 ⇒ **推上去的不是我以为的那一份**（或远端有别人推的东西）。
 *
 * ★ 它为**什么不在 `--fast` 里跑**：
 *   它要**联网 clone**（几十秒），而 `--fast` 的定位是"改完随手跑一遍"。
 *   ⇒ 与「验证代表性」同类：**按需项**。收尾 / 推送后 / 交付前跑它。
 *
 * ⚠️ 诚实边界：
 *   · 它只验 **"clone → 跑一条命令 → 有结果"**；
 *     **不验**"README 的渲染效果"（那要浏览器）、**不验**"用户在别的 OS 上能不能跑"。
 *   · 它**默认 clone 浅历史**（`--depth 1`）⇒ 那些"依赖完整历史"的检查在远端副本里
 *     可能表现不同（本项目当前没有那种检查；**若有，这条要说清**）。
 *
 * 用法: node _check_remote_visitor.cjs [--remote <url>] [--keep]
 * 退出码: 0 = 远端与本地读数一致且能跑 / 1 = 不一致或跑不通 / 2 = 结构性错误 / 3 = 未配置 ⇒ 跳过
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HERE = __dirname
const argv = process.argv.slice(2)
const iRemote = argv.indexOf('--remote')
const KEEP = argv.includes('--keep')

// ── 本地那份（开发形态在 `核查/public/`）─────────────────────────────────────
const CANDIDATES = [path.join(HERE, 'public'), HERE]
let LOCAL = null
for (const c of CANDIDATES) {
  if (!fs.existsSync(c)) continue
  try {
    execFileSync('git', ['-C', c, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
    LOCAL = c
    break
  } catch { /* 试下一个 */ }
}
if (!LOCAL) {
  console.log('⏭️  找不到本地公开集（试过 ' + CANDIDATES.join(' / ') + '）⇒ 本项**跳过**')
  process.exit(3)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'visitor-'))
const run = (cmd, args, cwd, timeoutMs) => {
  const log = path.join(TMP, 'r.txt')
  const fd = fs.openSync(log, 'w')
  let code = 0
  try { execFileSync(cmd, args, { cwd, stdio: ['ignore', fd, fd], timeout: timeoutMs || 300000 }) }
  catch (e) { code = (typeof e.status === 'number' ? e.status : 99) }
  fs.closeSync(fd)
  return { code, out: fs.readFileSync(log, 'utf8') }
}
const REMOTE = iRemote >= 0 ? argv[iRemote + 1]
  : run('git', ['-C', LOCAL, 'remote', 'get-url', 'origin'], LOCAL).out.trim()
if (!REMOTE) {
  console.log('⏭️  本地仓库没有 `origin` 远端（也没给 `--remote`）⇒ 本项**跳过**')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(3)
}

/** 在一个目录里跑访客第一步，返回通过数 */
const visitorRun = (dir) => {
  // ★ 用共享真源（第 56 轮：那份清单原来在这里与生成器里各写了一遍，被「重复清单」抓到）。
  //   ⚠️ **别写 `catch { return [...] }` 那种 fallback** —— 那**又把清单写了一遍**，
  //     而「重复清单」检查会（也应该）当场抓到。同目录的 `require` 不会失败；
  //     真失败了也该**当场报错**，而不是悄悄用一份可能过期的副本。
  const r = run(process.execPath, require('./_paths.cjs').VISITOR_CMD, dir)
  const m = r.out.match(/通过\s*(\d+)\s*\/\s*(\d+)/)
  return { code: r.code, pass: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, out: r.out }
}

console.log('▶ 访客视角（从远端 clone 一份，跑 README 那条命令）')
console.log('  远端：' + REMOTE)
console.log('')

// ── ① 本地读数（基准）──────────────────────────────────────────────────────
const localR = visitorRun(LOCAL)
if (localR.pass === null) {
  console.error('❌ 结构性错误：连**本地**公开集都读不到通过数 —— 先修本地，再谈远端。')
  console.error(localR.out.split('\n').slice(-8).join('\n'))
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(2)
}
console.log('  本地公开仓：通过 ' + localR.pass + ' / ' + localR.total + '（exit ' + localR.code + '）')

// ── ② 远端读数（访客）───────────────────────────────────────────────────────
const REPO = path.join(TMP, 'repo')
// ★★★ 2026-09-26 修（第 57 轮）：**clone 要重试** —— 实测栽过一次。
//   现场：`git push` 与 `git clone` **同一天各失败一次**，报错都是
//     `Connection reset by 20.205.243.160 port 443` + `Could not read from remote repository`
//     + **`Please make sure you have the correct access rights and the repository exists`** ——
//   而那条报错**会把人引向错误方向**（"是不是 key 过期了 / 仓库没了？"）；
//   `ssh -T git@ssh.github.com` 当场证明**认证完全正常**，**重试一次就成功了。**
//   ⇒ 所以：**网络抖动必须在脚本里被吸收**，而不是让"访客能不能跑"这一项假红。
//   ⇒ 判据：**"读取失败"与"读到了但不对"是两件事** —— 前者值得重试，后者不该。
const cloneTry = (n) => {
  for (let i = 1; i <= n; i++) {
    const r = run('git', ['-c', 'core.autocrlf=false', 'clone', '-q', '--depth', '1', REMOTE, REPO], TMP, 600000)
    if (r.code === 0) return r
    if (i < n) {
      const transient = /Connection reset|Could not read from remote|timed out|TLS|EOF|broken pipe/i.test(r.out)
      console.log('      ↳ 第 ' + i + ' 次 clone 失败（' + (transient ? '**像是网络抖动**' : '非网络原因') + '），3 秒后重试…')
      if (!transient) return r          // **不是网络问题就别重试**（重试只会拖长等待）
      try { require('node:child_process').execFileSync('sleep', ['3']) } catch { /* Windows 无 sleep，用下面这行 */ }
      const until = Date.now() + 3000
      while (Date.now() < until) { /* 忙等 3 秒（本脚本不在热路径上） */ }
    }
    if (i === n) return r
  }
  return { code: 99, out: '(clone 未执行)' }
}
const c = cloneTry(3)
if (c.code !== 0) {
  console.error('')
  console.error('❌ **clone 失败**（exit ' + c.code + '）—— 访客第一步就卡住了。')
  console.error(c.out.split('\n').slice(-8).join('\n'))
  console.error('   ⇒ 那意味着：**"别人拿得到"这一条不成立。**')
  console.error('   ⚠️ 但**先看报错是不是网络**（`Connection reset` / `Could not read from remote`）：')
  console.error('      那类错误**会附带一句误导**（"check your access rights and the repository exists"）——')
  console.error('      而 `ssh -T git@ssh.github.com` 能当场证明认证是否正常。**网络抖动重试即可。**')
  if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true })
  else console.log('   （--keep：临时目录留在 ' + TMP + '）')
  process.exit(1)
}
const remoteR = visitorRun(REPO)
const sha = run('git', ['-C', REPO, 'rev-parse', 'HEAD'], REPO).out.trim().slice(0, 8)
const localSha = run('git', ['-C', LOCAL, 'rev-parse', 'HEAD'], LOCAL).out.trim().slice(0, 8)
console.log('  远端 clone ：通过 ' + remoteR.pass + ' / ' + remoteR.total + '（exit ' + remoteR.code + '）'
  + '　那份里的 commit：' + sha)

const findings = []
if (remoteR.pass === null || remoteR.pass !== remoteR.total) {
  findings.push('**访客跑不通**：远端 clone 出来的仓库跑 README 那条命令'
    + (remoteR.pass === null ? '**读不到通过数**' : '只通过 ' + remoteR.pass + ' / ' + remoteR.total)
    + '（exit ' + remoteR.code + '）—— **"别人拿得到、跑得起来"这一条不成立。**')
}
if (remoteR.pass !== localR.pass || remoteR.total !== localR.total) {
  findings.push('**远端与本地读数不一致**：本地 ' + localR.pass + '/' + localR.total
    + '，远端 ' + remoteR.pass + '/' + remoteR.total
    + ' ⇒ **推上去的不是我以为的那一份**（或远端有别人推的东西）。')
}
if (sha !== localSha) {
  findings.push('**远端 commit 与本地不同**：远端 `' + sha + '`，本地 `' + localSha
    + '` ⇒ **有东西没推**（或推的不是这个分支）。')
}

if (!KEEP) fs.rmSync(TMP, { recursive: true, force: true })

console.log('')
console.log('—'.repeat(50))
if (!findings.length) {
  console.log('✅ 访客视角通过：远端 clone 下来能跑，且读数与本地一致'
    + '（' + remoteR.pass + ' / ' + remoteR.total + '，commit ' + sha + '）')
  console.log('   （检查强度说明：它只验"clone → 跑一条命令 → 有结果"，')
  console.log('     **不验**README 的渲染效果、也**不验**"别人在别的 OS 上能不能跑"。）')
  process.exit(0)
}
for (const f of findings) console.log('⚠️ ' + f)
console.log('')
console.log('   ⇒ 两条出路：')
console.log('      ① 只是没推：`git push origin master`，然后复跑本项；')
console.log('      ② 推了但读数不一致：**去远端看看那份到底是什么**（`git ls-remote` / 网页）。')
process.exit(1)
