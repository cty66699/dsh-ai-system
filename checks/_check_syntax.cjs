// 语法门 + 进程 I/O 静默失效门（S-1 / S-2）—— 我们自己的脚本必须能编译，且不踩已知会静默失效的写法。
//
// 治什么（lesson （内部条目 id 略））：
//   `edit` 工具是**字面替换**，不是行操作。
//     · 用「少一个 \n」表达「删一行」⇒ 会把下一行**粘上来**（`]const xxx` ⇒ SyntaxError）；
//     · 插入时 `new_string` 不以锚点行原样结尾 ⇒ 顺手把锚点那行删了。
//   那两次都是**靠跑干净副本才暴露的**，而其中一次**在本地悄悄崩掉了一个脚本、当时没人发现**。
//
//   为什么必须有这道门：`_check_json.cjs` 只管 `.json`，**`.cjs` / `.js` / `.mjs` 此前没有任何语法门** ——
//   一个被改坏的断言脚本，症状会伪装成「这一项报错/报出令人误解的错」，而不是「文件坏了」。
//   这与 `_check_json.cjs` 被放在统一入口第一位是同一个理由：**坏掉的文件会让后面几项报出错误的结论。**
//
// ★ S-2（2026-09-25 新增，lesson （内部条目 id 略））：**禁止用管道捕获子进程输出**。
//   本机在 DSH 沙箱下，`stdio:'pipe'` = 命名管道，打不开 ⇒ **EPERM**；
//   而 `_check_all.cjs` 的 catch 把 EPERM 的 `e.status`（undefined）当成 `1` ⇒
//   **13 项一律显示「有发现」，而每一项单独跑都是绿的**（改动前实测「通过 0 / 13」）。
//   修法是改用**文件描述符**（`fs.openSync` 后 `stdio:['ignore', fd, fd]`）。
//   这条规则就来自那次事故 —— 它当场把我自己新写的那条 lesson 变成了断言。
//
// 判据：S-1 用 `vm.Script` 在**进程内**编译（不 spawn，避免 N 次进程启动）；
//      S-2 静态匹配 `stdio` 值为 `'pipe'` 或数组里含 `'pipe'`。
// 边界（诚实说明）：
//   · **ESM 跳过**：`vm.Script` 只能编译 script，不能编译 module ⇒ `.mjs`、以及含顶层 `import`/`export`
//     的文件一律**跳过并在输出里报出条数**（不静默）。这是一处已知缺口，不是"通过"。
//   · **只扫我们自己的脚本层**：`方案设计\` 递归 + 仓库根一级目录下的脚本。
//     各项目的浏览器页脚本与第三方 js 不在范围内。
//   · 它只判「能不能编译」与「有没有踩那个写法」，判不了「跑起来对不对」。
//
// 用法: node _check_syntax.cjs [--target <配置>]
// 退出码: 0=全部可编译且无管道捕获  1=有语法错误或用了管道捕获  2=结构性错误  3=未配置 ⇒ 跳过
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const _CFG = require('./_paths.cjs').load()
const HERE = __dirname

const ROOTS = _CFG.t.syntaxRoots
if (!ROOTS || !ROOTS.length) {
  console.log('⏭️  未配置：syntaxRoots ⇒ 本项**跳过**（自定义目标模式下不回落默认布局）')
  process.exit(3)
}

const EXT = new Set(require('./_paths.cjs').JS_EXT)
const SKIP = name => name.startsWith('.') || name === 'node_modules' || /^_归档_/.test(name)

// ESM 特征：顶层 import/export，或 import.meta。命中就跳过（vm.Script 编译不了 module）。
const ESM_RE = /^[ \t]*(?:import|export)\b/m

const bad = [], esm = [], pipeHits = []
let nScanned = 0, nEsm = 0

