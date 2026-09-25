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
    execFileSync(process.execPath, [path.join(HERE, c.script), '--target', path.join(dir, '_target.json')],
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
  const bit = code !== 0 && probeOk
  results.push({ name: c.name, script: c.script, code, bit, valid: probeOk, why: c.probeWhy, head: out.split('\n').filter(Boolean)[0] || '' })
}

console.log('=== 反例自检：注入已知缺陷，**要求断言必须变红** ===')
console.log('')
let bad = 0
for (const r of results) {
  console.log((r.bit ? '✅ 咬到了   ' : (r.valid ? '❌ 没咬到   ' : '⚠️ 用例失效 ')) + r.name)
  console.log('            ' + r.script + ' → 退出码 ' + r.code + (r.head ? ' ｜ ' + r.head.slice(0, 70) : ''))
  if (!r.bit) {
    bad++
    if (!r.valid) console.log('            ⚠️ **扰动没生效**（' + (r.why || '') + '）⇒ 这个用例什么也没证明 —— 先修用例，别急着改断言')
  }
}
console.log('')
if (bad) {
  console.error('❌ 有 ' + bad + ' 个断言在**注入缺陷之后仍然报绿** —— 那它不是断言，是装饰。')
  console.error('   ⇒ 别改这条自检，去改那个断言。')
  process.exit(1)
}
console.log('✅ ' + results.length + ' 个断言全部"咬到了"（注入缺陷 ⇒ 都变红）。')
console.log('   （强度说明：本自检证明的是"**这些断言会失败**"，不证明"它们失败得对"。）')
