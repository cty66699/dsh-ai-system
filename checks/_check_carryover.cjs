// 跨轮结转账断言 —— 治 X-20：「我给别人的发现装了强制链路，却没给自己留的活装」
//
// 治什么（实测）：`07_致命问题登记册.md` 的「本轮未做」表里，C-6 / A-09 / A-10
//   **从第 4 轮第一次记，到第 10 轮仍是「未做」—— 记了 7 次，做了 0 次**，
//   而且是在写下 X-16（"列出来被当成做掉了"）**之后**继续复发的。
//   根因：「本轮未做」只是一个**记录位**，**没有任何机制把上一轮的"未做"变成下一轮的"必做"**。
//   ⇒ 与 X-13（红灯无人追）同机理，只是对象换成了**我自己的待办**。
//
// 核心规则（唯一的牙齿）：
//   **任何 opened_round 早于当前 round 的条目，不得保持 open。**
//   必须变成 done（做掉）或 waived（书面豁免 + reason + trigger）。
//   ⇒ 于是"忘记做"会 **在下一轮直接报错**，而不是安静地躺 7 轮。
//
// 用法: node _check_carryover.cjs
// 退出码: 0=无逾期欠账  1=有欠账逾期/豁免无理由  2=结构性错误
const fs = require('node:fs')
const path = require('node:path')

const _CFG = require('./_paths.cjs').requirePaths(['carryover'])
const LEDGER = _CFG.t.carryover
const ROOT = _CFG.ROOT
const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const die = m => { console.error('❌ 结构性错误：' + m); process.exit(2) }

if (!fs.existsSync(LEDGER)) die('找不到跨轮结转账：' + LEDGER)
let L
try { L = JSON.parse(readText(LEDGER)) } catch (e) { die('账本 JSON 解析失败：' + e.message) }

const round = L.round
if (!Number.isInteger(round) || round < 1) die('账本缺少合法的 round 字段')
const items = L.items
if (!Array.isArray(items) || items.length === 0) die('账本 items 为空')

const findings = []
const counts = { done: 0, waived: 0, open: 0 }
const overdue = []

for (const it of items) {
  const name = it.id || '(无编号)'
  if (!it.desc) findings.push(`【缺描述】${name} 没有 desc`)
  if (!['done', 'waived', 'open'].includes(it.status)) { findings.push(`【状态非法】${name} 的 status=${it.status}`); continue }
  counts[it.status]++

  if (it.status === 'open') {
    // ★ 唯一的牙齿：跨轮不得保持 open
    if (!Number.isInteger(it.opened_round)) findings.push(`【缺 opened_round】${name} 无法判断是否逾期`)
    else if (it.opened_round < round) {
      const age = round - it.opened_round
      overdue.push(`${name}（自第 ${it.opened_round} 轮起，已躺 ${age} 轮）`)
    }
  }
  if (it.status === 'done') {
    if (!Number.isInteger(it.done_round)) findings.push(`【缺 done_round】${name} 标为 done 但没写完成轮次`)
    else if (it.done_round > round) findings.push(`【完成轮次越界】${name} 的 done_round=${it.done_round} 大于当前 round=${round}`)
    if (!it.where) findings.push(`【缺落点】${name} 标为 done 但没写 where（改在哪里）`)
    // ★★ 把「done」从**声明**变成**可验证的事实**：账本里写的落点，必须真有那段文字。
    //   —— 否则"标记为 done"本身就是一次"列出来＝做掉了"（正是 X-16 的病）。
    if (!it.verify || !it.verify.file || !it.verify.contains) {
      findings.push(`【done 不可验证】${name} 标为 done 但没写 verify{file,contains} —— **"声明完成"不算完成**`)
    } else {
      const fp = path.join(_CFG.t.verifyBase || ROOT, it.verify.file)
      if (!fs.existsSync(fp)) findings.push(`【verify 落点不存在】${name} 的 verify.file 找不到：${it.verify.file}`)
      else if (!readText(fp).includes(it.verify.contains)) {
        findings.push(`【done 未被执行验证】${name} 声称改在 ${it.verify.file}，但该文件里找不到标记串「${it.verify.contains}」—— **可能只是标了个 done**`)
      }
    }
  }
  if (it.status === 'waived') {
    if (!it.reason || it.reason.length < 20) findings.push(`【豁免无理由】${name} 标为 waived，但 reason 缺失或过短 —— **禁止无限期不做**`)
    if (!it.trigger) findings.push(`【豁免无触发条件】${name} 标为 waived，但没写 trigger（什么时候会重新变成必做）`)
  }
}

if (overdue.length) {
  findings.push(`【欠账逾期】以下条目跨轮仍为 open —— **必须做掉或书面豁免**：${overdue.join(' · ')}`)
}

// ── 输出 ─────────────────────────────────────────────────────────────────
console.log(`跨轮结转账检查（第 ${round} 轮）`)
console.log(`  条目 ${items.length}：✅ 已做 ${counts.done} · 🟡 豁免 ${counts.waived} · ⬜ open ${counts.open}`)
if (counts.waived) {
  console.log('  —— 已豁免（**带触发条件，不是无限期不做**）：')
  for (const it of items.filter(x => x.status === 'waived')) {
    console.log(`     🟡 ${it.id} —— ${String(it.trigger).slice(0, 70)}`)
  }
}

if (findings.length) {
  console.log('')
  for (const f of findings) console.log('  ⚠️ ' + f)
  console.log('')
  console.log(`有 ${findings.length} 项未通过`)
  process.exit(1)
}

console.log('')
console.log('✅ 无跨轮逾期欠账：所有早于本轮的条目都已做掉或书面豁免（且豁免带触发条件）')
console.log('   （检查强度说明：本脚本保证的是「**不许忘**」，不保证「豁免理由成立** —— 那需要 T6。）')
