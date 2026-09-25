// 目录符合性对账 v2 —— **清单从源头自动派生**，消除"手写映射静默脱节"这个最大风险
// v1 的缺陷：检查词是手写 ITEMS，`00` 改了而脚本没改 ⇒ 断言静默失效且不报错。
// v2 的做法：从 `00` 解析条目名 → 与映射文件对账 → **集合不一致就报错**（脱节会立刻暴露）
// 用法: node _check_conformance.cjs [成品路径]
// 退出码: 0=全部落实且映射一致  1=有未落实项或映射脱节
//
// ⚠️ 两层边界（与 v1 相同，仍然成立）
//   · 只查"关键词是否出现"，**不判断是否真的落实到位**（出现一次提及也算通过）；
//   · **检出"未落实"是强信号；报"落实"是弱信号。** 完整判断仍须走 T3。
const fs = require('node:fs')
const path = require('node:path')

const _CFG = require('./_paths.cjs').requirePaths(['declaration', 'product', 'conformanceMap'])
const ROOT = _CFG.ROOT
const SRC = _CFG.t.declaration
const MAP = _CFG.t.conformanceMap
const TARGET = process.argv[2] ? path.resolve(process.argv[2]) : _CFG.t.product

const src = readText(SRC)
const lines = src.split(/\r?\n/)

// 读文本并剥掉 UTF-8 BOM —— **脚本不该因为 BOM 就崩**。
// （踩过：`Out-File -Encoding utf8` 在 pwsh 7 会写 BOM，`JSON.parse` 直接报 Unexpected token。）
function readText(p) { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '') }

// ── 从 §4.1 / §4.2 / §4.3 解析条目名 ────────────────────────────────────────
function section(startRe, endRe) {
  let on = false
  const out = []
  for (const ln of lines) {
    if (!on && startRe.test(ln)) { on = true; continue }
    if (on && endRe.test(ln)) break
    if (on) out.push(ln)
  }
  return out
}

const items = []

