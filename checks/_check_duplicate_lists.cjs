#!/usr/bin/env node
/**
 * 重复清单对账（_check_duplicate_lists.cjs）—— 第 49 轮加
 * ============================================================================
 * ★ 治的是「列举会漂移」的**第 6 种形态**：
 *   **不是清单漏了东西，而是**同一份清单在几个地方各写了一遍**。**
 *
 * 前面五种形态（都已修）：
 *   ① 「生成物陈旧」的对账清单写死 3 对，而实际有 12 个手写源；
 *   ② 按名字模式抠脚本名的正则漏了 `_refresh_snapshots.cjs`；
 *   ③ 项数对账的文档清单写死 3 处，漏了配置说明与 AI-INSTALL；
 *   ④ 「一条命令跑完…N 项」那句的名字列表写死 16 个；
 *   ⑤ 发布白名单 `CHECK_FILES` 不随统一入口自动更新。
 * ⇒ 而第 6 种**不需要"加新东西"就会出事**：两处**各自漂移**时，会出现「一处认、一处不认」。
 *
 * ★ 它做什么：扫 `核查/` 下的 `.cjs`，找出**同一个字符串数组字面量出现 ≥2 次**的地方，逐个列出来。
 * ⚠️ 它**不改代码，也不判"该不该合并"** —— 只把事实摆出来。
 *    因为"这两处该共享一份常量"是**设计判断**（有时候重复是合理的：例如测试要自造数据），
 *    而**"我知道它们重复了"**是底线。
 *
 * 用法: node _check_duplicate_lists.cjs
 * 退出码: 0 = 没有重复（或有带理由的豁免）  1 = 有重复清单  2 = 结构性错误
 * ============================================================================
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname

// ── 带理由的豁免（**禁止静默豁免**：每条都要写清"为什么这份重复是可以接受的"）──────────
const EXEMPT = {
  // 键 = 那份字面量的原文（字符串数组，逗号分隔）；值 = 理由
  "'assertions', 'partial', 'external', 'domain', 'waived'":
    '一处是**真源**（毕业账本的五个桶）；另一处在 `_selftest.cjs` 里，是**测试自造的假账本** —— '
    + '测试必须能独立构造输入，**故意不共享**（否则被测对象一改，测试也跟着改，就测不出东西了）。',
}

const files = fs.readdirSync(HERE).filter(f => /\.cjs$/.test(f))
if (files.length === 0) {
  console.error('❌ 结构性错误：扫描到 0 个 .cjs —— 扫描类检查必须断言集合非空。')
  process.exit(2)
}

const seen = new Map()
for (const f of files) {
  const lines = fs.readFileSync(path.join(HERE, f), 'utf8').split('\n')
  lines.forEach((l, i) => {
    const t = l.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    const m = l.match(/\[\s*((?:'[^']+'\s*,\s*){2,}'[^']+')\s*[,\]]/)
    if (!m) return
    const key = m[1].replace(/\s+/g, ' ').trim()
    if (!seen.has(key)) seen.set(key, [])
    seen.get(key).push(f + ':' + (i + 1))
  })
}

const dups = [...seen.entries()].filter(([, where]) => where.length >= 2)
const offending = dups.filter(([k]) => !EXEMPT[k])
const waived = dups.filter(([k]) => EXEMPT[k])

console.log('▶ 重复清单对账（治「列举会漂移」的第 6 种形态）')
console.log('  扫描 ' + files.length + ' 个 .cjs｜发现重复的字面量数组 ' + dups.length + ' 组')
console.log('')

if (waived.length) {
  console.log('  ── 带理由豁免的 ' + waived.length + ' 组（**理由可审计**，不是静默跳过）：')
  for (const [k, where] of waived) {
    console.log('     · ' + where.join('  '))
    console.log('       [' + k.slice(0, 76) + ']')
    console.log('       ⇒ ' + EXEMPT[k])
  }
  console.log('')
}

console.log('—'.repeat(50))
if (offending.length) {
  console.log('⚠️ **有 ' + offending.length + ' 组清单在多处各写了一遍：**')
  for (const [k, where] of offending) {
    console.log('   · ' + where.join('  '))
    console.log('     [' + k.slice(0, 76) + ']')
  }
  console.log('')
  console.log('   ⇒ **它们现在是一致的 —— 而这份检查存在的意义，是"将来不一致时有人知道"。**')
  console.log('   ⇒ 两条出路（按本项目规矩，不许静默挂着）：')
  console.log('      ① 抽成共享常量（若两处**语义相同**）；')
  console.log('      ② 在本文件 EXEMPT 里写明"为什么这份重复可以接受"（若两处**语义不同或故意独立**）。')
  process.exit(1)
}
console.log('✅ 没有"无理由的重复清单"（' + waived.length + ' 组带理由豁免）')
console.log('   （检查强度说明：它只找**字面量完全相同**的数组。）')
console.log('')
console.log('   ★ **已知盲区（第 7 种形态）：「同一份语义，以不同写法表达」—— 本检查看不出来。**')
console.log('     第 50 轮实测的真实例子：')
console.log('       · `_check_text_hygiene.cjs` 里有两处扩展名清单：')
console.log('         第 168 行 `[.ps1,.cjs,.js,.mjs]`（＝「能跑脚本的」）与')
console.log('         第 192 行 `[.ps1,.cjs,.js,.mjs,.json,.yaml,.yml,.md]`（＝「文本文件」）——')
console.log('         **它们看着像，但回答的是两个不同的问题**（前者判"要不要过语法门"，后者判"要不要查编码"）。')
console.log('       · 而 `_paths.cjs` 的 `JS_EXT`（`.cjs,.js,.mjs`）**才是**「这是 JS 源码」的那个真源。')
console.log('     ⇒ 所以**这一类不能靠机器判**：它需要回答「这两处在回答同一个问题吗？」——那是语义问题。')
console.log('     ⇒ **本检查的立场是：不假装能判语义重复。** 想要近似的机器判据，只有一条：')
console.log('        **「同一个概念如果有真源，那别处就不该再出现它的字面量」** ——')
console.log('        那需要**先有真源**（本轮的 `JS_EXT` / `SKIP_DIRS_SCRIPTS` 就是这么来的），')
console.log('        而那一步是**人的判断**，不是扫描能给的。')
process.exit(0)
