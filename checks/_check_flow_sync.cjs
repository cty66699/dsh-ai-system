// 文档漂移断言 —— 「规则写在哪」与「流程里有没有」必须一致
//
// 治什么（第 6 次同型错）：`AGENTS.md` 已把 T7 与「逐条处置」写成硬要求，
//   而**操作流程文档 `docs/派发流程.md` 里一个字都没有** ——
//   7 个断言脚本里有 4 个全文未提，T7 零次提及，且它自称「五步」而实际有 7 步。
//   **⇒ 规则在 AGENTS.md 里、流程文档里没有 = 工具存在但不在流程里。**
//   这一错此前已犯五次（_check_counts / _check_refs / _check_conformance / T7 轨道 / 本次）。
//
// 与 `_check_refs.cjs` 的分工：那条查「引用指向的文件/行号存不存在」；
//   本条查「**承诺与操作文档是否脱节**」——引用没断，但内容该有而没有。
//
// 用法: node _check_flow_sync.cjs
// 退出码: 0=同步  1=有漂移  2=结构性错误
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
const _CFG = require('./_paths.cjs').requirePaths(['agentsDoc', 'flowDoc', 'capabilityFile', 'guide', 'declaration'])
// ★ `register`（致命问题登记册）**不在已确认的开源范围里**（范围是 `AI体系\04/05/06`）
//   ⇒ 不做硬依赖：**给了就跑索引覆盖检查，没给就跳过那一块并明说**。
//   否则示例工程永远只能整项跳过「文档漂移」——那是"少查了"，不该伪装成"查过了"。
const REG = _CFG.t.register || null
const ROOT = _CFG.ROOT
const CHECK_ALL = path.join(HERE, '_check_all.cjs')
const FLOW = _CFG.t.flowDoc
const AGENTS = _CFG.t.agentsDoc

const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const die = m => { console.error('❌ 结构性错误：' + m); process.exit(2) }
for (const [p, n] of [[CHECK_ALL, '_check_all.cjs'], [FLOW, 'README-派发流程.md'], [AGENTS, 'AGENTS.md']]) {
  if (!fs.existsSync(p)) die('找不到 ' + n + '：' + p)
}

const allSrc = readText(CHECK_ALL)
const flow = readText(FLOW)
const agents = readText(AGENTS)
const findings = []

