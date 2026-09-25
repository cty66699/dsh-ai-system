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

// ═══ 参数白名单（2026-09-26 加，独立审查抓出的**最致命的一个假绿**）══════════════
// ★ 症状（核验方实测）：`--taget <我的配置>`（target 拼错一个字母）
//   ⇒ 原来**静默忽略未知参数** ⇒ 回落 `example/_target.json` ⇒ `通过 8 / 8`、**exit 0**。
//   ⇒ 接 CI 的人会被坑死：**拼错一个字母，CI 永远绿灯**。
// ★ 同源：`--help` 也被静默忽略 ⇒ 直接跑示例工程并 exit 0 ——
//   **想查用法的人，拿到的是一个绿色的假运行**。
// ★ 所以：**未知参数一律报错**；`--help` 单独给出用法。
// ★ 必须放在 `_paths.cjs` 的 `load()` **之前** —— 因为 load() 会把 `--target <v>` 从 argv 里摘掉。
{
  const KNOWN = new Set(['--fast', '--target'])
  const argv = process.argv.slice(2)
  const unknown = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') {
      // ★★ 2026-09-26 加（独立核验 F-6）：--target 给了但没值 也要拦住。
      //   原来只跳过它的值，不检查值是否存在 ⇒ node _check_all.cjs --fast --target（尾随、无值）
      //   会一路静默回落到 example/_target.json ⇒ 报「通过 9 / 9」exit 0。
      //   ⇒ CI 里写 --target "$CONFIG" 而变量没设上，就得到一次绿色的假运行。
      //   （同一个假绿的「拼错」那一半已经修了 —— 这是另一半。）
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        console.error('❌ `--target` 后面没给值 —— 拒绝回落到示例工程。')
        console.error('   用法: node _check_all.cjs --fast --target <配置文件.json>')
        console.error('   ★ 这条是刻意的：静默回落会让 CI 拿到一个绿色的假运行。')
        process.exit(2)
      }
      i++; continue
    }        // 连同它的值一起跳过
    if (!KNOWN.has(a)) unknown.push(a)
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node _check_all.cjs [--fast] [--target <配置文件>]')
    console.log('')
    console.log('  --fast              跳过需要联网的检查（快照复查）')
    console.log('  --target <文件>     用指定的目标配置（不传则用本仓库默认布局）')
    console.log('')
    console.log('  ⚠️ **参数拼错会直接报错**，不会静默回落到示例工程 ——')
    console.log('     因为"回落 + 报绿"会让 CI 永远绿灯（这是实测踩过的坑）。')
    console.log('')
    console.log('退出码: 0=全部通过  1=有发现  2=结构性错误/参数错')
    process.exit(0)
  }
  if (unknown.length) {
    console.error('❌ 不认识的参数：' + unknown.join(' '))
    console.error('')
    console.error('   已知参数只有：--fast / --target <配置文件>')
    console.error('   （是不是拼错了？例如把 --target 写成 --taget —— 实测有人这么干过。）')
    console.error('')
    console.error('   ★ 这里**故意**不回落默认布局：否则拼错一个字母会静默跑示例工程并报"通过"。')
    console.error('')
    console.error('   用法: node _check_all.cjs [--fast] [--target <配置文件>]')
    process.exit(2)
  }
}

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
  // ★ PowerShell 语法门（2026-09-26 加）：`.cjs/.js/.mjs` 有了语法门，但 **`.ps1` 一直没有** ——
  //   而 `.ps1` 恰恰最容易「文本变形且静默」（中文注释 + 中文输出的编码问题、PowerShell 自己的
  //   字符串规则）。实测：同一类错（字符串里嵌半角引号）犯了 **6 次**，前 5 次都是手工改掉、接着犯。
  //   它用 **PowerShell 自己的解析器**判，不是我的正则（正则判不出「谁和谁是一对引号」）。
  ['PS 语法门', '_check_ps_syntax.cjs', [], false],
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
  // ★ 文本卫生（2026-09-25 新增）：查"文本变形且静默"那一类错 ——
  //   BOM 多余（json/yaml/ssh config）、PowerShell 引号未闭合（会静默截断输出）、
  //   `//` 注释写错（PS 只认 #）、生成物是否比源陈旧。
  //   与上一项「文件卫生」分工：那项管**编码与残留**（.ps1 缺 BOM / 可解码性 / 临时脚本），
  //   这项管**文本结构与新鲜度**。
  ['文本卫生', '_check_text_hygiene.cjs', [], false],
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


  // ★ 2026-09-26 加（**"新东西有没有被看见"的自动化答案**）：
  //   它问的不是"这一项自己查到问题没有"，而是"**公开集里的每个文件，有没有被任何检查看见**"。
  //   起因是一条推论：「**如果新东西进来时旧护栏什么都不说，那要么新东西确实合规，
  //   要么旧护栏看不见它**」—— 而后者**不会自己报出来**（看不见就是看不见）。
  //   实测（首次运行）：48 个文件全部至少有一道护栏，最薄的 `LICENSE` 也有 3 道。
  //   ⚠️ 它与"发布覆盖检查"分工不同：那个问"**这个文件是不是本次生成写出来的**"（防手放/防漏生成），
  //     本项问"**这个文件有没有被任何一条检查看见**"（防"进来了但没人管"）。
  ['覆盖矩阵', '_check_coverage.cjs', [], false],

  // ★ 2026-09-26 加（**「列举会漂移」第 6 种形态**）：
  //   前面五种是"清单漏了东西"；这第 6 种是**同一份清单在几个地方各写了一遍** ——
  //   两处**各自漂移**时会出现「一处认、一处不认」的静默不一致。
  //   实测：`跳过目录` 与 `JS 扩展名` 两份清单**各自在两个脚本里写了一遍**，已抽到 `_paths.cjs`；
  //   而毕业账本那份五桶清单在 `_selftest.cjs` 里**故意不共享**（测试要能独立造输入）⇒ 带理由豁免。
  //   ⚠️ 它**不改代码、也不判"该不该合并"** —— 只把"哪里重复了"摆出来（判断留给人）。
  ['重复清单', '_check_duplicate_lists.cjs', [], false],

  // ★ 2026-09-26 加（第 52 轮）：**推送前核历史内容** ——
  //   它回答的是「**当前文件干净**」与「**历史里干净**」的区别，而**推上去之后历史会跟着走**：
  //   一个提交过的密钥，**删掉文件也仍然在历史里**。
  //   做法：`rev-list --objects --all` ⇒ **按 `cat-file -t` 过滤出 blob** ⇒ 逐个扫模式表。
  //   ⚠️ 那步过滤是**必须的** —— 不过滤时每个 tree 都贡献一堆 40 位 hex（**实测 41 处误报**）。
  //   实测读数：公开集 52 个对象 / 46 个 blob / **0 命中**。
  ['历史卫生', '_check_git_history.cjs', [], false],

  // ★ 2026-09-26 加（第 54 轮）：**把"推送"变成有断言守着的过程**。
  //   它回答三个以前**全靠我记得**的问题：① 工作区干净吗 ② 与 `origin/master` 一致吗 ③ 差的是哪些提交。
  //   ★ 起因是"产物仓库"的固有性质：公开集是**原子替换**出来的 ⇒
  //     「推送到位」**不是一个一次性动作，而是一个状态**（推完 `git status` 是 0，
  //     而下次生成又会让它变 —— 哪怕内容一字不差，换行符/BOM/顺序的差异也会产生真实 diff）。
  //   ⚠️ 它**不判"该不该推"**，也不看内容对不对 —— 那两件是人的事；它只负责"现在同步吗"。
  //   ⚠️ 在公开集里它会**跳过**（`origin/master` 引用在浅 clone 或非仓库形态下可能没有）。
  ['发布同步', '_check_publish_sync.cjs', [], false],

  // ★ 2026-09-26 加（第 55 轮）：**"提交"这一环里唯一没人管的东西**。
  //   到第 54 轮为止，发布链每一环都有断言看着（生成 5 道闸 / 推送有发布同步 / 访客有干净环境验证），
  //   而**提交信息是我手写的** —— 它恰恰是"给人看的、最该一致"的那一份。
  //   判四件：① 首行非空·≤72 字符·不以句号结尾 ② 改动大就要有正文
  //           ③ 首行不能是"update/fix/改"这类没信息量的词
  //           ④ **信息里提到的文件名必须真的在本次改动里**（"说的与做的对得上"）
  //   ⚠️ 它判不了"说得**全不全**"与"措辞好不好" —— 那两件是人的事。
  ['提交信息', '_check_commit_msg.cjs', [], false],
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
  // ★ 2026-09-26 加（独立审查抓出）：**「脚本崩溃」与「脚本报出发现」必须分开。**
  //   实测症状：`目标声明.md` 名字不对 ⇒ `_check_conformance.cjs` 在**模块加载期**抛 ENOENT
  //   ⇒ Node 未捕获异常 ⇒ 进程以 **exit 1** 结束 ⇒ 被显示成「⚠️ 有发现（退出码 1）」
  //   ⇒ **用户跑去自己项目里找"发现"，而检查器根本没跑起来。**
  //   判据：未捕获异常的 stderr 一定带**栈帧行**（形如 `    at foo (file:line:col)`）。
  //   ★ 只认「至少两行栈帧」或明确的 `XxxError:` 头 —— 单行 `at` 可能是正文里恰好出现的词。
  {
    const frames = out.split(/\r?\n/).filter(l => /^\s+at\s+.+:\d+:\d+/.test(l))
    const hasThrowHeader = /^(?:[A-Za-z]*Error|Uncaught):/m.test(out)
    if (frames.length >= 2 || hasThrowHeader) {
      const first = out.split(/\r?\n/).find(l => /^(?:[A-Za-z]*Error|Uncaught):/.test(l)) || frames[0] || '(无输出)'
      console.log('❌ **这一项崩了**（不是"有发现"）—— ' + first.trim().slice(0, 100))
      console.log('   ⇒ 检查器根本没跑起来，所以下面任何"结论"都不成立。')
      console.log('   ⇒ 常见原因：配置里指向的目标文件不存在 / 格式不对。')
      console.log('     （这是**结构性错误**，不是"你的项目有问题"—— 别去自己项目里找发现。）')
      results.push({ name, code: 2, crashed: true, out })
      continue
    }
  }
  const tail = out.trim().split(/\r?\n/).filter(l => l.trim()).slice(-1)[0] || ''
  console.log(code === 0 ? '✅ 通过' : (code === 1 ? '⚠️ 有发现（退出码 1）' : '❌ 失败（退出码 ' + code + '）'))
  if (tail) console.log('     ' + tail.slice(0, 160))
  results.push({ name, code, out, script })
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