// S-2 判据：`stdio` 的值是 'pipe'，或数组里含 'pipe'。
//   正例（放行）：`stdio: ['ignore', fd, fd]`、`stdio: ['ignore', 'inherit', 'inherit']`、不写 stdio 的纯静态调用。
const PIPE_RE = /stdio\s*:\s*(?:\[[^\]]*['"]pipe['"][^\]]*\]|['"]pipe['"])/g

// ★ 匹配前必须**先剥注释**：本文件头部那段说明里就写着 `stdio: ['ignore','pipe','pipe']` 这个反例，
//   第一版直接匹配源码 ⇒ **lint 把自己的注释报成了违规**（6 处里 2 处是注释）。
//   **一个会把注释当代码报的 lint 就是噪音，而噪音会让人开始忽略它** —— 那正是本册反复记的病。
//   剥法是逐字符状态机：注释字符替换成空格（**保留换行与长度 ⇒ 行号不错位**），
//   字符串内容**原样保留**（`stdio: 'pipe'` 的值就在字符串里，不能一起吃掉）。
function stripComments(src) {
  let out = '', i = 0, state = 'code', inClass = false
  // 正则字面量的起始判据（标准启发式）：看 `/` 前面最后一个非空白字符。
  //   **必须有这一条** —— 否则 `PIPE_RE = /…['"]pipe['"]…/` 里的引号会被当成字符串开头，
  //   **状态机从此错位**，后面所有注释都不再被剥掉 ⇒ lint 把自己的示例当违规报（第一版就是这样）。
  //   这与 lesson `0mudiz759-2c`「校验器与被校验对象必须走同一条转换路径」是同一类错误：
  //   **错的是校验器，不是被校验的对象。**
  const REGEX_OK = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === '/') {
        let j = out.length - 1
        while (j >= 0 && /\s/.test(out[j])) j--
        const prev = j >= 0 ? out[j] : ''
        if (prev === '' || REGEX_OK.has(prev)) { state = 'regex'; inClass = false; out += c; i++; continue }
      }
      if (c === "'" ) { state = 'sq';  out += c; i++; continue }
      if (c === '"' ) { state = 'dq';  out += c; i++; continue }
      if (c === '`' ) { state = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue }
      out += ' '; i++; continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += (c === '\n' ? '\n' : ' '); i++; continue
    }
    if (state === 'regex') {
      if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue }
      if (c === '[') { inClass = true; out += c; i++; continue }
      if (c === ']') { inClass = false; out += c; i++; continue }
      if (c === '/' && !inClass) { state = 'code'; out += c; i++; continue }
      out += (c === '\n' ? '\n' : ' '); i++; continue    // 正则内容置空，避免它参与匹配
    }
    // 字符串态：转义成对跳过，闭合引号回 code
    if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
      state = 'code'; out += c; i++; continue
    }
    out += c; i++; continue
  }
  return out
}

function check(p) {
  let src
  try { src = fs.readFileSync(p, 'utf8') } catch { return }
  src = src.replace(/^\uFEFF/, '')
  nScanned++
  // ── S-2：先查写法（它对 ESM 同样适用，不受下面的 ESM 跳过影响）──
  const code = stripComments(src)
  for (const m of code.matchAll(PIPE_RE)) {
    const line = code.slice(0, m.index).split(/\r?\n/).length
    pipeHits.push({ file: p, line, text: m[0].replace(/\s+/g, ' ') })
  }
  if (path.extname(p).toLowerCase() === '.mjs' || ESM_RE.test(src)) { nEsm++; esm.push(p); return }
  // ── S-1：编译 ──
  try {
    new vm.Script(src, { filename: p })
  } catch (e) {
    // `e.stack` 自带「出错行 + 脱字符」，照抄 `_check_json.cjs` 的做法：省一轮人肉往返。
    const lines = String(e.stack || e.message).split(/\r?\n/).slice(0, 4)
    bad.push({ file: p, detail: lines.join('\n') })
  }
}

function walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP(e.name)) continue
    const p = path.join(dir, e.name)
    // ★ 生成物目录（开源子集）**显式排除**：`public/checks/*` 是 脱敏生成器 生成出来的副本，
    //   由生成器从源头拷贝，不是手写代码。它当前与源**不同步**（是旧版本）—— 那是一个**独立已知缺口**，
    //   记在 `AI体系\_subagent_machineable_candidates.md`（候选 `（内部条目 id 略）`：需要一条「public 与源一致」的断言）。
    //   **排除是显式写在这里的，不是静默略过** —— 想靠它让本项变绿，得先看见这一行，而改它会进 diff。
    if (p === path.join(HERE, 'public')) { console.log('  ⏭️ 跳过生成物目录：' + path.relative(_CFG.ROOT, p) + '（其新鲜度是独立缺口，本项不覆盖）'); continue }
    if (e.isDirectory()) { walk(p); continue }
    if (EXT.has(path.extname(e.name).toLowerCase())) check(p)
  }
}

