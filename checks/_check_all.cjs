// 统一检查入口 —— 一条命令跑完全部断言
// 解决 X-05：断言全靠手动跑，我这一会话已多次违反（建了 `_check_counts.cjs` 没进流程 ⇒ 手写计数写错）。
// 用法: node _check_all.cjs [--fast]
//   --fast  跳过需要联网的检查（_refresh_snapshots）
// 退出码: 0=全部通过  1=有任一检查未通过
//
// ★★ 2026-09-25 修掉的一个**静默失效**（本文件自己犯的、也是本书反复记的那一类）：
//   原先用 `execFileSync(..., { stdio: ['ignore','pipe','pipe'] })` 捕获子进程输出。
//   而**本机在 DSH 沙箱下，管道 = 命名管道，打不开 ⇒ 直接 EPERM**（实测：`spawnSync node.exe EPERM`；
//   同一个子进程改用 `stdio:'inherit'` 或**文件描述符**都正常）。
//   致命之处在于下面的 catch 把 EPERM 的 `e.status`（undefined）当成 `1` ⇒
//   **每一项都显示「⚠️ 有发现（退出码 1）」，13 项全红，而每一项单独跑都是绿的。**
//   ⇒ 这正是 `（内部条目 id 略）`「**一个永远亮着的红灯，等于没有红灯**」在治理层核心的实例：
//     它照常打印、照常计数、看上去一直在工作，**所以从来没人怀疑它**。
//   ⇒ 修法两条：① 输出改走**文件描述符**；② **「根本没跑起来」与「跑了、有发现」必须分开报** ——
//     前者是"没有结论"，绝不允许伪装成后者。
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const HERE = __dirname
const fast = process.argv.includes('--fast')
// 子进程输出的落点（**文件，不是管道** —— 见循环里那段说明）。跑完删掉。
const RUNOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-check-'))
const _CFG = require('./_paths.cjs').load()
// 把 `--target <配置>` 透传给每个子脚本 —— 否则子脚本会退回默认布局，与父脚本看到的不是同一个工程。
// ★ 必须用 `_CFG.cfgPath`（load() 已把它从 argv 摘掉，此处再 indexOf 是找不到的 —— 踩过：
//   子脚本一个都没拿到 --target，于是"发布闸门 ✅ / 引用检查 ✅"其实是**空跑出来的绿**）。
const PASS = (_CFG.usingCustomTarget && _CFG.cfgPath) ? ['--target', _CFG.cfgPath] : []
console.log('目标工程：' + _CFG.cfgPath)
// 公开仓库里没有本机账本 ⇒ 预算闸门整项跳过（而不是报错或按本机数据误判）
if (_CFG.t.skipBudgetCheck) console.log('⏭️  预算闸门（`_target.json` 声明无账本 ⇒ 跳过）')

