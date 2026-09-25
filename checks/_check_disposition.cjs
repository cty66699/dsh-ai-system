// 发现 → 处置 的强制链路断言（**通用版**，取代只管 T7 的 _check_t7_disposition.cjs）
//
// 治什么（X-13）：体系里原本有断言管「引用不断」「计数不飘」「目录不脱节」，
//   却**没有一条**管「核验方报了发现，主控逐条处置了没有」。
//   后果实测两次：T7 的 25 条裁定数搁了一整轮是 0；T3 的 A-05~A-10 被**批量合并成一行**
//   「倾向成立，待逐条补证据」，而那 6 条里 A-05/A-06/A-07 后来被证实是真窟窿
//   （02 §7.2 可靠度只做 R 侧、S 侧从未定义）。**批量裁定就是处置的漏斗。**
//
// 设计原则（沿用 _check_conformance.cjs v2 的教训）：**发现清单从源头派生，不手写**。
//
// 用法: node _check_disposition.cjs [--quiet-legacy]
// 退出码: 0=全部通过  1=有发现（漏裁定/批量裁定/孤儿报告）  2=结构性错误（清单或源头坏了）
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
const _CFG = require('./_paths.cjs').requirePaths(['dispositionManifest'])
// ★ 清单内部的相对路径（source / ledger / exempt）一律以 `_CFG.base` 为基准 ——
//   默认布局下 base === HERE（行为不变）；自定义目标下 base = 配置文件所在目录。
//   踩过：原来一律 `path.join(HERE, t.source)`，于是示例目标下会去脚本目录找核验报告。
const BASE = _CFG.base
const MAN = _CFG.t.dispositionManifest
const quietLegacy = process.argv.includes('--quiet-legacy')

// BOM 容错：pwsh 的 `Out-File -Encoding utf8` 会写 BOM ⇒ JSON.parse 会崩。
const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const die = m => { console.error('❌ 结构性错误：' + m); process.exit(2) }

if (!fs.existsSync(MAN)) die('找不到清单：' + MAN)
let man
try { man = JSON.parse(readText(MAN)) } catch (e) { die('清单 JSON 解析失败：' + e.message) }

const findings = []
const legacyShown = []

// ── 清单自身的完整性检查（断言必须能坏，不能坏得静默）────────────────────
// 踩过：idPattern 漏写捕获组时 `m[1]` 全是 undefined，脚本报出「重复编号 」这种空话；
//       idPattern 与报告格式脱节时解析出 0 条，看起来像"没有发现"而不是"断言坏了"。
for (const t of man.tracks || []) {
  if (!/\(.*\)/.test(t.idPattern || '')) findings.push(`【清单错误】${t.track} 的 idPattern 没有捕获组 —— 它会解析出 undefined`)
  if (t.mode === 'strict') {
    if (!t.dispositionPattern) findings.push(`【清单错误】${t.track} 是 strict 但没有 dispositionPattern`)
    else if (!t.dispositionPattern.includes('{ID}')) findings.push(`【清单错误】${t.track} 的 dispositionPattern 缺少 {ID} 占位符`)
  }
  if (t.mode === 'legacy' && !t.reason) findings.push(`【清单错误】${t.track} 是 legacy 但没写 reason —— 禁止静默豁免`)
}

// ── 逐轨道：源头派生 id → 在 ledger 里找「逐条处置行」─────────────────────
for (const t of man.tracks || []) {
  const srcPath = path.join(BASE, t.source)
  if (!fs.existsSync(srcPath)) { findings.push(`【源头缺失】${t.track}：找不到 ${t.source}`); continue }

  const ids = []
  for (const m of readText(srcPath).matchAll(new RegExp(t.idPattern, 'gm'))) if (m[1]) ids.push(m[1])
  if (ids.length === 0) { findings.push(`【断言失效】${t.track}：从 ${t.source} 解析出 0 条发现 —— idPattern 可能已与报告脱节`); continue }
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i)
  if (dup.length) findings.push(`【源头重复】${t.track}：报告里有重复编号 ${[...new Set(dup)].join('、')}`)

  if (t.mode === 'verifiedBy') continue          // 已由另一脚本断言，不重复
  if (t.mode === 'legacy') {
    legacyShown.push(`  ⏭️ ${t.track}：${ids.length} 条，**未强制逐条裁定** —— ${t.reason}`)
    continue
  }

  const ledPath = path.join(BASE, t.ledger)
  if (!fs.existsSync(ledPath)) { findings.push(`【无处置落点】${t.track}：找不到裁定记录 ${t.ledger}（${ids.length} 条发现无处安放）`); continue }

  const lines = readText(ledPath).split(/\r?\n/)
  const unadjudicated = ids.filter(id => !lines.some(ln => new RegExp(t.dispositionPattern.replace('{ID}', id)).test(ln)))
  if (unadjudicated.length) {
    findings.push(`【未逐条处置】${t.track}：${t.ledger} 里找不到以下 ${unadjudicated.length}/${ids.length} 条的**单独**处置行 —— ${unadjudicated.join('、')}`)
  }
}

