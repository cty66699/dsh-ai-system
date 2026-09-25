// 记忆毕业断言 —— 「lesson 写下来了」与「这个错不会再犯」之间的那条强制链路。
//
// 治什么（2026-09-25 全库盘点）：
//   lesson 共 127 条（active），**全部产生于 2026-09-20 ~ 09-24 这 3.81 天内**；
//   其中 **17 条正文自己写着「同一个错又犯了」**。
//   ⇒ **记忆量暴涨的同一时期，「同一个错又犯了」也最多 —— 记忆没有降低错误率。**
//   根因不是「记不住」，而是**记忆是参考文献、不是闸门**：
//   它改变「我知道什么」，而错误发生在「我做什么」的那一刻，两者之间**没有任何强制链路**。
//
//   佐证（本工作区自带的对照实验）：同一条内容，
//     · 写成 lesson          → 记完之后照样踩，第 3 次；
//     · 写进 AGENTS.md（每会话**全量注入**，命中率 100%）→ 同类错**已犯八次**；
//     · 写成断言进统一入口   → 第 7、8 次**是脚本自己抓到的，不是我事后想起的**。
//   第二行排除了「检索不到」这个解释 —— **瓶颈在执行的强制性，不在记忆的检索。**
//
// 本脚本就是那条链路的载体：**每条 active lesson 必须在毕业账本里有一个归宿**，
// 而且「能机械化的」必须落到一个**真的在统一入口里跑**的脚本上。
//
// 账本：`docs/_lesson_graduation.json`，五种归宿（各自的必填字段由本脚本断言）：
//   assertions —— 已被断言覆盖     ⇒ 必填 landing（且该脚本必须在 _check_all.cjs 的 CHECKS 里）
//   partial    —— 部分机械化       ⇒ 必填 landing + residual（剩什么）+ trigger（何时重评）
//   external   —— 只能靠外部复核   ⇒ 必填 track + reason
//   domain     —— 领域/环境事实，本就不是「可预防的行为错误」 ⇒ 必填 reason
//   waived     —— 书面豁免         ⇒ 必填 reason + trigger
//
// ★ 唯一的牙齿（这条设计照抄 `_check_carryover.cjs` 的经验）：
//   **未分诊数必须严格等于 `backlogMax`。**
//   · 写了新 lesson 却没分诊 ⇒ 未分诊数上升 ⇒ **红灯**（新 lesson 不可能悄悄溜过）；
//   · 分诊掉一条却忘了下调账本 ⇒ **也红灯**（账本不会烂在原地）。
//   即：**账本只有被维护才可能是绿的。**
//
// 用法: node _check_lesson_graduation.cjs [--target <配置>]
// 退出码: 0=每条 lesson 都有归宿  1=有未分诊/字段缺失  2=结构性错误  3=未配置 ⇒ 跳过
const fs = require('node:fs')
const path = require('node:path')
const _CFG = require('./_paths.cjs').requirePaths(['lessonGraduation', 'lessonDb'])

const HERE = __dirname
const LEDGER = _CFG.t.lessonGraduation
const DB = _CFG.t.lessonDb
const CHECK_ALL = path.join(HERE, '_check_all.cjs')

const die = m => { console.error('❌ 结构性错误：' + m); process.exit(2) }
for (const [p, n] of [[LEDGER, '毕业账本'], [DB, '记忆库'], [CHECK_ALL, '_check_all.cjs']]) {
  if (!fs.existsSync(p)) die('找不到' + n + '：' + p)
}

