// 占位符检查（P-1）—— 成品里**不许出现「未完成态标记」**。
//
// 为什么需要它（来自 T7 对抗性推演第二轮的三条发现，其中一条是**直接否决**）：
//   · A-1：指标表与规范表里有至少 7 行自标「待补 / 待核 / 未实测」——**提交日无法考核**。
//   · A-3：自定规矩「不得裸给数字」，自己裸给了一个 0.80。
//   · D-1：成品带三张全空申报要素表 + 几十处内部核验批注与修改留痕（「据 T7/核查补」「攻方原话」
//          「我自己先写错了一次」）。评审的原话是：**「这是工作底稿，不是申报书。形式审查这一关就过不去。」**
//   三条指向同一形态：**「成品看起来完整」与「成品真的完整」是两件事** ——
//   而在此之前，十项断言**没有一条**查这个形态（它们查引用、计数、映射、漂移，都是**结构**层面的）。
//
// ★ 检查强度说明（必须与结论一起给出，否则会被当成"通过 = 没问题"）：
//   · 本脚本**只认字形，不认语义** —— 它抓不到「填了个数、但那个数没有依据」，那是 P-2 的活。
//   · 它**会误报**：正文里正常讨论「该字段待核」这类表述也会被抓到。
//     ⇒ **报错时逐条判读**，不要无脑删词。
//   · 因此：**判「不能提交」可靠**（有占位符就一定不是成品）；**判「可以提交」不可靠**（单向可靠）。
//
// 用法: node _check_placeholders.cjs [--target <配置>]
// 退出码: 0=干净  1=发现占位符  2=结构性错误  3=未配置 ⇒ 跳过
const fs = require('node:fs')
const path = require('node:path')
const _CFG = require('./_paths.cjs').requirePaths(['product'])

// 要扫的交付物：成品（必配）+ 目标声明（配置了就一并扫）。
const TARGETS = [['成品', _CFG.t.product]]
if (_CFG.t.declaration) TARGETS.push(['目标声明', _CFG.t.declaration])

// 占位符模式。**每条都写清它抓什么**，因为「误报怎么判」取决于这条的意图。
const PATTERNS = [
  [/⬜/g, '未填方格（表格空行）'],
  [/待填|待补|待核|待定|未实测|未测定/g, '自标未完成'],
  [/\bTODO\b|\bTBD\b|\bFIXME\b|\bWIP\b/gi, '英文未完成标记'],
  [/[（(]\s*略\s*[)）]|×××|xxx+/g, '略去符'],
]

  // ═══ 豁免机制（2026-09-26 加 —— 此前**一点都没有**，这是个真空缺）═══
  // 为什么要加：这个检查的判据是「成品里有没有未完成态标记」，而它**必然**会在两种情况下误报：
  //   ① **那不是本次交付的成品**（例如工作区里另一个项目的文档，它的待办与本次无关）；
  //   ② **那处标记是"诚实的待办"**（作者明确写了"待核/未实测"，那是如实标注，不是没做完没说）。
  // ⇒ 而本项目一贯的原则是「**禁止静默豁免**」：豁免可以存在，**但必须写明理由、且理由可审计**。
  //   此前这个脚本没有豁免通道 ⇒ 使用者只有两条路：**要么改产品（可能篡改证据）、要么关掉这个检查（更糟）**。
  // ★ 照 `_check_refs.cjs` 的做法，加**两种**（都要求带理由）：
  //   ① **行内**：该行含 `placeholders:ignore` ⇒ 跳过，**理由写在行内**；
  //   ② **文件级**：配置里 `placeholderExempt` = `{ "文件名.md": "理由" }` ⇒ 整个文件跳过，
  //      **并在输出里把"豁免了谁、为什么"打出来**（不打印就等于静默）。
  const EXEMPT_FILES = _CFG.t.placeholderExempt || {}
  const exempted = []
const found = []
let scanned = 0
for (const [label, file] of TARGETS) {
  if (!fs.existsSync(file)) { console.error('❌ 找不到' + label + '：' + file); process.exit(2) }
  scanned++
  // ★ 文件级豁免（理由在配置里，且下面会打印出来）
  const __base = path.basename(file)
  // ★ 注意：这里是 `for` 循环体，不是函数体 ⇒ 必须用 `continue`（写 `return` 是语法错）。
  if (EXEMPT_FILES[__base]) { exempted.push([__base, EXEMPT_FILES[__base]]); continue }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    // ★ 行内豁免（理由写在那一行里，让豁免本身可审计）
    if (/placeholders:ignore/.test(line)) return
    for (const [re, why] of PATTERNS) {
      const m = line.match(re)
      if (m) found.push({ label, file, line: i + 1, why, hit: [...new Set(m)].join(' '), text: line.trim().slice(0, 90) })
    }
  })
}

// ★「扫了个空 ≠ 干净」—— 一个文件都没扫到就必须判失败，不能报 ✅。
if (scanned === 0) { console.error('❌ 没有扫到任何交付物 —— 扫描类检查必须断言集合非空。'); process.exit(2) }

// ★ 豁免必须**打印出来** —— 不打印就等于静默豁免，而那正是本项目禁止的。
if (exempted.length) {
  console.log('⏭️  按配置豁免了 ' + exempted.length + ' 份（理由如下，可审计）：')
  for (const [b, why] of exempted) console.log('     · ' + b + ' —— ' + why)
}

if (!found.length) {
  // ★ 修（2026-09-26）：原来这里说「N 份交付物未出现占位符」—— 而豁免掉的文件**并没有被查**，
  //   那句话会把"没查"说成"查了且干净"（本项目最忌讳的那种）。改成把两者分开报。
  const reallyScanned = scanned - exempted.length
  console.log('✅ ' + reallyScanned + ' 份交付物未出现占位符（' + PATTERNS.length + ' 类模式）'
    + (exempted.length ? '；另有 ' + exempted.length + ' 份**按配置豁免、未参与本次检查**（理由见上）' : ''))
  console.log('   （单项可靠：有占位符 ⇒ 一定不是成品；无占位符 ⇏ 已完整 —— 见脚本头部"检查强度说明"）')
  process.exit(0)
}

console.log('❌ 发现 ' + found.length + ' 处未完成态标记 —— **这不是"格式问题"，是"还没做完"**。')
console.log('   评审对同类形态的原话：「这是工作底稿，不是申报书。形式审查这一关就过不去。」')
console.log('')
const byFile = new Map()
for (const f of found) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f) }
for (const [file, rows] of byFile) {
  console.log('   ' + path.basename(file) + '（' + rows.length + ' 处）')
  for (const r of rows.slice(0, 12)) {
    console.log('     L' + String(r.line).padEnd(5) + '[' + r.why + '：' + r.hit + ']  ' + r.text)
  }
  if (rows.length > 12) console.log('     … 另有 ' + (rows.length - 12) + ' 处')
}
console.log('')
console.log('   ⚠️ 逐条判读：**正文里正常讨论这些词也会被抓到**（误报）。')
console.log('      ⇒ 不要为了让它变绿而删词 —— 要**把每一处真的填上或真的删掉那一行**。')
process.exit(1)
