#!/usr/bin/env node
/**
 * 收尾（_finish.cjs）—— 第 57 轮加
 * ============================================================================
 * ★ 它把"收尾要跑的四步"收敛成**一条命令**，并**替你把顺序管住**。
 *
 * 为什么需要它（**顺序这件事我漏过好几次**）：
 *   收尾要跑的是：**① 文本卫生 → ② 生成 → ① 复跑 → ③ 统一入口（→ ④ 访客视角）**
 *   而**它们有固定的顺序与依赖**：
 *     · 若你改了 `_public_src/` 的源，① 会报「生成物陈旧」—— **那是预期内的**，
 *       正确做法是**先生成、再复跑 ①**；
 *     · 而这一步**在最近这十几轮里我漏过至少三次**（每次都要看输出才发现"顺序反了"）。
 *   ⇒ **把"我记得按顺序跑这几条"变成一个入口**（本项目一贯的做法）。
 *
 * ★ 它的行为（**失败就停，不往下跑**）：
 *   ① 文本卫生        —— 若**只**报「生成物陈旧」，标记为"预期内"，继续；
 *                        若报**别的**（BOM/引号/JS 语法…），**停**。
 *   ② 生成            —— 5 道闸；失败就停。
 *   ③ 文本卫生（复跑）—— **这一次必须干净**；不干净就停。
 *   ④ 统一入口 --fast —— 失败就停（除非 `--allow-red`）。
 *   ⑤ 发布同步        —— **它红了不算失败**（那只是"还没推"），但要**说清楚**。
 *   ⑥ 访客视角        —— 只在 `--with-visitor` 时跑（联网，~40 秒）。
 *
 * 用法：
 *   node _finish.cjs                    # ① ② ① ③ ⑤
 *   node _finish.cjs --with-visitor     # 再加 ⑥（联网）
 *   node _finish.cjs --allow-red        # 允许 ③/④ 有红（例如你正改到一半）
 *
 * 退出码：0 = 全绿（或有红但带了 --allow-red）/ 1 = 有一步失败 / 2 = 结构性错误
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HERE = __dirname
const argv = process.argv.slice(2)
const WITH_VISITOR = argv.includes('--with-visitor')
const ALLOW_RED = argv.includes('--allow-red')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-'))
let stepNo = 0
const results = []

/** 跑一步：返回 {code, out}；**用文件描述符**（本项目纪律：不用管道捕获子进程输出） */
const step = (title, file, args, opts = {}) => {
  stepNo++
  const n = String(stepNo).padStart(2)
  process.stdout.write('  [' + n + '] ' + title + ' … ')
  const log = path.join(TMP, 'step' + stepNo + '.txt')
  const fd = fs.openSync(log, 'w')
  let code = 0
  try {
    execFileSync(process.execPath, [path.join(HERE, file), ...args],
      { cwd: HERE, stdio: ['ignore', fd, fd], timeout: opts.timeout || 900000 })
  } catch (e) { code = (typeof e.status === 'number' ? e.status : 99) }
  fs.closeSync(fd)
  const out = fs.readFileSync(log, 'utf8')
  const ok = opts.expectCode !== undefined ? code === opts.expectCode : code === 0
  console.log((ok ? '✅' : '❌') + ' exit ' + code)
  // ★ `expectedRed`：**"预期内的红"不算失败**（第 57 轮加，被反例②抓到）。
  //   本脚本第一遍跑文本卫生时，"生成物陈旧"是**设计上会出现的**（改了源还没重新生成）；
  //   而它在汇总里**不该**被算成"失败"—— 否则输出会说"失败 1"，而实际上每一步都对。
  results.push({ n, title, file, code, ok, out, optional: !!opts.optional, expectedRed: !!opts.expectedRed })
  return { code, out, ok }
}

const showTail = (out, n) => {
  const lines = out.split('\n').filter(l => l.trim())
  for (const l of lines.slice(-n)) console.log('        ' + l.trim().slice(0, 118))
}

console.log('▶ 收尾（把"按顺序跑这几条"变成一条命令）')
console.log('  目录：' + HERE)
console.log('')

