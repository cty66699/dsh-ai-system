// 工作区文件卫生断言（H-1 / H-2 / H-3）
// —— 把三条「写过错、也记过教训、但靠记性拦不住」的坑机械化。
//
// 为什么需要它（2026-09-25「记忆毕业评审」的产出）：
//   记忆库里有 130 条 lesson，其中 **19 条正文自己写着「同一个错又犯了」**。
//   评审的结论是：**凡「同一个错在写过教训之后仍然复发」的，必须停止写教训、改为造机制。**
//   判据很干脆 —— **这个错能不能被一段代码拦下？** 本脚本收的是答案为「能」的那几条。
//
//   H-1 `.ps1` 含非 ASCII 字节却没有 UTF-8 BOM          —— lesson 0muck738j-ae
//       PowerShell 5.1 读**无 BOM 的 UTF-8**会按 GBK 解 ⇒ 中文注释/字符串把语法整个搞坏，
//       报一堆 `Unexpected token` / `Missing closing '}'`，**看起来毫无道理**。
//       本机 shell 就是 PowerShell 5.1（无 pwsh），所以这条经常触发。
//       ★ **建成当天就在工作区里抓到活体实例**：`_（业务标识略）\（本机脚本名略）`（72 个非 ASCII 字节、无 BOM）。
//         那句话是对的：**教训写在记忆里，实例躺在工作区里，两者从未相遇** —— 直到有了这条断言。
//
//   H-2 文本文件不是 UTF-8                            —— lesson 0mudiz74u-80
//       形态 A（**写坏**）：用 PowerShell 的 `Get-Content -Raw` / `Set-Content` 改含中文的 UTF-8 文件，
//         会「按 GBK 解释再写回」⇒ 直接把源码写成非法 UTF-8（当时把 `cx-play.mjs` 写坏了）。
//         铁律是「改源码一律用 read/edit/write 文件工具」，但**纪律靠记性，断言靠机制** —— 所以扫。
//       形态 B（**写成别的编码**）：PowerShell 5.1 的 `>` 重定向与 `Out-File` 默认写 **UTF-16LE**（`FF FE`）。
//         ★ 这条是**断言第一次跑出来的**，不在任何 lesson 里 —— 建成当天在 `_（业务标识略）\` 抓到 9 个 UTF-16LE 文件。
//         **它同时也纠正了本脚本的第一版诊断**：第一版把这 9 个文件报成「不是合法 UTF-8，首个坏字节约在第 0 字节」，
//         而它们并没有坏，只是**编码不是 UTF-8**。⇒ **一个诊断错的断言比没有断言更糟**，
//         所以本项现在**先认 BOM 再判**：UTF-8 / UTF-16LE / UTF-16BE 各报各的，理由与修法都不同。
//       判据统一为：**本工作区的工具链（node / read / edit / write）只按 UTF-8 读** ——
//       凡不是 UTF-8 的文本文件，在这里都会被读成乱码，因此一律判失败。
//
//   H-3 `_tmp_*` 临时探查脚本残留                     —— lesson 0mubepmnb-27 ④「探查脚本用完即删」
//       探查脚本是最容易夹带敏感内容的载体（该 lesson 的形态③ 就是「打印一段上下文窗口，
//       窗口里并排的其他密钥全部明文泄漏」）。**残留的临时脚本 = 一个没人管的泄漏面。**
//       合规去处：删掉，或移进 `_归档_临时脚本_<日期>\`。
//
// 用法: node _check_hygiene.cjs [--target <配置>]
// 退出码: 0=干净  1=有发现  2=结构性错误  3=未配置 ⇒ 跳过
//
// ★ 检查强度说明（必须与结论一起给出）：
//   · H-1 单向可靠：报了就是真危险（PS 5.1 下确实会坏）；但它**只认 .ps1**，
//     `.bat` / `.cmd` 里的同类问题它管不了。
//   · H-2 只判「**能不能按 UTF-8 严格解码**」，判不了「内容对不对」——
//     一个被 GBK 写坏但恰好仍是合法 UTF-8 的文件，它抓不到。
//   · H-3 只认 `_tmp_` 前缀这一种命名约定。**换个名字就绕过去了** ——
//     所以它是纪律的护栏，不是纪律本身。
const fs = require('node:fs')
const path = require('node:path')
const _CFG = require('./_paths.cjs').load()

