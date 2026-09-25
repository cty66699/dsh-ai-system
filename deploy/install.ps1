<#
  ============================================================================
  DSH AI 体系 · 一键部署（Windows / PowerShell 5.1+）
  ============================================================================

  用法（最省事的一条）：
      powershell -ExecutionPolicy Bypass -File install.ps1

  它会做这十件事：
      1. 环境检查（Node / npm / pnpm）
      2. 装 DSH 本体（版本锁定；★ 已装别的版本默认**拒绝覆盖**，要加 -Force）
      3. 建工作区目录
      4. 初始化 profile（dsh 会自己从出厂模板建骨架）
      5. 预置 pnpm 的两段关键配置（allowBuilds + overrides；★ 不填就不让装 / 装了也不加载）
      6. 装插件（版本锁定；装饰类默认不装）
      7. 核对它们真的进了 bundles（★ 只看 dependencies 会被骗）
      8. 落一份工作区指令模板（★ 叫 AGENTS.template.md，不自动生效）
      9. 说明配置怎么填 + 自检
     10. 起一次服务验证（★ 唯一能发现"装了但一半插件不工作"的判据）

  四条设计原则（都是实测踩出来的，不是设计出来的）：
    1. 版本全部锁死 —— "别人能跑"必须有可复现性。
    2. 不碰 file: 与 github: 源 —— 前者别人 clone 不到、后者要 GitHub 可达。
       装饰类插件（状态灯、分隔线）默认不装，一举绕开这两个坑。
    3. 配置留空 + 说明 —— 作者的模型路由走私有中转站，访客没有。
       默认只启用 DSH 原生支持的 deepseek-official。
    4. 判成败要看"结果"，不看"命令的退出码自述"：
       dsh plugin add 是「先写 package.json、再 pnpm install」，
       pnpm 那步失败时 dependencies 里已经有名字了 ⇒ 必须核对 bundles。

  退出码：0=成功  1=环境不满足  2=安装失败
  ============================================================================
#>

[CmdletBinding()]
param(
  [string]$WorkDir = "$HOME\dsh-workspace",
  [string]$ProfileName = 'web',
  [switch]$CoreOnly,
  [switch]$NoBoot,

  # 跳过"起服务验证"这一步（默认**会**做 —— 它是唯一能发现"装了但一半插件不工作"的判据）
  [switch]$SkipBootVerify,
  [switch]$DryRun,

  # 明确接受「覆盖已装的 DSH」。默认**拒绝**覆盖别的版本 —— 原因见第 2 步那段。
  [switch]$Force
)

# 为什么不是 'Stop'：dsh 每次调用都往 stderr 打一条无害的 Node 警告，
# 而 'Stop' 会让 PowerShell 把原生命令的 stderr 当成终止错误
# ⇒ 脚本在第一处调用 dsh 时就中止，屏幕上是与使用者环境无关的警告。
# 通则：给别人的脚本，"遇错即停"要靠退出码，不能靠 PowerShell 的错误偏好。
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# ── 版本锁定区（唯一需要改版本的地方）──────────────────────────────────────
$DSH_VERSION = '0.1.7-rc.2'

$PLUGINS_CORE = [ordered]@{
  'meow-memory'                   = '0.29.0'
  '@linxin666/dsh-web-ui-all'     = '0.3.6'
  '@ychris12138/dsh-usage-stats'  = '0.3.3'
  '@nanmicoder/dsh-agent-teams'   = '0.1.21'
}
$PLUGINS_OPTIONAL = [ordered]@{
  'dshmarket'                     = '1.65.1'
  'dsh-find-plugin'               = '0.3.7'

  '@linxin666/dsh-remote-web-ui'  = '0.4.2'
}
# 刻意不装：dsh-done-whale（只在 GitHub）、dsh-ui-gray-divider（作者的 file: 依赖）

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$HOME\.dsh" }

