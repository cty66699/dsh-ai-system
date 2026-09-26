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
const SESSION_OF = new Map()   // id → 来源会话（按会话分别记账用）；必须在 try 之外，否则块作用域看不见
try {
  const db = new sqlite.DatabaseSync(DB, { readOnly: true })
  rows = db.prepare('select id, status, source_session from lesson').all()
  // id → 来源会话（2026-09-26：账本改成按会话分别记账，需要它）
  for (const r of rows) SESSION_OF.set(r.id, r.source_session || '(无来源)')
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

// ── E4 牙齿（v2，2026-09-26 改）：**按来源会话分别记账** ──────────────────
//   v1 的判据是「全部未分诊数必须严格等于 backlogMax」，那是**单一全局数字** ——
//   于是别的会话写几条，我这边就红灯一次（当天替人清了两次）。
//   ★ 但它不能简单删掉：**牙齿本身是对的**（新 lesson 不该悄悄溜过）。
//   ⇒ 改法是**加归属维度**：按 lesson.source_session 分组，逐组与账本比对，
//     并把「本会话的」与「其他会话的」分开报 —— 归因清晰，牙齿保留。
//   ⇒ 账本新字段 backlogBySession: { "<session-id>": 配额, ... }；
//     未在账本里出现过的会话 ⇒ 配额视为 0 ⇒ 它一写就红（那正是"新 lesson 必须当场分诊"）。
const bySession = new Map()
for (const it of untriaged) {
  const s = SESSION_OF.get(it) || '(无来源)'
  if (!bySession.has(s)) bySession.set(s, [])
  bySession.get(s).push(it)
}
const quota = ledger.backlogBySession || {}
const SELF = ledger.selfSession || null
const overQuota = []
for (const [sess, list] of bySession) {
  const q = typeof quota[sess] === 'number' ? quota[sess] : 0
  if (list.length !== q) overQuota.push({ sess, list, q })
}

// ★★ 2026-09-26 加（独立核验 F-4 —— 一个假绿）：
//   原来唯一的牙齿是 `if (list.length !== q)` —— **相等**判定 ⇒
//   把配额调成「恰好的数字」（backlogBySession 里写 3、实际也 3）就**完全静音**。
//   而"五桶全空（断言/部分/外部/领域/豁免 都是 0）"时 —— 也就是**一条都没分诊** —— 本该无条件报红。
//   ⇒ 实测：3 条 active lesson、五桶全空、配额=3 ⇒ 它打印「未分诊：3 条」然后报
//     「✅ 每条 active lesson 都有归宿」exit 0。**上面两行与结论直接矛盾。**
{
  // ★ 修（2026-09-26，第 49 轮）：这里原来把**同一份五桶清单又写了一遍** ——
  //   而第 58 行已经有一份 `BUCKETS` 了。两处**各自漂移**时（比如将来加第 6 个桶只改一处）
  //   会出现「一处认、一处不认」的静默不一致。**⇒ 改成用同一个常量。**
  //   ★ 这是「列举会漂移」的**第 6 种形态**：不是清单漏了东西，是**同一份清单写了两遍**。
  const totalBuckets = BUCKETS.reduce((a, k) => a + Object.keys(ledger[k] || {}).length, 0)
  // ★ 变量名以本文件为准：ACTIVE 是「记忆库里 status === active 的 id 集合」（第 73 行），
  //   untriaged 是「其中在账本里没有归宿的」（第 130 行）。
  if (ACTIVE.size > 0 && totalBuckets === 0) {
    console.error('❌ ' + ACTIVE.size + ' 条 active lesson，但毕业账本五个桶**全是空的** —— 一条都没分诊。')
    console.error('   ⇒ 「有 lesson 且一个归宿都没有」不可能算通过。')
    console.error('   ⇒ 给每条 lesson 一个归宿（断言 / 外部复核 / 领域事实 / 书面豁免），或把它标 stale。')
    process.exit(1)
  }
}

if (overQuota.length) {
  const selfOver = overQuota.filter(o => SELF && o.sess === SELF)
  const otherOver = overQuota.filter(o => !(SELF && o.sess === SELF))
  for (const o of overQuota) {
    // ★★ 2026-09-26 第 59 轮修（一个**真的误导了我**的假提示）：
    //   原来 `SELF` 取自 `ledger.selfSession`，而**账本里根本没有这个键** ⇒ `SELF = null`
    //   ⇒ 这一行的三元判断恒走 else ⇒ **每一条欠账都被写成「其他会话」**，
    //   而下面第 190 行还会**无条件**打印「本会话 0 欠账」。
    //   ⇒ 后果实测：我照它写进了收尾报告（"那 2 条不是我产生的"），**而其中一条是我当天写的。**
    //   ★ 错法值得记：**当它"不知道"时，它没有说不知道，而是自信地说"没有"。**
    //     这与本工作区既有的那条纪律正相反 ——「查不到就说查不到，永不报『已最新』」。
    //   ⇒ 修法：取不到就如实说**归属未知**，绝不猜。
    const who = SELF ? (o.sess === SELF ? '**本会话**' : '其他会话') : '**归属未知**'
    const dir = o.list.length > o.q ? '增加' : '减少（账本未同步）'
    findings.push('【未分诊' + dir + '·' + who + '】会话 ' + o.sess.slice(0, 22) + '… 未分诊 **' + o.list.length + '** 条（账本配额 ' + o.q + '）'
      + (o.list.length > o.q
        ? '。要么给它归宿，要么把 backlogBySession["' + o.sess + '"] 上调到 ' + o.list.length + '（**上调等于承认这轮没做**）。'
        : '。分诊掉了却没下调配额 —— 请把该会话的配额改成 ' + o.list.length + '。'))
  }
  if (selfOver.length) findings.push('【归属提示】**其中 ' + selfOver.length + ' 组是本会话的** —— 这部分该由本会话当天分诊，不能推给后来人。')
  if (otherOver.length && !selfOver.length) {
    if (!SELF) {
      // ★ 不知道就说不知道（第 59 轮）：不许把"我判不了"说成"不是我的"。
      findings.push('【归属未知】账本里没有 `selfSession`，**我无法判断这些欠账属于哪个会话** —— '
        + '**不要据此认为"不是本会话的"**（这一行原来会无条件打印「本会话 0 欠账」，实测误导过一次）。'
        + '要分开报：在账本顶层写 `"selfSession": "<你的 session-id>"`。')
    } else {
      findings.push('【归属提示】本次红灯**全部来自其他会话**（本会话 0 欠账）—— 按既有约定，别人的欠账不该算成本会话的失职；修法见 backlogBySession。')
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────
const n = b => Object.keys(ledger[b]).length
console.log('记忆毕业断言（每条 active lesson 必须有归宿）')
console.log('  记忆库 active lesson：' + ACTIVE.size + ' 条')
console.log('  归宿分布：断言 ' + n('assertions') + ' ｜ 部分 ' + n('partial') + ' ｜ 外部复核 ' + n('external')
  + ' ｜ 领域事实 ' + n('domain') + ' ｜ 书面豁免 ' + n('waived'))
// ★★ 2026-09-26 第 59 轮修（与「归属未知」同族的一个显示问题）：
//   原来这一行印 `backlogMax`，而那是 **v1 时代的「单一全局数字」** ——
//   自第 49 轮改成**按会话分别记账**之后，它**已经不是判据**了（牙齿在 backlogBySession）。
//   ⇒ 后果：实测打印出「未分诊 86 条（账本 backlogMax=87）」**然后报 ✅ 通过** ——
//     两个数字对不上却绿着，读的人（包括我自己）会以为"是不是漏掉了 1 条"。
//   ★ 与「归属未知」是同一族：**输出的字必须与结论一致**，对不上就要说清为什么。
const sessSum = [...bySession.values()].reduce((a, l) => a + l.length, 0)
console.log('  未分诊：' + untriaged.length + ' 条（按会话记账：' + bySession.size + ' 个会话，合计 ' + sessSum + '）')
if (untriaged.length !== ledger.backlogMax) {
  console.log('     （注：账本里那个历史数字 `backlogMax=' + ledger.backlogMax + '` **已不是判据** —— '
    + '第 49 轮起改为**按会话分别记账**，两者对不上是正常的。）')
}
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
