// 死引用与歧义引用检查 —— 把「引用前必须核对」变成脚本断言
// 背景：我曾把「`02` L336 明写温度标定」写进 AGENTS.md，而 `02_体系现状_v3.md` 只有 154 行；
//       该错误随工作区指令进入了**每一次会话注入**，而我自己读不到自己的系统提示。
// 用法: node _check_refs.cjs [根目录]   默认 = 方案设计的上层（工作区根）
// 退出码: 0=无问题  1=发现悬空引用或歧义引用
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.argv[2] || path.resolve(__dirname, '..', '..')
// 扫描目录：默认 = 本工作区布局；若配置给了 `scanDirs` 则用它（公开仓库指向 example/）。
// ★ 自定义目标模式下**未配置即跳过** —— 否则会静默去扫默认工程，得出"假绿"。
const _C = require('./_paths.cjs').load()
const _SCAN_OVERRIDE = _C.t.scanDirs
if (_C.usingCustomTarget && !_SCAN_OVERRIDE) {
  console.log('⏭️  未配置：scanDirs ⇒ 本项**跳过**（自定义目标模式下不回落默认布局）')
  process.exit(3)
}
const SCAN_DIRS = _SCAN_OVERRIDE || [ROOT, path.join(ROOT, '方案设计')]

// 已知的短名歧义（同一工作区里多个文件都被这样简称）
const AMBIGUOUS_SHORT = { '00': ['00_总览与共性技术底座.md', '00_AI体系重排.md'], '02': ['02_体系现状_v3.md', '02_任务二_（未发表项目）.md'] }

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // ★★ 2026-09-26 加（F-7 修复的连带发现）：原来只跳过「以 . 开头」与 node_modules，
    //   而本工作区里有若干**不以 . 开头的内部目录**（回退点 / 沙箱 / 各种测试目录）——
    //   它们不该被当成"待检查的正文"。实测：`_回退点提交前_20260925` 里的**历史报告**
    //   被扫出来一堆「文件不存在」—— 那是**历史快照**，不是待修的引用。
    //   ★ 这套前缀与 `_check_ps_syntax.cjs` / `_check_text_hygiene.cjs` 保持一致。
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (/^(_回退点|_沙箱|_sandbox|_开荒测试|_复现测试|_clone测试|_fakebin|\.build-|\.tmp-|\.oss-clean)/.test(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

// 建索引：文件名 → 行数（全工作区，按 basename）
const lineCount = new Map()
const byBase = new Map()
// ── 文件级豁免：**核验方的报告是证据，不得为了迁就我们的引用格式而改写它** ──────────
// 实例（2026-09-24）：Kimi 的 T7 第二轮报告里用了短名 `` `02` L834 `` 这类写法，
//   触发「歧义引用」。但那是**核验方自己的表述**，改写它就等于篡改证据。
//   ⇒ 对这类文件豁免**歧义**检查（悬空检查仍然保留，因为它指出的可能是真问题）。
//   ⚠️ 代价：这类文件内部的歧义引用不再被查 —— **写在这里，不假装没有。**
const EVIDENCE_FILES = [/^T7对抗性推演_.*\.md$/, /^第三轨道_.*\.md$/, /^框架漏洞审查_.*\.md$/,
  /^T[56].*\.md$/, /^事实核查_.*\.md$/, /^推导复核_.*\.md$/, /^规程核验_.*\.md$/, /^裁定复核_.*\.md$/]
const isEvidence = p => EVIDENCE_FILES.some(re => re.test(path.basename(p)))
const files = [...new Set(SCAN_DIRS.flatMap(d => walk(d)))]
// ★ 扫了个空 ≠ 干净：「0 个文件里没有悬空引用」是句废话。
//   实测（2026-09-24）：干净副本里本项曾因为目标没透传、扫到 0 个文件而报 ✅。
if (files.length === 0) {
  console.error('❌ 扫描到 **0 个** .md 文件（' + SCAN_DIRS.join(' / ') + '）—— 这样的「未发现」不算数，判为失败')
  process.exit(1)
}
for (const f of files) {
  const n = fs.readFileSync(f, 'utf8').split(/\r?\n/).length
  lineCount.set(f, n)
  const b = path.basename(f)
  if (!byBase.has(b)) byBase.set(b, [])
  byBase.get(b).push({ file: f, lines: n })
}

let problems = 0, checked = 0
const report = []

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  const lines = text.split(/\r?\n/)
  // 文件若已声明简称约定（「文件简称约定」字样），则短名歧义已被人为消解 ⇒ 跳过「模式二」。
  // 这是让检查器**认可显式声明**，而不是把告警压下去：悬空引用检查（模式一）仍然照跑。
  const declaresConvention = /文件简称约定/.test(text)
  // 核验方产物 ⇒ 歧义检查豁免（理由见上方 EVIDENCE_FILES 注释）
  const evidence = isEvidence(f)
  lines.forEach((ln, i) => {
    // 带理由的豁免：该行若含 `check-refs:ignore`，跳过检查。
    // ⚠️ 豁免必须**在行内写明理由**，使豁免本身可审计 —— 这是"压告警"与"标注已知假阳性"的区别。
    if (/check-refs:ignore/.test(ln)) return
    // 模式一：`某文件名.md` 附近的 L<数字>
    // ⚠️ 匹配窗口**不得跨越括号或引号** —— 否则会把「描述历史」的句子（如
    //    「我曾留下一个死引用（引 `02` L336…）」）误判成活引用。这是本脚本第一版的假阳性来源。
    // ★★ 2026-09-26 修（独立核验 F-7 —— 一个假绿）：**文件名字符类里原来不含全角括号**，
    //   而 `.md` 前面那个字符恰好是 `）` ⇒ 整条匹配失败 ⇒ 引用数永远是 0 ⇒ 报「✅ 未发现悬空引用」。
    //   实测：`成品（v2）.md` 配一句死引用「见 成品（v2）.md L999」⇒ 解析到 0 处、报通过；
    //   换成纯 ASCII 文件名 ⇒ 立刻报悬空。
    //   ★ 注意：**只给"文件名"加括号，不给"匹配窗口"加** —— 窗口跨越括号会把
    //     「描述历史」的句子误判成活引用（见上面那段注释，那是第一版的假阳性来源）。
    const re = /([\w\u4e00-\u9fa5.（）\-]+\.md)[^\n（）()「」【】]{0,40}?L(\d+)/g
    let m
    while ((m = re.exec(ln)) !== null) {
      const target = m[1], n = Number(m[2])
      checked++
      const cands = byBase.get(target)
      if (!cands) { report.push({ f, line: i + 1, kind: '文件不存在', detail: target + '  L' + n }); problems++; continue }
      if (!cands.some(c => c.lines >= n)) {
        report.push({ f, line: i + 1, kind: '悬空引用', detail: target + '  L' + n + '（该文件仅 ' + Math.max(...cands.map(c => c.lines)) + ' 行）' })
        problems++
      }
    }
    // 模式二：短名歧义（如 `02` L336）—— **仅当该文件未声明「文件简称约定」、且它不是核验方证据时才检查**
    if (!declaresConvention && !evidence) {
      const re2 = /`(\d{2})`[^\n（）()「」【】]{0,20}?L(\d+)/g
      while ((m = re2.exec(ln)) !== null) {
        const short = m[1], n = Number(m[2])
        checked++
        const names = AMBIGUOUS_SHORT[short]
        if (!names) continue
        const cands = names.flatMap(x => byBase.get(x) || [])
        const ok = cands.filter(c => c.lines >= n)
        if (!ok.length) {
          report.push({ f, line: i + 1, kind: '悬空引用（短名）', detail: '`' + short + '` L' + n + ' —— 候选文件均不足该行数' })
          problems++
        } else if (ok.length < cands.length) {
          report.push({ f, line: i + 1, kind: '★歧义引用', detail: '`' + short + '` L' + n + ' —— 只有 ' + ok.map(c => path.basename(c.file)).join('、') + ' 够长，但短名本身有歧义，应写全名' })
          problems++
        }
      }
    }
  })
}

console.log('=== 死引用 / 歧义引用检查 ===')
console.log('扫描 .md 文件：' + files.length + ' 个    解析到文件+行号引用：' + checked + ' 处')
console.log('')
if (!report.length) console.log('✅ 未发现悬空或歧义引用')
else {
  for (const r of report) {
    console.log('  ' + (r.kind.startsWith('★') ? '⚠️ ' : '❌ ') + r.kind + '  ' + path.relative(ROOT, r.f) + ':' + r.line)
    console.log('      ' + r.detail)
  }
}
console.log('')
console.log('⚠️ 已知边界：')
console.log('  · **歧义引用检查可靠**（短名 `02` 等有歧义，必须写全名）。')
console.log('  · **悬空引用检查有假阳性**：文本上无法区分「引用」与「描述一个引用」')
console.log('    （例如复核报告里写的"裁定引的 L336 不存在"会被当成活引用）。**该类别须人工判断。**')
console.log('')
console.log(problems ? '🔴 共 ' + problems + ' 处需处理' : '✅ 通过')
process.exit(problems ? 1 : 0)
