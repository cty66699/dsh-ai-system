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
// ★★ 2026-09-26 改：从硬依赖里**拿掉 `declaration`**（照本文件给 `register` 定的规矩）。
//   理由：`declaration` 只被**第 ⑥ 块**（「分层表覆盖全部正文文件」）用到 ——
//   那**与「文档漂移」本身无关**，却让它成为硬门槛 ⇒ **访客少配一个键，整项就跳过**。
//   ★ 而 `register` 早就是这么做的（「不在已确认的开源范围里 ⇒ 不做硬依赖：给了就跑，没给就跳过那一块并明说」）。
//   ⇒ 同一个文件里，一条规矩只用在了一个键上。这里补上第二个。
const _CFG = require('./_paths.cjs').requirePaths(['agentsDoc', 'flowDoc', 'capabilityFile', 'guide'])
// ★ `register`（致命问题登记册）**不在已确认的开源范围里**（范围是 `AI体系\04/05/06`）
//   ⇒ 不做硬依赖：**给了就跑索引覆盖检查，没给就跳过那一块并明说**。
//   否则示例工程永远只能整项跳过「文档漂移」——那是"少查了"，不该伪装成"查过了"。
const REG = _CFG.t.register || null

// ★★ 2026-09-26 加：`declaration` 改成**软依赖**（`|| null`）。
//   给了 ⇒ 跑第 ⑥ 块「分层表覆盖全部正文文件」；
//   没给 ⇒ **跳过那一块并明说** —— 而不是让整项「文档漂移」都跑不起来。
const OVERVIEW = _CFG.t.declaration || null
const ROOT = _CFG.ROOT
const CHECK_ALL = path.join(HERE, '_check_all.cjs')
const FLOW = _CFG.t.flowDoc
const AGENTS = _CFG.t.agentsDoc

const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
// ★ 加（第 48 轮）：递归找一个目录下的所有 .md（给"全仓对账"用）。
const walkMd = (d, out = []) => {
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'public') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walkMd(p, out)
      else if (/\.md$/.test(e.name)) out.push(p)
    }
  } catch { /* 读不到就跳过 */ }
  return out
}
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