const ROOTS = _CFG.t.hygieneRoots
if (!ROOTS || !ROOTS.length) {
  console.log('⏭️  未配置：hygieneRoots ⇒ 本项**跳过**（自定义目标模式下不回落默认布局）')
  process.exit(3)
}

// 走目录时跳过的名字：**所有点开头**（含 `.git` / `（记忆库路径略）`，后者是记忆库的数据目录）与 `node_modules`。
// 与 `_check_flow_sync.cjs` 的 walk 保持同一口径。
const SKIP = name => name.startsWith('.') || name === 'node_modules'

// ★ 归档目录：**显式保留区**，不参与卫生检查（`_归档_临时脚本_20260923\` 里 34 个文件就是这么攒下的）。
//   纪律：这里是**名字前缀匹配**而不是"随便放哪都行"。想靠归档让检查变绿，得先看见这个常量 ——
//   而**改这个常量会出现在 diff 里**。同时脚本会**明说跳过了哪些归档目录**，不静默。
const ARCHIVE_RE = /^_归档_/

// H-2 认的文本扩展名。**不收二进制**（图片/PDF/数据库），也不收超大文件。
const TEXT_EXT = new Set(['.md', '.cjs', '.mjs', '.js', '.json', '.ps1', '.psm1', '.yml', '.yaml',
  '.txt', '.html', '.css', '.py', '.ts', '.tsx', '.jsx', '.bat', '.cmd', '.xml', '.csv'])
const MAX_BYTES = 8 * 1024 * 1024

// H-3 认的临时脚本命名约定。
const TMP_RE = /^_tmp[_.-]/i

const dec = new TextDecoder('utf-8', { fatal: true })

const findings = []
let nFiles = 0, nPs1 = 0, nText = 0, nSkippedBig = 0
const archives = []

function walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch { return }                       // 读不到的目录跳过，不让它把整项检查变成一次崩溃
  for (const e of entries) {
    if (SKIP(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (ARCHIVE_RE.test(e.name)) { archives.push(p); continue }   // 显式保留区，但**明说跳过**
      walk(p); continue
    }
    nFiles++
    const ext = path.extname(e.name).toLowerCase()
    let size = 0
    try { size = fs.statSync(p).size } catch { continue }

    // ── H-1：`.ps1` 含非 ASCII 就必须带 UTF-8 BOM ──────────────────────────
    if (ext === '.ps1') {
      nPs1++
      let buf
      try { buf = fs.readFileSync(p) } catch { continue }
      const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
      let nonAscii = 0
      for (const b of buf) if (b > 127) nonAscii++
      if (nonAscii > 0 && !bom) {
        findings.push({
          rule: 'H-1', file: p,
          why: '非 ASCII 字节 ' + nonAscii + ' 个但无 UTF-8 BOM（PowerShell 5.1 会按 GBK 解）',
        })
      }
    }

    // ── H-2：文本文件必须是 UTF-8（本工作区工具链唯一认的编码）──────────────
    if (TEXT_EXT.has(ext)) {
      if (size > MAX_BYTES) { nSkippedBig++; continue }
      let buf
      try { buf = fs.readFileSync(p) } catch { continue }
      nText++
      // **先认 BOM 再判** —— 否则会给 UTF-16 文件一个"已损坏"的错误诊断（第一版就是这么错的）。
      const bom = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE ? 'UTF-16LE'
        : buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF ? 'UTF-16BE'
          : null
      if (bom) {
        findings.push({
          rule: 'H-2', file: p,
          why: bom + ' 编码（**文件没坏，只是不是 UTF-8**）—— PowerShell 5.1 的 `>` 重定向与 `Out-File` 默认就写 UTF-16LE；'
            + '本工作区工具链按 UTF-8 读，会读成乱码。修法：转成 UTF-8，或删掉',
        })
      } else {
        try { dec.decode(buf) }
        catch {
          // 定位：用非 fatal 解码 + 找第一个替换字符。**近似而非精确**（U+FFFD 也是合法字符，
          //   正文里本来就有 U+FFFD 的文件会把它报偏）—— 所以措辞是"约"。
          let at = -1
          try { at = new TextDecoder('utf-8').decode(buf).search(/\uFFFD/) } catch { at = -1 }
          findings.push({
            rule: 'H-2', file: p,
            why: '无 BOM 且不是合法 UTF-8（疑似 GBK/latin-1，或被 `Get-Content`/`Set-Content` 按 GBK 写坏）'
              + (at >= 0 ? '；首个可疑字节约在第 ' + at + ' 个字符处' : ''),
          })
        }
      }
    }

    // ── H-3：临时探查脚本残留 ─────────────────────────────────────────────
    if (TMP_RE.test(e.name)) {
      findings.push({
        rule: 'H-3', file: p,
        why: '临时探查脚本残留（用完即删，或移入 `_归档_临时脚本_<日期>\\`）',
      })
    }
  }
}