// ── ① 文本卫生（第一遍：允许"生成物陈旧"这一种红）──────────────────────────
const s1 = step('文本卫生（第一遍）', '_check_text_hygiene.cjs', [])
const STALE_ONLY = s1.code !== 0 && /生成物陈旧/.test(s1.out) && !/❌\s*\[(?!生成物陈旧)/.test(s1.out)
if (s1.code !== 0) {
  if (STALE_ONLY) {
    console.log('        ↳ 只报「生成物陈旧」—— **那是预期内的**（改了源还没重新生成），继续。')
    results[results.length - 1].expectedRed = true   // ★ 它不算失败
  } else {
    console.log('        ↳ ❌ 报了**别的**（不只是生成物陈旧）—— 停下，先修它：')
    showTail(s1.out, 8)
    fs.rmSync(TMP, { recursive: true, force: true })
    process.exit(1)
  }
}

// ── ② 生成（5 道闸）─────────────────────────────────────────────────────────
const s2 = step('生成（5 道闸）', '_build_public_docs.cjs', [])
if (!s2.ok) {
  console.log('        ↳ ❌ 生成失败 —— 停下（**闸门拦住了某件事，去读它说了什么**）：')
  showTail(s2.out, 14)
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

// ── ③ 文本卫生（复跑：**这一次必须干净**）───────────────────────────────────
const s3 = step('文本卫生（复跑）', '_check_text_hygiene.cjs', [])
if (!s3.ok && !ALLOW_RED) {
  console.log('        ↳ ❌ 复跑仍有红 —— 停下（**生成之后它应当干净了**）：')
  showTail(s3.out, 8)
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

// ── ④ 统一入口（--fast）─────────────────────────────────────────────────────
const s4 = step('统一入口（--fast）', '_check_all.cjs', ['--fast'])
if (!s4.ok && !ALLOW_RED) {
  console.log('        ↳ ❌ 统一入口有红 —— 停下（**那是"改完必跑"的第三条**）：')
  showTail(s4.out, 12)
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
}

// ── ⑤ 发布同步（**红了不算失败**：那只是"还没推"）────────────────────────────
const s5 = step('发布同步（"推到位了吗"）', '_check_publish_sync.cjs', [], { optional: true })
if (!s5.ok) {
  console.log('        ↳ ⚠️ 还没同步到远端（**这不是失败** —— 它只是回答"现在同步吗"）：')
  showTail(s5.out, 4)
}

// ── ⑥ 访客视角（可选）───────────────────────────────────────────────────────
if (WITH_VISITOR) {
  const s6 = step('访客视角（从远端 clone）', '_check_remote_visitor.cjs', [], { timeout: 900000 })
  if (!s6.ok) {
    console.log('        ↳ ❌ 访客视角不通过（**"别人拿得到、跑得起来"这一条不成立**）：')
    showTail(s6.out, 8)
  }
}

fs.rmSync(TMP, { recursive: true, force: true })

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('')
console.log('—'.repeat(56))
// ★ 三种"不 ok"要分开算：**预期内的红**（不算失败）· **提醒类**（可选）· **真失败**
const failed = results.filter(r => !r.ok && !r.optional && !r.expectedRed)
const expectedReds = results.filter(r => !r.ok && r.expectedRed)
const reminders = results.filter(r => !r.ok && r.optional && !r.expectedRed)
console.log('收尾步骤 ' + results.length + ' 步｜通过 ' + results.filter(r => r.ok).length
  + '｜失败 ' + failed.length
  + (expectedReds.length ? '｜预期内的红 ' + expectedReds.length : '')
  + (reminders.length ? '｜提醒 ' + reminders.length : ''))
if (failed.length) {
  console.log('❌ **有步骤失败** —— 上面每一条都写清了它是哪一步、去读它的输出。')
  process.exit(1)
}
const notSync = results.find(r => r.file === '_check_publish_sync.cjs' && !r.ok)
console.log('✅ 收尾通过' + (notSync ? '（**但还没推到远端** —— 要发就跑 `git -C public add -A && commit && push`，然后复跑本项）' : '，且已与远端同步'))
if (!WITH_VISITOR) {
  console.log('   （访客视角没跑 —— 要跑加 `--with-visitor`，它联网 ~40 秒。）')
}
process.exit(0)