for (const r of ROOTS) {
  if (!fs.existsSync(r)) { console.error('❌ 结构性错误：扫描根不存在 —— ' + r); process.exit(2) }
  walk(r)
}
﻿// ★★ 2026-09-26 修（反例自检当场抓出的一处"修得不彻底"）：
//   这一段是**硬编码的额外扫描根**（仓库根**一级目录**下的脚本），**不受 `syntaxRoots` 控制**。
//   后果有两条：
//     ① **在自定义目标模式下**，如果访客没配 `repoRoot`，`_CFG.ROOT` 会回落到断言层自己的仓库 ——
//        于是"检查你自己的脚本"这件事，实际检查的是**别人的目录**（与 F-11 那一类同源）；
//     ② 它让 `nScanned - nEsm === 0` 这条守卫**几乎不可能被触发** ——
//        因为仓库根一级总有 `.cjs`，所以"实际编译了 0 个脚本"这个场景造不出来。
//        ⇒ **反例自检加进这一条用例时，它当场报「没咬到」** —— 正是它在提醒上面②这件事。
//   ⇒ 改成：**只有在配置里明确给了 `repoRoot` 时才扫它**（与其它门的"未配置不回落"一致）。
if (_CFG && _CFG.t && _CFG.t.repoRoot) {
  try {
    for (const e of fs.readdirSync(_CFG.ROOT, { withFileTypes: true })) {
      if (e.isDirectory() || SKIP(e.name)) continue
      if (EXT.has(path.extname(e.name).toLowerCase())) check(path.join(_CFG.ROOT, e.name))
    }
  } catch { /* 忽略 */ }
}

if (nScanned - nEsm === 0) {
  // ★★ 2026-09-26 修（独立核验 F-8）：原来判 `nScanned === 0`，而 `nScanned++` **把 ESM 也算了进去**
  //   ⇒ 一个**全是 ESM** 的扫描根 ⇒ 编译 0 个却 nScanned === 1 ⇒ 守卫失效 ⇒ 报「✅ 全部可编译」。
  //   ⇒ 对现代全 ESM 工程，这道门等于不存在，而它显示通过。改成「真正编译过的」为 0 就判失败。
  console.error('❌ 结构性错误：实际编译了 0 个脚本（扫描 ' + nScanned + ' 个，其中 ESM 跳过 ' + nEsm + ' 个）')
  console.error('   ⇒ 扫描类检查必须断言集合非空；「全是 ESM」意味着这道门什么都没查。')
  process.exit(2)
}

console.log('语法门 + 进程 I/O 门（我们自己的脚本必须能编译，且不踩管道捕获）')
console.log('  扫描根：' + ROOTS.map(r => path.relative(_CFG.ROOT, r) || '.').join('  ') + (_CFG && _CFG.t && _CFG.t.repoRoot ? '  + 仓库根一级' : ''))
console.log('  编译 ' + (nScanned - nEsm) + ' 个脚本；' + (nEsm ? '**跳过 ' + nEsm + ' 个 ESM**（vm.Script 编译不了 module —— 这是缺口，不是通过）' : '无 ESM 跳过'))

const problems = []
if (pipeHits.length) {
  console.log('')
  console.log('❌ S-2 · ' + pipeHits.length + ' 处用**管道**捕获子进程输出 —— 本机沙箱下 `stdio:\'pipe\'` 直接 EPERM，')
  console.log('   而调用方的 catch 往往会把 EPERM 当成"退出码 1" ⇒ **检查全部假红而看不出原因**。')
  console.log('   ⇒ 改用**文件描述符**：`const fd = fs.openSync(log,\'w\')` 后 `stdio: [\'ignore\', fd, fd]`，读完删文件。')
  for (const h of pipeHits) console.log('     ' + (path.relative(_CFG.ROOT, h.file) || h.file) + ':' + h.line + '　' + h.text)
  problems.push('S-2')
}
if (bad.length) {
  console.log('')
  console.log('❌ S-1 · ' + bad.length + ' 个脚本编译失败 —— **这不是"这一项报错"，这是文件本身坏了。**')
  for (const b of bad) {
    console.log('')
    console.log('  ' + (path.relative(_CFG.ROOT, b.file) || b.file))
    for (const l of b.detail.split('\n')) console.log('     ' + l)
  }
  console.log('')
  console.log('  ⚠️ 最常见成因是 `edit` 的字面替换：删行时少写一个换行 ⇒ 下一行被粘上来；')
  console.log('     插入时 `new_string` 没有以锚点行原样结尾 ⇒ 锚点行被顺手删掉。')
  problems.push('S-1')
}

if (!problems.length) {
  console.log('')
  console.log('✅ 全部可编译，且没有用管道捕获子进程输出')
  console.log('   （检查强度说明：只判能不能编译与有没有踩那个写法，判不了跑起来对不对；ESM 未覆盖编译。）')
  process.exit(0)
}
process.exit(1)