// ── 覆盖检查：每个报告文件都必须有处置落点或书面豁免（禁止静默）──────────
const declared = new Set()
// ★ 2026-09-26 修：**分隔符归一化**。
//   原来只做 `declared.add(t.source)`，而下面算出的 `rel` 是 `path.relative(...)` 的结果 ——
//   在 Windows 上是**反斜杠**（`docs/核验报告.md`），于是清单里写正斜杠（`docs/核验报告.md`）
//   会被判成"孤儿报告"：**同一个文件，一处说它是源头、一处说它是孤儿**。
//   清单是**跨平台的数据文件**，不该逼作者写死某一种分隔符 ⇒ 两边都归一成 `/` 再比。
const norm = (s) => String(s || '').replace(/\\/g, '/')
for (const t of man.tracks || []) { declared.add(norm(t.source)); if (t.ledger) declared.add(norm(t.ledger)) }
for (const f of man.ledgerOnly || []) declared.add(norm(f))
const exempt = new Map((man.exempt || []).map(e => [norm(e.file), e.reason]))

// ★ 2026-09-25 修（GPT-6 第二轮实测）：`exempt` 缺 `reason` 也能通过 —— 而本文件自己的
//   `_纪律` 写着「**禁止静默豁免**」。原来 `reason` 被存进 Map 却**从没被检查过**，
//   于是"给个 file 字段、理由留空"就能悄悄放行一个报告。
//   判据：**豁免本身可以存在，但它必须是一行看得见的理由，而不是一个默认通过的缺口。**
const badExempt = (man.exempt || []).filter(e => !e || typeof e.reason !== 'string' || !e.reason.trim())
if (badExempt.length) {
  findings.push('【豁免无理由】以下 exempt 条目没有 reason（或只有空白）—— '
    + '**豁免可以存在，但必须说明理由**：'
    + badExempt.map(e => (e && e.file) || '(连 file 字段都缺)').join('、'))
}

const scanDirs = _CFG.t.dispositionScanDirs || [HERE, path.join(HERE, '_briefs')]
// ⚠️ 这里曾被一次 edit 把换行吃掉，合成 `]const orphans = []` ⇒ SyntaxError。
//    教训：**用 old_string 结尾带 \n、new_string 不带 \n 做"删空行"是危险的** —— 它会粘行。
const orphans = []
for (const dir of scanDirs) {
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue
    const rel = norm(path.relative(BASE, path.join(dir, f)))
    if (declared.has(rel) || exempt.has(rel)) continue
    orphans.push(rel)
  }
}
if (orphans.length) findings.push(`【孤儿报告】以下文件既不是发现源头也不是裁定记录，也没有书面豁免 —— ${orphans.join('、')}`)

// ── 输出 ────────────────────────────────────────────────────────────────
const strict = (man.tracks || []).filter(t => t.mode === 'strict')
console.log('发现 → 处置 强制链路检查')
console.log(`  严格轨道：${strict.length} 条（${strict.map(t => t.track).join(' · ')}）`)
console.log(`  历史轨道：${(man.tracks || []).filter(t => t.mode === 'legacy').length} 条（豁免逐条强制，但豁免理由可见）`)
if (!quietLegacy && legacyShown.length) { console.log(''); for (const l of legacyShown) console.log(l) }

if (findings.length) {
  console.log('')
  for (const f of findings) console.log('  ⚠️ ' + f)
  console.log('')
  console.log(`有 ${findings.length} 项未通过`)
  process.exit(1)
}

console.log('')
console.log('✅ 严格轨道的发现全部逐条有处置，无孤儿报告')
console.log('   （检查强度说明：本脚本断言「每条发现单独有一行处置」。它**不能**判断处置对不对 ——')
console.log('     那是 T6 的活；也**不能**判断 legacy 轨道的 1:1 映射是否完整 —— 那是已知残余。）')
