// 预算熔断检查 —— 派发前必经步骤（F-08-a）
// 用法: node _budget_check.cjs [预警阈值¥ 熔断阈值¥] [--ledger 文件] [--prices 文件]
// 退出码: 0=正常  1=预警/输入错误  2=熔断  4=金额未知（禁止自动派发）
// 只读账本，不写任何东西，不发任何请求。
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const positional = []
const named = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target') { if (!args[++i]) { console.error('❌ --target 缺路径'); process.exit(1) }; continue }
  if (args[i] === '--ledger' || args[i] === '--prices') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) { console.error('❌ ' + args[i] + ' 缺路径'); process.exit(1) }
    named[args[i]] = args[++i]
  } else if (args[i].startsWith('--')) { console.error('❌ 未知参数：' + args[i]); process.exit(1) }
  else positional.push(args[i])
}
if (positional.length > 2) { console.error('❌ 阈值参数过多'); process.exit(1) }
const WARN = positional[0] === undefined ? 30 : Number(positional[0])
const BLOCK = positional[1] === undefined ? 60 : Number(positional[1])
if (!Number.isFinite(WARN) || !Number.isFinite(BLOCK) || WARN <= 0 || BLOCK <= WARN) {
  console.error('❌ 预算阈值必须是有限正数，且熔断阈值大于预警阈值')
  process.exit(1)
}

// ★ 2026-09-25 修（第二轮访客实测）：新增**可选的第 4 个参数 = 账本路径**。
//   原来它**只读运行者自己 HOME 下的固定路径** ⇒ `_target.json` 里那个 `budgetLedger` 键
//   **配了也没用**（只有 `=== null` 时派生的「跳过」标记有意义）。现在：
//   **显式给了路径就用它；没给才回落到 HOME 下的默认位置。**
// ★ 另一处修正：**"显式给了路径但文件不存在"此前会静默 `exit 0`** —— 那正是"配了但没生效"的假绿。
const HOME = process.env.USERPROFILE || process.env.HOME || require('node:os').homedir()
// ★ 用**命名参数** `--ledger <路径>`，不用位置参数 —— 因为统一入口会给每个子脚本透传
//   `--target <配置路径>`，位置参数会被它挤占（第一版就这么错了）。
const EXPLICIT = named['--ledger'] ? path.resolve(named['--ledger']) : null
const LEDGER = EXPLICIT || path.join(HOME, '.dsh', 'storages', 'usage-stats-cache.json')
if (!fs.existsSync(LEDGER)) {
  if (EXPLICIT) {
    console.log('❌ **显式指定的账本不存在**：' + LEDGER)
    console.log('   ⇒ 配了 `budgetLedger` 却读不到账本 —— 这不是「没有预算问题」，是**这一项根本没跑**。')
    console.log('   ⇒ 两条出路：修正路径；或显式写 `budgetLedger: null` 关掉这一项（**跳过是诚实的，假绿不是**）。')
    process.exit(1)
  }
  console.log('账本不存在: ' + LEDGER + '（未显式指定 ⇒ 视为「这一项不适用」，跳过）')
  process.exit(3)
}

// 单价（¥/M）。cache = 缓存命中读价。
// ⚠️ **这里是模板，故意留空**：价格随供应商、分组、结算口径变化，
//    把它硬编码进脚本既会悄悄过时，也会泄露商业条款 —— 两者都不该发生。
//    请按你自己的账本填入。**不在表中的 provider 会被明确报成「未计入」，
//    不会静默按 0 计** —— 静默按 0 会伪造出一个漂亮的低读数。
const PRICE = {
  // 'your-provider-id': { in: 0, cache: 0, out: 0 },
}
const pricing = new Map(Object.entries(PRICE))

if (named['--prices']) {
  let custom
  try { custom = JSON.parse(fs.readFileSync(path.resolve(named['--prices']), 'utf8').replace(/^\uFEFF/, '')) }
  catch (e) { console.error('❌ 价格文件不可读或 JSON 无效：' + e.message); process.exit(1) }
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) { console.error('❌ 价格文件须为 provider → 单价对象'); process.exit(1) }
  for (const [provider, p] of Object.entries(custom)) {
    if (!p || typeof p !== 'object' || !['in', 'cache', 'out'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0)) {
      console.error('❌ 价格无效：' + provider + '（in/cache/out 必须为有限的非负数字）'); process.exit(1)
    }
    pricing.set(provider, p)
  }
}

