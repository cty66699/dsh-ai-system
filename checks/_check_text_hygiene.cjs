#!/usr/bin/env node
/**
 * 文本卫生检查（_check_text_hygiene.cjs）— 第 2 版
 * ============================================================================
 * 2026-09-25/26 两天里，同一类错误犯了 10 次以上，形态各异但**归属同一层**：
 *   · BOM：`.ps1` 缺 ⇒ PS 5.1 按 GBK 解、中文全乱；`.ssh/config` 多 ⇒ ssh 不认整个文件。
 *   · 引号：PowerShell 字符串里嵌半角引号 ⇒ 提前结束字符串 ⇒ 输出静默截断成半句。
 *   · 注释符：在 JS 里写 PowerShell 代码，注释用成 `//` ⇒ 被当代码解析。
 *   · 替换：用批量正则修引号，把**正确的** `""` 转义也一起改坏（把对的改错了）。
 *
 * **共同点：全是「文本变形」，而且全是静默的** —— 不报错、语法可能还过得去，
 * 只是内容悄悄错了；发现成本全压在"人工读输出"上。⇒ 那就该机械化。
 *
 * 第 2 版新增（2026-09-26）：全角标点混入代码 / 换行符混用 / JS 语法（内置编译检查）。
 *
 * 与 _check_hygiene.cjs 的分工（★ 别重复建设）：
 *   那一项管**编码与残留**（.ps1 缺 BOM / 可解码性 / 临时脚本残留）；
 *   本脚本管**文本结构与新鲜度**（多余 BOM / 引号 / 注释符 / 生成物陈旧 / 全角 / 换行符 / JS 语法）。
 *
 * 退出码：0 = 通过 / 1 = 有发现 / 2 = 结构性错误
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const HERE = __dirname
const ROOT = path.resolve(HERE, '..')
const findings = []
const hints = []   // 提示（不判红、不影响退出码）—— 判据不够可靠但值得看一眼的

const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm', 'public', 'sessions', 'cache', 'logs', 'attachments'])
const SKIP_DIR_PREFIX = ['.build-', '.tmp-', '.oss-clean', '_回退点']
const MAX_SIZE = 2 * 1024 * 1024
const MUST_NOT_HAVE_BOM = new Set(['.cjs', '.js', '.mjs', '.json', '.yaml', '.yml', '.md', '.txt', '.gitignore'])
const MUST_NOT_HAVE_BOM_NAMES = new Set(['config', '.gitignore', 'LICENSE'])

function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (SKIP_DIR_PREFIX.some(p => e.name.startsWith(p))) continue
      walk(path.join(dir, e.name), out)
    } else if (e.isFile()) out.push(path.join(dir, e.name))
  }
  return out
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
function readBuf(p) { try { return fs.readFileSync(p) } catch { return null } }
const hasBom = (b) => b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF
const textOf = (b) => b.toString('utf8').replace(/^\uFEFF/, '')
const push = (kind, file, line, detail, fix) => findings.push({ kind, file, line, detail, fix })

// 1. 多余的 BOM（缺 BOM 交给 _check_hygiene.cjs 的 H-1）
function checkBom(files) {
  for (const f of files) {
    const ext = path.extname(f).toLowerCase(), base = path.basename(f)
    const buf = readBuf(f)
    if (!buf || !buf.length || buf.length > MAX_SIZE) continue
    if (!hasBom(buf)) continue
    if (MUST_NOT_HAVE_BOM.has(ext) || MUST_NOT_HAVE_BOM_NAMES.has(base)) {
      push('BOM 多余', rel(f), 0, base + ' 不该有 BOM（解析器会报意外的字符，或污染 diff）', '按 UTF-8 without BOM 重写')
    } else if (base === 'config' || f.includes(path.sep + '.ssh' + path.sep)) {
      push('BOM 多余', rel(f), 0, 'SSH 配置绝不能有 BOM —— 实测：ssh 直接不认整个文件（Bad configuration option）', '按 UTF-8 without BOM 重写')
    }
  }
}

// 2. PowerShell 引号未闭合（静默截断）。判据第 3 版：数未转义的半角引号，奇偶判定。
//    为什么不用更聪明的写法："" 的语义取决于它是空串边界还是串内转义，
//    想按语义数就得做状态机，而状态机一写错就误报。误报比漏报更糟 —— 会让人不再信任这个检查。
function checkPsQuotes(files) {
  const CMD = /^\s*(Say|Warn|Ok|Fail|Problem|\$bad \+=)\s+"/
  for (const f of files) {
    if (path.extname(f).toLowerCase() !== '.ps1') continue
    const buf = readBuf(f); if (!buf || buf.length > MAX_SIZE) continue
    textOf(buf).split(/\r?\n/).forEach((line, i) => {
      const s = line.trim()
      if (s.startsWith('#')) return
      if (!CMD.test(line)) return
      let cnt = 0
      for (let k = 0; k < line.length; k++) {
        if (line[k] === '`') { k++; continue }
        if (line[k] === '"') cnt++
      }
      if (cnt % 2 !== 0) push('引号未闭合', rel(f), i + 1, '该行有 ' + cnt + ' 个半角双引号（奇数）⇒ 字符串没闭合 ⇒ 输出会被静默截断。原文：' + s.slice(0, 70), '内层引号改用中文引号或双写转义')
    })
  }
}

// 3. PowerShell 里出现 // 注释（PS 只认 #）
function checkWrongComment(files) {
  for (const f of files) {
    if (path.extname(f).toLowerCase() !== '.ps1') continue
    const buf = readBuf(f); if (!buf || buf.length > MAX_SIZE) continue
    textOf(buf).split(/\r?\n/).forEach((line, i) => {
      if (/^\s*\/\/\s/.test(line)) push('注释符写错', rel(f), i + 1, 'PowerShell 的注释是 #，不是 //（这行会被当代码解析）。原文：' + line.trim().slice(0, 70), '把行首的 // 改成 #')
    })
  }
}

// 4. 生成物比源陈旧
function checkGeneratedFreshness() {
  const pairs = [
    [path.join(HERE, '_public_src', 'deploy', 'install.ps1'), path.join(HERE, 'public', 'deploy', 'install.ps1')],
    [path.join(HERE, '_public_src', 'README.md'), path.join(HERE, 'public', 'README.md')],
    [path.join(HERE, '_public_src', 'REQUIREMENTS.md'), path.join(HERE, 'public', 'REQUIREMENTS.md')],
  ]
  for (const [src, dst] of pairs) {
    if (!fs.existsSync(src) || !fs.existsSync(dst)) continue
    if (fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs + 1000) push('生成物陈旧', rel(dst), 0, '源（' + rel(src) + '）比它新 ⇒ 改了源但没重新生成公开仓', '跑 node _build_public_docs.cjs')
  }
}

// 5. 全角标点混入代码行（只查像代码的行，且先剥字符串）
function checkFullWidth(files) {
  const FULL = /[（）｛｝［］，；：]/g
  const CODEISH = /^\s*(?:\$|if\b|else|foreach|function|param|return|Write-|Say|Warn|Ok|Fail|const|let|var|await|import|export|for\b|while\b|switch\b|try\b|catch\b)/i
  for (const f of files) {
    const ext = path.extname(f).toLowerCase()
    if (!['.ps1', '.cjs', '.js', '.mjs'].includes(ext)) continue
    const buf = readBuf(f); if (!buf || buf.length > MAX_SIZE) continue
    textOf(buf).split(/\r?\n/).forEach((line, i) => {
      const s = line.trim()
      if (s.startsWith('#') || s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return
      if (!CODEISH.test(line)) return
      const noStr = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''")
      const hit = noStr.match(FULL)
      if (hit) {
        // ★ 降级为「提示」而不是判红（2026-09-26 实测）：
        //   我的"剥字符串"只处理了 "…" 和 '…'，**剥不掉模板串 `` `…` `` 与正则 /…/ **，
        //   于是把 `console.log(`今日：${x}`)` 这种【内容里的全角】全报成了语法错 ——
        //   一跑就 20+ 条假警报。而剥正则本身就很难（`/` 也可能是除号）。
        //   ⇒ 按「**误报比漏报更糟**」的原则：**降级为提示**，不判红、不影响退出码。
        hints.push('全角标点 ' + [...new Set(hit)].join('') + ' @ ' + rel(f) + ':' + (i + 1) + '  原文：' + s.slice(0, 60))
      }
    })
  }
}

// 6. 换行符混用
function checkMixedEol(files) {
  for (const f of files) {
    const ext = path.extname(f).toLowerCase()
    if (!['.ps1', '.cjs', '.js', '.mjs', '.json', '.yaml', '.yml', '.md'].includes(ext)) continue
    const buf = readBuf(f); if (!buf || buf.length > MAX_SIZE) continue
    let crlf = 0, lf = 0
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0A) { if (i > 0 && buf[i - 1] === 0x0D) crlf++; else lf++ }
    if (crlf > 0 && lf > 0 && Math.min(crlf, lf) > 1) push('换行符混用', rel(f), 0, '同一文件里既有 CRLF（' + crlf + '）又有 LF（' + lf + '）⇒ diff 会整片变红', '统一成一种（Windows 用 CRLF 正常，但别混）')
  }
}

// 7. JS 语法（内置编译检查，不调外部命令）
function checkJsSyntax(files) {
  for (const f of files) {
    const ext = path.extname(f).toLowerCase()
    if (!['.cjs', '.js', '.mjs'].includes(ext)) continue
    const buf = readBuf(f); if (!buf || buf.length > MAX_SIZE) continue
    const src = textOf(buf)
    if (/^\s*(import|export)\s/m.test(src)) continue
    try { new vm.Script(src, { filename: f }) } catch (e) { push('JS 语法错', rel(f), 0, String(e.message).split('\n')[0], '修掉语法错') }
  }
}

const t0 = Date.now()
const files = walk(ROOT)
checkBom(files); checkPsQuotes(files); checkWrongComment(files); checkGeneratedFreshness()
checkFullWidth(files); checkMixedEol(files); checkJsSyntax(files)

console.log('▶ 文本卫生检查（BOM多余 / 引号 / 注释符 / 生成物陈旧 / 全角标点 / 换行符 / JS语法）')
console.log('  扫描 ' + files.length + ' 个文件｜7 类检查')
if (findings.length) {
  console.log('')
  for (const f of findings) {
    const loc = f.line ? f.file + ':' + f.line : f.file
    console.log('  ❌ [' + f.kind + '] ' + loc)
    console.log('       ' + f.detail)
    console.log('       ⇒ ' + f.fix)
  }
  console.log('')
  console.log('  ❌ 有 ' + findings.length + ' 处发现（' + (Date.now() - t0) + ' ms）')
  console.log('')
  console.log('  这些错都是文本变形且静默型 —— 语法可能过、脚本可能跑，只是内容悄悄错了。')
  process.exit(1)
} else {
  console.log('  ✅ 通过（' + (Date.now() - t0) + ' ms）')
  if (hints.length) {
    console.log('')
    console.log('  ℹ️  ' + hints.length + ' 条提示（**不判红** —— 判据不够可靠，可能有假阳性，仅备查）：')
    hints.slice(0, 6).forEach(h => console.log('       · ' + h))
    if (hints.length > 6) console.log('       … 另有 ' + (hints.length - 6) + ' 条')
  }
  process.exit(0)
}