# ── 小工具 ─────────────────────────────────────────────────────────────────
function Say  ($m) { Write-Host $m }
function Step ($n, $t) { Write-Host ""; Write-Host "── [$n] $t " -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "   OK   $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "   WARN $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "   FAIL $m" -ForegroundColor Red }
function Have ($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

# ★★ 全脚本的"问题收集器"（2026-09-25 加，修核验方 H2）。
#   原来：插件全装不上 / 没进 bundles / 服务没起来 / 端口没释放 —— 任意组合发生后，
#   脚本仍以绿字 "OK 安装流程走完" + exit 0 结束。核验方原话：「**所有真话都说完之后，exit 0 撒了谎**」。
#   ⇒ 现在每个"不致命但没成功"的地方都往这里推一条；收尾按它决定颜色与退出码。
$script:Problems = @()
function Problem ($m) { $script:Problems += $m; Warn $m }

function Get-NativeVersion ($cmd, [string[]]$ArgList) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
  try {
    $raw = & $cmd @ArgList 2>&1 | Out-String
    $m = [regex]::Match($raw, '\d+\.\d+\.\d+(?:-[A-Za-z]+\.\d+)?')
    if ($m.Success) { return $m.Value }
  } catch { } finally { $ErrorActionPreference = $old }
  return $null
}

# 不用 `& cmd | Out-Null` 再读 $LASTEXITCODE：管道之后那个变量是 Out-Null 的，
# 永远是 0 ⇒ 失败会被记成成功（实测踩过：8 个插件坏 7 个，脚本却报"全部就位"）。
function Invoke-Native ($cmd, [string[]]$ArgList) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
  try {
    $out = & $cmd @ArgList 2>&1 | Out-String
    return [pscustomobject]@{ Output = $out; Code = $LASTEXITCODE }
  } catch {
    return [pscustomobject]@{ Output = "$_"; Code = 1 }
  } finally { $ErrorActionPreference = $old }
}
# ── 主流程 ─────────────────────────────────────────────────────────────────
Say ""
Say "================================================================"
Say "  DSH AI 体系 · 一键部署"
Say "  DSH $DSH_VERSION  profile=$ProfileName  工作区=$WorkDir"
Say "  DSH_HOME = $dshHome"
if ($DryRun) { Say "  [DRY-RUN] 只打印，不实际改动" }
Say "================================================================"

Step 1 "环境检查"
$bad = @()
if (-not (Have 'node')) { $bad += 'Node.js 未安装 —— 去 https://nodejs.org 装 LTS' }
else {
  $nv = Get-NativeVersion 'node' @('-v')
  $parts = "$nv".Split('.')
  if ($parts.Count -ge 2) {
    $maj = [int]$parts[0]; $min = [int]$parts[1]
    # ★ 门槛从 22.5 提到 22.19（2026-09-25，核验方实测发现）：
    #   锁定的插件 @linxin666/dsh-pet@0.3.25 声明 engines.node = ^22.19.0 || >=24.0.0。
    #   Node 22.5–22.18 的访客**过得了这道闸门、但运行时可能坏** —— 典型的"作者机器没事"。
    if ($maj -lt 22 -or ($maj -eq 22 -and $min -lt 19)) {
      $bad += "Node $nv 太旧 —— 需要 >= 22.19（锁定的插件要求 ^22.19.0 || >=24.0.0）"
    } else { Ok "Node $nv" }
  } else { Warn "Node 版本读不出来（继续）" }
}
if (-not (Have 'npm')) { $bad += 'npm 不在 PATH 里 —— 重装 Node 时勾选「加入 PATH」' }
else { Ok "npm $(Get-NativeVersion 'npm' @('-v'))" }
if ($bad.Count) { $bad | ForEach-Object { Fail $_ }; Say ""; Say "   ==> 修好上面这些再跑一次。"; exit 1 }