// §4.1：`**M1 xxx**` 形式
for (const ln of section(/^###\s*4\.1/, /^###\s*4\.2/)) {
  const m = ln.match(/^\*\*(M\d+)\s+(.+?)\*\*/)
  if (m) items.push({ list: '§4.1 六大公共模块', key: m[1] + ' ' + m[2].trim() })
}

// §4.2 / §4.3：表格首列（§4.3 用三列拼 —— 借出→借入：内容）
for (const ln of section(/^###\s*4\.2/, /^###\s*4\.3/)) {
  const t = ln.trim()
  if (!t.startsWith('|') || /^\|[\s\-:|]+\|$/.test(t)) continue
  const c = t.slice(1, -1).split('|').map(s => s.trim())
  if (!c[0] || /^数学工具$/.test(c[0])) continue
  items.push({ list: '§4.2 数学工具箱', key: c[0] })
}
for (const ln of section(/^###\s*4\.3/, /^---/)) {
  const t = ln.trim()
  if (!t.startsWith('|') || /^\|[\s\-:|]+\|$/.test(t)) continue
  const c = t.slice(1, -1).split('|').map(s => s.trim())
  if (c.length < 3 || /^借出方$/.test(c[0])) continue
  items.push({ list: '§4.3 互相借用', key: c[0] + ' → ' + c[1] + '：' + c[2] })
}

// ── 读映射 ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(MAP)) { console.log('❌ 映射文件不存在: ' + MAP); process.exit(1) }
const map = JSON.parse(readText(MAP))

// ── 集合对账（**这是 v2 的核心：脱节会报错，而不是静默失效**）────────────────
const srcKeys = items.map(i => i.key)
// 以 `_` 开头的是映射文件自己的元数据键，不参与条目对账
const mapKeys = Object.keys(map).filter(k => !k.startsWith('_'))
const missingInMap = srcKeys.filter(k => !(k in map))
const staleInMap = mapKeys.filter(k => !srcKeys.includes(k))

const tgt = readText(TARGET)

console.log('=== 目录符合性对账 v2（清单从源头自动派生）===')
console.log('目标声明：' + path.basename(SRC) + '（解析出 ' + items.length + ' 个条目）')
console.log('成品：    ' + path.basename(TARGET))
console.log('')

let bad = 0

// ── ★ 先拦住「解析出 0 个条目」（2026-09-25 修：访客实测复现的假绿）──────────────
//   原逻辑的漏洞：items 为空 ⇒ srcKeys 为空 ⇒ missingInMap 为空；若映射也是 {}，
//   staleInMap 也为空 ⇒ bad 保持 0 ⇒ **退出码 0、显示通过**。
//   但「解析出 0 个条目」的真实含义**不是"没有要求"**，而是**声明格式不符合本脚本的解析协议**。
//   ⇒ 这与本仓库自己的纪律直接冲突：**「扫了个空 ≠ 干净」** ——
//     `_check_refs` / `_check_json` / `_publish_audit` 都对空集判失败，**唯独这一项曾经没有**。
if (items.length === 0) {
  bad++
  console.log('❌ **解析出 0 个条目** —— 这不是「没有要求」，是**声明格式不符合本脚本的解析协议**。')
  console.log('')
  console.log('   本脚本认的结构是**硬编码**的（三段都从三级标题开始）：')
  console.log('     · `### 4.1` 到 `### 4.2` 之间：条目写成 `**M1 名称**` 形式（编号必须是 `M` + 数字）')
  console.log('     · `### 4.2` 到 `### 4.3` 之间：**首列**是条目名的表格（表头行会被跳过）')
  console.log('     · `### 4.3` 到 `---` 之间：**三列**表格（借出方 | 借入方 | 内容）')
  console.log('')
  console.log('   ⇒ **「扫了个空 ≠ 干净」**：0 个条目必须判失败，否则你会拿到一个**假绿** ——')
  console.log('     检查"通过"了，但它**一个要求都没对账过**。')
  console.log('   ⇒ 要么把你的声明改成上述结构（推荐：照 `example/目标声明.md` 的骨架），')
  console.log('     要么改写本脚本的解析规则来适配你自己的格式。**不要为了让它变绿而删要求。**')
  console.log('')
}

if (missingInMap.length || staleInMap.length) {
  bad++
  console.log('❌ **映射与源头脱节**（这正是 v1 会静默失效的情形，v2 让它报错）')
  missingInMap.forEach(k => console.log('   · `00` 里有但映射缺失：' + k))
  staleInMap.forEach(k => console.log('   · 映射里有但 `00` 已无：' + k))
  console.log('   ⇒ 请更新 `符合性映射.json`')
  console.log('')
}

// ── 断言自身的完整性检查：短 ASCII 词会被更长的单词吃掉（词内子串劫持）──────
// 实例（第 4 轮查出）：「可靠度理论（FORM/SORM/MC）」的检查词 `FORM` 命中的是
//   `conformal`（共形预测）里的 "form" —— 9 次"提及"全是假命中，
//   **这条断言自建成起一直假通过**，恰好掩盖了 T3 报的 A-08（可靠度计算路线未指定）。
// 这类错误**不报错、只静默给绿灯**，所以必须由脚本自己查出来。
// （同类前科：`（业务标识略）` 正则误命中 `accept` / `concept`。）
// ★ 2026-09-25：这两条自身风险检查**此前只打印告警、不影响退出码** ⇒ 每轮都亮、每轮都放过 ——
//   **正是一个永远亮着的红灯**（lesson （内部条目 id 略））。现已升级为 findings，计入退出码。
//
// ★ 判据必须看**解析之后的值**，不能看文件原文 —— 这是 lesson `0mudiz759-2c` 的
//   「校验器与被校验对象必须走同一条转换路径」。理由很具体：
//   **JSON 里写 `"\bOOD\b"`（单个反斜杠）会被 JSON.parse 解析成"退格符 U+0008"**，
//   正则需要的是**两个字符 `\` + `b`**（磁盘上要写成 `"\\bOOD\\b"`）。
//   若只看文件原文，`\bOOD\b` 看起来"有词边界"，而实际编译出来的是 `\x08OOD\x08` —— 永远匹配不到任何东西，
//   **静默假通过**。所以这里显式用 charCode 构造反斜杠，并显式检测控制字符。
let selfRisk = 0
const BSLASH_B = String.fromCharCode(92) + 'b'   // 两个字符：反斜杠 + b。**不是退格符。**
const risky = []
for (const [key, spec] of Object.entries(map)) {
  if (typeof spec !== 'string') continue
  for (const alt of spec.split('|')) {
    const a = alt.trim()
    const wrapped = a.startsWith(BSLASH_B) && a.endsWith(BSLASH_B)
    let core = wrapped ? a.slice(2, -2) : a
    const hadControl = /[\u0000-\u001F]/.test(core)
    core = core.replace(/[\u0000-\u001F]/g, '')
    if (!/^[A-Za-z0-9]{2,6}$/.test(core)) continue
    if (wrapped) continue
    risky.push(core + (hadControl
      ? '（原文含控制字符：JSON 里 `\\b` 才是词边界，`\b` 会被解析成退格符 U+0008 —— 正则永远匹配不到）'
      : ''))
  }
}
if (risky.length) {
  const uniq = [...new Set(risky)]
  console.log('❌ 断言自身风险：' + uniq.length + ' 个检查词是短 ASCII 词且未加词边界，')
  console.log('   会被更长的单词词内劫持（假通过）：' + uniq.join('、'))
  console.log('   ⇒ 修法：写成 \\bXXX\\b。**假通过比不通过更危险 —— 它是静默的。**')
  console.log('')
  selfRisk += uniq.length
}

// ── 断言自身的完整性检查之二：「多项条目」只检查了其中一项 ──────────────────
// 实例：§4.3 那条 `两者共享 → —：不完美检测推断引擎、本体与时空索引、边缘部署、主动学习流水线`
//   一次点名 4 个条目，而检查词只覆盖 1 个 ⇒ **另外 3 个即使全文没有也报「落实」**。
//   ——与 FORM/conformal 同类（假通过），只是成因是「项目漏检」而非「词内子串」。
const multi = []
for (const [key, spec] of Object.entries(map)) {
  if (typeof spec !== 'string') continue
  // 只认**顿号枚举**（`、`）—— 那才是"一次点名多个不同条目"。
  // `A / B` 多为同义别名或平行译名（如「子模优化 / 次模最大化」「Markov / Gamma / 更新过程」），
  // 任一命中即足以说明该项被用到 ⇒ **或式是对的**，不该报警（首版把 11 条全报出来，是假阳性）。
  // 括号内的顿号也不算（如「声学/振动信号识别（结构敲击回声、缆索振动 → 同源算法）」里那是同义并列）。
  const outsideParens = key.replace(/（[^）]*）|\([^)]*\)/g, '')
  if (outsideParens.includes('、')) multi.push(key)
}
if (multi.length) {
  console.log('❌ 断言自身风险：' + multi.length + ' 个条目名用顿号一次点名了**多个不同条目**，但检查词是**或**式字符串，')
  console.log('   只覆盖其中一项就会假通过。改成**数组**（与式）：')
  for (const k of multi) console.log('   · ' + k)
  console.log('')
  selfRisk += multi.length
}

let missing = 0, lastList = '', thin = 0
for (const it of items) {
  if (it.list !== lastList) { console.log('【' + it.list + '】'); lastList = it.list }
  const spec = map[it.key]
  if (spec === undefined) { console.log('  ⚠️ 无映射，跳过  ' + it.key); continue }
  if (spec === null) { console.log('  ⏭️ 方向不适用，跳过  ' + it.key); continue }
  // ★ 提及次数：本脚本的通过条件是"关键词出现过"，而这是**作者自己写进去的**。
  //   第 4 轮实测：我把 3 项 ❌ 写成 ✅，靠的只是在 `02` 里加了讨论它们的段落 ——
  //   退出码从 1 变 0，**而"把洞填上"与"给洞贴个标签"在这一层完全不可区分**。
  //   ⇒ 廉价缓解：把提及次数打出来，让"仅 1 次提及"在眼睛上就与"通篇论述"不同。
  //   这**治不了**根本问题（作者仍可刷提及次数），完整判断仍须走 T3。
  // ★ 检查词支持两种形态：
  //   · 字符串 = **或**（任一命中即算出现）—— 默认；
  //   · 数组   = **与**（每项都必须命中）—— 用于"一次点名多个条目"的映射，
  //     否则只覆盖其中一个就会假通过（实例：§4.3 那条一次点了 4 个条目，检查词只覆盖 1 个）。
  const specs = Array.isArray(spec) ? spec : [spec]
  let hits = 0, absent = false
  for (const s of specs) {
    const n = (tgt.match(new RegExp(s, 'gi')) || []).length
    if (n === 0) { absent = true; break }
    hits += n
  }
  if (absent) missing++
  const weak = !absent && hits === 1
  if (weak) thin++
  console.log('  ' + (absent ? '❌ 未落实' : (weak ? '⚠️ 仅1次提及' : '✅ 落实  ')) + '  ' + it.key + (absent ? '' : '  （提及 ' + hits + ' 次' + (specs.length > 1 ? '，与式 ' + specs.length + ' 项' : '') + '）'))
}

console.log('')
console.log('落实 ' + (items.length - missing) + ' / ' + items.length + ' 项，**未落实 ' + missing + ' 项**' + (thin ? '，其中 **仅 1 次提及（弱证据）' + thin + ' 项**' : ''))
if (selfRisk) console.log('**断言自身风险 ' + selfRisk + ' 项** —— 未加词边界的短检查词会让本脚本静默假通过，比"未落实"更危险。')
console.log('')
console.log('⚠️ 已知边界')
console.log('  · 只查「关键词是否出现」，**不判断是否真的落实到位**（出现一次提及也算通过）。')
console.log('  · **检出"未落实"是强信号；报"落实"是弱信号。** 完整判断仍须走 T3。')
console.log('  · 映射文件 `符合性映射.json` 需人工维护，但**脱节会被本脚本报错**（v1 不会）。')
process.exit(missing || bad || selfRisk ? 1 : 0)