// [名称, 脚本, 参数, 是否需要网络]
const CHECKS = [
  // ★ 第一项就跑 JSON 预检：坏掉的 JSON 会让后面几项报出令人误解的错，先拦住
  ['JSON 预检', '_check_json.cjs', [], false],
  // ★ 第二项：语法门。同一个道理 —— **坏掉的脚本会让后面几项报出令人误解的错**
  //   （`_check_json.cjs` 只管 `.json`，`.cjs` 此前没有任何语法门；见 lesson （内部条目 id 略））。
  ['语法门', '_check_syntax.cjs', [], false],
  // ★ 2026-09-25 修（第二轮访客实测）：把配置里的 `budgetLedger` **透传给预算脚本** ——
  //   原来它只在 `=== null` 时派生一个「跳过」标记，**配置了路径也不生效**（脚本自己写死读 HOME）。
  //   用命名参数 `--ledger`，避免与统一入口透传的 `--target <路径>` 抢位置参数。
  ['预算闸门', '_budget_check.cjs',
    (_CFG.t.budgetLedger ? ['--ledger', _CFG.t.budgetLedger] : []), false],
  ['引用检查', '_check_refs.cjs', [], false],
  ['发布闸门', '_publish_audit.cjs', [], false],
  ['目录符合性', '_check_conformance.cjs', [], false],
  // ★ P-1（第 24 轮新增，来自 T7 第二轮 A-1 / A-3 / D-1）：**成品里不许有"未完成态标记"**。
  //   旧十项查的全是**结构**（引用、计数、映射、漂移），**没有一条查"这东西到底做完了没有"**。
  ['占位符检查', '_check_placeholders.cjs', [], false],
  // ★ 文件卫生（2026-09-25 记忆毕业评审新增）：`.ps1` 编码 / 文本文件是否 UTF-8 / 临时脚本残留。
  //   三条都是「写过教训之后仍然复发」的坑 ⇒ 停止写教训、改为造机制。建成当天抓到 13 处真问题。
  ['文件卫生', '_check_hygiene.cjs', [], false],
  ['收敛账计数', '_check_counts.cjs', [_CFG.t.convergenceLedger, _CFG.t.convergenceList], false],
  ['发现处置链路', '_check_disposition.cjs', ['--quiet-legacy'], false],
  ['跨轮结转欠账', '_check_carryover.cjs', [], false],
  ['文档漂移', '_check_flow_sync.cjs', [], false],
  // ★ 记忆毕业（2026-09-25 新增，治理规则第 10 条）：每条 active lesson 必须有归宿，
  //   且「能机械化的」必须落到一个**真的在本文件 CHECKS 里跑**的脚本上。
  //   这是「lesson 写下来了」与「这个错不会再犯」之间的那条强制链路。
  ['记忆毕业', '_check_lesson_graduation.cjs', [], false],
  // ★ 配置 section 存活（2026-09-25 新增，来自当天真实事故）：
  //   升级到 0.1.7 后，settings 的 `llm-pi-ai` section 被迁移流程**静默拒绝**
  //   ⇒ 运行时 providers 为空 ⇒ 除 deepseek-official 外**全部 provider 报 NO_ADAPTER**
  //   ⇒ T1/T2/T4/T6/T7 核验轨道全部失效，**而日常对话毫无异常**（主控自己走 deepseek）
  //   —— 只有"换模型家族"时才暴露，所以能躺很久没人发现。
  //   **"配置在"不等于"配置被运行时读到"** —— 这条断言就是那两者之间缺的链路。
  //   零成本（只读文件 + 跑一次 `--dump-config`，不发任何外部请求）⇒ 可以每次收尾都跑。
  //   已做过牙齿测试：移走补丁里的该段后本项立刻红灯，放回即绿灯。
  ['配置存活', '_check_provider_config.cjs', [], false],
  // ★ 验证代表性（2026-09-25 新增，来自同一批教训）：**验证用的 profile 必须 ⊇ 生产 profile 的 bundles**。
  //   当天我用 `--profile headless` 拿到 `HEADLESS-OK` 就认为 web 可用 —— 而 headless 只有 2 个 bundle、
  //   **缺 10 个**（含 meow-memory / usage-stats / dsh-autovision 等全部第三方）⇒ **假阳性**，
  //   掩盖了当时"8 条模型通道全部 NO_ADAPTER"的真实状态。
  //   **它是「按需」项**：不带参数时一律跳过（退出码 3）—— 因为"headless 比 web 精简"本身不是错误，
  //   错的是"拿精简组合去代表完整组合"。真正做验证之前手动跑：
  //       node checks/_check_verify_profile.cjs headless
  ['验证代表性', '_check_verify_profile.cjs', [], false],
  ['快照复查', '_refresh_snapshots.cjs', [], true],
].filter(c => !(_CFG.t.skipBudgetCheck && c[0] === '预算闸门'))
  // ★ 参数里含 null（＝自定义目标下未配置）⇒ **标记为跳过，而不是把整项从列表里删掉**。
  //   踩过：原来是 `.filter(...)` 直接删 ⇒ 该项在输出里**连"跳过"都不显示**，
  //   而其它跳过项会显示 ⏭️。**"悄悄不见"比"明说跳过"更糟 —— 它让人以为这项本来就不存在。**
  .map(c => (c[2].some(a => a === null || a === undefined)
    ? [...c, '参数未配置（自定义目标模式下不回落默认布局）'] : c))

const results = []
console.log('=== 统一检查入口 ===' + (fast ? '（--fast：跳过联网检查）' : ''))
console.log('')

