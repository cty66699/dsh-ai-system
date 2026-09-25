// 发布前敏感内容闸门 —— **不可逆操作前的断言**
// 依据：准则「不可逆操作前必须装闸门：执行前必须回读实际状态做完整性校验，宁可拒绝执行，也不要带着缺陷提交」
// 用法:
//   node _publish_audit.cjs                  → 扫描默认候选开源集
//   node _publish_audit.cjs <路径> [<路径>…]  → 扫描指定路径（文件或目录）
// 退出码: 0=可发布  1=发现敏感内容，**禁止发布**
//
// ⚠️ 本脚本只打印「文件名 + 命中数 + 模式类别」，**绝不打印命中内容本身**（避免把敏感数据写进日志/对话）。
const fs = require('node:fs')
const path = require('node:path')

const _C = require('./_paths.cjs').load()
// ★ 自定义目标模式下未配置 ⇒ 跳过（否则会静默去扫默认工程，得出"假绿"）
if (_C.usingCustomTarget && !_C.t.publishTargets) {
  console.log('⏭️  未配置：publishTargets ⇒ 本项**跳过**（自定义目标模式下不回落默认布局）')
  process.exit(3)
}
// ★ 默认扫描目标（2026-09-26 改）：
//   原来是 `AGENTS.md` + `AI体系/` —— 那是**当时的发布物**。但现在本工作区的发布路径是
//     `_public_src/` → 生成器（自带脱敏自检）→ `public/` → 推送
//   而那两样**已经不再对外发布**了（AGENTS.md 是工作区指令、AI体系/ 是内部文档）。
//   ⇒ 继续扫它们：每次收尾都报一串**与发布无关的红**（中转站信息 / Cookie / 姓名），把真信号淹掉 ——
//     实测这盏红灯**长期挂着没人管**，正说明它已经失去意义。
//   ★ 那两样**确实含敏感内容**（报告没说错）—— 是**"不再发布"**让这条检查失去了对象，
//     不是"扫描有 bug"。所以这里改的是**默认扫描目标**，不是把检查放松。
const DEFAULT_TARGETS = _C.t.publishTargets || [
  path.resolve(__dirname, 'public'),
]
// ⚠️ 本脚本**不把自己列入扫描目标**：它内部写着要搜的全部模式，自我扫描必然全中（自匹配假阳性）。
//    发布时本脚本自身应做人工审阅。

// ── 内部件名单：**从来不发布**的文件 ────────────────────────────────────────
// 为什么要这一层（2026-09-24 第 5 轮）：本闸门此前对「设计如此」与「真违规」不加区分 ——
//   默认候选集里混着两份**本来就不该发布**的内部件，于是它**长期 exit 1**。
//   而第 4 轮已经证明这类"长期红灯"不是无害的：`目录符合性` 的红灯亮了两轮没人追，
//   追下去是 `02` §7.2 可靠度只做 R 侧（L4 层核心输出缺一半输入）。
//   **一个永远亮着的红灯，等于没有红灯。**
// ⇒ 现在：默认扫描**只覆盖可发布集**（内部件被排除并单独列出）；
//   而若有人**显式**把内部件当参数传进来（= 真的要发布它），**直接硬拦**。
const INTERNAL = [
  { rel: path.join('_briefs', '_派发参数.md'), reason: '每轮覆盖的派发参数（含未发表项目名 + 本机路径），从不发布' },
  { rel: path.join('_briefs', '裁定记录_框架漏洞审查.md'), reason: '内部裁定记录（含中转站倍率/余额），从不发布' },
]
const ROOT = path.resolve(__dirname, '..', '..')
// ⚠️ 首版把 rel 写成了「相对工作区根」的字符串，而比较用的是另一套基准 ⇒ **排除静默失效**：
//    扫描结果里那两份内部件照样出现，脚本却"看起来"已经做了排除。已改为**按绝对路径比较**。
const internalAbs = new Map(INTERNAL.map(i => [path.resolve(__dirname, i.rel).toLowerCase(), i]))
const relOf = abs => path.relative(ROOT, abs)