if (-not (Have 'pnpm')) {
  Warn "pnpm 未安装（dsh plugin 依赖它）"
  if (Have 'corepack') {
    if ($DryRun) { Say "   (dry-run) corepack enable pnpm" }
    else {
      # ★ 原来这里**无条件**打 Ok —— 返回码根本没读（核验方称为"全脚本最直白的假绿"）。
      $rC = Invoke-Native 'corepack' @('enable', 'pnpm')
      if ($rC.Code -eq 0) { Ok "corepack 已启用 pnpm" }
      else {
        Warn "corepack enable pnpm 失败（退出码 $($rC.Code)）—— 装插件时大概率会失败"
        Say "       自己装一个：npm i -g pnpm"
      }
    }
  } else { Warn "corepack 也没有 —— 先继续，装插件时若报错就装 pnpm" }
} else { Ok "pnpm $(Get-NativeVersion 'pnpm' @('-v'))" }

Step 2 "装 DSH 本体（版本锁定 $DSH_VERSION）"
$existing = if (Have 'dsh') { Get-NativeVersion 'dsh' @('--version') } else { $null }
if ($existing -eq $DSH_VERSION) {
  Ok "已是 $DSH_VERSION，跳过"
} elseif ($existing -and -not $Force) {
  # ★★ 版本兼容闸门（2026-09-25 加）—— 默认**不覆盖**别人的环境。
  #   为什么必须默认拒绝：宿主与插件是**强耦合**的，而不是"装个新版本就行"。
  #   实证：DSH 0.1.7 的 @deepseek-ai/dsh-settings **删掉了两个导出**
  #   （settingsNamespace / installSettingsSection）⇒ 旧的 UI 插件在模块层 import 失败
  #   ⇒ 实测 11/11 失败；而宿主只报一句 'failed to import'（真实错误被吞），
  #   **服务照样起、界面照样开，只是插件全没了** ⇒ 覆盖别人的 DSH 可能让他现有环境静默残废。
  Fail "检测到已装的 DSH $existing —— **本体系只适配 $DSH_VERSION**，默认不做覆盖。"
  Say ""
  Say "   为什么不能「装上就行」：宿主与插件强耦合。实测 DSH 0.1.7 的 dsh-settings"
  Say "   删掉了两个导出，旧插件在模块层直接失败 ⇒ 11/11 报 failed to import，"
  Say "   而服务照样起、界面照样开 —— 只是插件全没了。"
  Say ""
  Say "   三条出路（选一条）："
  Say "     a) 保留现有版本，本体系先不装；"
  Say "     b) 明确接受覆盖：重跑并加  -Force   （会替换全局 DSH）"
  Say "     c) 先卸干净再装（npm uninstall -g @deepseek-ai/dsh），然后重跑本脚本"
  Say ""
  Say "   ★ 你的现有 profile 仍然会被保留 —— 但覆盖后它里面的插件可能与新宿主不兼容。"
  exit 1
} else {
  if ($existing) { Warn "已装 $existing，且你用了 -Force —— 将覆盖安装 $DSH_VERSION" }
  if ($DryRun) { Say "   (dry-run) npm install -g @deepseek-ai/dsh@$DSH_VERSION" }
  else {
    $r = Invoke-Native 'npm' @('install', '-g', "@deepseek-ai/dsh@$DSH_VERSION")
    if ($r.Code -ne 0) {
      Fail "安装失败（退出码 $($r.Code)）—— 最后几行输出："
      ($r.Output -split [Environment]::NewLine) | Where-Object { $_.Trim() } | Select-Object -Last 10 | ForEach-Object { Say "        " + $_.Trim() }
      Say ""
      Say "   ==> 常见原因：网络到不了 npm / 权限不够（Windows 上试管理员）"
      exit 2
    }
    Ok "已装 @deepseek-ai/dsh@$DSH_VERSION"
  }
}

