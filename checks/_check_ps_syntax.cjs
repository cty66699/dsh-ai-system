// ── PowerShell 语法门 ────────────────────────────────────────────────────────
//
// 治什么（2026-09-26 建；起因是**同一个坑第 6 次复发**）
// ────────────────────────────────────────────────────────────────────────────
// `_check_syntax.cjs` 的门只管 `.cjs / .js / .mjs`；`.ps1` **此前没有任何语法门**。
// 而 `.ps1` 恰恰是这套交付物里最容易「文本变形且静默」的文件类型：
//   · 中文注释 + 中文输出是常态 ⇒ 编码问题本来就多；
//   · PowerShell 的字符串规则与 JS 不同（`""` 转义、反引号、**中文引号不是引号**）；
//   · **在字符串里嵌半角引号 ⇒ 字符串提前结束** ⇒ 后面变成裸标识符。
//
// ★ 为什么要机械化成断言，而不是「我下次注意」
//   2026-09-26 那天，同一类错犯了**第 6 次**：前 5 次手工改掉、接着犯；
//   第 6 次我加「兜底正则」批量修，**它又误伤了一行**（把 `"结果"` 改成了 `「，不看」`）。
//   ⇒ **靠纪律压不住第 6 次。** 而这次那 14 处语法错，是我**手工跑一次 Parser**才发现的 ——
//     换句话说：**发现它的能力一直存在，只是没进流程。** 那就让它进流程。
//
// ★ 判据用 **PowerShell 自己**（`[System.Management.Automation.Language.Parser]::ParseFile`），
//   不是我自己写的正则 —— 正则判不出「谁和谁是一对引号」。
//   实测：一个朴素的「引号后跟汉字」候选式在本仓库 5 个 .ps1 上命中 **75 行，全是误报**
//   （它把「开引号后的正常内容」也算了进去）。**让语法解析器判语法**，这是唯一可靠的判据。
//
// ★ 两个实现细节（都是踩出来的）：
//   ① 子进程输出**走文件**，不走 stdout 管道 —— 沙箱下管道是命名管道，会 EPERM；
//   ② 调用的是 `powershell`（5.1）而不是 `pwsh`（7）—— **脚本要跑的正是 5.1**，
//      用 7 的解析器会把 `||` 之类「7 合法、5.1 不合法」的写法放过去。
//
// 用法: node _check_ps_syntax.cjs [--target <配置>]
// 退出码: 0=全部可解析  1=有语法错  2=跑不起来（结构性）  3=未配置（跳过）

'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// ★ 平台检查：本项只在 Windows 上有意义 —— 其它平台没有 PowerShell。
//   显式跳过（exit 3）比报「跑不成」诚实：后者会被误读成这一项坏了。
if (process.platform !== 'win32') {
  console.log('⏭️  非 Windows 平台 ⇒ 本项**跳过**（没有 PowerShell 可调）')
  process.exit(3)
}

const HERE = __dirname
let _CFG = null
try { _CFG = require('./_paths.cjs').load() } catch { _CFG = null }

// 扫描根：用配置里的 syntaxRoots（与 `_check_syntax.cjs` 同键 —— 语义相同：都是「我们自己的脚本」）。
// 未配置 ⇒ 显式跳过（不回落整个工作区：那会扫到别的项目，报出与本次无关的红）。
// ★★ 2026-09-26 修（独立核验 F-1 —— 一个假绿，而且是我重复犯的）：
//   原来那句的右边是 `(process.argv.includes('--target') ? null : [path.resolve(HERE, '..')])`，
//   而 `_paths.cjs` 的 `load()` **会把 `--target <值>` 从 argv 里 splice 掉**（它在上面就跑了），
//   所以 `process.argv.includes('--target')` **永远为 false** ⇒ 那个「未配置就跳过」的守卫是**死代码**，
//   直接落进 `[path.resolve(HERE, '..')]` ⇒ **扫的是断言层自己的目录**。
//   ⇒ 实测：用户工程里放一个真语法错的 .ps1、配置不写 syntaxRoots ⇒ 它报「✅ 全部可解析」exit 0。
//   ★ 而我刚刚才在 `_check_text_hygiene.cjs` 里修过同一个错（扫自己）—— 修完之后建的新脚本又犯了。
//   ★ 正解就是姊妹门 `_check_syntax.cjs:37` 的写法：**只认配置，不认 argv**。
const ROOTS = (_CFG && _CFG.t && _CFG.t.syntaxRoots) || null
if (!ROOTS || !ROOTS.length) {
  console.log('⏭️  未配置：syntaxRoots ⇒ 本项**跳过**')
  process.exit(3)
}

