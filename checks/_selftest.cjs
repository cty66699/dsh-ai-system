// 反例自检（D-2）—— 证明这些断言**真的会咬人**。
//
// 为什么必须有它（Kimi 发布前审查 D-2，原话）：
//   「**演示是「全绿样板」**：示例只有 2 条发现且全部成立、0 驳回 —— **全仓库没有任何一个
//     「断言咬人」的反例演示**；而 12 个断言脚本自身**没有任何测试**。
//     评审会问：一套以「可断言」为全部价值主张的体系，**为什么它的断言器自己没有一行测试？**」
//
// 做法：把 `example/` 拷到临时目录 → **注入一个已知缺陷** → 跑对应断言 → **要求它必须失败**。
//   **如果一个断言在被注入缺陷之后仍然报绿，那它就不是断言，是装饰。**
//   —— 这条判据本身就是本工作区反复吃亏学来的：**假通过比不通过更危险，因为它是静默的。**
//
// 用法: node _selftest.cjs
// 退出码: 0=全部用例都"咬到了"  1=有断言没咬到（或读不到退出码）  2=结构性错误
//
// 说明：它是**按需运行**的（onDemand）—— 它要往临时目录写缺陷样本，不该进每次收尾的必跑清单。
//   但它**必须存在**，否则"断言有效"就永远只是一句声称。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const HERE = __dirname
// ★ 两种布局都要能找到示例：内部是 `核查/example`，公开仓是 `<repo>/example`（脚本在 `checks/`）。
//   —— 这类"只在一种布局下成立"的路径假设，正是 C 类（可移植性）发现的来源。
const EXT = [path.join(__dirname, 'example'), path.join(__dirname, '..', 'example')]
  .find(p => fs.existsSync(p))
if (!EXT) { console.error('❌ 找不到示例工程（试过 ./example 与 ../example）'); process.exit(2) }

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name)
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b)
  }
}