Step 3 "建工作区"
if (-not (Test-Path $WorkDir)) {
  if ($DryRun) { Say "   (dry-run) mkdir $WorkDir" }
  else { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null; Ok "已创建 $WorkDir" }
} else { Ok "已存在 $WorkDir" }
Say "   （记忆库与会话日志按工作区隔离 —— 这个路径就是你以后的项目根）"

Step 4 "初始化 profile"
# 实测（全新 DSH_HOME）：dsh --profile web --dump-config 会自动从出厂模板建骨架，
# 产出 4 个文件：cordis.patch.yml / cordis.yml / package.json / pnpm-workspace.yaml；
# 出厂只带两个 bundle：@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app。
# 注意 web / headless 是 shipped profile，不能当 --from-default-profile 的目标
# （会报 profile "web" is shipped and cannot be a custom profile target），
# 但直接跑它就会自动建 —— 所以这里用 --dump-config（顺带当自检，不启服务）。
$profDir = Join-Path $dshHome "profiles\$ProfileName"
if (Test-Path (Join-Path $profDir 'package.json')) {
  Ok "profile 已存在：$profDir"
} elseif ($DryRun) {
  Say "   (dry-run) dsh --profile $ProfileName --dump-config   # 建 profile 骨架"
} else {
  $r0 = Invoke-Native 'dsh' @('--profile', $ProfileName, '--dump-config')
  if ($r0.Code -ne 0 -or -not (Test-Path (Join-Path $profDir 'package.json'))) {
    Fail "profile 初始化失败（退出码 $($r0.Code)）"
    ($r0.Output -split [Environment]::NewLine) | Where-Object { $_.Trim() } | Select-Object -Last 10 | ForEach-Object { Say "        " + $_.Trim() }
    exit 2
  }
  Ok "已建：$profDir"
}
Step 5 "预置 pnpm 的两段关键配置（allowBuilds + overrides）"
# 实测（完整安装时抓到）：pnpm 11 默认不执行依赖的 build scripts，并因此以非零码退出：
#   [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared / cpu-features / node-pty ...
# 它写进 pnpm-workspace.yaml 的是占位符：
#   allowBuilds:
#     cloudflared: set this to true or false
# 而"值没填"会让整条安装失败 => 插件装不上，
# 但 package.json 的 dependencies 里已经有名字了 => 只看那里会以为装好了。
# 作者本机是当年手工填过 true，才一直没暴露这个问题。
# 这四个都在插件的依赖链里：node-pty(终端) / cloudflared(远程访问) / cpu-features + ssh2(SSH)。
$wsFile = Join-Path $profDir 'pnpm-workspace.yaml'
if ($DryRun) {
  Say "   (dry-run) 预置 allowBuilds（pnpm 的 build script 白名单）"
} elseif (Test-Path $wsFile) {
  $y = [System.IO.File]::ReadAllText($wsFile, [System.Text.UTF8Encoding]::new($false))
  if ($y -match 'allowBuilds:') {
    $y2 = $y -replace '(?m)^(\s+\S+):\s*set this to true or false\s*$', '$1: true'
    if ($y2 -ne $y) {
      [System.IO.File]::WriteAllText($wsFile, $y2, [System.Text.UTF8Encoding]::new($false))
      Ok "已把 allowBuilds 的占位符填成 true"
    } else { Ok "allowBuilds 已填过（无需改）" }
  } else {
    $nl = [Environment]::NewLine
    $add = $nl + 'allowBuilds:' + $nl + '  node-pty: true' + $nl + '  cloudflared: true' + $nl + '  cpu-features: true' + $nl + '  ssh2: true' + $nl
    [System.IO.File]::WriteAllText($wsFile, $y.TrimEnd() + $add, [System.Text.UTF8Encoding]::new($false))
    Ok "已补 allowBuilds 段"
  }
} else { Warn "pnpm-workspace.yaml 还不存在（跳过，装插件时 pnpm 会建）" }