let j
try { j = JSON.parse(fs.readFileSync(LEDGER, 'utf8').replace(/^\uFEFF/, '')) }
catch (e) { console.error('❌ 账本不可读或 JSON 无效：' + e.message); process.exit(1) }
if (!j.sessions || typeof j.sessions !== 'object' || Array.isArray(j.sessions)) { console.error('❌ 账本缺少 sessions 对象'); process.exit(1) }
// ★ 2026-09-30 修（一个真 bug，实测抓到）：
//   原来写的是 `new Date().toISOString().slice(0,10)` —— 那是 **UTC 日期**，而账本的
//   `sessions.<sid>.days.<date>` 用的是**本地日历日**（宿主按本地时区写的）。
//   ⇒ 在 UTC+8（本机）下，**每天 00:00–08:00 这 8 小时**，UTC 日期还是**昨天** ——
//     于是清晨查预算，读到的是**昨天的账**：金额是昨天的合计、熔断状态是昨天的结论。
//   实测（2026-09-30 07:44）：本地已是 09-30，它却打印「今日（2026-09-29）」，合计 ¥（略）
//   —— 那个 ¥（略） 正是**前天/昨天**那一笔，而账本里今天（09-30）尚无记录。
//   后果两面：① 若昨天花了钱，**今天 08:00 前一直显示昨天的熔断状态**；
//            ② 清晨做派发决策时，依据的是**与当天无关**的一张表。
//   ★ 修法：按**本地**日历日取键（账本怎么写、就怎么读），并同时打印两个日期以便对账。
//   ⇒ 这与本工作区那条铁律同族：**读到坏消息（或"可派发"）时，先核对那个读数本身。**
const localDay = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
const _now = new Date()
const today = localDay(_now)
const todayUTC = _now.toISOString().slice(0, 10)

// 账本结构: sessions.<sid>.days.<date>.models.<provider>/<model>.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
const perProvider = new Map()
let unknown = 0
for (const s of Object.values(j.sessions || {})) {
  const day = (s.days || {})[today]
  if (!day) continue
  for (const [key, m] of Object.entries(day.models || {})) {
    const prov = key.includes('/') ? key.split('/')[0] : key
    const p = pricing.get(key) || pricing.get(prov)
    const values = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(k => m[k] === undefined ? 0 : m[k])
    if (values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      console.error('❌ 账本 token 数无效：' + key + '（必须为有限的非负数字）')
      process.exit(1)
    }
    const [inp, out, read, write] = values
    if (!p) { unknown++; continue }
    // 写缓存按输入价 ×1.25 估（**各供应商口径不同，按你的改**），读缓存按缓存价
    const cost = (inp / 1e6) * p.in + (out / 1e6) * p.out + (read / 1e6) * p.cache + (write / 1e6) * p.in * 1.25
    if (!Number.isFinite(cost)) { console.error('❌ 金额计算溢出：' + key); process.exit(1) }
    const cur = perProvider.get(prov) || { in: 0, out: 0, read: 0, write: 0, cost: 0 }
    cur.in += inp; cur.out += out; cur.read += read; cur.write += write; cur.cost += cost
    perProvider.set(prov, cur)
  }
}

let total = 0
console.log('=== 今日（本地 ' + today + ' / UTC ' + todayUTC + '）预算熔断检查 ===')
if (today !== todayUTC) {
  console.log('   ⚠️ 本地日与 UTC 日不同（本地 ' + today + ' / UTC ' + todayUTC + '）—— '
    + '账本按**本地**日历日记账，因此本表读的是 ' + today + ' 那一天。')
}
console.log('provider'.padEnd(22) + '输入'.padStart(10) + '缓存读'.padStart(12) + '输出'.padStart(10) + '≈¥'.padStart(10))
for (const [prov, v] of [...perProvider.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
  total += v.cost
  console.log(prov.padEnd(22) + String(v.in).padStart(10) + String(v.read).padStart(12) + String(v.out).padStart(10) + v.cost.toFixed(3).padStart(10))
}
console.log('—'.repeat(66))
console.log('合计 ≈ ¥' + total.toFixed(3) + '   阈值：预警 ¥' + WARN + ' / 熔断 ¥' + BLOCK)
if (unknown) console.log('⚠️ 有 ' + unknown + ' 个未在价格表中的 provider，未计入 —— **须人工确认**')

console.log('')
if (total >= BLOCK) {
  console.log('🛑 **熔断**：今日已超 ¥' + BLOCK + '。**停止向外部付费通道派发**，只允许已在用的低价通道（DeepSeek/Kimi）。')
  console.log('   恢复需用户明确同意 —— 这是不可逆开销的闸门。')
  process.exit(2)
} else if (unknown) {
  console.log('🛑 **金额未知**：有未计价 provider，不能自动判定「可派发」。补齐 --prices 后重跑。')
  process.exit(4)
} else if (total >= WARN) {
  console.log('⚠️ **预警**：今日已超 ¥' + WARN + '。继续派发前先说清「这次派发改变哪个决策」。')
  process.exit(1)
} else {
  console.log('✅ 正常：可派发。')
  process.exit(0)
}