// ── 从统一入口派生「真的在跑的断言脚本」清单 ────────────────────────────────
const allSrc = fs.readFileSync(CHECK_ALL, 'utf8')
const IN_CHECKS = new Set([...allSrc.matchAll(/\['[^']+',\s*'(_[A-Za-z0-9_]+\.cjs)'/g)].map(m => m[1]))
if (IN_CHECKS.size === 0) die('从 _check_all.cjs 解析出 0 个断言脚本 —— CHECKS 格式可能已变')

// ── 读账本 ──────────────────────────────────────────────────────────────────
let ledger
try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8').replace(/^\uFEFF/, '')) }
catch (e) { die('毕业账本解析失败（注意：JSON 里不能用中文直角双引号）—— ' + e.message) }

const BUCKETS = ['assertions', 'partial', 'external', 'domain', 'waived']
for (const b of BUCKETS) if (ledger[b] === undefined) die('账本缺少 `' + b + '` 一节')
if (typeof ledger.backlogMax !== 'number') die('账本缺少数字字段 `backlogMax`')

// ── 读记忆库（只取所需字段，不整表 dump）────────────────────────────────────
let sqlite
try { sqlite = require('node:sqlite') } catch { die('本机 Node 没有 node:sqlite（需 ≥22.5）') }
let rows
try {
  const db = new sqlite.DatabaseSync(DB, { readOnly: true })
  rows = db.prepare('select id, status from lesson').all()
} catch (e) { die('读记忆库失败：' + e.message) }
const ACTIVE = new Set(rows.filter(r => r.status === 'active').map(r => r.id))
const ALLIDS = new Set(rows.map(r => r.id))
if (ACTIVE.size === 0) die('记忆库里 active lesson 为 0 —— 库读错了，这样的通过不算数')

// ── 校验账本 ────────────────────────────────────────────────────────────────
const findings = []
const onDemand = []             // 显式声明的按需落点（已带理由），单独报出，不混进"每次都会跑到"
const owner = new Map()          // id → 归宿（一个 id 只许有一个归宿，防止两处都写、两处都不做）
const need = (id, bucket, field) => {
  const rec = ledger[bucket][id]
  if (!rec || typeof rec !== 'object') { findings.push('【' + bucket + '】' + id.slice(0, 12) + ' 的值必须是对象'); return null }
  const v = rec[field]
  if (typeof v !== 'string' || !v.trim()) {
    findings.push('【缺字段】' + bucket + ' / ' + id.slice(0, 12) + ' 缺 `' + field + '`' + (bucket === 'waived' || bucket === 'partial' ? '（豁免与部分覆盖必须写清，否则就是合法地永远不做）' : ''))
    return null
  }
  return v
}

for (const bucket of BUCKETS) {
  for (const id of Object.keys(ledger[bucket])) {
    // E1 死引用：账本里的 id 必须真实存在
    if (!ALLIDS.has(id)) { findings.push('【死引用】账本引用了记忆库里不存在的 lesson：' + id); continue }
    if (owner.has(id)) findings.push('【归宿重复】' + id.slice(0, 12) + ' 同时出现在 ' + owner.get(id) + ' 与 ' + bucket + ' —— 一条 lesson 只许有一个归宿')
    else owner.set(id, bucket)
    if (!ACTIVE.has(id)) findings.push('【已退役】' + id.slice(0, 12) + ' 在记忆库里已不是 active，却仍占着账本 ' + bucket + ' 的位置（应从账本清掉，否则未分诊计数会失真）')

    if (bucket === 'assertions' || bucket === 'partial') {
      // E2 落点必须真的在统一入口里跑 —— 「工具存在」与「工具在流程里」是两件事，只有后者算数
      const landing = need(id, bucket, 'landing')
      const rec = ledger[bucket][id] || {}
      if (landing) {
        for (const s of landing.split(/[+＋,、\s]+/).map(x => x.trim()).filter(Boolean)) {
          if (!/^_[A-Za-z0-9_]+\.cjs$/.test(s)) { findings.push('【落点格式】' + id.slice(0, 12) + ' 的 landing 含非法脚本名：' + s); continue }
          if (IN_CHECKS.has(s)) continue
          // ★ 按需运行的落点（例如扰动回归 —— 它会**改工作区文件**，不能每次收尾都跑）：
          //   允许，但**必须显式声明并给出理由**（`onDemand` + `onDemandReason`）。
          //   **禁止静默豁免** —— 与 `_check_disposition.cjs` 同一条纪律：
          //   豁免本身可以存在，但它必须是一行看得见的字，而不是一个默认通过的缺口。
          if (rec.onDemand === true && typeof rec.onDemandReason === 'string' && rec.onDemandReason.trim()) {
            onDemand.push({ id: id.slice(0, 12), script: s })
          } else {
            findings.push('【落点不进流程】' + id.slice(0, 12) + ' 声称由 ' + s + ' 覆盖，**但它不在 _check_all.cjs 的 CHECKS 里** —— '
              + '没跑过的断言不算断言。若它确实是**按需运行**（如扰动回归会改工作区文件，不能每次收尾都跑），'
              + '必须在账本这一条上显式写 `"onDemand": true` 与 `"onDemandReason": "…"`。')
          }
        }
      }
      if (bucket === 'partial') { need(id, bucket, 'residual'); need(id, bucket, 'trigger') }
    }
    if (bucket === 'external') { need(id, bucket, 'track'); need(id, bucket, 'reason') }
    if (bucket === 'domain') { need(id, bucket, 'reason') }
    if (bucket === 'waived') { need(id, bucket, 'reason'); need(id, bucket, 'trigger') }
  }
}

// ── E4 唯一的牙齿：未分诊数必须严格等于 backlogMax ─────────────────────────
const untriaged = [...ACTIVE].filter(id => !owner.has(id))
const base = new Set(Array.isArray(ledger.baseline) ? ledger.baseline : [])
const untriagedNew = untriaged.filter(id => !base.has(id))

if (untriaged.length !== ledger.backlogMax) {
  if (untriaged.length > ledger.backlogMax) {
    findings.push('【未分诊增加】账本声明 backlogMax=' + ledger.backlogMax + '，实际未分诊 **' + untriaged.length + '** 条'
      + (untriagedNew.length ? '（其中 **' + untriagedNew.length + ' 条是账本建立之后新写的 lesson** —— 新 lesson 必须当场分诊：'
        + untriagedNew.slice(0, 5).map(i => i.slice(0, 12)).join('、') + (untriagedNew.length > 5 ? ' 等' : '') + '）' : '')
      + '。要么给它归宿，要么把 backlogMax 上调到 ' + untriaged.length + '（**上调等于承认这轮没做**）。')
  } else {
    findings.push('【账本未更新】未分诊已降到 ' + untriaged.length + ' 条，而账本仍写 ' + ledger.backlogMax + ' —— 请把 backlogMax 下调为 ' + untriaged.length + '（账本只有被维护才可能是绿的）。')
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const n = b => Object.keys(ledger[b]).length
console.log('记忆毕业断言（每条 active lesson 必须有归宿）')
console.log('  记忆库 active lesson：' + ACTIVE.size + ' 条')
console.log('  归宿分布：断言 ' + n('assertions') + ' ｜ 部分 ' + n('partial') + ' ｜ 外部复核 ' + n('external')
  + ' ｜ 领域事实 ' + n('domain') + ' ｜ 书面豁免 ' + n('waived'))
console.log('  未分诊：' + untriaged.length + ' 条（账本 backlogMax=' + ledger.backlogMax + '）')
console.log('  统一入口可用的断言脚本：' + IN_CHECKS.size + ' 个')
if (onDemand.length) {
  console.log('  按需落点 ' + onDemand.length + ' 处（**不在每次必跑路径上**，已在账本显式声明理由）：'
    + onDemand.map(o => o.id + '→' + o.script).join('、'))
}

if (untriagedNew.length) {
  // 新 lesson 是本机制最该拦的东西 —— 单独点名，不混在总数里
  console.log('  ⚠️ 账本建立后新增且未分诊：' + untriagedNew.length + ' 条')
}

if (findings.length) {
  console.log('')
  for (const f of findings) console.log('  ❌ ' + f)
  console.log('')
  console.log('有 ' + findings.length + ' 项未通过 —— **lesson 写下来了，但没有任何东西保证它会被执行。**')
  console.log('  分诊判据只有一句：**这个错能不能被一段代码拦下？** 能 ⇒ 去建断言；不能 ⇒ 写清它只能靠外部复核。')
  process.exit(1)
}
console.log('')
console.log('✅ 每条 active lesson 都有归宿，且每个「断言」落点都真的在统一入口里跑')
console.log('   （检查强度说明：本脚本查的是「有没有归宿、落点在不在流程里」，判不了归宿选得对不对。）')
process.exit(0)
