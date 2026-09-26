// 「只读」断言 —— 跑了整套检查之后，**被检查的工程一个字节都没变**
// ★ 起因（2026-09-26 第 69 轮）：把「范围」判据的第四种面孔（**写入范围**）问出来之后，
//   一条一条看完全部写/删操作，结论是「断言层只写自己的临时目录与台账，不碰被检查的工程」。
//   ⚠️ 而那是**一条承诺** —— 承诺必须能被证伪，否则它只是宣传。
//   ⇒ 本项把它变成断言：**算哈希 → 跑一遍统一入口 → 再算哈希 → 比**。
// ★ 递归保护：本项自己也会出现在统一入口里 ⇒ 用环境变量让"内层那次"直接跳过。
// ★ 未配置 `repoRoot` ⇒ **诚实跳过**（exit 3）—— 不回落去猜"你的项目根在哪"。
// 退出码: 0=未改变  1=**有文件被改动**（那说明某个检查写了不该写的东西）  2=结构性错误  3=未配置
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

// ── 递归保护：内层那次直接跳过（否则会无限跑下去）
if (process.env.DSH_READONLY_INNER === '1') {
  console.log('⏭️  本项是"外层的内层调用" ⇒ 跳过（递归保护）')
  process.exit(3)
}

const _C = require('./_paths.cjs').load()
if (_C.usingCustomTarget && !_C.t.repoRoot) {
  console.log('⏭️  未配置：repoRoot ⇒ 本项**跳过**（自定义目标模式下不回落默认布局）')
  process.exit(3)
}
// ★★ 2026-09-26 第 69 轮**实测修正**：第一版哈希的是**整个 repoRoot**，而它误报了一次 ——
//   命中的是 `实验室安全教育_5/profile/Default/History-journal`，**那是另一个会话的 Chrome 在写**，
//   不是任何检查写的。⇒ 那个判据隐含了一个假定：**「跑检查的这段时间里，只有检查在动这些文件」** ——
//   而**当一个目录里同时有别的东西在活动时（浏览器 profile / 别的会话 / 后台任务），它就不成立**。
//   ⇒ 正解：**哈希范围 = 配置里声明的那些「检查对象」**（那才是"被检查的工程"的定义）——
//     把 `_CFG.t` 里所有**存在**的路径取并集，文件按文件哈希、目录递归。
//   ★ 诚实边界（写进输出）：**检查对象以外**的文件不在本项范围内 ——
//     那不代表"检查不会写它们"，只代表"本项不覆盖那里"。
const _cfgVals = []
const _collect = v => {
  if (typeof v === 'string') { _cfgVals.push(v); return }
  if (Array.isArray(v)) { v.forEach(_collect); return }
  if (v && typeof v === 'object') { for (const x of Object.values(v)) _collect(x) }
}
_collect(_C.t)
const TARGETS = []
for (const v of new Set(_cfgVals)) {
  let p
  try { p = path.resolve(_C.base, v) } catch { continue }
  if (!fs.existsSync(p)) continue
  if (TARGETS.some(x => p === x || p.startsWith(x + path.sep))) continue
  for (let i = TARGETS.length - 1; i >= 0; i--) if (TARGETS[i].startsWith(p + path.sep)) TARGETS.splice(i, 1)
  TARGETS.push(p)
}
if (TARGETS.length === 0) {
  console.error('❌ 配置里没有解析出任何**存在**的检查对象 —— 本项什么也没证明（不是"通过"）。')
  process.exit(2)
}

// ── 哈希（跳过 .git / node_modules / 生成物目录 / 临时目录）
const SKIP = name => name === '.git' || name === 'node_modules' || name.startsWith('.build-') || name.startsWith('.gitkeep-')
function hashOne(p, out, n) {
  let st
  try { st = fs.statSync(p) } catch { return }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (SKIP(e.name)) continue
      hashOne(path.join(p, e.name), out, n)
    }
    return
  }
  try {
    const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    out.set(path.relative(_C.base, p).replace(/\\/g, '/'), h)
    n.v++
  } catch { /* 读不到就跳过 */ }
}
function hashTargets() {
  const out = new Map(), n = { v: 0 }
  for (const p of TARGETS) hashOne(p, out, n)
  return { map: out, count: n.v }
}

function diff(a, b) {
  const changed = [], added = [], removed = []
  for (const [k, v] of a) { if (!b.has(k)) removed.push(k); else if (b.get(k) !== v) changed.push(k) }
  for (const k of b.keys()) if (!a.has(k)) added.push(k)
  return { changed, added, removed }
}