// ★ 修（第 49 轮）：这份清单原来在这里与 `_check_text_hygiene.cjs` 各写了一遍 ⇒ 改用共享常量。
//   ★ 同样别写 fallback（那会把清单又写一遍）—— 同目录 require 不会失败。
const SKIP_DIRS = new Set(require('./_paths.cjs').SKIP_DIRS_SCRIPTS)
const SKIP_PREFIX = ['.build-', '.tmp-', '.oss-clean', '_回退点', '_沙箱', '_sandbox', '_开荒测试', '_复现测试', '_fakebin']

const files = []
function walk(dir) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (SKIP_PREFIX.some(p => e.name.startsWith(p))) continue
      walk(path.join(dir, e.name))
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.ps1')) {
      files.push(path.join(dir, e.name))
    }
  }
}
for (const r of ROOTS) walk(r)

if (!files.length) {
  // ★★ 2026-09-26 修（独立核验 F-2）：扫到 0 个目标 ⇒ **结构性错误**，不是「干净」。
  //   本仓库自己的纪律是「**扫了个空 ≠ 干净**」（_check_json / _publish_audit / _check_hygiene /
  //   _check_conformance 都实现了）—— 唯独这一条漏了。姊妹门 _check_syntax.cjs:159 判 exit 2。
  console.error('❌ 结构性错误：扫描到 0 个 .ps1 —— 扫描类检查必须断言集合非空。')
  console.error('   （「没有 .ps1 要检查」不等于「全部可解析」；要么给 syntaxRoots 一个真有 .ps1 的目录，要么本项应跳过。）')
  process.exit(2)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-syntax-'))
const filesTxt = path.join(TMP, 'files.txt')
const outFile = path.join(TMP, 'out.txt')
fs.writeFileSync(filesTxt, files.join('\n'), 'utf8')

// 让 PowerShell 自己解析，并把结果**写进文件**
const psScript = [
  "$ErrorActionPreference = 'Continue'",
  "$paths = Get-Content -LiteralPath '" + filesTxt.replace(/'/g, "''") + "' -Encoding UTF8",
  "$out = New-Object System.Collections.Generic.List[string]",
  "$bad = 0",
  "foreach ($p in $paths) {",
  "  if (-not (Test-Path -LiteralPath $p)) { continue }",
  "  $text = [System.IO.File]::ReadAllText($p)",
  "  # ★★ 加（2026-09-26）：**AST 级检查 —— 抓「解析器不报错、但引号已被切断」**",
  "  #   起因：本工作区最常犯的错（已 16 次）是「在字符串里嵌半角引号」。",
  "  #   实测：那种写法 **PowerShell 解析器报 0 错**（它把后半截当成**第二个参数**），",
  "  #     而运行时被调函数只收第一个 ⇒ **内容静默截断**。",
  "  #   ⇒ 光靠 ParseFile 的 $errs **抓不到它**（那正是这道门此前的盲区）。",
  "  #   判据（实测能区分真伪）：找一个命令里**相邻的两个字符串常量**，其中**后一个不以引号开头**",
  "  #     且它在源码里**紧贴着**前一个（中间无空白）—— 正常的 `Write-Host 'a' 'b'` 有空格，不会命中。",
  "  $ast = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$null)",
  "  $cmds = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)",
  "  foreach ($c in $cmds) {",
  "    $strs = @($c.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.StringConstantExpressionAst] })",
  "    if ($strs.Count -lt 2) { continue }",
  "    for ($i = 1; $i -lt $strs.Count; $i++) {",
  "      $t = $strs[$i].Extent.Text",
  "      if ($t.StartsWith('\"') -or $t.StartsWith(\"'\")) { continue }",
  "      $gap = $text.Substring($strs[$i-1].Extent.EndOffset, $strs[$i].Extent.StartOffset - $strs[$i-1].Extent.EndOffset)",
  "      if ($gap -match '\\s') { continue }",
  "      $bad++",
  "      $out.Add('FILE=' + $p)",
  "      $out.Add('  LINE=' + $strs[$i].Extent.StartLineNumber + ' MSG=★ 引号被切断：字符串里嵌了半角引号（后半截变成了第二个参数）')",
  "      $out.Add('    CODE=' + $t.Substring(0, [Math]::Min(90, $t.Length)))",
  "      break",
  "    }",
  "  }",
  "  $errs = $null",
  "  $null = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs)",
  "  if ($errs -and $errs.Count -gt 0) {",
  "    $bad++",
  "    $out.Add('FILE=' + $p)",
  "    foreach ($e in ($errs | Select-Object -First 5)) {",
  "      $out.Add('  LINE=' + $e.Extent.StartLineNumber + ' MSG=' + $e.Message)",
  "    }",
  "  }",
  "}",
  "$out.Add('TOTALFILES=' + $paths.Count)",
  "$out.Add('BADFILES=' + $bad)",
  "[System.IO.File]::WriteAllLines('" + outFile.replace(/'/g, "''") + "', $out, [System.Text.UTF8Encoding]::new($false))",
].join('\n')

try {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript], { stdio: ['ignore', 'ignore', 'ignore'] })
} catch (e) {
  console.error('❌ 调 PowerShell 失败：' + String(e.message).slice(0, 120))
  console.error('   ⇒ 这一项**没跑成**（不是「通过了」）。')
  process.exit(2)
}