// 类别：BLOCK = 一旦命中必须停止发布；WARN = 需人工判断
const RULES = [
  // ⚠️ **这里整块都是模板，必须换成你自己项目的模式。**
  //    一个不含本项目任何真实条目的敏感词表，等于一道没有闸门的闸门 ——
  //    而它还会照样打印「0 BLOCK / 0 WARN」，**伪造出一种干净**。
  //    （内部版此处列的是真实条目，公开版已整块移除。）
  { cls: 'BLOCK', name: '私钥 / 令牌字面量', re: /sk-[A-Za-z0-9_\-]{16,}/ },
  { cls: 'BLOCK', name: '个人身份（身份证 / 手机号）', re: /\b\d{17}[\dXx]\b|\b1[3-9]\d{9}\b/ },
  { cls: 'BLOCK', name: '内部主机名 / 端点', re: /internal\.example\.com/ },
  { cls: 'WARN', name: '本机绝对路径 / 用户名', re: /[A-Za-z]:\\{1,2}Users\\{1,2}|\/Users\// },
  { cls: 'WARN', name: '会话 / 日志引用', re: /session\.jsonl|session-[0-9a-f]{8}/ },
]

function collect(t) {
  const out = []
  if (!fs.existsSync(t)) return out
  const st = fs.statSync(t)
  if (st.isFile()) { out.push(t); return out }
  for (const e of fs.readdirSync(t, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_xmind_build') continue
    const p = path.join(t, e.name)
    if (e.isDirectory()) out.push(...collect(p))
    else out.push(p)
  }
  return out
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TARGETS

// 显式点名内部件 ⇒ 硬拦（不是在扫描里放过它，而是判定"你正在试图发布内部件"）
const explicitlyInternal = targets
  .map(t => internalAbs.get(path.resolve(t).toLowerCase()))
  .filter(Boolean)

const files = [...new Set(targets.flatMap(t => collect(path.resolve(t))))]
  .filter(f => !internalAbs.has(f.toLowerCase()))

// ★ 扫了个空 ≠ 干净：待发布集为空时，「未命中任何敏感模式」是句废话。
//   实测（2026-09-24）：干净副本里本项曾因为目标没透传、扫到 0 个文件而报 ✅。
if (files.length === 0) {
  console.error('❌ 待发布集展开后为 **0 个文件** —— 这样的「未命中」不算数，判为失败')
  process.exit(1)
}

console.log('=== 发布前敏感内容闸门 ===')
console.log('待发布路径 ' + targets.length + ' 个 → 展开为 ' + files.length + ' 个文件（已排除内部件）')
if (INTERNAL.length) {
  console.log('')
  console.log('内部件 ' + INTERNAL.length + ' 个（**不发布，已从扫描集排除**）：')
  for (const i of INTERNAL) console.log('  ⛔ ' + relOf(path.resolve(__dirname, i.rel)) + ' —— ' + i.reason)
}
console.log('')

if (explicitlyInternal.length) {
  console.log('❌ **你显式点名了内部件** —— 这是"真的打算发布它"，不是扫描误伤：')
  for (const i of explicitlyInternal) console.log('   · ' + relOf(path.resolve(__dirname, i.rel)) + ' —— ' + i.reason)
  console.log('⇒ 若确要发布，先脱敏并把该条从 INTERNAL 名单里移除（改动本身留痕）。')
  process.exit(1)
}

let block = 0, warn = 0
const rows = []
for (const f of files) {
  let text
  try { text = fs.readFileSync(f, 'utf8') } catch { continue }
  const hits = []
  for (const r of RULES) {
    const n = (text.match(new RegExp(r.re.source, r.re.flags.includes('i') ? 'gi' : 'g')) || []).length
    if (n) hits.push({ cls: r.cls, name: r.name, n })
  }
  if (!hits.length) continue
  for (const h of hits) { h.cls === 'BLOCK' ? block++ : warn++ }
  rows.push({ f: path.relative(path.resolve(__dirname, '..', '..'), f), hits })
}

if (!rows.length) console.log('✅ 全部文件未命中任何敏感模式')
else {
  for (const r of rows.sort((a, b) => (b.hits.some(h => h.cls === 'BLOCK') ? 1 : 0) - (a.hits.some(h => h.cls === 'BLOCK') ? 1 : 0))) {
    const isBlock = r.hits.some(h => h.cls === 'BLOCK')
    console.log((isBlock ? '❌ ' : '⚠️ ') + r.f)
    console.log('     ' + r.hits.map(h => h.cls + ':' + h.name + '×' + h.n).join('   '))
  }
}

console.log('')
console.log('BLOCK 命中 ' + block + ' 处   WARN 命中 ' + warn + ' 处')
console.log('')
console.log('⚠️ 本脚本的已知边界：')
console.log('  · 正则只能抓「形似」的东西，**抓不到语义级的敏感信息**（如未点名但可识别项目的叙述）。')
console.log('  · **WARN 类不是"可以忽略"，是"必须人工逐条判断"** —— 例如中转站的倍率与缓存行为属内部信息，')
console.log('    公开披露是否会给用户带来麻烦，超出脚本可判断的范围。')
console.log('  · 因此：**脚本说通过 ≠ 可以发布。脚本说不通过 = 一定不能发布。**（单向可靠）')
process.exit(block ? 1 : 0)