for (const [name, script, args, needsNet, skip] of CHECKS) {
  if (skip) { console.log('⏭️  ' + name + '（' + skip + '）'); results.push({ name, code: 'SKIP' }); continue }
  if (needsNet && fast) { results.push({ name, code: 'SKIP' }); console.log('⏭️  ' + name + '（--fast 跳过）'); continue }
  process.stdout.write('▶ ' + name + ' … ')
  // ★ 参数一律相对**本目录**解析，不依赖调用者的 CWD。
  //   踩过的坑：AGENTS.md 治理规则第 7 条教的命令是 `node checks/_check_all.cjs`（CWD = 工作区根），
  //   而下面曾直接传 `docs/...` —— 于是 `_check_counts.cjs` 按 CWD 找不到文件，
  //   报「文件不存在」并被误读成「计数不符」。**脚本对不对，不该取决于你在哪个目录敲命令。**
  // ★ 2026-09-25 补：**以 `--` 开头的旗标不参与路径解析** —— 否则 `--ledger` 会被拼成
  //   `<本目录>\--ledger`，子脚本根本收不到这个旗标（实测：预算闸门的账本透传就是这么失效的）。
  //   其余参数仍按「相对本目录」解析（见上面那条注释的理由）。
  const absArgs = [
    ...args.map(a => (a.startsWith('--') ? a : (path.isAbsolute(a) ? a : path.join(HERE, a)))),
    ...PASS,
  ]
  let code = 0, out = '', spawnErr = null
  const logFile = path.join(RUNOUT, String(results.length) + '-' + script + '.log')
  // ★★ 2026-09-25 修：**捕获子进程输出不能用管道**。
  //   本机在 DSH 沙箱下，`execFileSync(..., { stdio: ['ignore','pipe','pipe'] })` 直接 **EPERM**
  //   （Windows 上管道是命名管道，受限模式下打不开）—— 而下面的 catch 会把 EPERM 的 `e.status`
  //   当成 `undefined` ⇒ 记成 `code = 1` ⇒ **每一项都显示「⚠️ 有发现（退出码 1）」**。
  //   后果：**统一入口在这个环境里对 13 项一律报红，而每一项单独跑都是绿的**；
  //   更糟的是它看上去"在工作"（照常打印、照常计数），所以没人怀疑它。
  //   **这正是 `（内部条目 id 略）` 说的「一个永远亮着的红灯，等于没有红灯」在治理层核心的实例。**
  //   修法：输出**改走文件描述符**（文件不是命名管道，实测三个候选目录都可用），
  //   并且**把「根本没跑起来」与「跑了、有发现」彻底分开报** —— 前者是结构性错误，不许伪装成结论。
  let fd
  try {
    fd = fs.openSync(logFile, 'w')
    execFileSync(process.execPath, [path.join(HERE, script), ...absArgs], { stdio: ['ignore', fd, fd] })
  } catch (e) {
    if (typeof e.status === 'number') code = e.status
    else { code = 'SPAWN-FAIL'; spawnErr = e.code || String(e.message).slice(0, 60) }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 忽略 */ } }
  }
  try { out = fs.readFileSync(logFile, 'utf8') } catch { /* 忽略 */ }
  if (code === 'SPAWN-FAIL') {
    console.log('❌ 无法启动（' + spawnErr + '）—— **这不是"有发现"，这是这一项根本没跑**')
    results.push({ name, code: 2, out: '', spawnFail: true })
    continue
  }
  // ★ 退出码 3 = **未配置 ⇒ 跳过**（自定义目标模式下不回落默认布局）。
  //   必须显示成 ⏭️ 而不是 ✅ —— 否则会把「没查」显示成「查过了」。
  if (code === 3) {
    const why = out.trim().split(/\r?\n/).filter(l => l.trim()).slice(-1)[0] || ''
    console.log('⏭️  跳过（未配置）' + (why ? '　' + why.slice(0, 90) : ''))
    results.push({ name, code: 'SKIP' })
    continue
  }
  const tail = out.trim().split(/\r?\n/).filter(l => l.trim()).slice(-1)[0] || ''
  console.log(code === 0 ? '✅ 通过' : (code === 1 ? '⚠️ 有发现（退出码 1）' : '❌ 失败（退出码 ' + code + '）'))
  if (tail) console.log('     ' + tail.slice(0, 160))
  results.push({ name, code, out })
}

console.log('')
try { fs.rmSync(RUNOUT, { recursive: true, force: true }) } catch { /* 忽略 */ }
const bad = results.filter(r => r.code !== 'SKIP' && r.code !== 0)
const spawnFails = results.filter(r => r.spawnFail)
console.log('—'.repeat(50))
// ★ 「跳过」的计数必须与**打印出来的 ⏭️ 行数**一致 —— 踩过：预算闸门那行 log 发生在
//   `results` 数组声明之前，于是**打印了 3 个 ⏭️、计数却说"另有 2 项跳过"**。账对不上就是错。
const _preSkip = _CFG.t.skipBudgetCheck ? 1 : 0
console.log('通过 ' + results.filter(r => r.code === 0).length + ' / ' + results.filter(r => r.code !== 'SKIP').length
  + ((results.filter(r => r.code === 'SKIP').length + _preSkip) > 0
    ? '（另有 ' + (results.filter(r => r.code === 'SKIP').length + _preSkip) + ' 项跳过）' : ''))
if (spawnFails.length) {
  console.log('')
  console.log('❌ **' + spawnFails.length + ' 项根本没跑起来**（不是"有发现"，是没有结论）：' + spawnFails.map(b => b.name).join('、'))
  console.log('   ⇒ 先修运行环境，**不要把这些项当成"检查未通过"来读** —— 那是把"没查"当成"查了"。')
}
if (bad.length) {
  console.log('')
  console.log('⚠️ 未通过的检查：' + bad.filter(b => !b.spawnFail).map(b => b.name).join('、') || '（无）')
  console.log('   ⚠️ 逐项判读（退出码含义不同，不能一概而论）：')
  console.log('      · `预算闸门` 0=正常 / **1=预警（未到熔断）** / **2=熔断（禁止对外派发）**')
  console.log('      · `引用检查` / `发布闸门` / `目录符合性` 退出码 1 表示**确有发现，必须处理或书面说明**')
  console.log('      · `发现处置链路` 退出码 1 = **有发现未逐条处置**（治理规则第 4 条要求必采纳或书面说明不采纳）')
}
process.exit(bad.length ? 1 : 0)