for (const r of ROOTS) {
  if (!fs.existsSync(r)) { console.error('❌ 结构性错误：扫描根不存在 —— ' + r); process.exit(2) }
  walk(r)
}

// ★「扫了个空 ≠ 干净」—— 一个文件都没扫到就必须判失败，不能报 ✅。
//   （这是本册第五种假通过形态，见 lesson 0mufbaad7：`_publish_audit` 曾在空目录里报"通过"。）
if (nPs1 + nText === 0) {
  // ★★ 2026-09-26 修（独立核验 F-10 —— 一个假绿）：
  //   原来判 `nFiles === 0`，而 `nFiles++` **对每个文件都加**（包括 png 这类二进制与无关扩展名）。
  //   ⇒ 扫描根里只有一个 pic.png ⇒ nFiles=1 ⇒ 守卫过 ⇒ 报「✅ 三类都干净：…文本文件均为合法 UTF-8」——
  //     而**文本文件是 0 个**，那句话什么都没验证。改成判**真正被三类检查覆盖的文件数**。
  console.error('❌ 结构性错误：**没有被任何一类检查覆盖的文件**（扫到 ' + nFiles + ' 个，其中 .ps1 ' + nPs1 + ' 个、文本 ' + nText + ' 个）')
  console.error('   ⇒ 「扫了个空」不等于「干净」；扫描类检查必须断言集合非空。')
  process.exit(2)
}

console.log('文件卫生检查（H-1 编码 / H-2 UTF-8 / H-3 临时脚本残留）')
console.log('  扫描根：' + ROOTS.join('  ') )
console.log('  文件 ' + nFiles + ' 个｜其中 .ps1 ' + nPs1 + ' 个、文本 ' + nText + ' 个'
  + (nSkippedBig ? '（另有 ' + nSkippedBig + ' 个文本文件因超过 ' + (MAX_BYTES / 1024 / 1024) + ' MB 未扫）' : ''))
if (archives.length) {
  console.log('  ⏭️  跳过归档目录 ' + archives.length + ' 个（显式保留区，不静默）：'
    + archives.map(a => path.basename(a)).join('、'))
}

if (!findings.length) {
  console.log('')
  console.log('✅ 三类都干净：.ps1 编码合规、文本文件均为合法 UTF-8、无临时脚本残留')
  console.log('   （检查强度说明见脚本头部 —— H-1 只认 .ps1，H-2 只判可解码性，H-3 只认 `_tmp_` 前缀。）')
  process.exit(0)
}

const byRule = { 'H-1': [], 'H-2': [], 'H-3': [] }
for (const f of findings) byRule[f.rule].push(f)
const TITLE = {
  'H-1': 'H-1 · .ps1 含非 ASCII 却无 UTF-8 BOM（PowerShell 5.1 会按 GBK 解 ⇒ 中文注释/字符串把语法搞坏）',
  'H-2': 'H-2 · 文本文件不是 UTF-8（本工作区工具链只按 UTF-8 读；括号里写明是哪种非 UTF-8，修法不同）',
  'H-3': 'H-3 · 临时探查脚本残留（探查脚本最容易夹带敏感内容，用完即删）',
}
console.log('')
for (const rule of ['H-1', 'H-2', 'H-3']) {
  const rows = byRule[rule]
  if (!rows.length) continue
  console.log('❌ ' + TITLE[rule] + '　—— ' + rows.length + ' 处')
  for (const r of rows.slice(0, 15)) {
    const rel = path.relative(_CFG.ROOT, r.file) || r.file
    console.log('     ' + rel + '　—　' + r.why)
  }
  if (rows.length > 15) console.log('     … 另有 ' + (rows.length - 15) + ' 处')
  console.log('')
}
console.log('共 ' + findings.length + ' 处。')
process.exit(1)
