// 收敛账计数核对 —— 把「计数必须对得上」变成脚本断言，而不是靠人眼
// 用法: node _check_counts.cjs <裁定记录.md>
// 退出码: 0=全部一致  1=有不一致
const fs = require('node:fs')

const p = process.argv[2]
if (!p) { console.log('用法: node _check_counts.cjs <裁定记录.md>'); process.exit(1) }
if (!fs.existsSync(p)) { console.log('文件不存在: ' + p); process.exit(1) }

const text = fs.readFileSync(p, 'utf8')
const lines = text.split(/\r?\n/)

// 找「收敛账」小节里的表格行：| **状态** | **N** | 编号列表 |
const rows = []
let inSection = false
for (const ln of lines) {
  if (/^##+\s*.*收敛账/.test(ln)) { inSection = true; continue }
  if (inSection && /^##+\s/.test(ln)) break
  if (!inSection) continue
  const m = ln.match(/^\|\s*\*\*(.+?)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*(.*?)\s*\|\s*$/)
  if (m) rows.push({ label: m[1], declared: Number(m[2]), body: m[3] })
}

if (!rows.length) { console.log('⚠️ 未在「收敛账」小节里解析到任何行 —— 检查表格格式'); process.exit(1) }

let bad = 0, sumDeclared = 0, sumActual = 0
console.log('=== 收敛账计数核对 ===')
console.log('状态'.padEnd(16) + '标称'.padStart(6) + '实际'.padStart(6) + '  结果')
for (const r of rows) {
  // 只数「编号列表本身」：先剥掉括号里的补充说明，否则描述中提到的编号（如「与 F-11 绑定」）会被误计。
  const bare = r.body.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '')
  // ★ 2026-09-26 修：原来**硬编码** /F-\d+/，于是只认作者自己那套编号 ——
  //   公开仓的示例用 R-1/R-2（核验报告给的编号），到这里**解析出 0 条**，
  //   报的却是"未在收敛账小节里解析到任何行"，**看起来像文档格式错，实际是脚本认死了前缀**。
  //   同族的 _check_disposition.cjs 早就做对了：编号规则由每条轨道的 idPattern 声明。
  //   ⇒ 改成接受**通用的「大写字母 + 连字符 + 数字」编号**（1-3 个字母），圈号后缀照旧兼容。
  const ids = bare.match(/[A-Z]{1,3}-\d+(?:[①②③④⑤⑥⑦⑧⑨⑩])?/g) || []
  const actual = ids.length
  const dup = ids.length !== new Set(ids).size ? ' ⚠️有重复编号' : ''
  const ok = actual === r.declared
  if (!ok) bad++
  sumDeclared += r.declared
  sumActual += actual
  console.log(r.label.padEnd(16) + String(r.declared).padStart(6) + String(actual).padStart(6) + '  ' + (ok ? '✅' : '❌ 不一致') + dup)
}
console.log('—'.repeat(40))
console.log('合计'.padEnd(16) + String(sumDeclared).padStart(6) + String(sumActual).padStart(6))

// 与报告条数核对：优先从第二个参数（核验方清单）读自报合计；否则在本文件里找
const listPath = process.argv[3]
let declaredTotal = null
if (listPath && fs.existsSync(listPath)) {
  const lt = fs.readFileSync(listPath, 'utf8')
  declaredTotal = lt.match(/合计\s*[:：]\s*A=(\d+)\s*B=(\d+)\s*C=(\d+)/)
} else {
  declaredTotal = text.match(/合计\s*[:：]\s*A=(\d+)\s*B=(\d+)\s*C=(\d+)/)
}
const grand = declaredTotal ? Number(declaredTotal[1]) + Number(declaredTotal[2]) + Number(declaredTotal[3]) : null
if (grand !== null) {
  console.log('')
  console.log('外部清单自报合计 = ' + grand)
  console.log(sumActual === grand ? '✅ 收敛账覆盖完整（' + sumActual + ' = ' + grand + '）' : '❌ **覆盖不全**：收敛账 ' + sumActual + ' 条 vs 清单 ' + grand + ' 条，差 ' + (grand - sumActual))
  if (sumActual !== grand) bad++
} else {
  // ★ 2026-09-25 修（Kimi 第二轮 A5 实测发现）：原来这里**只打印 ⚠️、不增加 bad** ⇒ 退出码 0。
  //   但「**无法对账**」不是「**对账通过**」—— 对账根本没发生，报绿就是给了一个**假绿**。
  //   这与本仓库自己的纪律同源：**扫了个空 ≠ 干净。**
  bad++
  console.log('')
  console.log('❌ **无法与外部清单对账** —— 没找到「合计：A=? B=? C=?」这一行。')
  console.log('   ' + (listPath ? ('给了外部清单（' + listPath + '），但里面没有那一行。') : '既没给外部清单参数，本文件里也没有那一行。'))
  console.log('')
  console.log('   ⇒ **「无法对账」不等于「对账通过」** —— 这正是"扫了个空 ≠ 干净"那一类：')
  console.log('     对账根本没发生，若报绿就等于发了一个**假绿**。')
  console.log('   ⇒ 两条出路：① 在被对账的清单里补上 `合计：A=<n> B=<n> C=<n>`；')
  console.log('     ② 或明确不启用本项（把那两个配置键删掉，让它显示 ⏭️ 跳过 —— **跳过是诚实的，假绿不是**）。')
}

console.log('')
process.exit(bad ? 1 : 0)