console.log('=== 「只读」断言：跑完检查后，被检查的工程是否一个字节都没变 ===')
console.log('检查对象（' + TARGETS.length + ' 个，来自配置）：')
for (const p of TARGETS) console.log('   · ' + (path.relative(_C.ROOT, p) || '.'))
console.log('  ★ 范围只到这些 —— 检查对象以外的文件不在本项覆盖内（那不代表检查不会写它们）。')
console.log('  ★ **已知弱点（如实写在输出里）**：若这些目录里**同时有别的东西在活动**')
console.log('     （浏览器 profile、别的会话、后台任务），它们改动的文件**也会被算成"被改动了"** ——')
console.log('     实测踩过一次（命中的是另一个会话的 Chrome 写的 History-journal）。')
console.log('     ⇒ 判读时：**先看那个文件名像不像检查写的**。')
console.log('')
const before = hashTargets()
console.log('  跑之前：' + before.count + ' 个文件')
process.stdout.write('  正在跑一遍统一入口（内层会跳过本项）… ')
// ★ 用**文件描述符**捕获子进程输出，不用管道（S-2：本机沙箱下 stdio:'pipe' 直接 EPERM，
//   而调用方的 catch 会把 EPERM 当成"退出码 1" ⇒ 检查全部假红而看不出原因）。
const _log = path.join(require('node:os').tmpdir(), 'readonly-inner-' + process.pid + '.log')
const _fd = fs.openSync(_log, 'w')
let inner = ''
let innerCode = 0
try {
  execFileSync(process.execPath, [path.join(__dirname, '_check_all.cjs'), '--fast',
    // ★ 只在 cfgPath **真的是一个存在的文件**时才传（裸跑时它是说明性占位串，不是路径 —— 实测踩过）
    ...(_C.cfgPath && fs.existsSync(_C.cfgPath) ? ['--target', _C.cfgPath] : [])],
    { cwd: __dirname, env: { ...process.env, DSH_READONLY_INNER: '1' }, stdio: ['ignore', _fd, _fd] })
} catch (e) {
  // ★ EPERM 之类没有 status ⇒ -1（**不能当成 1**：那会把"没跑成"和"有发现"混起来）
  innerCode = e.status === undefined ? -1 : e.status
} finally {
  fs.closeSync(_fd)
}
try { inner = fs.readFileSync(_log, 'utf8') } catch { inner = '' }
try { fs.unlinkSync(_log) } catch { /* 忽略 */ }
console.log('完成（内层退出码 ' + innerCode + '）')
const after = hashTargets()
console.log('  跑之后：' + after.count + ' 个文件')
console.log('')

// ★ 内层"因为参数/配置而整项没跑"时，本项什么也没证明
// ★ 失败时**把内层输出打出来** —— 不然只能猜（本项目通则：打印现场）
const innerTail = inner.split('\n').filter(l => l.trim()).slice(-12)
if (innerCode === 2) {
  console.error('❌ 内层统一入口报**结构性错误**（exit 2）—— 那种情况下本项什么也没证明。')
  console.error('   ⇒ 内层输出的最后 12 行：')
  for (const l of innerTail) console.error('      | ' + l.slice(0, 110))
  process.exit(2)
}
if (innerCode === -1) {
  console.error('❌ 内层统一入口**根本没跑成**（没有退出码，通常是 EPERM/超时）—— 本项什么也没证明。')
  console.error('   ⇒ 注意：**这不是"有发现"**（那是 exit 1）—— 是"这一项没查成"，两者不能混。')
  console.error('   ⇒ 内层输出的最后 12 行：')
  for (const l of innerTail) console.error('      | ' + l.slice(0, 110))
  process.exit(2)
}

const d = diff(before.map, after.map)
const bad = d.changed.length + d.added.length + d.removed.length
if (bad) {
  console.error('❌ **被检查的工程在跑检查的过程中被改动了** —— 那违反「断言层只读」这条承诺：')
  for (const f of d.changed.slice(0, 12)) console.error('   · 内容变了：' + f)
  for (const f of d.added.slice(0, 12)) console.error('   · 多出来的：' + f)
  for (const f of d.removed.slice(0, 12)) console.error('   · 少掉的：  ' + f)
  if (bad > 36) console.error('   …（共 ' + bad + ' 项，这里只列了前 36）')
  console.error('   ⇒ 去查是哪个检查写了它 —— 那是一个真缺陷，不是本项判据的问题。')
  process.exit(1)
}
if (before.count === 0) {
  console.error('❌ 工程根下**一个文件都没扫到** —— 这样的"没变化"不算数，判为失败')
  process.exit(2)
}
console.log('✅ 通过：' + before.count + ' 个文件的哈希**逐个未变**（跑了一整套检查，工程没被碰过）')
process.exit(0)