// 每个用例：{ 名, 断言脚本, 注入(目标目录)⇒改动 }
const CASES = [
  {
    name: '占位符检查应该在成品有未完成态标记时变红',
    script: '_check_placeholders.cjs',
    inject: d => fs.appendFileSync(path.join(d, '成品.md'), '\n\n| 新指标 | ⬜ 待填 |\n'),
  },
  {
    name: 'JSON 预检应该在 JSON 坏掉时变红',
    script: '_check_json.cjs',
    inject: d => fs.appendFileSync(path.join(d, '结转账.json'), '\n{'),
  },
  {
    name: '目录符合性应该在成品漏掉某条要求时变红',
    script: '_check_conformance.cjs',
    // ★ 用例修正（第一次写错的就是这里）：`M2` 的检查词是 `证据融合|温度标定|不确定性`（**或**关系），
    //   只抹掉一个词它照样绿 —— **那是用例太弱，不是断言是装饰**。
    //   改用一个**单关键词**条目（`极值理论`），并回读确认它真的被抹掉了。
    inject: d => {
      const f = path.join(d, '成品.md')
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/极值理论/g, '（该处已被反例自检抹去）'), 'utf8')
    },
    probe: d => !fs.readFileSync(path.join(d, '成品.md'), 'utf8').includes('极值理论'),
    probeWhy: '抹掉 `极值理论`（若成品里本就没有它，这个用例什么也没证明）',
  },
  {
    name: '发布闸门应该在出现禁忌模式时变红',
    script: '_publish_audit.cjs',
    // ★★ 载荷必须**运行时拼装**，源码里不能出现形如 `sk-<长串>` 的字面量。
    //   实测（2026-09-25）：公开集生成器的脱敏规则 `/sk-[A-Za-z0-9_\-]{16,}/` 会把这条载荷
    //   替换成 `sk-（略）` —— **载荷太短 ⇒ 闸门扫不到 ⇒ 自检误报「断言是装饰」**。
    //   即：**我的脱敏机制会制造「假红」，冤枉一个本来正常工作的断言。**
    //   这与"假绿"同族：**判据坏了，结论就不可信 —— 不管它指向哪个方向。**
    inject: d => fs.appendFileSync(path.join(d, '成品.md'), '\n\n' + 'sk-' + 'A'.repeat(30) + '\n'),
    // 回读确认载荷**真的**是一个"禁忌样本"（而不是被谁悄悄改短的残次品）。
    probe: d => /sk-[A-Za-z0-9_\-]{16,}/.test(fs.readFileSync(path.join(d, '成品.md'), 'utf8')),
    probeWhy: '确认注入的载荷真的能匹配发布闸门的模式（若被脱敏/截断，这个用例什么也没证明）',
  },
  {
    name: '目录符合性应该在「解析出 0 个条目」时变红（而不是静默通过）',
    script: '_check_conformance.cjs',
    // ★ 2026-09-25 新增（访客实测复现过的假绿）：原逻辑里 items 为空 + 映射为空 ⇒
    //   missingInMap 与 staleInMap 都为空 ⇒ bad 保持 0 ⇒ **退出码 0、显示通过**。
    //   而「解析出 0 个条目」的真实含义**不是"没有要求"**，是**声明格式不符合解析协议**。
    //   ⇒ 这与本仓库自己的纪律冲突（**"扫了个空 ≠ 干净"**）。已修，此用例长期盯着它。
    inject: d => {
      const f = path.join(d, '目标声明.md')
      // 把解析器认的三段编号（### 4.1/4.2/4.3）改成它不认的（### 3.x）
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^### 4\./gm, '### 3.'), 'utf8')
    },
    probe: d => !/^### 4\./m.test(fs.readFileSync(path.join(d, '目标声明.md'), 'utf8')),
    probeWhy: '确认三段编号真的被改掉了（若格式没变，这个用例什么也没证明）',
  },
  // ═══ 以下 4 条是 2026-09-26 加的（来自一次独立核验：它找到 10 条假绿，
  //     而**全部落在"从没被注入过缺陷"的名单里** —— 报告的原话是
  //     「修完请把这 10 条加进 _selftest.cjs 的 CASES —— 它们的共同点是"从没被注入过缺陷"」）。
  //     ⇒ 这些用例的作用就是：**让它们不可能再退化回假绿**。
  {
    name: 'PS 语法门在未配置 syntaxRoots 时应该跳过，而不是回落到扫断言层自己的目录',
    script: '_check_ps_syntax.cjs',
    // ★ 假绿形态（独立核验 F-1）：它曾经有个**死代码守卫**（判据依赖了已被 `_paths.load()` 从 argv 摘掉的
    //   `--target`）⇒ 永远为假 ⇒ 回落到扫**断言层自己的目录** ⇒
    //   用户工程里放一个真语法错的 .ps1，它照样报「✅ 全部可解析」exit 0。
    //   ★ 特别毒的地方：同一个配置键，姊妹门 `_check_syntax.cjs` 报「⏭️ 跳过」、它报「✅ 通过」。
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.syntaxRoots                       // 把"未配置"这个状态造出来
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
      // 同时在用户工程里放一个真语法错的 .ps1（如果它回落扫自己，就扫不到这个）
      fs.writeFileSync(path.join(d, 'bad.ps1'),
        'function Get-Thing {\n  if ($true) {\n    Write-Output "hello\n}\n', 'utf8')
    },
    probe: d => !('syntaxRoots' in JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))),
    probeWhy: '确认配置里真的没有 syntaxRoots（否则这个用例什么也没证明）',
  },
  {
    name: '发现处置链路应该在清单解析出 0 条轨道时变红（而不是报"全部有处置"）',
    script: '_check_disposition.cjs',
    // ★ 假绿形态（独立核验 F-3）：`tracks` 为空数组、**或者键名拼错（写成 track 单数）** 时，
    //   它打印「严格轨道：0 条」然后报「✅ 严格轨道的发现全部逐条有处置」exit 0。
    //   ⇒ 一个什么都没查的清单，得到了一句"全部有处置"。
    inject: d => {
      fs.writeFileSync(path.join(d, '处置清单.json'),
        JSON.stringify({ tracks: [], ledgerOnly: [], exempt: [] }, null, 2), 'utf8')
    },
    probe: d => {
      const m = JSON.parse(fs.readFileSync(path.join(d, '处置清单.json'), 'utf8'))
      return Array.isArray(m.tracks) && m.tracks.length === 0
    },
    probeWhy: '确认清单里 tracks 真的是空数组（否则这个用例什么也没证明）',
  },
  {
    name: '文件卫生应该在"没有任何一类检查覆盖到文件"时判失败（而不是说三类都干净）',
    script: '_check_hygiene.cjs',
    // ★ 假绿形态（独立核验 F-10）：空集守卫判的是 `nFiles === 0`，而 `nFiles++` **对每个文件都加**
    //   （包括 png 这类二进制与无关扩展名）⇒ 扫描根里只有一个 pic.png 时 nFiles=1 ⇒ 守卫过 ⇒
    //   报「✅ 三类都干净：…文本文件均为合法 UTF-8」—— **而"文本文件"是 0 个**。
    inject: d => {
      const sub = path.join(d, 'onlypng')
      fs.mkdirSync(sub, { recursive: true })
      fs.writeFileSync(path.join(sub, 'pic.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      j.hygieneRoots = ['onlypng']               // 指向一个"只有二进制"的目录
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const sub = path.join(d, 'onlypng')
      const fsx = fs.readdirSync(sub)
      return fsx.length === 1 && fsx[0] === 'pic.png'
    },
    probeWhy: '确认那个目录里只有一个 png、没有任何文本文件',
  },
  {
    name: '统一入口应该在 --target 给了却没值时拒绝回落（而不是静默跑示例工程）',
    script: '_check_all.cjs',
    argsOf: () => ['--fast', '--target'],        // ★ 尾随 --target、不给值
    inject: () => { /* 这个用例不改文件 —— 它考的是参数解析 */ },
    probe: () => true,
  },
  // ═══ 以下 4 条是 2026-09-26 第 17 轮加的（继续清那份"从没被注入过缺陷"的名单）。
  //     依据：独立核验报告发现「10 条假绿全部落在该名单里」，并建议
  //     「修完请把它们加进 CASES —— 它们的共同点是"从没被注入过缺陷"」。
  {
    name: '引用检查应该能匹配到含全角括号的文件名（否则那段引用整段扫不到）',
    script: '_check_refs.cjs',
    // ★ 假绿形态（独立核验 F-7）：原来文件名字符类 `[\w\u4e00-\u9fa5.\-]` **不含全角括号**，
    //   而 `.md` 前面那个字符恰好是 `）` ⇒ 整条匹配失败 ⇒ 引用数永远 0 ⇒ 报「✅ 未发现悬空引用」。
    //   ★ 本仓库自己的正文名就带全角括号 ⇒ 这是**承重的**，不是边角。
    inject: d => {
      // 造一个含全角括号的文件（只有 3 行），再写一句指向它第 999 行的死引用
      fs.writeFileSync(path.join(d, '成品（v2）.md'), '# 成品（v2）\n\n只有三行\n', 'utf8')
      fs.writeFileSync(path.join(d, '索引.md'), '# 索引\n\n见 成品（v2）.md L999\n', 'utf8')
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      j.scanDirs = ['.']
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => fs.existsSync(path.join(d, '成品（v2）.md'))
      && fs.readFileSync(path.join(d, '索引.md'), 'utf8').includes('成品（v2）.md L999'),
    probeWhy: '确认那个带全角括号的文件与那句死引用都真的写进去了',
  },
  {
    name: '文本卫生应该扫描 textHygieneRoots 的**全部**根（而不是只扫第一个）',
    script: '_check_text_hygiene.cjs',
    // ★ 假绿形态（独立核验 F-5）：配置键是**数组**，而它只取 `ROOTS[0]`。
    //   实测：`["th1","th2"]` 且坏文件在 th2 ⇒ 报「✅ 通过」；把顺序换成 `["th2","th1"]` ⇒ 立刻报红。
    //   ★ 现实后果：随仓库发布的 `example/_target.json` 写的就是 `[".", "../docs"]` ⇒
    //     **`docs/` 永远不会被文本卫生扫到**。
    inject: d => {
      const a = path.join(d, 'th1'), b = path.join(d, 'th2')
      fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true })
      fs.writeFileSync(path.join(a, 'ok.md'), '# 干净\n\n正常换行\n', 'utf8')
      // 坏文件放在**第二个**根里：2 行 CRLF + 2 行 LF（换行符混用）
      fs.writeFileSync(path.join(b, 'bad.md'), '# 坏\r\n\r\n混用\n\n换行\n', 'utf8')
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      j.textHygieneRoots = ['th1', 'th2']      // ★ 坏文件在第二个
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const bad = path.join(d, 'th2', 'bad.md')
      if (!fs.existsSync(bad)) return false
      const s = fs.readFileSync(bad, 'utf8')
      return s.includes('\r\n') && /[^\r]\n/.test(s)   // 真的混用了
    },
    probeWhy: '确认第二个根里那个文件真的"换行符混用"（若没混，这个用例什么也没证明）',
  },
  {
    name: '语法门应该在"实际编译了 0 个脚本"时判失败（而不是报全部可编译）',
    script: '_check_syntax.cjs',
    // ★ 假绿形态（独立核验 F-8）：空集守卫判 `nScanned === 0`，而 `nScanned++` **把 ESM 也算了进去**
    //   ⇒ 一个**全是 ESM** 的扫描根 ⇒ 「编译 0 个脚本」却 nScanned === 1 ⇒ 守卫失效 ⇒
    //   报「✅ 全部可编译」。**对现代全 ESM 工程，这道门等于不存在。**
    inject: d => {
      const esm = path.join(d, 'esm_only')
      fs.mkdirSync(esm, { recursive: true })
      fs.writeFileSync(path.join(esm, 'mod.js'), 'import fs from "node:fs"\nexport const x = 1\n', 'utf8')
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      j.syntaxRoots = ['esm_only']
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const f = path.join(d, 'esm_only', 'mod.js')
      if (!fs.existsSync(f)) return false
      const s = fs.readFileSync(f, 'utf8')
      return /^\s*(import|export)\s/m.test(s)     // 真的是 ESM
    },
    probeWhy: '确认那个脚本真的是 ESM（vm.Script 编译不了 module）',
  },
  {
    name: 'JSON 预检在尾逗号（而非直角引号）时不应该误诊为"直角双引号"',
    script: '_check_json.cjs',
    // ★ 坏判据（独立核验"附带"条）：那句诊断的字符类里放的是**两个 ASCII 双引号**（码点 34,34），
    //   不是 U+201C/U+201D ⇒ **任何** JSON 报错（只要上下文里有 `"`）都会附上"直角双引号"的误诊。
    //   ★ 按本仓库自己的话：「**一个诊断错的断言比没有断言更糟**」。
    //   ★ 注意：本用例只能验"它变红了"；"诊断文案对不对"要靠人工看输出（机制只回读文件，不回读文案）。
    inject: d => {
      fs.writeFileSync(path.join(d, '尾逗号.json'), '{\n  "a": 1,\n}\n', 'utf8')
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      j.scanDirs = ['.']
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const f = path.join(d, '尾逗号.json')
      if (!fs.existsSync(f)) return false
      const s = fs.readFileSync(f, 'utf8')
      let bad = false
      try { JSON.parse(s) } catch { bad = true }   // 确认它真的坏
      return bad && s.includes(',\n}')
    },
    probeWhy: '确认那个 JSON 真的是坏的（尾逗号），否则这个用例什么也没证明',
  },
  // ═══ 以下 5 条是 2026-09-26 第 18 轮加的（继续清那份"从没被注入过缺陷"的名单）。
  //     其中两条考的是**命令行参数**（用 argsOf），三条用标准机制（改文件 + 改配置）。
  {
    name: '跨轮结转欠账应该在有一条"逾期未结"时变红',
    script: '_check_carryover.cjs',
    // ★ 这是那份"从没被注入过缺陷"名单里的一员。它的判据核心是：
    //   「任何『本轮未做』的事项，必须在下一轮变成 done 或 waived；不许以 open 状态跨轮躺着」。
    //   ⇒ 造一条**逾期的 open**（记了好几轮还没做掉）。
    inject: d => {
      const led = {
        items: [
          { id: 'C-1', status: 'open', what: '一条永远做不完的事', firstSeenRound: 4, lastSeenRound: 10, note: '从第 4 轮记到第 10 轮' },
        ],
      }
      fs.writeFileSync(path.join(d, '结转账.json'), JSON.stringify(led, null, 2), 'utf8')
    },
    probe: d => {
      const j = JSON.parse(fs.readFileSync(path.join(d, '结转账.json'), 'utf8'))
      return Array.isArray(j.items) && j.items.length === 1 && j.items[0].status === 'open'
    },
    probeWhy: '确认账本里真的有一条 open 项（否则这个用例什么也没证明）',
  },
  {
    name: '文档漂移应该在"统一入口项数"对不上时变红',
    script: '_check_flow_sync.cjs',
    // ★ 名单里的一员。它管的其中一件事是：文档里写的「N 项机械检查」必须等于真实项数。
    //   ⇒ 把文档里的项数改成一个**错的**（真实是 18，写 17）。
    inject: d => {
      const p = path.join(d, '假文档.md')
      fs.writeFileSync(p, '# 假文档\n\n本体系有十七项机械检查，全部会跑。\n', 'utf8')
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      j.agentsDoc = '假文档.md'
      j.flowDoc = '假文档.md'
      j.capabilityFile = '假文档.md'
      j.guide = '假文档.md'
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const s = fs.readFileSync(path.join(d, '假文档.md'), 'utf8')
      return s.includes('十七项机械检查')
    },
    probeWhy: '确认那句错的项数真的写进去了（否则这个用例什么也没证明）',
  },
  {
    name: '预算闸门应该在"显式配了账本却不存在"时变红',
    script: '_budget_check.cjs',
    argsOf: d => ['--ledger', path.join(d, '根本没有这个账本.json')],
    inject: () => { /* 这个用例考的是参数 —— 它不需要改文件 */ },
    probe: () => true,
  },
  {
    name: '计数对账应该在"标称与实际的清单长度不符"时变红',
    script: '_check_counts.cjs',
    // ★ 它取路径用的是**位置参数**（argv[2]=账本、argv[3]=外部清单），不走 --target。
    argsOf: d => [path.join(d, '计数账本.md'), path.join(d, '计数清单.json')],
    inject: d => {
      // 账本里声称 5 条，而外部清单只有 2 条 ⇒ 账对不上
      fs.writeFileSync(path.join(d, '计数账本.md'),
        '# 计数账本\n\n**合计：A=3 B=2 C=0**（共 5 条）\n\n| ID | 类别 |\n|---|---|\n| A-1 | A |\n| A-2 | A |\n| B-1 | B |\n', 'utf8')
      fs.writeFileSync(path.join(d, '计数清单.json'),
        JSON.stringify({ items: [{ id: 'A-1' }, { id: 'A-2' }] }, null, 2), 'utf8')
    },
    probe: d => {
      const led = fs.readFileSync(path.join(d, '计数账本.md'), 'utf8')
      const list = JSON.parse(fs.readFileSync(path.join(d, '计数清单.json'), 'utf8'))
      return led.includes('合计：A=3 B=2 C=0') && list.items.length === 2
    },
    probeWhy: '确认账本声称 5 条、而清单只有 2 条（否则这个用例什么也没证明）',
  },
  {
    name: '记忆毕业应该在"有 active lesson 但五个桶全空"时变红',
    script: '_check_lesson_graduation.cjs',
    // ★ 这条正是独立核验 F-4 报的假绿：配额调成"恰好的数"就静音。
    //   注意：它需要真建一个 SQLite（用 node:sqlite，Node ≥ 22.5）。
    inject: d => {
      const { DatabaseSync } = require('node:sqlite')
      const dbp = path.join(d, 'memory.db')
      try { fs.rmSync(dbp, { force: true }) } catch { /* 忽略 */ }
      const db = new DatabaseSync(dbp)
      db.exec('CREATE TABLE lesson (id TEXT PRIMARY KEY, level TEXT, status TEXT, source_session TEXT, content TEXT)')
      const ins = db.prepare('INSERT INTO lesson VALUES (?,?,?,?,?)')
      ins.run('l1', 'lesson', 'active', 'sess-T', '反例自检用')
      ins.run('l2', 'lesson', 'active', 'sess-T', '反例自检用')
      db.close()
      fs.writeFileSync(path.join(d, '毕业账本.json'), JSON.stringify({
        backlogMax: 2, selfSession: 'sess-T', backlogBySession: { 'sess-T': 2 },
        assertions: {}, partial: {}, external: {}, domain: {}, waived: {},
      }, null, 2), 'utf8')
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      j.lessonDb = 'memory.db'
      j.lessonGraduation = '毕业账本.json'
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      try {
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(path.join(d, 'memory.db'))
        const rows = db.prepare('select id from lesson where status = \'active\'').all()
        db.close()
        const led = JSON.parse(fs.readFileSync(path.join(d, '毕业账本.json'), 'utf8'))
        const buckets = ['assertions', 'partial', 'external', 'domain', 'waived']
          .reduce((a, k) => a + Object.keys(led[k] || {}).length, 0)
        return rows.length === 2 && buckets === 0
      } catch { return false }
    },
    probeWhy: '确认库里真有 2 条 active lesson、且账本五个桶真的全空',
  },
  {
    name: '文档漂移不应该因为"少配一个 declaration"就整项跳过（软依赖）',
    script: '_check_flow_sync.cjs',
    // ★ 2026-09-26 加：这是「步骤少」那一条的直接守卫。
    //   原来 declaration 被放在 requirePaths([...]) 里 —— 它是硬依赖 ⇒
    //   访客少配这一个键（而它只被"分层表覆盖"那一块用到、与文档漂移本身无关），整项就 exit 3 跳过。
    //   ★ 而同一个文件里，register 早就是软依赖（给了就跑，没给就跳过那一块并明说）——
    //     一条规矩只用在了两个键中的一个上。
    //   ⇒ 本用例把这个契约钉住：只配那 4 个必需的键，这一项必须真跑起来。
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.declaration
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const j = JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))
      return !('declaration' in j)
    },
    probeWhy: '确认配置里真的没有 declaration（否则这个用例什么也没证明）',
  },
  {
    // ★★ 这是**误报类**的第二条用例（机制在 2026-09-26 才支持这一类）：
    //   注入的是**合法用法**（少配一个软依赖的键）⇒ 要求它**不报红**。
    //   ★ 为什么值得单独守：本项目的头号纪律之一是「**误报比漏报更糟**」——
    //     而"少配一个可选键就整项跳过/报假红"正是最典型的一种误报。
    name: '发现处置链路：少配 dispositionScanDirs 时不该回落扫自己的目录（也不该报假红）',
    script: '_check_disposition.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.dispositionScanDirs     // ★ 合法用法：那个键是可选的
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const j = JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))
      return !('dispositionScanDirs' in j)
    },
    probeWhy: '确认配置里真的没有 dispositionScanDirs（否则这个用例什么也没证明）',
  },
  {
    // ★★ 第二条误报类：守**第 20 轮的成果** ——
    //   把 `declaration` 从硬依赖降成软依赖之后，**少配它不该让整个「文档漂移」跳过**。
    name: '文档漂移：少配 declaration 时不该整项跳过（那一块与它无关，跳过的只是那一块）',
    script: '_check_flow_sync.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.declaration
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const j = JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))
      return !('declaration' in j)
    },
    probeWhy: '确认配置里真的没有 declaration（否则这个用例什么也没证明）',
  },
  // ═══ 以下 6 条是 2026-09-26 第 23 轮加的：**把"误报类"从两个点扩成一条线**。
  //     起因：机制刚支持 `expectOk` 时只有 2 条用例。而"可选输入"这件事
  //     **每个脚本都在做**（`requirePaths` 里缺任何一个键 ⇒ 打印「⏭️ 未配置：X ⇒ 跳过」+ `exit 3`），
  //     却**从来没有被机械化守住过**。
  //     ★ 实测（本轮）：7 个脚本、各删一个必需键 ⇒ **全部 `exit 3` + 同样的措辞** —— 机制是对的。
  //     ⇒ 这 6 条用例的作用：**把"缺键 = 诚实跳过"这个契约钉住**，
  //       防止将来有人把它改成"报错"（那是误报）或"静默回落到默认布局"（那是假绿）。
  {
    name: '跨轮结转：少配 carryover 时应该诚实跳过（不是报错、也不是回落到真项目）',
    script: '_check_carryover.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.carryover
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => !('carryover' in JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))),
    probeWhy: '确认配置里真的没有 carryover',
  },
  {
    name: '目录符合性：少配 product 时应该诚实跳过',
    script: '_check_conformance.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.product
      delete j.declaration
      delete j.conformanceMap
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const j = JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))
      return !('product' in j) && !('declaration' in j) && !('conformanceMap' in j)
    },
    probeWhy: '确认那三个键真的都不在配置里',
  },
  {
    name: '占位符检查：少配 product 时应该诚实跳过',
    script: '_check_placeholders.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.product
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => !('product' in JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))),
    probeWhy: '确认配置里真的没有 product',
  },
  {
    name: '文本卫生：少配 textHygieneRoots 时应该诚实跳过',
    script: '_check_text_hygiene.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.textHygieneRoots
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => !('textHygieneRoots' in JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))),
    probeWhy: '确认配置里真的没有 textHygieneRoots',
  },
  {
    name: '记忆毕业：少配 lessonGraduation/lessonDb 时应该诚实跳过',
    script: '_check_lesson_graduation.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.lessonGraduation
      delete j.lessonDb
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => {
      const j = JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))
      return !('lessonGraduation' in j) && !('lessonDb' in j)
    },
    probeWhy: '确认那两个键真的都不在配置里',
  },
  {
    name: '发现处置：少配 dispositionManifest 时应该诚实跳过',
    script: '_check_disposition.cjs',
    expectOk: true,
    inject: d => {
      const cfg = path.join(d, '_target.json')
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
      delete j.dispositionManifest
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
    },
    probe: d => !('dispositionManifest' in JSON.parse(fs.readFileSync(path.join(d, '_target.json'), 'utf8'))),
    probeWhy: '确认配置里真的没有 dispositionManifest',
  },
  // ⚠️ 2026-09-26：这里曾试图加一条用例「README 的验收判据块必须与汇总行一致」——
  //   它**跑不通**，而原因值得记：**本自检的机制是「注入缺陷 ⇒ 必须报红」**，
  //   而那条核对**与任何脚本的行为都无关**（它比的是"文档里的数字"与"真实输出"）。
  //   ⇒ **它不属于这里**。它属于**生成器**（见 脱敏生成器 里的"验收判据自检"）。
  //   ★ 教训：**给一条核对找位置时，先问"它在验什么"** ——
  //     验"脚本会不会咬人" ⇒ 反例自检；验"产物与实测一致" ⇒ 生成器；验"结构与源码同步" ⇒ 统一入口。

]