let output = ''
try { output = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '' } catch { output = '' }
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }

if (!output.trim()) {
  console.error('❌ PowerShell 没有产出结果 —— 这一项**没跑成**（不是「通过了」）。')
  process.exit(2)
}

const lines = output.split(/\r?\n/).filter(l => l.trim())
let badFiles = 0
for (const l of lines) if (l.startsWith('BADFILES=')) badFiles = Number(l.slice(9)) || 0

console.log('▶ PowerShell 语法门（用 PowerShell 自己的解析器）')
console.log('  扫描 ' + files.length + ' 个 .ps1｜可解析 ' + (files.length - badFiles) + '｜**有语法错 ' + badFiles + '**')

if (badFiles > 0) {
  console.log('')
  for (const l of lines) {
    if (l.startsWith('FILE=')) console.log('  ❌ ' + path.basename(l.slice(5)))
    else if (l.trim().startsWith('LINE=')) {
      const m = l.trim().match(/^LINE=(\d+)\s+MSG=(.*)$/)
      if (m) console.log('       line ' + m[1] + '：' + m[2])
    }
  }
  console.log('')
  console.log('  这些是**真语法错**（PowerShell 解析器判的，不是我的正则）—— 脚本跑不起来。')
  console.log('  ★ 常见原因：字符串里嵌了半角引号 ⇒ 字符串提前结束 ⇒ 后面变成裸标识符。')
  console.log('    修法：内层引号改用中文引号「」，或写成转义形式。')
  console.log('')
  console.log('  ❌ 有 ' + badFiles + ' 个文件不可解析')
  process.exit(1)
}

console.log('  ✅ 全部可解析')
process.exit(0)