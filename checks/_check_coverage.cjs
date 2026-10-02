#!/usr/bin/env node
// 扫描覆盖矩阵：复用扫描器自己的选文件逻辑，检查目标根下哪些文件没有进入扫描集合。
// 退出码：0=均覆盖；1=存在未覆盖文件；2=枚举失败；3=没有目标配置。
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const C = require('./_paths.cjs').load()
const HERE = __dirname
let cfgPath = C.cfgPath, root = C.t.repoRoot
// 内部工作区检查的是公开集的示例配置，不能用内部项目的配置冒充公开集覆盖。
if (!C.usingCustomTarget) {
  root = path.join(HERE, 'public')
  cfgPath = path.join(root, 'example', '_target.json')
}
if (!root || !fs.existsSync(cfgPath)) {
  console.log('⏭️ 未配置 repoRoot 或目标配置不存在 ⇒ 扫描覆盖矩阵跳过')
  process.exit(3)
}
function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '_拦截台账.jsonl') continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file, files)
    else if (entry.isFile()) files.push(file)
  }
  return files
}
let files
try { files = walk(root) } catch (error) { console.error('❌ 目标根无法枚举：' + error.message); process.exit(2) }
if (!files.length) { console.error('❌ 目标根下没有文件；空扫描不算覆盖'); process.exit(2) }
const scanners = [
  ['语法门', '_check_syntax.cjs'],
  ['PS 语法门', '_check_ps_syntax.cjs'],
  ['JSON 预检', '_check_json.cjs'],
  ['文本卫生', '_check_text_hygiene.cjs'],
  ['文件卫生', '_check_hygiene.cjs'],
  ['引用检查', '_check_refs.cjs'],
  ['发布闸门', '_publish_audit.cjs'],
]
const selected = new Map(), skipped = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-'))
try {
  for (const [name, script] of scanners) {
    const log = path.join(tmp, script + '.log'), fd = fs.openSync(log, 'w')
    let code = 0
    try {
      execFileSync(process.execPath, [path.join(HERE, script), '--target', cfgPath, '--list-files'], { stdio: ['ignore', fd, fd] })
    } catch (error) { code = typeof error.status === 'number' ? error.status : -1 }
    finally { fs.closeSync(fd) }
    if (code === 3) { skipped.push(name); continue }
    const out = fs.readFileSync(log, 'utf8')
    const match = out.match(/^DSH_FILE_LIST (.+)$/m)
    if (code !== 0 || !match) throw new Error(name + ' 文件选择枚举失败（退出码 ' + code + '）')
    const list = JSON.parse(match[1])
    if (!Array.isArray(list) || list.some(file => typeof file !== 'string')) throw new Error(name + ' 返回的文件清单无效')
    for (const file of list) {
      const absolute = path.resolve(file)
      if (!selected.has(absolute)) selected.set(absolute, [])
      selected.get(absolute).push(name)
    }
  }
} catch (error) { console.error('❌ 覆盖矩阵未查成：' + error.message); process.exitCode = 2 }
finally { fs.rmSync(tmp, { recursive: true, force: true }) }
if (process.exitCode === 2) process.exit(2)
const uncovered = files.filter(file => !selected.has(path.resolve(file)))
console.log('▶ 扫描覆盖矩阵：' + files.length + ' 个目标文件，复用 ' + (scanners.length - skipped.length) + ' 个扫描器的文件选择')
if (skipped.length) console.log('  ⏭️ 未启用的扫描器：' + skipped.join('、'))
console.log('  范围排除 .git、node_modules 和检查器自身的拦截台账。')
console.log('  该项只检查进入扫描集合，不证明各规则执行成功，也不证明能检测领域缺陷。')
if (uncovered.length) {
  console.log('❌ 有 ' + uncovered.length + ' 个文件未进入上述扫描器的检查集合：')
  for (const file of uncovered) console.log('   · ' + path.relative(root, file))
  console.log('   ⇒ 按文件类型配置实际适用的扫描根；专门核验的文件需另行留痕，不能以本项通过代替。')
  process.exit(1)
}
console.log('✅ 每个目标文件均进入至少一个已配置扫描器的检查集合')