const results = []
for (const c of CASES) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-'))
  const dir = path.join(tmp, 'example')
  copyTree(EXT, dir)
  c.inject(dir)
  let code = 0, out = ''
  // ★ S-2（**自家纪律，我自己先违反了**）：**不许用管道捕获子进程输出** ——
  //   本机沙箱下 `stdio:'pipe'` 直接 EPERM，而 catch 会把它当成"退出码 1"
  //   ⇒ **检查全部假红而看不出原因**。
  //   ⇒ 改用**文件描述符**。（Kimi 第二轮 D-2 逐字预言了这一条，语法门当场抓到它。）
  const logPath = path.join(tmp, '_check.log')
  const fd = fs.openSync(logPath, 'w')
  try {
    // ★★ 2026-09-26 加：支持 `argsOf` —— 有些用例考的是**参数解析**（例如「--target 给了却没值」），
    //   它们不改任何文件，所以需要能自己决定命令行参数。
    const ARGS = typeof c.argsOf === 'function' ? c.argsOf() : ['--target', path.join(dir, '_target.json')]
    execFileSync(process.execPath, [path.join(HERE, c.script), ...ARGS],
      { encoding: 'utf8', stdio: ['ignore', fd, fd] })
    code = 0
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1
  } finally {
    fs.closeSync(fd)
  }
  out = fs.readFileSync(logPath, 'utf8')
  fs.rmSync(logPath, { force: true })
  // ★ **先回读确认扰动真的生效**，再删临时目录（本工作区已付过学费：扰动没生效时，
  //   "断言没变红"会被误读成"断言是装饰" —— 实测第一次就是这么误判的）。
  const probeOk = c.probe ? c.probe(dir) : true
  fs.rmSync(tmp, { recursive: true, force: true })
  // ★ 「读不到退出码也要判失败」—— 扫了个空 ≠ 干净。且**扰动没生效就不算证明过**。
  // ★★★ 2026-09-26 加：**支持两类契约**（此前只支持一类）。
  //   ① 默认（**漏报类**）：注入**缺陷** ⇒ 断言**必须报红**（`code !== 0`）；
  //   ② `expectOk: true`（**误报类**）：注入**合法用法** ⇒ 断言**必须不报红**（`code === 0`）。
  //   ★ 为什么必须加这一类（起因）：第 21 轮我给"少配一个配置键"加了一条用例，
  //     期望它变红 —— 而它**永远咬不到**：**少配一个软依赖的键是合法用法**，修好后本就该通过。
  //     那个"没咬到"暴露的正是**本机制的能力边界**：**只验漏报，验不了误报**。
  //   ⇒ 而本项目的头号纪律之一就是「**误报比漏报更糟**」——
  //     那就更需要一条能机械守住它的测试。
  // ★★ 2026-09-26 修正：「误报」的定义要精确 —— **exit 3（跳过）不是误报，它是诚实的"没查"**。
  //   · 0 = 通过        ⇒ 正常
  //   · 1 = 有发现      ⇒ ★ 这才是"误报"（它会冤枉正常用法）
  //   · 2 = 结构性错误  ⇒ ★ 这也是真问题（例如缺键就崩）
  //   · 3 = 未配置跳过  ⇒ ✅ 合法（"没查"≠"报错"；本仓库的纪律是"跳过要显式显示"，不是"不许跳过"）
  //   ⇒ 所以 `expectOk` 的判据是「**没报红**」（0 或 3），不是「必须 0」。
  const isOk = c.expectOk ? (code === 0 || code === 3) : (code !== 0)
  const bit = isOk && probeOk
  results.push({ name: c.name, script: c.script, code, bit, valid: probeOk, why: c.probeWhy, expectOk: !!c.expectOk, head: out.split('\n').filter(Boolean).slice(-1)[0] || '' })
}