// ── ① 统一入口里的每个断言脚本，流程文档必须提到 ──────────────────────────
// 从 `_check_all.cjs` 的 CHECKS 数组派生（源头派生，不手写）。
const scripts = [...new Set([...allSrc.matchAll(/\['[^']+',\s*'(_[A-Za-z0-9_]+\.cjs)'/g)].map(m => m[1]))]
if (scripts.length === 0) die('从 _check_all.cjs 解析出 0 个断言脚本 —— CHECKS 格式可能已变')
const missingScripts = scripts.filter(s => !flow.includes(s))
if (missingScripts.length) {
  findings.push(`【工具不在流程里】以下断言已进统一入口，但流程文档全文未提 —— ${missingScripts.join('、')}`)
}

// ── ② 流程文档声明的步数必须等于实际步数 ──────────────────────────────────
const declaredSteps = flow.match(/^##\s*([一二三四五六七八九十]+)步/m)
// ⚠️ 首版写成 /g（漏了 m）⇒ `^` 只匹配整串开头 ⇒ 报「实际 0 段」。
//    这是**断言自己的 bug**，不是文档的 bug —— 又一次证明「跑一遍才算数」。
const actualSteps = [...flow.matchAll(/^###\s*第 \d+ 步/gm)].length
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
if (!declaredSteps) findings.push('【无步数声明】流程文档没有 `## N步` 形式的步数声明 —— 无法对账')
else {
  const d = CN[declaredSteps[1]]
  if (d !== actualSteps) findings.push(`【步数不符】流程文档声明「${declaredSteps[1]}步」，实际有 ${actualSteps} 个「### 第 N 步」段`)
}

// ── ②b AGENTS.md 里凡是引用本流程步数的地方，数字必须一致 ────────────────────
// 实例：本条断言建成之前，`AGENTS.md` 写「**派发四步见** `docs/派发流程.md`」，
//   而该文档当时实际有 7 步、现在有 8 步 —— **引用它的地方没跟着改，引用关系还在，所以 `_check_refs` 查不出来。**
// ⚠️ 已知边界（与 `_check_refs.cjs` 同型）：**文本上区分不了「引用」与「描述一个引用」**。
//   若某行是在**叙述历史**（如"该文档当时自称『五步』"），它会被误判 ⇒ 在该行加
//   `<!-- flow-sync:ignore 理由 -->` 显式豁免。**豁免必须写在行内、带理由**，不许整段静默放过。
const IGNORE = /<!--\s*flow-sync:ignore/
for (const line of agents.split(/\r?\n/)) {
  if (IGNORE.test(line)) continue
  if (!/README-派发流程|派发流程/.test(line)) continue
  for (const m of line.matchAll(/([一二三四五六七八九十]+)步/g)) {
    const n = CN[m[1]]
    if (n !== undefined && n !== actualSteps) {
      findings.push(`【AGENTS.md 引用的步数不符】该行说「${m[1]}步」，而流程文档实际有 ${actualSteps} 步 —— ${line.trim().slice(0, 60)}…`)
    }
  }
}

// ── ③ AGENTS.md 声明的轨道条数必须等于实际表行数 ──────────────────────────
const trackHead = agents.match(/###\s*核验轨道（\*\*([一二三四五六七八九十]+)条\*\*/)
if (!trackHead) findings.push('【无轨道声明】AGENTS.md 里找不到「核验轨道（**N条**」声明')
else {
  const declared = CN[trackHead[1]]
  const start = agents.indexOf(trackHead[0])
  // ⚠️ 首版用「下一个空行」当块结束 ⇒ 块里只有标题、**没有表格行**（标题与表之间正好是空行）
  //    ⇒ 报「实际 0 行」。改成「下一个同级/更高级标题」。
  const rest = agents.slice(start)
  const nextHeading = rest.slice(1).search(/\n#{2,3}\s/)
  const block = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1)
  const rows = [...block.matchAll(/^\|\s*\*\*T\d/gm)].length
  if (declared !== rows) findings.push(`【轨道数不符】AGENTS.md 声明「${trackHead[1]}条」核验轨道，实际表里有 ${rows} 行`)
}

// ── ④ 全库引用的「治理规则第 N 条」必须真的存在 ────────────────────────────
// AGENTS.md §三 里的编号条目数 = 实际规则数。
const sec3 = agents.slice(agents.indexOf('## 三、治理规则'), agents.indexOf('## 四、'))
const ruleCount = [...sec3.matchAll(/^\d+\.\s+\*\*/gm)].length
if (ruleCount === 0) die('从 AGENTS.md §三 解析出 0 条治理规则 —— 格式可能已变')
const cited = new Set()
for (const dir of [ROOT, path.join(ROOT, '方案设计')]) {
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(md|cjs)$/.test(e.name)) continue
      if (p === AGENTS) continue
      const t = readText(p)
      for (const m of t.matchAll(/治理规则第\s*(\d+)\s*条/g)) cited.add(Number(m[1]))
    }
  }
  try { walk(dir) } catch { /* 忽略不可读目录 */ }
}
const badCite = [...cited].filter(n => n < 1 || n > ruleCount).sort((a, b) => a - b)
if (badCite.length) findings.push(`【引用了不存在的规则】AGENTS.md §三 只有 ${ruleCount} 条治理规则，但全库引用了第 ${badCite.join('、')} 条`)

// ── ⑥ 「口径变更影响面」分层表必须覆盖全部正文文件 ──────────────────────────
// 治什么：`00_总览` §5.1.2 把材料分成「内核（口径无关）/ 外壳（口径相关）」并据此算出
//   **X-01 的影响面 ≈ 15–20% 篇幅**。**这张表一旦漏了新文件，那个"15–20%"就是错的**，
//   而错的方向是**低估风险**（新文件未被分类 ⇒ 默认不算进外壳）。
//   与 `_check_disposition.cjs` 的孤儿报告检查同一个道理：**新的东西必须有个归宿。**
const OVERVIEW = _CFG.t.declaration
if (!fs.existsSync(OVERVIEW)) findings.push('【缺目标声明】找不到 00_总览与共性技术底座.md')
else {
  const ov = readText(OVERVIEW)
  const sec = ov.indexOf('#### 5.1.2')
  if (sec === -1) findings.push('【缺影响面分析】`00` 里找不到 §5.1.2「口径变更的影响面」—— X-01 的风险边界无从判断')
  else {
    const nextSec = ov.slice(sec + 1).search(/\n#{2,4}\s/)
    const block = nextSec === -1 ? ov.slice(sec) : ov.slice(sec, sec + 1 + nextSec)
    // §5.1.2 的表里提到 10 个正文文件；01/02 只写了简称，故按「编号前缀」比对
    const listed = new Set([...block.matchAll(/`(\d\d)_/g)].map(m => m[1]))
    // ★ 目录可能不存在（公开仓库里没有 `方案设计\`）—— **不加保护会直接 ENOENT 崩掉整个脚本**，
    //   而崩掉时你看到的是 node 的栈，不是"这一项没查成"。**踩过：干净副本里本项就是这么崩的。**
    let actual = []
    try { actual = fs.readdirSync(path.join(ROOT, '方案设计')).filter(f => /^\d\d_.*\.md$/.test(f)).map(f => f.slice(0, 2)) }
    catch { console.log('  ⏭️ `' + path.join(ROOT, '方案设计') + '` 不存在 ⇒ 跳过「分层表覆盖全部正文文件」这一块比对') }
    const uncovered = actual.filter(n => !listed.has(n))
    if (uncovered.length) {
      findings.push(`【分层表未覆盖】\`方案设计\\\` 下的正文文件有 ${actual.length} 个，而 §5.1.2 的分层表只覆盖 ${listed.size} 个 —— 未分类：${uncovered.join('、')}（**更新影响面占比，否则会低估 X-01 的风险**）`)
    }
  }
}

// ── ⑤ 「需要用户做的事」里引用的登记册编号必须真实存在 ──────────────────────
// 该文件自己在脚注里承诺「由 _check_flow_sync.cjs 的编号存在性检查兜底」——
// **写了承诺就得兑现，否则又是一条"写了但没实现"**（本册反复记的那类错）。
// 判据（廉价且机械）：编号必须在**别的文件里也出现过**。只在指导文件里孤零零出现的编号 = 悬空引用。
const GUIDE = _CFG.t.guide
// ★★ 2026-09-25 修（Kimi 第二轮 B5 实测发现）：**"指导文件在不在"和"登记册在不在"是两件无关的事，
//   原来却被写成同一个 if/else 链** —— 于是文件存在性检查只在 `REG` 非空时才可能执行，
//   而登记册不在公开范围 ⇒ `REG` 恒为空 ⇒ **那一支永远不执行，配了死路径也静默通过**。
//   **根因不是"忘了检查"，是"检查被挂在一个永远为假的守卫下面"。**
//   ⇒ 现状：① 存在性**无条件**检查；② 只有"编号存在性"那一条（它的判据确实在登记册里）才依赖 REG。
if (GUIDE === null || GUIDE === undefined) {
  console.log('  ⏭️ 未配置 guide ⇒ 跳过「指导文件」相关检查')
} else if (!fs.existsSync(GUIDE)) {
  findings.push('【缺指导文件】`guide` 指向的文件不存在 —— ' + GUIDE
    + '（原来它静默通过，因为检查被挂在登记册存在性的分支下）')
} else if (!REG) {
  // ★ 「指导文件引用的编号必须存在」这条检查 **语义上依赖登记册**（编号都定义在那里）。
  //   登记册不在开源范围里 ⇒ **这项检查无法成立，应当跳过并明说**，而不是把每个编号都报成"悬空"。
  //   （实测：干净副本里它一次报出 8 个"悬空编号"，而它们全都在真登记册里。）
  console.log('  ⏭️ 登记册未发布 ⇒ 跳过「指导文件编号存在性」检查（该检查的判据就在登记册里）')
} else {
  const guide = readText(GUIDE)
  const idRe = /\b([XFABCDPI]-\d{1,2})\b/g
  const guideIds = [...new Set([...guide.matchAll(idRe)].map(m => m[1]))]
  // 允许集合：方案设计\ 下**除本文件外**任何 .md 里出现过的编号
  const elsewhere = new Set()
  const walk2 = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk2(p); continue }
      if (!e.name.endsWith('.md') || p === GUIDE) continue
      for (const m of readText(p).matchAll(idRe)) elsewhere.add(m[1])
    }
  }
  try { walk2(path.join(ROOT, '方案设计')) } catch { /* 忽略 */ }
  const dangling = guideIds.filter(id => !elsewhere.has(id))
  if (dangling.length) findings.push(`【悬空编号】\`guide\` 指向的文件引用了别处不存在的编号 —— ${dangling.join('、')}`)
}

// ── ⑦ 核验者能力档案必须含"回顾性标定"，且必须写明"一致率 ≠ 正确率" ──────────
// 治什么：第 9 轮往 `06_核验者能力档案.md` 写进了采纳率（GPT-6 T3 75% 等）与
//   「T6 判主控裁定 28.6% 有问题」。**这两组数字极容易被后来的人当成"准确率"引用** ——
//   而它们的真值（主控的裁定）本身未经核验。**⇒ 把"名字必须写对"变成断言。**
const CAP = _CFG.t.capabilityFile
if (!fs.existsSync(CAP)) findings.push('【缺能力档案】找不到 `AI体系\\06_核验者能力档案.md`')
else {
  const cap = readText(CAP)
  if (!/回顾性标定/.test(cap)) findings.push('【缺标定节】`06_核验者能力档案.md` 里找不到「回顾性标定」—— 核验者的准确率将重新变成未知')
  if (!/(一致率).{0,40}(不是|≠).{0,20}(正确率|准确率)/s.test(cap)) {
    findings.push('【缺限定语】`06` 里找不到「一致率不是正确率」的限定 —— **这两组数字会被后来的人当成准确率引用**')
  }
  if (!/标定集/.test(cap)) findings.push('【缺下一步】`06` 里找不到「核验者标定集」这个未建项 —— 缺口会被忘掉')
}

// ── ⑧ 登记册的「状态索引」必须覆盖全部 X 编号（不多不少）────────────────────
// 治什么：本册长到 587 行、18 条 X 散在 5 个小节里，**各小节标题计数早已过时** ⇒
//   「没人能一眼看出还剩什么没解决」⇒ **看不见 = 会被忘掉**（X-13 / X-16 的同一个病）。
//   §〇 状态索引是唯一权威表；**新登记的 X 若没进表，等于隐形**。
// ⚠️ `REG` 已在文件顶部声明（`_CFG.t.register || null`）—— **此处不得再声明一次**
//    （踩过：两处各写一次 ⇒ `Identifier 'REG' has already been declared` ⇒ 整个脚本崩）
if (!REG) {
  console.log('  ⏭️ 登记册未配置（不在已确认的开源范围内）⇒ 跳过「状态索引覆盖」这一块检查')
} else if (!fs.existsSync(REG)) findings.push('【缺登记册】找不到配置里指定的登记册：' + REG)
else {
  const reg = readText(REG)
  const idxStart = reg.indexOf('## 〇、★ 状态索引')
  if (idxStart === -1) findings.push('【缺状态索引】登记册里找不到 §〇 状态索引 —— 18 条 X 的状态将无从一眼看出')
  else {
    const rest = reg.slice(idxStart + 1)
    const nxt = rest.search(/\n##\s/)
    const idxEnd = idxStart + 1 + (nxt === -1 ? rest.length : nxt)
    const idxBlock = reg.slice(idxStart, idxEnd)
    const bodyBlock = reg.slice(0, idxStart) + reg.slice(idxEnd)   // 正文 = 索引之外
    // 行首编号，容忍两种写法：`| X-06 |` 与 `| **X-01** |`
    //   （踩过：索引表里我只给 X-01 加了粗 ⇒ 严格正则只数到 1 条。
    //     **格式统一不是目标，判据必须容忍两种写法** —— 否则它会报"漏登记"，而其实是格式不一致。）
    const rowRe = /^\|\s*\*{0,2}(X-\d{2})\*{0,2}\s*\|/gm
    const headRe = /^#{2,3}\s*[^\n]*?\b(X-\d{2})\b/gm
    const inIndex = new Set([...idxBlock.matchAll(rowRe)].map(m => m[1]))
    const all = new Set()
    for (const m of bodyBlock.matchAll(rowRe)) all.add(m[1])
    for (const m of bodyBlock.matchAll(headRe)) all.add(m[1])
    const missing = [...all].filter(x => !inIndex.has(x)).sort()
    const phantom = [...inIndex].filter(x => !all.has(x)).sort()
    if (missing.length) findings.push(`【索引漏登记】登记册正文里有 ${all.size} 条 X，§〇 状态索引只列了 ${inIndex.size} 条 —— 未进索引：${missing.join('、')}（**未进索引 = 隐形**）`)
    if (phantom.length) findings.push(`【索引多登记】§〇 状态索引里有正文不存在的编号：${phantom.join('、')}`)
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────
console.log('文档漂移检查（承诺 ↔ 操作文档）')
console.log(`  统一入口的断言脚本：${scripts.length} 个`)
console.log(`  流程文档步数：声明 ${declaredSteps ? declaredSteps[1] + '步' : '（缺）'} / 实际 ${actualSteps} 段`)
console.log(`  AGENTS.md 核验轨道：${trackHead ? trackHead[1] + '条' : '（缺）'}`)
console.log(`  AGENTS.md 治理规则：${ruleCount} 条；全库引用的最大编号 ${cited.size ? Math.max(...cited) : '无'}`)

if (findings.length) {
  console.log('')
  for (const f of findings) console.log('  ⚠️ ' + f)
  console.log('')
  console.log(`有 ${findings.length} 项未通过`)
  process.exit(1)
}
console.log('')
console.log('✅ 流程文档与 AGENTS.md 同步：断言脚本全部在流程里、步数与轨道/规则计数自洽')
console.log('   （检查强度说明：本脚本查的是**提到没有**与**计数一致**，判不了内容写得对不对。）')
