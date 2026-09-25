// 统一路径解析 —— 让断言脚本**不再写死本工作区的目录布局**
//
// 为什么要它（X-21）：把「可开源子集」复制到空目录后跑 `_check_all.cjs` ⇒ **通过 1/8**。
//   根因之一是：各脚本用 `__dirname/../..` 推出工作区根，再拼 `方案设计\…` ——
//   **公开仓库没有这个布局，于是全线失配**；更根本的是，它们要读的
//   `00_总览` / 核验报告 / 裁定记录 / 登记册**本身不可公开**。
//
// 设计：**一套逻辑名 → 一组真实路径**。默认值 = 本工作区布局（保证本地行为一字不变）；
//   若存在 `_target.json`（或环境变量 `DSH_CHECK_TARGET` 指向它），则用它的映射。
//   ⇒ 公开仓库只需带一份 `_target.json` 指向随仓库附带的 `example/` 样例工程。
//
// 纪律：**改这里不许改变本工作区的既有行为** —— 每次改完必须回跑 `_check_all.cjs` 对账。
const fs = require('node:fs')
const path = require('node:path')

const HERE = __dirname
// ⚠️ `let` 而非 `const`：`load()` 里允许用配置的 `repoRoot` 覆盖它（见下）。
let ROOT = path.resolve(HERE, '..', '..')            // 工作区根（默认布局用）
const readText = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')

let _cached = null