// ── ①b 项数一致性（2026-09-26 加，防「改了代码没同步文档」第 4 次复发）────────
// ★ 为什么必须机械化：这个错当天犯了 **4 次**（`--fast` 被包成必须带、`guide` 跳过粒度、
//   Node 22.5 vs 22.19、**加了「文本卫生」但四处文档仍写"十六项"、示例输出仍写"7 / 7"**）。
//   每一次都是**访客或用户**发现的，没有一次是自查或断言抓到的 ——
//   按记忆毕业制，同一错误第 2 次起就不许再写 lesson，只能建断言。
// ★ 判据：**文档里写的「N 项」必须等于 CHECKS 数组的实际条目数**。
//   实际项数从**源码派生**（不手写），文档侧扫三处：AGENTS.md、流程文档、公开 README 的源。
// ★ 诚实边界（写在输出里，不假装它覆盖全）：它只对账**「N 项」这一个数字**，
//   对不了「7 / 7」「4 / 4」那类**运行结果计数**（那些取决于当次跑出几项通过，非静态可判）。
const N = scripts.length
// ★★★ 2026-09-26 修 —— **这条断言从建立起就有一半是坏的**，而我当时没发现：
//   原来写的是 `[AGENTS, 'AGENTS.md']`，而 `AGENTS` 是**路径字符串**，不是**文件内容**。
//   于是循环里 `text.matchAll(...)` 扫的是 `"D:\...\AGENTS.md"` 这几十个字符 —— **永远匹配不到**。
//   只有第三项（`readText(PUB_README)`）写对了 ⇒ **它从头到尾只对过账 README 那一份**。
//   表现：改完项数后，`_public_src/README.md` 被抓到了（报「项数不符」），
//         而 `AGENTS.md` 里那句「③ 统一入口（17 项；…）」**留了下来、没人报**。
//   ⇒ **教训：断言自己也要"每个输入项都测一遍"** —— 我当时的牙齿测试只喂了 README 那一项，
//     于是"它有效"这个结论只对那一项成立。**一个只覆盖了三分之一输入的断言，比没有断言更危险**
//     （会让你以为三处都在管）。
const numDocs = [
  [readText(AGENTS), 'AGENTS.md'],
  [readText(FLOW), 'README-派发流程.md'],
]
﻿// 公开 README：**两种形态下路径不同**，两个都要试。
// ★★ 2026-09-26 修（独立核验 F-11 —— 一个**静默**的覆盖缺口）：
//   原来只写死 `path.join(HERE, '_public_src', 'README.md')` ——
//   · **开发形态**（本仓库 `核查/`）下它存在 ✅；
//   · **发布形态**（`public/checks/`）下 **`_public_src/` 根本不存在** ⇒ 那个分支永远不执行，
//     而且**不打印任何跳过行** ⇒ **"公开 README 不在对账清单里"这件事，没有任何人知道**。
//   ⇒ 实测（核验方做的）：把发布形态 `README.md` 里的「十八项机械检查」改成「十七项」，
//     文档漂移门**仍报「✅ 流程文档与 AGENTS.md 同步」exit 0**。
//   ★ 这与本脚本别处那条纪律冲突：「不做静默豁免」。**找不到就要说出来。**
const PUB_CANDS = [
  path.join(HERE, '_public_src', 'README.md'),   // 开发形态
  path.join(HERE, '..', 'README.md'),            // 发布形态（public/README.md）
]
const PUB_README = PUB_CANDS.find(p => fs.existsSync(p)) || null
if (PUB_README) {
  numDocs.push([readText(PUB_README), path.relative(ROOT, PUB_README) + '（公开 README）'])
} else {
  // ★ 找不到也要**显式说出来** —— 静默跳过会让"公开 README 从没被对账过"这件事无人知晓。
  console.log('⚠️  公开 README 没找到（试过：' + PUB_CANDS.map(p => path.relative(ROOT, p)).join(' / ') + '）')
  console.log('    ⇒ **这一份不参与本次对账** —— 不是"它没问题"，是"它没被查"。')
}
const CN_NUM = { 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25 }
const CN_SINGLE = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const cn2i = (s) => (CN_NUM[s] !== undefined ? CN_NUM[s] : CN_SINGLE[s])
// ★ 模式级覆盖收集器（第 64 轮）
const PATTERN_HITS = new Map()
for (const [text, label] of numDocs) {
  const claims = new Set()
  // ★ 判据收紧（第一版太宽，一跑就假阳性）：**只认"总数"语义**，不认"其中 / 另外 / X 项是"。
  //   第一版写成 `([一二三四五六七八九十]{1,3})项`，于是把
  //   「另外 **9** 项在示例里显示 ⏭️」「只配置了其中 **7** 项」「**5** 项是…**3** 项是…」
  //   一并当成总数 ⇒ README 一处就报 5 个假阳性。
  //   **误报比漏报更糟**（会让人不再信任这个检查）⇒ 只匹配紧跟这些词的形态：
  // ★★★ 2026-09-26 第 64 轮：**从"匿名正则数组"改成"带名字与意图的条目"** ——
  //   起因：这 12 条原来没有名字 ⇒ 报出来的只有「项数不符」一个标签，
  //   **无从知道是哪条模式触发的、也无从知道它是不是已经永远匹配不到了。**
  //   ⇒ 改成 `[名字, 正则, 它在防什么写法]`，并在跑完后印一份**模式级覆盖**：
  //     每条模式在当前文档上命中几次；**一次都没命中的单独点出来**
  //     （它们可能是**预防性**的 —— 在等"以后有人那样写"；也可能**那种写法已经不存在了**）。
  const PATTERNS = [
    ['机械检查·中文', /([一二三四五六七八九十]{1,3})项机械检查/g,
      '「十七项机械检查」—— 唯一无歧义的总结句'],
    ['标题行·中文', /^#{1,6}\s*([一二三四五六七八九十]{1,3})项断言/mg,
      '标题行「## 十七项断言分别管什么」'],
    ['这N项全绿·中文', /这([一二三四五六七八九十]{1,3})项全绿/g,
      '「这十七项全绿」'],
    ['流程图节点·中文', /统一检查入口[·\s]*([一二三四五六七八九十]{1,3})项断言/g,
      '流程图节点「统一检查入口 · 十七项断言」'],
    ['目录树注释·中文', /←\s*([一二三四五六七八九十]{1,3})项断言的脚本/g,
      '目录树注释「← 十七项断言的脚本」'],
    ['统一入口·阿拉伯', /统一入口[（(]\s*(\d{1,2})\s*项/g,
      '「统一入口（17 项」'],
    ['机械检查·阿拉伯', /(\d{1,2})\s*项机械检查/g,
      '「18 项机械检查」'],
    ['流程图节点·阿拉伯', /统一检查入口[·\s]*(\d{1,2})\s*项断言/g,
      '流程图节点（阿拉伯数字）'],
    ['目录树注释·阿拉伯', /←\s*(\d{1,2})\s*项断言的脚本/g,
      '目录树注释（阿拉伯数字）'],
    ['一条命令跑完', /一条命令跑完[^。\n]{0,12}?([一二三四五六七八九十]{1,3}|\d{1,2})\s*项/g,
      '「一条命令跑完全部断言。十七项：」与「第 7 步一条命令跑完十七项」'],
    ['遍指词·断言', /(?<!其中\s?)(?<!其中)(?<!另外\s?)(?<!这)(?<!那)(\d{1,2}|[一二三四五六七八九十]{1,3})\s*项断言[^。\n]{0,6}?(各|分别|都|全)/g,
      '「N 项断言各管什么」—— ★ 第 63 轮加：靠「遍指词」收窄，并排除「其中/另外/这/那」'],
    ['遍指词·机械检查', /(?<!其中\s?)(?<!其中)(?<!另外\s?)(?<!这)(?<!那)(\d{1,2}|[一二三四五六七八九十]{1,3})\s*项机械检查[^。\n]{0,6}?(各|分别|都|全)/g,
      '「N 项机械检查都在跑」—— 同上'],
  ]
  // ★★★ 2026-09-26 修（第 52 轮，**这条断言自己的一次真 bug**）：
  //   上面所有中文数字模式原来写的是 `{1,2}` —— 而 **「二十一」是 3 个字符** ⇒
  //   它们**看不懂「二十一项」**，却会从「二**十一**项」里**抠出一个不存在的「十一」** ⇒
  //   报「文档写的是 11 项，而实际 21 项」。**那是误报**，而文档里根本没写过 11。
  //   ⇒ 量词放宽到 `{1,3}`（容得下「二十一/二十二」），并给 `CN_NUM` 补到二十五。
  //   ★ 教训：**"宁可漏报不可误报"这条纪律，也包括"别把不存在的东西读出来"** ——
  //     误报的具体形态不只是"多报了真的存在的东西"，还有"报了一个根本没写在那儿的数"。
  const toInt = (s) => (/^\d+$/.test(s) ? Number(s) : cn2i(s))
  // ★ 为什么收得这么紧（第二版，第一版仍有 2 个假阳性）：实测被误匹配的两处是
  //   「**有一次三项断言**（脱敏自检 / 发布闸门 / 文档漂移）」和「**这一项**会先拦住」（指语法门）。
  //   它们谈的是**某几项**，不是**总数** —— 用 `N项断言` / `这N项` 这种宽形态必然误伤。
  //   ⇒ 只认**明确的总结性表述**；**宁可漏报，不可误报**（误报会让人不再信任这个检查）。
  for (const [pname, re, intent] of PATTERNS) {
    // ★ 模式级覆盖（第 64 轮）：记下**每条模式命中了什么**，
    //   用来回答"它是不是已经永远不会触发了"（见下面那份报告）。
    if (!PATTERN_HITS.has(pname)) PATTERN_HITS.set(pname, { intent, hits: 0, docs: [] })
    const rec = PATTERN_HITS.get(pname)
    for (const m of text.matchAll(re)) {
      const v = toInt(m[1])
      if (v) { claims.add(v); rec.hits++; if (!rec.docs.includes(label)) rec.docs.push(label) }
    }
  }
  const wrong = [...claims].filter(v => v !== N)
  if (wrong.length) {
    findings.push(`【项数不符】${label} 写的是「${wrong.map(v => v + ' 项').join('、')}」，`
      + `而 \`_check_all.cjs\` 的 CHECKS 实际有 **${N}** 项`
      + `（差 ${wrong.map(v => (v > N ? '多' : '少') + Math.abs(v - N)).join('、')}）。`)
  }
}


// ── ★★ 模式级覆盖报告（2026-09-26 第 64 轮）────────────────────────────────
//   ★ 为什么要有它：拦截台账管的是"**断言**级"（哪一项报红了），
//     而 ①b 里这十几条**模式**是匿名的 —— 报出来的只有「项数不符」一个标签，
//     **无从知道是哪条模式触发的、也无从知道它是不是已经永远匹配不到了。**
//   ⇒ 它回答的问题很具体：**"这条模式防的那种写法，现在还有可能出现吗？"**
//   ★ 而结论必须诚实：**一次都不命中 ≠ 它没用** ——
//     它可能正是**预防性**的（在等"以后有人那样写"）。
{
  const total = PATTERN_HITS.size
  const dead = [...PATTERN_HITS.entries()].filter(([, r]) => r.hits === 0)
  const alive = total - dead.length
  console.log('  ①b 模式级覆盖：' + total + ' 条模式，' + alive + ' 条命中过，**' + dead.length + ' 条一条都没命中**')
  if (dead.length) {
    for (const [n, r] of dead) console.log('     · ' + n + '　—— 它在防：' + r.intent)
    console.log('     ⇒ **一条都不命中不等于它没用** —— 它可能正是在防"以后有人那样写"。')
    console.log('       判别方法只有一句：**它在防的那种写法，现在还有没有可能被写出来？**')
    console.log('       · 有可能 ⇒ 留着（**预防性**）；· 那种写法已经不存在了 ⇒ 它已经死了，该删。')
  }
}// ── ①b-补：**全仓扫**（2026-09-26 加，第 48 轮）────────────────────────────────────
// ★ 起因：上面那三处是**写死的**（`AGENTS.md` / 派发流程 / 公开 README），
//   而实测 `_public_src/配置说明.md` 里**也有**「统一入口共 18 项」「跑 9 项、跳 9 项」这类句子 ——
//   **它不在清单里 ⇒ 一直没人报**（那三处旧了整套两轮而无人知）。
//   ⇒ 又一次「**写死的清单会漂移**」。修法照旧：**不列举，扫出来**。
// ★ 判据：凡是**在交付物里的 `.md`**，只要出现了「N 项」这种总数表述，就纳入对账。
//   ⚠️ 诚实边界：它只扫 `_public_src/` 与 `docs/` 两个会随产物走或随文档走的目录；
//     不扫 `核查/` 下的诊断脚本与临时文件（那些不是交付物，改了也不该被要求同步）。
{
  const SCAN_DIRS = [path.join(HERE, '_public_src'), path.join(HERE, '_briefs'), path.join(ROOT, 'AI体系')]
  const extra = []
  for (const d of SCAN_DIRS) {
    if (!fs.existsSync(d)) continue
    for (const f of walkMd(d)) {
      const rel = path.relative(ROOT, f)
      // 已经在 numDocs 里的（按文件名）跳过，避免重复报
      if (numDocs.some(([, label]) => label.includes(path.basename(f)))) continue
      const txt = readText(f)
      if (/(?:共|统一入口共|合计)\s*[\d一二三四五六七八九十]{1,3}\s*项/.test(txt)
        || /[\d一二三四五六七八九十]{1,3}\s*项机械检查/.test(txt)) {
        extra.push([txt, rel])
      }
    }
  }
  if (extra.length) {
    console.log('   ℹ️  ①b 额外纳入 ' + extra.length + ' 份文档（它们也写了"共 N 项"这类总数）：')
    for (const [, rel] of extra) console.log('      · ' + rel)
    for (const [txt, rel] of extra) {
      const m = txt.match(/(?:共|统一入口共|合计)\s*([\d一二三四五六七八九十]{1,3})\s*项/)
        || txt.match(/([\d一二三四五六七八九十]{1,3})\s*项机械检查/)
      // ★ 修（第 48 轮，**我新写的检查的第一个 bug**）：原来用 `cn2i(m[1])` ——
      //   而 `cn2i` **只认中文数字** ⇒ 阿拉伯数字 '19' 进去得到 NaN ⇒ `NaN !== 19` ⇒ **把对的判成错的**。
      //   文件里早就有个 `toInt`（`/^\d+$/ ? Number : cn2i`），我没用它。
      // ★ 修（第 48 轮，**块作用域第二次**）：`toInt` / `cn2i` 都定义在 **①b 那个块里** ——
      //   本段在**另一个块**里，看不见它们（实测 `ReferenceError: toInt is not defined`）。
      //   ⇒ **就地算**，不依赖别处的局部函数。（第 33 轮踩过同一个坑：`all` 是块级变量。）
      const __num = s => (/^\d+$/.test(s) ? Number(s)
        : ({ 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20 }[s] !== undefined
          ? { 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20 }[s]
          : { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[s]))
      const claimed = m ? __num(m[1]) : NaN
      if (claimed !== N) {
        findings.push('【项数不符·全仓扫描】' + rel + ' 写的是 **' + (m ? m[1] : '?') + ' 项**，'
          + '而统一入口实际 **' + N + ' 项** ⇒ **这份文档不在原来的对账清单里**（写死三处的代价）')
      }
    }
  }
}
// ── ①c 名字列表一致性（2026-09-26 加，**第 5 次同型错**）─────────────────────────
// ★ 起因：`AGENTS.md` 那句「一条命令跑完 …**十八项**断言」——
//   **数字写对了（18），但列出来的名字只有 16 个**：漏了「PS 语法门」与「文本卫生」
//   （它们是后来才加进 CHECKS 的，加的人只改了数字、没补名字）。
//   ⇒ ①b 只对账「N 项」那个**数字**，所以**抓不到"数字对、名字漏"**这一形态。
// ★ 判据：那句里以「、」分隔的名字个数，必须等于 CHECKS 的实际项数。
//   **为什么值得单列一条**：AGENTS.md 自己写着「散文层的漂移这三条命令都抓不到，
//   实测犯了 3 次，三次的发现者依次是访客 / 访客 / 用户，没有一次是自查或断言抓到的」——
//   这一条就是把那句"唯一能防的动作"（改完当场搜一遍那个数字）**交给断言去记**。
// ★ 诚实边界：它只数**个数**，不管名字是否**对应**（「标记A」和「标记B」调换了它看不出来）——
//   那需要一份"脚本名 → 中文名"的映射，而那份映射本身会漂移。**这里明确不假装覆盖到那一层。**
for (const [text, label] of numDocs) {
  // ★ 收紧（2026-09-26，第一版假阳性）：第一版写成 `一条命令跑完\s*([^）]*?)\s*断言` ——
  //   于是流程文档里那句「**一条命令跑完****全部断言**。」被匹配到，`全部` 被当成"一个名字"
  //   ⇒ 报「列了 1 个名字」。**那是假阳性，不是真问题。**
  //   ⇒ 判据收紧为：**那句里必须真的有「、」分隔的名字列表**（≥2 个名字才叫"列表"）。
  const mList = text.match(/一条命令跑完\s*([^）\n]{0,600}?)\s*断言/)
  if (!mList) continue
  const raw = mList[1].replace(/\*\*/g, '')
  // 只有出现「、」才认定它在"列名字"；否则那句话是"跑完全部断言"这类总述，跳过。
  if (!raw.includes('、')) continue
  const names = raw.split('、').map(s => s.trim()).filter(Boolean)
  if (names.length !== N) {
    findings.push(`【名字列表与项数不符】${label} 里「一条命令跑完」那句列了 ${names.length} 个名字，`
      + `而统一入口实际有 ${N} 项 —— 数字与名字对不上（漏的可能是后加的那几项）`)
  }
}

// ── ①d 「同一个真源、多个消费者」的**交叉对账**（2026-09-26 加，第 5 次同型错的下半场）──
// ★ 起因：`CHECKS` 数组是**唯一真源**，而有**四个**地方各印各的数字：
//     ① `_check_all.cjs` 打印「通过 N / M」（它数的是**数组长度**）
//     ② 脱敏生成器 的保障清单（解析**条目形状**）
//     ③ `_selftest.cjs` 的覆盖率分母（解析**条目形状**）
//     ④ 本脚本的「统一入口的断言脚本：N 个」（解析**条目形状**）
//   实测过它们**一起错**的样子：那三处共用的正则按名字前缀猜，漏了 `_refresh_snapshots.cjs`
//     ⇒ 保障清单印 17、覆盖率分母 17、而第 18 项**连被数的资格都没有**。
//     ★ 当时唯一没被带偏的是 ② 之外的**数组长度**那条 —— 两个数一对，差 1，才暴露出来。
//   ⇒ 所以：**让"两种独立算法"每次都互相对一次账**，而不是靠某一次偶然的比对。
//   ★ 为什么用两种算法：**同一个函数算两遍不算交叉核对**（同错同对）；
//     只有"数组长度"与"条目形状"这两种**互不依赖**的算法，才互为反例。
// ★ 诚实边界：它只能对账**"项数"**这一个数字，对不了项名与顺序（那需要逐项比，本脚本不做）。
{
  const mArr = allSrc.match(/const CHECKS = \[([\s\S]*?)\n\]/)
  if (!mArr) {
    findings.push('【真源对账】从 `_check_all.cjs` 里找不到 `const CHECKS = [` 数组 —— 对账没法做（**这不是通过**）')
  } else {
    // 算法 A：**数组长度**（数顶层条目行）
    const nA = (mArr[1].match(/^\s{2}\[/gm) || []).length
    // 算法 B：**条目形状**（`['显示名', '脚本名'…`）
    const nB = [...new Set([...mArr[1].matchAll(/\['([^']+)',\s*'([^']+\.cjs)'/g)].map(m => m[2]))].length
    if (nA !== nB) {
      findings.push(`【真源对账】\`CHECKS\` 的两种数法对不上：**数组长度 ${nA}** vs **条目形状解析 ${nB}**`
        + ' ⇒ 说明有一方的判据认不全（**差异本身就是线索**：去查第 ' + (Math.min(nA, nB) + 1) + ' 项为什么没被认出来）')
    } else {
      // 算法 C：**产物里印的那个数**（读保障清单，如果它存在）
      const gPath = path.join(HERE, 'public', 'docs', '保障清单.md')
      if (fs.existsSync(gPath)) {
        const g = fs.readFileSync(gPath, 'utf8')
        const mG = g.match(/## 一、统一入口里的\s*(\d+)\s*项断言/)
        if (!mG) {
          findings.push('【真源对账】保障清单里找不到「## 一、统一入口里的 N 项断言」那句 —— **对账没法做**（可能那句话被改写了）')
        } else if (Number(mG[1]) !== nA) {
          findings.push(`【真源对账】保障清单里印的是 **${mG[1]} 项**，而 \`CHECKS\` 实际 **${nA} 项**`
            + ' ⇒ 生成器那边的解析与真源不一致（**先看它是不是又按名字猜了**）')
        }
      }
    }
  }
}
// 反向：一处都没提到"共 N 项" ⇒ 也是漂移（说明"有 N 项"这个事实没被表达）
const anyClaim = numDocs.some(([t]) => /[一二三四五六七八九十]{1,3}项机械检查|这[一二三四五六七八九十]{1,3}项|共\s*[一二三四五六七八九十]{1,3}项/.test(t))
if (!anyClaim) {
  findings.push('【无项数声明】三份文档（AGENTS / 流程文档 / 公开 README 源）里都没写"共 N 项" —— 无法对账')
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
﻿if (!OVERVIEW) {
  console.log('  ⏭️ 未配置 declaration ⇒ 跳过「分层表覆盖全部正文文件」这一块比对')
  console.log('     （这一块与「文档漂移」本身无关 —— 它是「口径变更影响面」的分层表检查；）')
  console.log('       要看它，就把 declaration 指向 00_总览与共性技术底座.md。）')
} else if (!fs.existsSync(OVERVIEW)) findings.push('【缺目标声明】找不到 00_总览与共性技术底座.md')
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
