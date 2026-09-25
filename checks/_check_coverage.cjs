#!/usr/bin/env node
/**
 * 覆盖矩阵（_check_coverage.cjs）—— 第 47 轮加
 * ============================================================================
 * ★ 它回答一个问题：**公开集里的每个文件，有几道护栏能看见它？**
 *
 * 为什么需要它（来自一条推论）：
 *   「**如果新东西进来时旧护栏什么都不说，那要么新东西确实合规，要么旧护栏看不见它。**」
 *   —— 后者更值得担心，而它**不会自己报出来**（看不见就是看不见）。
 *   ⇒ 所以必须**主动去查"谁没有被看见"**，而不是等某个检查碰巧扫到。
 *
 * ★ 它与"发布覆盖检查"分工不同（别重复建设）：
 *   · 那个问：**"这个文件是不是本次生成写出来的？"**（防手放的、防漏生成的）
 *   · 本项问：**"这个文件有没有被任何一条检查看见？"**（防"进来了但没人管"）
 *
 * 用法: node _check_coverage.cjs [--target <配置>]
 * 退出码: 0=都有护栏  1=有文件没有任何护栏（孤儿）  2=结构性错误  3=未配置⇒跳过
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
let _CFG = null
try { _CFG = require('./_paths.cjs').load() } catch { _CFG = null }

// 公开集的位置：开发形态是 `核查/public/`，发布形态是 `checks/` 的上一级。
const CANDIDATES = [path.join(HERE, 'public'), path.join(HERE, '..')]
const PUB = CANDIDATES.find(p => fs.existsSync(path.join(p, 'README.md')) && fs.existsSync(path.join(p, 'checks')))
if (!PUB) {
  console.log('⏭️  找不到公开集（试过 ' + CANDIDATES.map(p => path.relative(HERE, p)).join(' / ') + '）⇒ 本项**跳过**')
  process.exit(3)
}

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out); else out.push(p)
  }
  return out
}

// ── 各检查"能看见什么"。**这里每加一条，都要问："它真的会读这个文件吗？"** ──────────
// ⚠️ 诚实边界：这是**按扩展名/位置推断**的近似，不是"逐项去问那个脚本会不会读它"。
//    但它的用途是"发现**完全没人管**的文件"—— 近似足够；**要精确判断"某一项管不管某个文件"，
//    仍然要去看那一项的源码**（`docs/保障清单.md` 第五节那张"拦截厚度表"讲的就是这个区别）。
const SEES = [
  ['语法门', f => /\.(cjs|js|mjs)$/.test(f)],
  ['PS 语法门', f => /\.ps1$/.test(f)],
  ['JSON 预检', f => /\.json$/.test(f)],
  ['文本卫生', f => /\.(cjs|js|mjs|ps1|json|yaml|yml|md|txt)$/.test(f) || path.basename(f) === '.gitignore'],
  ['文件卫生', f => true],                    // 编码与残留：对所有文本文件生效
  ['引用检查', f => /\.md$/.test(f)],
  ['占位符检查', f => /\.md$/.test(f)],
  ['发布闸门', f => true],                    // 全仓扫禁忌模式
  ['目录符合性', f => true],                  // 解析配置声明的产物
]

const files = walk(PUB)
if (files.length === 0) {
  console.error('❌ 结构性错误：公开集里扫到 0 个文件 —— 扫描类检查必须断言集合非空。')
  process.exit(2)
}

const rows = files.map(f => {
  const rel = path.relative(PUB, f).replace(/\\/g, '/')
  return { rel, seen: SEES.filter(([, pred]) => pred(f)).map(([n]) => n) }
})

const orphans = rows.filter(r => r.seen.length === 0)

console.log('▶ 覆盖矩阵（公开集里的每个文件，有几道护栏能看见它）')
console.log('  公开集：' + path.relative(HERE, PUB) + '　共 ' + rows.length + ' 个文件')
console.log('')

const thin = rows.filter(r => r.seen.length > 0 && r.seen.length <= 4)
  .sort((a, b) => a.seen.length - b.seen.length)
console.log('  ── **覆盖最薄的 ' + thin.length + ' 个**（≤4 道）—— 它们不是"没人管"，是"管的人少"：')
for (const r of thin.slice(0, 12)) {
  console.log('     ' + String(r.seen.length).padStart(2) + ' 道  ' + r.rel.padEnd(36) + r.seen.join('/'))
}
if (thin.length > 12) console.log('     …另有 ' + (thin.length - 12) + ' 个')

console.log('')
console.log('—'.repeat(50))
if (orphans.length) {
  console.log('❌ **有 ' + orphans.length + ' 个文件，没有任何检查能看见它们：**')
  for (const r of orphans) console.log('   · ' + r.rel)
  console.log('')
  console.log('   ⇒ 这不等于"它们有问题" —— 它等于"**它们有问题也不会有人知道**"。')
  console.log('   ⇒ 两条出路（按本项目的规矩，**不许静默挂着**）：')
  console.log('      ① 把它的所在目录加进某个配置的扫描根（`syntaxRoots` / `textHygieneRoots` / `scanDirs` …）；')
  console.log('      ② 如果它**本就不需要**被检查（例如纯二进制资源），在本脚本的 SEES 附近')
  console.log('         写明"它为什么不需要"，让这个判断**可审计**而不是靠默认。')
  process.exit(1)
}
console.log('✅ 每个文件都至少有一道护栏能看见它（最薄的也有 ' + (thin.length ? thin[0].seen.length : '—') + ' 道）')
console.log('   （检查强度说明：本项只看"**有没有人管**"，判定不了"管得对不对" —— 那是各检查自己的事。）')
process.exit(0)