function load() {
  // ★ 结果**缓存**（且只解析一次 argv、只 splice 一次）。
  //   踩过的坑：`load()` 会从 argv 摘掉 `--target`，**第二次调用就找不到它了** ⇒
  //   返回的对象里 `usingCustomTarget` 变 false ⇒ **静默退回默认布局**。
  if (_cached) return _cached
  // ⚠️ **只在显式指定时**才启用自定义目标 —— 否则本地布局有被悄悄改掉的风险。
  //   指定方式两种：`--target <配置文件>`（优先）或环境变量 `DSH_CHECK_TARGET`。
  //   **不再隐式读取同目录的 `_target.json`** —— 第一版这么写，等于"放个文件就改变全部断言的行为"。
  const ai = process.argv.indexOf('--target')
  let cfgPath = null
  if (ai !== -1) {
    cfgPath = process.argv[ai + 1] || null
    // ★ 把 `--target <v>` **从 argv 里摘掉**再交还给调用脚本 —— 否则它会占用调用方
    //   原有的位置参数（`_check_conformance.cjs` 的 `argv[2]` 就是「成品路径」，
    //    第一版没摘，它把 `--target` 当成成品路径去读，报 ENOENT）。
    process.argv.splice(ai, 2)
  }
  if (!cfgPath) cfgPath = process.env.DSH_CHECK_TARGET || null
  if (!cfgPath) {
  // ★ 公开仓专用默认值：未给 `--target` 时用 `example/_target.json`。
  //   理由：README 教的那条命令带 `--target`，但第一次跑的人不会读；
  //   而裸跑会去爬**仓库外面**的内部布局，报出一屏红 —— 看起来像仓库是坏的。
  const _dflt = path.join(HERE, '..', 'example', '_target.json')
  if (fs.existsSync(_dflt)) cfgPath = _dflt
}
if (cfgPath) cfgPath = path.resolve(cfgPath)
  // ★ C-3（Kimi 发现）：**给了 `--target` 却找不到 ⇒ 明确报错，不许静默回落到"默认布局"。**
  //   否则在别的目录敲同一条命令 ⇒ 配置不存在 ⇒ 退回默认布局 ⇒ 各脚本开始**爬仓库外的树**，
  //   报出一屏莫名其妙的红或假绿，而**没有任何提示告诉用户"你站错目录了"**。
  //   注意：只有"显式给了却找不到"才判错；**完全不给**（裸跑）仍走各自的默认路径。
  if (cfgPath && !fs.existsSync(cfgPath)) {
    console.error('❌ 找不到目标配置：' + cfgPath)
    console.error('   ⇒ 本项**不回落默认布局**。请确认你在仓库根目录下运行（见 README 那条命令）。')
    process.exit(2)
  }
  let t = {}
  if (cfgPath && fs.existsSync(cfgPath)) {
    try { t = JSON.parse(readText(cfgPath)) }
    catch (e) { console.error('❌ _paths.cjs：目标配置解析失败 ' + cfgPath + ' —— ' + e.message); process.exit(2) }
  }
  // ★ 仓库根也是**可配的**：脚本默认按 `__dirname/../..` 推（本工作区的形状），
  //   但公开仓库的目录深度可以不同 ⇒ 允许 `repoRoot` 显式指定。
  //   **不配就与从前一字不差**（默认布局下仍是 `__dirname/../..`）。
  {
    const BASE0 = cfgPath ? path.dirname(cfgPath) : HERE
    if (t.repoRoot) ROOT = path.resolve(BASE0, t.repoRoot)
  }
  // 相对路径一律相对**配置文件所在目录**解析（更直觉）；未给配置时用默认布局
  const BASE = cfgPath ? path.dirname(cfgPath) : HERE
  const custom = Object.keys(t).length > 0
  // ★★ 三态（本轮修的核心）：**未配置 ≠ 用默认**。
  //   进入「自定义目标」模式后，未配置的项一律返回 null ⇒ 调用方报「未配置 ⇒ 跳过」。
  //   理由（实测教训）：在工作区里跑 `--target example\…` 时，未配置项回落到**真项目**的路径，
  //   于是收敛账/跨轮结转/文档漂移三项"变绿" —— **而那是假的**（读的是另一个工程）。
  //   **宁可少跑，不许混跑。**
  const R = (v, dflt) => (v ? path.resolve(BASE, v) : (custom ? null : dflt))
  const P = (...s) => path.join(ROOT, ...s)

  return (_cached = {
    cfgPath: cfgPath || '(未指定 ⇒ 本工作区默认布局)',
    // 配置里相对路径的基准目录（无配置时 = 脚本目录）。处置清单等**数据文件内部**的相对路径也应以此为准。
    base: BASE,
    usingCustomTarget: Object.keys(t).length > 0,
    ROOT,
    t: {
      declaration: R(t.declaration, P('方案设计', '00_总览与共性技术底座.md')),
      product: R(t.product, P('方案设计', '02_任务二_（未发表项目）.md')),
      conformanceMap: R(t.conformanceMap, path.join(HERE, '_conformance_map.json')),
      dispositionManifest: R(t.dispositionManifest, path.join(HERE, '_disposition_manifest.json')),
      carryover: R(t.carryover, P('方案设计', 'AI体系', '_carryover.json')),
      agentsDoc: R(t.agentsDoc, P('AGENTS.md')),
      flowDoc: R(t.flowDoc, P('方案设计', '核查', '_briefs', 'README-派发流程.md')),
      register: R(t.register, P('方案设计', 'AI体系', '07_致命问题登记册.md')),
      guide: R(t.guide, P('方案设计', 'AI体系', '08_需要用户做的事.md')),
      capabilityFile: R(t.capabilityFile, P('方案设计', 'AI体系', '06_核验者能力档案.md')),
      convergenceLedger: R(t.convergenceLedger, P('方案设计', '核查', '_briefs', '裁定记录_框架漏洞审查.md')),
      convergenceList: R(t.convergenceList, P('方案设计', '核查', '_briefs', '_框架审查清单_Kimi.md')),
      // ⚠️ 纪律：这几项**未配置时返回 null**，由各脚本沿用自己原有的默认值 ——
      //    不在这里另造一套默认，否则本地行为会被悄悄改掉（第一次写的时候就把 '方案设计' 按 HERE 解析错了）。
      scanDirs: t.scanDirs ? t.scanDirs.map(d => R(d, null)).filter(Boolean) : null,
      // 文件卫生断言（`_check_hygiene.cjs`）的扫描根。默认 = 仓库根（全量走，实测 6362 文件 / 0.6 秒）；
      //   自定义目标下未配置 ⇒ null ⇒ 该项**跳过**（宁可少跑，不许混跑）。
      hygieneRoots: t.hygieneRoots ? t.hygieneRoots.map(d => R(d, null)).filter(Boolean) : (custom ? null : [ROOT]),
      // 语法门（`_check_syntax.cjs`）的扫描根。默认只扫**我们自己的脚本层**（`方案设计\` 递归），
      //   另加仓库根一级目录下的脚本 —— 不扫各项目的浏览器页脚本/第三方 js（那是别人的产物，
      //   坏了也不该让本工作区的统一入口长期亮红灯）。自定义目标下未配置 ⇒ 跳过。
      syntaxRoots: t.syntaxRoots ? t.syntaxRoots.map(d => R(d, null)).filter(Boolean) : (custom ? null : [P('方案设计')]),
      // 记忆毕业账本与记忆库（`_check_lesson_graduation.cjs`）—— 自定义目标下未配置 ⇒ 跳过。
      lessonGraduation: R(t.lessonGraduation, P('方案设计', 'AI体系', '_lesson_graduation.json')),
      lessonDb: R(t.lessonDb, P('（记忆库路径略）', 'memory.db')),
      dispositionScanDirs: t.dispositionScanDirs ? t.dispositionScanDirs.map(d => R(d, null)).filter(Boolean) : null,
      publishTargets: t.publishTargets ? t.publishTargets.map(d => R(d, null)).filter(Boolean) : null,
      budgetLedger: R(t.budgetLedger, null),
      skipBudgetCheck: t.budgetLedger === null,
      // `verify.file` 的基准：默认 = 仓库根（与既有行为一致）；自定义目标下可用 `verifyBase` 显式指定。
      //   ⚠️ 这一项**不参与"未配置即跳过"** —— 它只是一个目录常量，不是工程文件。
      verifyBase: t.verifyBase ? path.resolve(BASE, t.verifyBase) : ROOT,
    },
  })
}

module.exports = {
  load,
  // 供各脚本一行接入：所需路径若在自定义目标下未配置 ⇒ 打印并 **exit 3（跳过）**，
  // 由 `_check_all.cjs` 识别为 ⏭️（而不是 ✅ 通过 —— 那会把"没查"显示成"查过了"）。
  requirePaths(keys) {
    const c = load()
    const missing = keys.filter(k => !c.t[k])
    if (missing.length) {
      console.log('⏭️  未配置：' + missing.join(' / ') + ' ⇒ 本项**跳过**（自定义目标模式下不回落默认布局）')
      process.exit(3)
    }
    return c
  },
  HERE, ROOT, readText,
}
