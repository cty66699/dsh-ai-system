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

// ★★ 2026-09-26 加（独立核验 F-3 —— 一个假绿）：
//   原来 tracks 为空数组、**或者键名拼错（写成 track 单数）** 时，
//   本脚本会打印「严格轨道：0 条」然后报「✅ 严格轨道的发现全部逐条有处置」exit 0。
//   ⇒ 一个什么都没查的清单，得到了一句「全部有处置」。
//   ★ 作者已经在 _check_conformance.cjs:88 修过同一个洞（0 条目 ⇒ 判失败）—— 唯独这一条没修。
if (!Array.isArray(man.tracks) || man.tracks.length === 0) {
  console.error('❌ 结构性错误：清单里解析出 0 条严格轨道 —— 检查类脚本必须断言集合非空。')
  console.error('   （常见原因：清单本来就是空的；或者键名拼错了 —— 是 tracks，不是 track。）')
  console.error('   ⇒ 「没有轨道要查」不等于「全部有处置」。')
  process.exit(2)
}

const findings = []
const legacyShown = []

// 表格列由表头确定。不得把新增的备注/日期列误认为处置，也不得假定编号后必有发现列。
const tableCells = line => {
  if (!line.trim().startsWith('|')) return null
  const cells = line.trim().split(/(?<!\\)\|/).slice(1)
  if (cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map(cell => cell.trim())
}
const columnName = cell => cell.replace(/[*`\s]/g, '')
function dispositionRows(lines) {
  let header = null
  return lines.map((line, index) => {
    const cells = tableCells(line)
    if (!cells) { header = null; return { line, cells: null } }
    const next = tableCells(lines[index + 1] || '')
    // 表头由紧随的分隔行确认；新表即使没有“处置”列，也必须替换旧表头。
    if (next && next.length === cells.length && next.every(cell => /^:?-+:?$/.test(cell))) { header = cells.map(columnName); return { line, headerRow: true } }
    if (cells.every(cell => /^:?-+:?$/.test(cell))) return { line, headerRow: true }
    return { line, cells, header }
  })
}

// ── 清单自身的完整性检查（断言必须能坏，不能坏得静默）────────────────────
// 踩过：idPattern 漏写捕获组时 `m[1]` 全是 undefined，脚本报出「重复编号 」这种空话；
//       idPattern 与报告格式脱节时解析出 0 条，看起来像"没有发现"而不是"断言坏了"。
for (const t of man.tracks || []) {
  if (!/\(.*\)/.test(t.idPattern || '')) findings.push(`【清单错误】${t.track} 的 idPattern 没有捕获组 —— 它会解析出 undefined`)
  if (t.mode === 'strict') {
    if (!t.dispositionPattern) findings.push(`【清单错误】${t.track} 是 strict 但没有 dispositionPattern`)
    else if (!t.dispositionPattern.includes('{ID}')) findings.push(`【清单错误】${t.track} 的 dispositionPattern 缺少 {ID} 占位符`)
  }
  if (t.mode === 'verifiedBy' && (!t.verifiedBy || !fs.existsSync(path.join(BASE, t.verifiedBy)))) {
    findings.push(`【核验委托无效】${t.track}：verifiedBy 指向的检查脚本不存在`)
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

  if (t.mode === 'verifiedBy') continue          // 此处仅核对委托脚本存在；其执行结果由统一入口负责
  if (t.mode === 'legacy') {
    legacyShown.push(`  ⏭️ ${t.track}：${ids.length} 条，**未强制逐条裁定** —— ${t.reason}`)
    continue
  }

  const ledPath = path.join(BASE, t.ledger)
  if (!fs.existsSync(ledPath)) { findings.push(`【无处置落点】${t.track}：找不到裁定记录 ${t.ledger}（${ids.length} 条发现无处安放）`); continue }

  const rows = dispositionRows(readText(ledPath).split(/\r?\n/))
  const unadjudicated = ids.filter(id => !rows.some(({ line: ln, cells, header, headerRow }) => {
    if (headerRow) return false
    const literalId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(t.dispositionPattern.replace('{ID}', () => literalId))
    const hit = re.exec(ln)
    if (!hit) return false
    const dispositionColumn = header ? header.indexOf('处置') : -1
    if (cells && (dispositionColumn < 0 || cells.length !== header.length)) return false
    const content = cells ? cells[dispositionColumn] : ln.slice(hit[0].length)
    // ★ 2026-10-02 修（T7 第 4 轮 R4-F01）：**占位词被装饰字符包裹时不再能冒充完成处置。**
    //   旧判据：先剥一撮写死的符号 `[|*#\s:：✅⚠️❌🔵]`，再**行首锚定**匹配占位词。
    //   而括号、反引号、书名号、破折号、表情**都不在那一撮里** ⇒ `(TODO)`、`（待补证据）`、
    //   `` `TODO` ``、`——待补证据`、`⏳待补证据` 的 `^` 全匹配不上 ⇒ 判为"已处置" ⇒
    //   **整条链路报绿、统一入口 `通过 12 / 12`** —— 与 R3-F01 同族的假绿，两轮未收敛。
    //   ⇒ 新判据把顺序倒过来：**先规范化**（去掉一切标点 / 符号 / 空白 / 表情，只留实义字符），**再整体判定**。
    //   ★ 判据的语义没有变（问的仍是"这一格里有没有实义内容"），
    //     变的是**装饰字符不再能挡住它** —— 即"已知占位词 + 标点"这条预注册判据真正成立。
    //   ★ 已知残余限制（如实写明，别当它覆盖全了）：这仍是**闭集词表**，措辞一变（如"稍后补"）就漏；
    //     本次只补了五个最常见的同义变体，它比的是"已知占位词"，不是"这句话的语义"。
    //   ★★ 2026-10-02 再修（T7 **第 5 轮 F-01**，独立复核抓到）：**分隔符要保留，不能一删了之。**
    //     上一版把标点 / 空白**全部删掉** ⇒ `TODO list` 规范化成 `TODOlist` ⇒
    //     词边界断言 `(?![A-Za-z])` 认为"TODO 后面还跟着字母，这不是那个词" ⇒ **放行**。
    //     而 `TODO list` / `TODO item` 恰恰是最常见的写法 —— **判据自己造出了一个逃逸口**。
    //   ⇒ 正解：标点 / 符号 / 空白**归一成一个空格**（**分隔信息留着，装饰信息去掉**），再判定。
    //     · `TODO list`      ⇒ `TODO list`      ⇒ 词边界成立 ⇒ **拦下** ✓
    //     · `TODOLIST 已归档` ⇒ 词边界不成立     ⇒ 放行 ✓（保住"不误伤长词"的原意）
    //     · `(TODO)` / `` `TODO` `` / `——待补证据` / `⏳待补证据` ⇒ 归一后仍是裸词 ⇒ 拦下 ✓
    const core = content
      .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')   // 表情：直接删（它不构成分隔）
      .replace(/[\p{P}\p{S}\p{Z}\p{C}]+/gu, ' ')                  // 标点 / 符号 / 空白 / 控制符 ⇒ **一个空格**
      .trim()
    if (!/[\p{L}\p{N}]/u.test(core) ||
        /^(待逐条补证据|待补充证据|待补证据|待处理|尚未处置|尚未处理|未处置|未处理|TODO(?![A-Za-z])|TBD(?![A-Za-z]))/i.test(core)) return false
    if (t.requireEvidenceLink) {
      // 仅核对和处置列提供证据；编号、发现、备注等其他列不得充当证据。
      const evidenceText = cells ? cells.filter((_, index) => index === dispositionColumn || /核对/.test(header[index])).join(' ') : ln.slice(hit[0].length)
      const links = [...evidenceText.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)].map(m => m[1])
      if (!links.some(ref => {
        const target = path.resolve(BASE, ref)
        return target.startsWith(BASE + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()
      })) return false
    }
    return true
  }))
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

// ★★★ 2026-09-26 修（一条从**独立审查**里躺了很久没处理的假绿 + 一次系统扫描把它照了出来）：
//   原来是 `_CFG.t.dispositionScanDirs || [HERE, path.join(HERE, '_briefs')]` ——
//   **未配置就回落到"断言层自己的目录"**。
//   ⇒ 后果有**两个方向**，两个都是错的（取决于那个目录里恰好有什么）：
//     · 扫到别人的报告 ⇒ 报「✅ 通过」（**假绿**：它查的是断言层自己的文件，不是被检查的工程）；
//     · 扫到自己人 ⇒ 报「⚠️【孤儿报告】…核查/xxx.md」（**假红**：报出来的"问题"不属于被检查的工程）。
//   ★ 这违反了本仓库自己的头号纪律：**"未配置的项不会回落到默认布局（否则会悄悄混用两个工程、得出假绿）"**。
//   ⇒ 改成**软依赖**：**未配置就跳过「孤儿报告」这一块，并明说**；
//     其余的检查（逐条处置、豁免理由、断言失效…）**照跑** —— 它们**不依赖** `dispositionScanDirs`。
const scanDirs = _CFG.t.dispositionScanDirs || null
// ⚠️ 这里曾被一次 edit 把换行吃掉，合成 `]const orphans = []` ⇒ SyntaxError。
//    教训：**用 old_string 结尾带 \n、new_string 不带 \n 做"删空行"是危险的** —— 它会粘行。
const orphans = []
if (scanDirs) {
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const rel = norm(path.relative(BASE, path.join(dir, f)))
      if (declared.has(rel) || exempt.has(rel)) continue
      orphans.push(rel)
    }
  }
} else {
  console.log('  ⏭️ 未配置 dispositionScanDirs ⇒ 跳过「孤儿报告」这一块检查')
  console.log('     （这一块要扫一个目录，看里面有没有既不是发现源头、也不是裁定记录、又没有豁免的报告；')
  console.log('       要看它，就把 dispositionScanDirs 指向你的报告目录。）')
}
if (scanDirs && orphans.length) findings.push(`【孤儿报告】以下文件既不是发现源头也不是裁定记录，也没有书面豁免 —— ${orphans.join('、')}`)