// ══════════════════════════════════════════════════════════════════════════════════════
// ★ 「拦截台账」：把每次"真的有项报红"记一笔（2026-09-26 加）
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么加它：本项目反复出现"**机制是对的，但没人守它，于是长期空转**"这一类失效 ——
//   实例：跨轮欠账检查读的账本 `round` 停在 12、而它一直输出「✅ 无跨轮逾期欠账」。
//   ⇒ 对策之一是问「**这个机制上一次真的拦截到什么？**」——
//     而在此之前，那个答案**只能靠我回忆**（本文件开头那段"五道闸的上一次拦截"就是我手写的）。
//     手写的会过期；**而且它答不了"这 16 项里哪些从来没拦到过东西"**。
//   ⇒ 所以：**让每次拦截自动留一行**。
// ⚠️ 台账是**本机运行历史**，不进版本库（在 `.gitignore` 里）。
// ⚠️ 它**只追加、不清理**；要重置就直接删文件（那是有意的：删掉 = 从零开始观察）。
// ══════════════════════════════════════════════════════════════════════════════════════
// ★ 「规则级台账」（2026-09-26 加，第 45 轮）
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么在"项级台账"之外再加一层：原台账只记**哪一项报红**（`_check_refs.cjs=1`）——
//   而一项检查里通常有好几条**规则**（`_check_text_hygiene.cjs` 有 7 条：BOM 多余 / 引号未闭合 /
//   注释符写错 / 生成物陈旧 / 全角标点 / 换行符混用 / JS 语法错）。
//   ⇒ 于是"这一项报过红"这句话，**说明不了"它的哪条规则真的拦到过东西"**。
//   ★ 而本项目反复关心的问题恰恰是那个：**「这条规则上一次真的拦到什么？」**
// ⇒ 所以：从每项的输出里**提取规则标签**（形如 `[生成物陈旧]` 或 `【缺字段】`），
//   与历史台账比对，**标出"本次首次出现"的规则** —— 那就是"某条规则第一次真的拦到了东西"。
// ⚠️ 诚实边界（写在输出里，不假装它覆盖全）：
//   它只能提取**自带方括号标签**的输出；有些检查的文案没有标签（或标签不规范）⇒ **那些抓不到**。
//   这是"能做到多少就报多少"，不是"全部规则的首次触发都被记下来了"。
const RULE_RE = /\[([\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9 _\-]{1,15})\]|【([^】]{2,16})】/g
const rulesThisRun = new Set()
for (const r of bad) {
  if (r.spawnFail || !r.out) continue
  for (const m of String(r.out).matchAll(RULE_RE)) {
    const tag = (m[1] || m[2] || '').trim()
    if (tag) rulesThisRun.add(tag)
  }
}
let seenBefore = new Set()
try {
  if (fs.existsSync(LEDGER)) {
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)) {
      try { for (const t of (JSON.parse(line).rules || [])) seenBefore.add(t) } catch { /* 旧行没有 rules 字段，跳过 */ }
    }
  }
} catch { /* 读不到历史就当"没见过的"——宁可多报首次，也不要漏报 */ }
const firstTime = [...rulesThisRun].filter(t => !seenBefore.has(t))
const LEDGER = path.join(HERE, '_拦截台账.jsonl')
if (bad.length) {
  try {
    fs.appendFileSync(LEDGER, JSON.stringify({
      at: new Date().toISOString(),
      // ★ 记的是**脚本名**（不是中文项名）—— 这样它才能和 `_selftest.cjs` 里那份
      //   「断言清单」（从本文件源码里抠出来的文件名）对上。
      //   踩过：第一版记的是项名，于是摘要里把所有项都算成「从没拦到过」（两套名字对不上）。
      bad: bad.filter(b => !b.spawnFail).map(b => (b.script || b.name) + '=' + b.code),
      // ★ 规则级（第 45 轮加）：本次命中的规则标签 + **本次首次出现**的那些。
      rules: [...rulesThisRun],
      firstTime: firstTime,
      spawnFails: spawnFails.map(b => b.name),
    }) + '\n', 'utf8')
  } catch { /* 记台账失败不影响判定 */ }
if (firstTime.length) {
  console.log('')
  console.log('★ 本次有 ' + firstTime.length + ' 条规则**第一次真的拦到了东西**：' + firstTime.join('、'))
  console.log('   （记进台账了。想知道每条规则的首次触发，查 `_拦截台账.jsonl` 的 firstTime 字段。）')
}
}
process.exit(bad.length ? 1 : 0)