# ★★★ 预置 overrides（比 allowBuilds 更要命 —— 少了它服务能起来、但一半插件不工作）
#   实测（起服务验证时抓到）：装完 8 个插件、服务确实起来了（HTTP 401、打印带 token 的地址），
#   但组合树里 **11 个子插件 "failed to import"**：
#     web-ui-settings / market / task-board / pet / ssh / describe-image /
#     desktop-launcher / doctor / skin-center / better-sidebar / autovision
#   根因：总包 @linxin666/dsh-web-ui-all@0.3.6 的子插件是**适配 0.1.1 线的旧版**，
#   而宿主是 0.1.7-rc.2 ⇒ 入口 import 不到新版 API（dsh-settings 删了 settingsNamespace、
#   schemastery 缺 .volatile()、dsh-session 缺 SessionLogOffset）。
#   ⇒ 作者的机器没事，是因为它当年在 pnpm-workspace.yaml 里写死了这批 overrides 把子插件顶到适配版本。
#   ⇒ 这几行必须随脚本发出去；否则访客得到的是"能启动、但 UI 残缺"的半成品。
if ($DryRun) {
  Say "   (dry-run) 预置 overrides（把 @linxin666/* 子插件顶到适配 0.1.7 线的版本）"
} elseif (Test-Path $wsFile) {
  $y = [System.IO.File]::ReadAllText($wsFile, [System.Text.UTF8Encoding]::new($false))
  if ($y -match '(?m)^overrides:') {
    Ok "overrides 已存在（无需改）"
  } else {
    $nl = [Environment]::NewLine
    $ov = @(
      '',
      '# ★ 把 @linxin666/* 的子插件顶到适配 0.1.7 线的版本（总包把子插件**精确钉死**在旧线上，',
      '#   必须逐条顶掉，漏一条那条就会在启动时报 failed to import）。',
      '# 不写这些，服务能启动，但这批 UI 子插件会全部 failed to import。',
      'overrides:',
      "  '@linxin666/dsh-client-ui-web-ui-settings': 0.4.1",
      "  '@linxin666/dsh-client-ui-market': 0.4.1",
      "  '@linxin666/dsh-client-ui-task-board': 0.4.1",
      "  '@linxin666/dsh-client-ui-skin-center': 0.3.25",
      "  '@linxin666/dsh-pet': 0.3.25",
      "  '@linxin666/dsh-ssh': 0.4.1",
      "  '@linxin666/dsh-doctor': 0.3.24",
      "  '@linxin666/dsh-remote-web-ui': 0.4.2",
      "  '@linxin666/dsh-tool-describe-image': 0.3.24",
      "  '@linxin666/dsh-desktop-launcher': 0.3.13",
      "  'dsh-better-sidebar': 0.21.1",
      "  '@nanmicoder/dsh-agent-teams': 0.1.21"
    ) -join $nl
    [System.IO.File]::WriteAllText($wsFile, $y.TrimEnd() + $nl + $ov + $nl, [System.Text.UTF8Encoding]::new($false))
    Ok "已补 overrides 段（11 条）"
  }
} else { Warn "pnpm-workspace.yaml 不存在（跳过 overrides）" }

Step 6 "装插件（版本锁定）"
$targets = [ordered]@{}
foreach ($k in $PLUGINS_CORE.Keys) { $targets[$k] = $PLUGINS_CORE[$k] }
if (-not $CoreOnly) { foreach ($k in $PLUGINS_OPTIONAL.Keys) { $targets[$k] = $PLUGINS_OPTIONAL[$k] } }

$failed = @()
foreach ($pkg in $targets.Keys) {
  $spec = "$pkg@$($targets[$pkg])"
  if ($DryRun) { Say "   (dry-run) dsh plugin --profile $ProfileName add $spec"; continue }
  $r = Invoke-Native 'dsh' @('plugin', '--profile', $ProfileName, 'add', $spec)
  if ($r.Code -ne 0) {
    $failed += $spec
    $script:Problems += "插件未装上：$spec"
    Warn $spec
    ($r.Output -split [Environment]::NewLine) |
      Where-Object { $_ -match 'ERR_|error|failed|approve-builds' } |
      Select-Object -First 3 |
      ForEach-Object { Say "        " + $_.Trim().Substring(0, [Math]::Min(110, $_.Trim().Length)) }
  } else { Ok $spec }
}