console.log('=== 反例自检：注入已知缺陷，**要求断言必须变红** ===')
console.log('')
let bad = 0
for (const r of results) {
  // ★ 两类契约的措辞不同：漏报类说「咬到了」，误报类说「没误报」。
  const mark = r.bit ? (r.expectOk ? '✅ 没误报   ' : '✅ 咬到了   ')
                      : (r.valid ? (r.expectOk ? '❌ 误报了   ' : '❌ 没咬到   ') : '⚠️ 用例失效 ')
  console.log(mark + r.name)
  console.log('            ' + r.script + ' → 退出码 ' + r.code + (r.head ? ' ｜ ' + r.head.slice(0, 70) : ''))
  if (!r.bit) {
    bad++
    if (!r.valid) console.log('            ⚠️ **扰动没生效**（' + (r.why || '') + '）⇒ 这个用例什么也没证明 —— 先修用例，别急着改断言')
  }
}
console.log('')
if (bad) {
  console.error('❌ 有 ' + bad + ' 个用例没通过 —— 分两种，看上面的 ❌ 是哪一类：')
  console.error('   · 「❌ 没咬到」= 注入缺陷后仍报绿 ⇒ **那不是断言，是装饰**；')
  console.error('   · 「❌ 误报了」= 注入合法用法却报红 ⇒ **它会冤枉正常用法**（误报比漏报更糟）。')
  console.error('   ⇒ 两种都**别改这条自检，去改那个断言**。')
  process.exit(1)
}
console.log('✅ ' + results.length + ' 个用例全部通过（' + results.filter(r => r.expectOk).length + ' 条是误报类：注入合法用法 ⇒ 必须不报红）。')
console.log('   （强度说明：本自检证明的是"**这些断言会失败**"，不证明"它们失败得对"。）')