// ── 输出 ────────────────────────────────────────────────────────────────
const strict = (man.tracks || []).filter(t => t.mode === 'strict')
console.log('发现 → 处置 强制链路检查')
console.log(`  严格轨道：${strict.length} 条（${strict.map(t => t.track).join(' · ')}）`)
console.log(`  委托轨道：${(man.tracks || []).filter(t => t.mode === 'verifiedBy').length} 条（此处仅检查委托脚本存在；需在统一入口看它的执行结果）`)
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
// ★★ 2026-09-26 改：这句结论必须**跟着实际查了什么**走 ——
//   孤儿检查**没跑**的时候，不能在结论里声称「无孤儿报告」（那是把"没查"说成"查过了"）。
console.log(scanDirs
  ? '✅ 严格轨道的发现全部逐条有处置，无孤儿报告'
  : '✅ 严格轨道的发现全部逐条有处置（**「孤儿报告」那一块没查** —— 未配置 dispositionScanDirs）')
console.log('   （检查强度说明：本脚本断言「每条发现有非空的单独处置行」；requireEvidenceLink 轨道还要求有效文件链接。它**不能**判断处置对不对 ——')
console.log('     那是 T6 的活；也**不能**判断 legacy 轨道的 1:1 映射是否完整 —— 那是已知残余。）')
