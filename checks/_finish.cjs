#!/usr/bin/env node
// 公开版收尾入口：只运行公开仓实际包含的检查，不依赖作者工作区的生成器。
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
let full = false, targetArg = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--full' && !full) { full = true; continue }
  if (args[i] === '--target' && targetArg === null) {
    if (!args[i + 1] || args[i + 1].startsWith('--')) { console.error('❌ --target 缺配置文件路径'); process.exit(2) }
    targetArg = args[++i]
    continue
  }
  console.error('❌ 未知或重复参数：' + args[i])
  process.exit(2)
}
const target = targetArg === null ? path.join(ROOT, 'example', '_target.json') : path.resolve(targetArg)
if (!fs.existsSync(target)) { console.error('❌ 找不到目标配置：' + target); process.exit(2) }
const flags = full ? [] : ['--fast']
console.log('▶ 公开版收尾：' + target)
const result = spawnSync(process.execPath,
  [path.join(__dirname, '_check_all.cjs'), ...flags, '--target', target],
  { cwd: ROOT, stdio: 'inherit' })
if (result.error) { console.error('❌ 无法启动统一检查：' + result.error.message); process.exit(2) }
process.exit(result.status === null ? 2 : result.status)