// ★★ 2026-09-26 加：**把"覆盖了几个断言"印出来**。
//   起因（一次独立盘点）：CHECKS 里有 17 个断言，而本自检只覆盖 4 个 ——
//   加上本文件是**按需运行**（不进统一入口）⇒ **改了脚本也不会有人提醒自测过时**。
//   ⇒ 本文件自己的判据是「注入缺陷后仍报绿 ⇒ 那不是断言，是装饰」；
//     那么"**从没被注入过缺陷**"的那些，**是装饰还是断言，无人知道**。
//   ⇒ 与其假装覆盖全了，不如**把数字印出来** —— 这也是本仓库一贯的做法：**让缺口可见**。
{
  let all = []
  try {
    const src = fs.readFileSync(path.join(HERE, "_check_all.cjs"), "utf8")
    // ★★ 2026-09-26 修（**「手写清单会漂移」的第 4 个实例**）：
  //   这里原来按**名字模式**抠脚本名（`_check_*.cjs` / `_publish_audit.cjs` / `_budget_check.cjs`）——
  //   而 `CHECKS` 数组里的第 18 项叫 `_refresh_snapshots.cjs`，**不以 `_check_` 开头** ⇒
  //   **被静默漏掉**：保障清单印的是「17 项断言」（实际 18）、反例自检的覆盖率分母也是 17。
  //   ⇒ 改成**按形状**解析 CHECKS 数组的每个条目 `[显示名, 脚本名]`，不再猜名字。
  //   ★ 为什么按形状而不是按名字：**名字是数据，形状是结构** —— 数据会变，结构稳定。
  all = [...src.matchAll(/\['([^']+)',\s*'([^']+\.cjs)'/g)].map(x => x[2])
  } catch { /* 读不到就跳过 */ }
  all = [...new Set(all)]
  if (all.length) {
    // ★★ 2026-09-26 修（本轮查覆盖率时发现的算法毛病）：
//   原来分子是「CASES 里出现过的所有 script」，**包含 `_check_all.cjs`** —— 而它**不在 CHECKS 里**
//   （它是统一入口本身，不是被跑的一项）⇒ 分母 17、分子 16，**虚高一项**。
//   ⇒ 改成：**分子只算"既在 CASES 里、又在 CHECKS 里"的**。
//   ★ 顺带加一条豁免：**占位实现**（本子集未含实现的那些）本来就不该有反例测试 ——
//     它们一律 `⏭️ 跳过 + exit 3`，没有"会咬人"这回事。把这类**显式标出来**，
//     而不是让它混在"从没被注入过缺陷"的名单里吓人。
const PLACEHOLDER = new Set(['_check_provider_config.cjs', '_check_verify_profile.cjs'])
const covered = [...new Set(CASES.map(c => c.script))].filter(s => all.includes(s))
    const missing = all.filter(s => !covered.includes(s) && !PLACEHOLDER.has(s))
    const placeholders = all.filter(s => PLACEHOLDER.has(s))
    console.log("")
    console.log("  ★ 自测覆盖率：" + covered.length + " / " + all.length + " 个断言有反例测试")
    if (missing.length) {
      console.log("    **下列断言从没被注入过缺陷 ⇒ 会不会咬人未知：**")
      for (const s of missing) console.log("      · " + s)
      console.log("    ⇒ 本自检的判据是「注入缺陷后仍报绿 ⇒ 那不是断言，是装饰」；")
      console.log("      那么上面这些**是装饰还是断言，目前无人知道**。")
      console.log("    ⇒ 这不是通过，这是**已知的覆盖缺口** —— 请照此判读别处的绿。")
    }
    if (placeholders.length) {
      console.log("    （另有 " + placeholders.length + " 个是**本子集未含实现的占位项**，不需要反例测试：" + placeholders.join("、") + "）")
      console.log("      ⇒ 它们一律 ⏭️ 跳过 + exit 3，没有「会咬人」这回事 —— 但**也不该被算作已覆盖**。")
    }
  }
}


// ══════════════════════════════════════════════════════════════════════════════════════
// ★ 「拦截台账」摘要（2026-09-26 加）
// ══════════════════════════════════════════════════════════════════════════════════════
// 为什么要读它：上面那一段覆盖率说的是「**这个断言能不能咬人**」（喂它一个缺陷，它会不会红）；
//   而这一段说的是完全不同的一件事 ——「**它实际上咬到过什么**」。
//   两者必须分开看：一个断言可以"能咬"却"从未咬到"（那说明它防的事还没发生，或者它没被跑到）。
//   ★ 判据（来自一条教训）：**「这个机制上一次真的拦截到什么？——想不起来的，就是空转的。」**
// ⚠️ 台账是**本机运行历史**（在 `.gitignore` 里）；没有它时这一段只打印一句"还没有台账"。
{
  const LEDGER = path.join(HERE, '_拦截台账.jsonl')
  console.log('')
  if (!fs.existsSync(LEDGER)) {
    console.log('★ 拦截台账：还没有（跑几次 `_check_all.cjs` 之后回来看）')
  } else {
    const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const hits = new Map()          // 项名 → 拦截次数
    for (const r of rows) {
      for (const b of (r.bad || [])) {
        const name = String(b).split('=')[0]
        hits.set(name, (hits.get(name) || 0) + 1)
      }
    }
    console.log('★ 拦截台账：共 ' + rows.length + ' 次运行有报红（台账：' + path.relative(HERE, LEDGER) + '）')
    if (hits.size) {
      const sorted = [...hits.entries()].sort((a, b) => b[1] - a[1])
      console.log('   拦到过东西的项（次数）：' + sorted.map(([n, c]) => n + ' × ' + c).join('、'))
    } else {
      console.log('   （有报红记录，但解析不出项名 —— 台账格式变了？）')
    }
    // ★ 关键的一句：**从没拦到过东西的项**
    // ★ 修（2026-09-26）：这里原来写的是 `CHECKS` —— 而本文件里没有那个变量；
    //   它读断言清单用的是上面那个 `all`（从 `_check_all.cjs` 源码里正则抠出来的脚本名）。
    // ★ 修（2026-09-26，第二次）：`all` 是**块级**变量（它在上面的覆盖率那一段里定义），
    //   在这里看不见 —— 所以**就地重读一遍清单**（更自包含，也不依赖别处的写法）。
    const allNames = [...new Set([...fs.readFileSync(path.join(HERE, '_check_all.cjs'), 'utf8')
      .matchAll(/\['([^']+)',\s*'([^']+\.cjs)'/g)].map(x => x[2]))]
    const never = allNames.filter(n => !hits.has(n))
    console.log('   **从没拦到过东西的 ' + never.length + ' 项**：' + (never.join('、') || '（无）'))
    console.log('   ⇒ ★ 那**不等于它们没用**：可能是"它们防的事还没发生"（预防性），也可能是"它们根本没被跑到"。')
    console.log('     **判别方法：主动喂它一个注定失败的输入**（`_selftest.cjs` 的覆盖率就是干这个的）。')
  }
}