Step 7 "核对：它们真的进了 bundles 吗"
# 为什么必须核这个：dsh plugin add 是「先写 package.json、再 pnpm install」，
# pnpm 那步失败时 dependencies 里已经有名字，而包根本没装、也没进组合树
# => 只看 dependencies 会得出"装好了"的错误结论（实测踩过）。
if ($DryRun) {
  Say "   (dry-run) 核对 dsh.profile.bundles"
} else {
  $pjFile = Join-Path $profDir 'package.json'
  if (Test-Path $pjFile) {
    $pjTxt = [System.IO.File]::ReadAllText($pjFile, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    $inBundles = @($pjTxt.dsh.profile.bundles)
    # ★ bundles 里存的是**安装时用的包名**，不是组合树里的内部 id。
    #   实测（2026-09-25）：autovision 以 npm 别名 `@iroam2375/dsh-autovision` 安装，
    #   bundles 里就是这个名字；而组合树里它显示为 `name: dsh-autovision`。
    #   我一开始按内部 id 去核对，于是对每一个已装好的插件误报"没进 bundles"。
    $want = @($targets.Keys)
    $missing = @($want | Where-Object { $_ -notin $inBundles })
    if ($missing.Count) {
      Warn ("装了但没进 bundles（等于没启用）：" + ($missing -join '、'))
      Say "   ==> 多半是 pnpm 的 build script 拦截 —— 找上面 [ERR_PNPM_IGNORED_BUILDS] 那几行"
      Say "   ==> 手动补救：在 $wsFile 里把 allowBuilds 的占位符填成 true，再重跑本次安装"
    } else {
      Ok "全部进了 bundles（共 $($inBundles.Count) 个）"
    }
  } else { Warn "读不到 profile 的 package.json" }
}
if ($failed.Count) {
  Warn ("这些命令没成功：" + ($failed -join '、'))
  Say "   ==> 插件是别人的包，会变；装不上不影响主体可用。记下名字，回头单独试。"
}

Step 8 "落一份工作区指令模板（可选启用）"
# ★ 为什么落成 AGENTS.template.md 而不是 AGENTS.md（重要）：
#   AGENTS.md 会被 DSH 类工具**自动注入每一个会话的系统提示**。而模板里全是〈占位符〉，
#   直接生效反而会干扰你的 agent（它会以为那些占位符是真策略）。
#   ⇒ 想启用：改名成 AGENTS.md，再按你的实际情况填。**不启用也完全不影响使用。**
$tplSrc = Join-Path $PSScriptRoot 'AGENTS.template.md'
$tplDst = Join-Path $WorkDir 'AGENTS.template.md'
if (-not (Test-Path $tplSrc)) {
  Warn "找不到模板（$tplSrc）—— 跳过。它应当与本脚本同一个目录。"
} elseif (Test-Path $tplDst) {
  Ok "已存在，不覆盖：$tplDst"
} else {
  if ($DryRun) { Say "   (dry-run) 落 AGENTS.template.md 到 $WorkDir" }
  else { Copy-Item $tplSrc $tplDst -Force; Ok "已落：$tplDst" }
  Say "   ==> 想启用工作区指令：把它改名成 AGENTS.md，再按 〈…〉 处替换成你自己的配置。"
  Say "       不启用也完全没有影响 —— 它只是一份可选的策略骨架。"
}

Step 9 "配置怎么填 + 自检"
Say "   DSH_HOME = $dshHome"
Say "   profile  = $profDir"
Say ""
Say "   模型路由刻意留空 —— 作者用的是私有中转站，你没有。"
Say "   默认可用：DSH 原生的 deepseek-official（去 platform.deepseek.com 拿 key）。"
Say "   也可以起来后在设置页里填 —— 不填也能启动。"
Say ""
if ($DryRun) {
  Say "   (dry-run) dsh --profile $ProfileName --dump-config"
} else {
  $dumpR = Invoke-Native 'dsh' @('--profile', $ProfileName, '--dump-config')
  # 判据要收窄：2>&1 会把 PowerShell 自己的 NativeCommandError 也抓进来，
  # 而那条与本仓库无关（只是 dsh 往 stderr 打的无害警告）。
  $realErr = ($dumpR.Output -split [Environment]::NewLine) | Where-Object {
    $_ -match '(?i)\b(error|failed)\b' -and
    $_ -notmatch 'NativeCommandError|FullyQualifiedErrorId|CategoryInfo|UNDICI|trace-warnings'
  }
  if ($realErr) {
    Warn "组合树里有错误字样（退出码 $($dumpR.Code)）："
    $realErr | Select-Object -First 5 | ForEach-Object { Say "        " + $_.Trim() }
  } else { Ok "组合树可读（退出码 $($dumpR.Code)）" }
}

# ─────────────────────────────────────────────────────────────────────────────
Step 10 "起服务验证（唯一能发现「装了但一半插件不工作」的判据）"
# ★ 为什么必须有这一步（实测，2026-09-25）：
#   装完 8 个插件后读数**全是绿的**（8/8 + 10/10 bundles + 组合树可读 + exit 0），
#   但一起服务就有 **11 个子插件 failed to import** —— 因为总包 @linxin666/dsh-web-ui-all
#   的子插件是适配旧宿主线的，需要 pnpm-workspace.yaml 里的 overrides 顶到适配版本。
#   ⇒ 只看"装上了"会交付一个**能启动、UI 残缺**的半成品。
if ($DryRun) {
  Say "   (dry-run) dsh --profile $ProfileName --port <空闲端口> --no-open   # 起一下、探活、看 failed to import"
} elseif ($SkipBootVerify -or $NoBoot) {
  Warn "跳过了起服务验证（-SkipBootVerify / -NoBoot）"
  Say "   ==> 提醒：跳过它就无法发现「装了但插件没加载」的情况。"
} elseif (-not (Have 'dsh')) {
  Warn "找不到 dsh，跳过"
} else {
  # 找一个空闲端口（避开常见的 3080 和作者用过的 3099/3111）
  $port = 0
  foreach ($p in 3177..3200) {
    if (-not (Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue)) { $port = $p; break }
  }
  if (-not $port) { Warn "找不到空闲端口，跳过起服务验证" }
  else {
    Say "   起在端口 $port（--no-open，不会弹浏览器）…"
    $job = Start-Job -ScriptBlock {
      param($dshHomeArg, $portArg, $profArg)
      $env:DSH_HOME = $dshHomeArg
      # 环境里同时有 NO_PROXY 与 no_proxy 会让 Start-Process 崩；Start-Job 里也顺手清一下
      Remove-Item Env:no_proxy -ErrorAction SilentlyContinue
      & dsh --profile $profArg --port $portArg --no-open 2>&1
    } -ArgumentList $dshHome, $port, $ProfileName

    $alive = $false
    for ($i = 1; $i -le 40; $i++) {
      Start-Sleep -Seconds 1
      try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        $alive = $true; Say "   HTTP $($resp.StatusCode)（第 $i 秒）"; break
      } catch {
        if ($_.Exception.Message -match '401') { $alive = $true; Say "   HTTP 401（第 $i 秒，服务活着、裸访问无 token —— 正常）"; break }
      }
    }

    $svcOut = Receive-Job -Job $job -Keep 2>&1 | Out-String
    $importFails = ($svcOut -split [Environment]::NewLine) | Where-Object { $_ -match 'failed to import' }
    if (-not $alive) {
      $script:Problems += "起服务验证：40 秒内没探到 HTTP 响应"
      Warn "40 秒内没探到 HTTP 响应 —— 服务没起来。最后几行输出："
      ($svcOut -split [Environment]::NewLine) | Where-Object { $_.Trim() } | Select-Object -Last 8 | ForEach-Object { Say "        " + $_.Trim() }
    } elseif ($importFails.Count) {
      $script:Problems += "起服务验证：$($importFails.Count) 个插件 failed to import"
      Warn "服务起来了，但有 $($importFails.Count) 个插件 failed to import："
      $importFails | Select-Object -First 8 | ForEach-Object { Say "        " + $_.Trim() }
      Say "   ==> 多半是 overrides 没顶住版本 —— 见第 5 步那段注释"
    } else {
      Ok "服务起来了，且没有 failed to import"
    }

    # 收尾：Stop-Job 杀不掉已脱离作业的进程，必须按端口找 PID。
    # ★ 而且要**重试着等** —— 原来只 Start-Sleep 2 秒就复查，那时进程还在退出中
    #   => 误报"端口仍被占用"（实测：它随后其实自己释放了）。给最多 10 秒。
    # ★ H1 主修（2026-09-25，核验方实测）：**顺序倒过来**。
    #   原来先 Stop-Job 再等端口 —— 那是在**与孙进程的退出赛跑**，实测跑输了（虚警"仍被占用"，
    #   而 60 秒后端口其实自己释放了）。核验方的对照实验：**手动按端口杀掉 LISTEN 属主，
    #   1 秒内条目清零** ⇒ 正确顺序是**先按端口杀 PID、再收作业**。
    $conn0 = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($conn0) {
      $conn0.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    }
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    $released = $false
    for ($k = 1; $k -le 5; $k++) {
      Start-Sleep -Seconds 2
      $conn = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
      if (-not $conn) { $released = $true; break }
      $conn.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    }
    if ($released) { Ok "已停止，端口 $port 已释放" }
    else {
      # ★ H1 之一：原来这里打的是**字面量** <PID>（脚本明明枚举过 OwningProcess 却不打真 PID）
      $stillPids = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
      $script:Problems += "端口 $port 未释放（PID: $($stillPids -join ',')）"
      Warn "端口 $port 仍被占用（等满 10 秒）—— 手动清理：Stop-Process -Id $($stillPids -join ',') -Force"
    }
  }
}

