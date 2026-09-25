// 预算熔断检查 —— 派发前必经步骤（F-08-a）
// 用法: node _budget_check.cjs [预警阈值¥ 熔断阈值¥]
// 退出码: 0=正常  1=预警  2=熔断
// 只读账本，不写任何东西，不发任何请求。
const fs = require('node:fs')
const path = require('node:path')

const WARN = Number(process.argv[2] || 30)
const BLOCK = Number(process.argv[3] || 60)

// ★ 2026-09-25 修（第二轮访客实测）：新增**可选的第 4 个参数 = 账本路径**。
//   原来它**只读运行者自己 HOME 下的固定路径** ⇒ `_target.json` 里那个 `budgetLedger` 键
//   **配了也没用**（只有 `=== null` 时派生的「跳过」标记有意义）。现在：
//   **显式给了路径就用它；没给才回落到 HOME 下的默认位置。**
// ★ 另一处修正：**"显式给了路径但文件不存在"此前会静默 `exit 0`** —— 那正是"配了但没生效"的假绿。
const HOME = process.env.USERPROFILE || process.env.HOME || require('node:os').homedir()
// ★ 用**命名参数** `--ledger <路径>`，不用位置参数 —— 因为统一入口会给每个子脚本透传
//   `--target <配置路径>`，位置参数会被它挤占（第一版就这么错了）。
const LI = process.argv.indexOf('--ledger')
const EXPLICIT = (LI !== -1 && process.argv[LI + 1]) ? path.resolve(process.argv[LI + 1]) : null
const LEDGER = EXPLICIT || path.join(HOME, '.dsh', 'storages', 'usage-stats-cache.json')
if (!fs.existsSync(LEDGER)) {
  if (EXPLICIT) {
    console.log('❌ **显式指定的账本不存在**：' + LEDGER)
    console.log('   ⇒ 配了 `budgetLedger` 却读不到账本 —— 这不是「没有预算问题」，是**这一项根本没跑**。')
    console.log('   ⇒ 两条出路：修正路径；或显式写 `budgetLedger: null` 关掉这一项（**跳过是诚实的，假绿不是**）。')
    process.exit(1)
  }
  console.log('账本不存在: ' + LEDGER + '（未显式指定 ⇒ 视为「这一项不适用」，跳过）')
  process.exit(0)
}

// 单价（¥/M）。cache = 缓存命中读价。
// ⚠️ **这里是模板，故意留空**：价格随供应商、分组、结算口径变化，
//    把它硬编码进脚本既会悄悄过时，也会泄露商业条款 —— 两者都不该发生。
//    请按你自己的账本填入。**不在表中的 provider 会被明确报成「未计入」，
//    不会静默按 0 计** —— 静默按 0 会伪造出一个漂亮的低读数。
const PRICE = {
  // 'your-provider-id': { in: 0, cache: 0, out: 0 },
}

const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'))
const today = new Date().toISOString().slice(0, 10)

// 账本结构: sessions.<sid>.days.<date>.models.<provider>/<model>.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
const perProvider = new Map()
let unknown = 0
for (const s of Object.values(j.sessions || {})) {
  const day = (s.days || {})[today]
  if (!day) continue
  for (const [key, m] of Object.entries(day.models || {})) {
    const prov = key.includes('/') ? key.split('/')[0] : key
    const p = PRICE[prov]
    const inp = m.inputTokens || 0, out = m.outputTokens || 0
    const read = m.cacheReadTokens || 0, write = m.cacheWriteTokens || 0
    if (!p) { unknown++; continue }
    // 写缓存按输入价 ×1.25 估（**各供应商口径不同，按你的改**），读缓存按缓存价
    const cost = (inp / 1e6) * p.in + (out / 1e6) * p.out + (read / 1e6) * p.cache + (write / 1e6) * p.in * 1.25
    const cur = perProvider.get(prov) || { in: 0, out: 0, read: 0, write: 0, cost: 0 }
    cur.in += inp; cur.out += out; cur.read += read; cur.write += write; cur.cost += cost
    perProvider.set(prov, cur)
  }
}

let total = 0
console.log('=== 今日（' + today + '）预算熔断检查 ===')
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
} else if (total >= WARN) {
  console.log('⚠️ **预警**：今日已超 ¥' + WARN + '。继续派发前先说清「这次派发改变哪个决策」。')
  process.exit(1)
} else {
  console.log('✅ 正常：可派发。')
  process.exit(0)
}
