// JSON 预检 —— 治「直角引号」那个坑
//
// 为什么必须有它（而不是再写一条 lesson）：
//   往 JSON 里写中文时顺手打了 `"…"`（直角双引号）⇒ `JSON.parse` 崩、退出码 2。
//   这个错我**踩了三次**，其中一次**就在我刚把它记成 lesson 之后**。
//   ⇒ 判断很干脆：**这个错能被一段代码拦下 ⇒ 就不该再靠记性。**
//
// 另一个改进：默认的报错只给 `position 1844 (line 13 column 1411)`，
//   还得人自己去切字符串看。**本脚本把出错位置附近的原文直接打出来。**
//
// 用法: node _check_json.cjs [--target <配置>]
// 退出码: 0=全部可解析  1=有文件解析失败  2=结构性错误
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
const ROOT = path.resolve(HERE, '..', '..')
const _C = require('./_paths.cjs').load()
const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')

// 扫描范围：自定义目标模式下用配置的 scanDirs；否则本工作区布局
const SCAN = _C.t.scanDirs || [ROOT, path.join(ROOT, '方案设计')]
if (_C.usingCustomTarget && !_C.t.scanDirs) {
  console.log('⏭️  未配置：scanDirs ⇒ 本项**跳过**（自定义目标模式下不回落默认布局）')
  process.exit(3)
}

// ★ 2026-09-25 加：**排除浏览器 profile 目录**。
//   起因（实测）：本工作区会被**多个会话并行使用** —— 跑自动化课程的那个会话在工作区里留了一个
//   419 MB 的 Chrome profile，其中 `FirstPartySetsPreloaded\…\sets.json` 是 Chrome 自己生成的、
//   **不是合法 JSON** ⇒ 本项扫全工作区时命中它 ⇒ **JSON 预检无故红灯**（"551 个正常 / 1 个失败"）。
//   判据：**"扫到别人的活产物"不是我的发现，是我的扫描范围错了** —— 该修范围，不是去删别人的目录。
//   特征：Chrome / Edge 的 profile 根目录里有这几个固定文件名（比"目录名叫 profile"可靠得多）。
const BROWSER_MARKERS = ['Local State', 'FirstPartySetsPreloaded', 'Last Version', 'SingletonLock']
const isBrowserProfile = d => {
  try { return BROWSER_MARKERS.some(m => fs.existsSync(path.join(d, m))) } catch { return false }
}

function walk(dir, out = []) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (isBrowserProfile(p)) continue          // ← 整棵浏览器 profile 树跳过（不是我的产物）
      walk(p, out)
    } else if (e.name.endsWith('.json')) out.push(p)
  }
  return out
}

const files = [...new Set(SCAN.flatMap(d => walk(d)))]
const bad = []
let ok = 0
for (const f of files) {
  const text = readText(f)
  try { JSON.parse(text); ok++ } catch (e) {
    // 从 V8 的报错里抠出位置
    const m = /position (\d+)/.exec(e.message)
    const pos = m ? Number(m[1]) : -1
    const ctx = pos >= 0 ? text.slice(Math.max(0, pos - 70), pos + 40).replace(/\r?\n/g, '⏎') : ''
    bad.push({ f, msg: e.message, ctx })
  }
}

console.log('JSON 预检：扫描 ' + files.length + ' 个 .json（' + SCAN.map(d => path.relative(ROOT, d) || '.').join(' / ') + '）')

if (files.length === 0) {
  // ★ 扫了个空 ≠ 干净（同族第 5 条假通过）
  console.log('⚠️ 扫描到 **0 个** .json 文件 —— 这样的"通过"不算数，判为失败')
  process.exit(1)
}

if (bad.length) {
  console.log('')
  for (const b of bad) {
    console.log('  ❌ ' + path.relative(ROOT, b.f))
    console.log('     ' + b.msg)
    if (b.ctx) {
      console.log('     出错处原文：…' + b.ctx + '…')
      // 最常见的成因直接点出来，省一轮往返
      if (/[""]/.test(b.ctx)) console.log('     ⚠️ 附近出现**直角双引号**（""）—— JSON 字符串里必须用「」')
      else if (/"\s*[^,:}\]"\\]/.test(b.ctx)) console.log('     ⚠️ 附近可能有**未转义的双引号**')
    }
  }
  console.log('')
  console.log('有 ' + bad.length + ' 个文件无法解析（' + ok + ' 个正常）')
  process.exit(1)
}

console.log('✅ 全部 ' + files.length + ' 个 .json 均可解析')