Say ""
Say "================================================================"
# ★★ H2 主修：收尾不再无条件报绿。
if ($script:Problems.Count) {
  Warn "安装流程走完，但有 $($script:Problems.Count) 个问题："
  $script:Problems | ForEach-Object { Say "     - $_" }
  Say ""
  Say "   ==> 上面这些都会影响实际使用。修好后可重跑本脚本（已装的部分会跳过）。"
  # ★★ H2 的另一半（2026-09-25）：**失败必须反映在退出码上**。
  #   原来：文案说"有问题"，但脚本仍以 exit 0 结束 ⇒ 接 CI / 写自动化的人照样被骗。
  #   现在：有任何一条问题 ⇒ exit 2（与头部声明的 0=成功 1=环境不满足 2=安装失败 对齐）。
  #   注：那些"不致命但没成功"的情形（某插件装不上 / 端口没释放）都归到 2 —— 它们是"没装成"，
  #   不是"环境不满足"。
  Say ""
  Say "   （退出码 = 2，表示「流程走完但有失败」）"
  exit 2
} else {
  Ok "安装流程走完 —— 无问题。"
}
Say ""
Say "   下一步（二选一）："
Say "     · 直接起服务：      dsh --profile $ProfileName"
Say "     · 只想问一句试试：  dsh headless ""Reply with exactly: OK"""
Say ""
Say "   起服务时若非本机访问，注意 DSH 会打印一个带 token 的地址。"
Say "   那个 token 就是门禁 —— 别贴进聊天记录或截图里。"
Say "================================================================"
Say ""