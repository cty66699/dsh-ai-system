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
     10. 起一次服务验证（★ 唯一能发现「装了但一半插件不工作」的判据）

  四条设计原则（都是实测踩出来的，不是设计出来的）：
    1. 版本全部锁死 —— "别人能跑"必须有可复现性。
    2. 不碰 file: 与 github: 源 —— 前者别人 clone 不到、后者要 GitHub 可达。
       装饰类插件（状态灯、分隔线）默认不装，一举绕开这两个坑。
    3. 配置留空 + 说明 —— 作者的模型路由走私有中转站，访客没有。
       默认只启用 DSH 原生支持的 deepseek-official。
    4. 判成败要看「结果」，不看「命令自述」：
       dsh plugin add 是「先写 package.json、再 pnpm install」，
       pnpm 那步失败时 dependencies 里已经有名字了 ⇒ 必须核对 bundles。

  退出码（2026-09-26 补全 —— 独立审查指出原声明与实际不符）：
     0 = 成功（**且没有任何一条问题被记下**）
     1 = 环境不满足 **或 版本冲突**（两种成因，看 FAIL 那几行：
         ① 缺 Node/npm、Node 版本太旧；② 检测到已装别的 DSH 版本、或读不出它的版本）
     2 = 流程走完但有失败（`$script:Problems` 非空：插件没装上 / 没进 bundles /
         起服务没起来 / 有插件未激活 / 端口没释放 / 模板没落成 …）
   ★ 另有**两个未在声明里、但确实会出现**的退出码，来源在 PowerShell 本身：
     · **参数拼错或用了不支持的开关**（如 -WhatIf）⇒ 参数绑定失败 ⇒ exit 1，**脚本体一行都不执行**；
     · **未捕获的终止错误**（如 profile 的 package.json 坏了 ⇒ ConvertFrom-Json 抛错）
       ⇒ exit 1，**且永远不会打印收尾汇总**。这两种都不是"环境不满足"。
   ⇒ 判 CI 时别只看 0/1/2 三个数：**1 可能意味着"你没跑起来"，而不只是"你环境不行"。**
  ============================================================================
#>

[CmdletBinding()]
param(
  [string]$WorkDir = "$HOME\dsh-workspace",
  [string]$ProfileName = 'web',
  [switch]$CoreOnly,
  [switch]$NoBoot,

  # 跳过「起服务验证」这一步（默认**会**做 —— 它是唯一能发现「装了但一半插件不工作」的判据）
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
#   ⇒ 现在每个「不致命但没成功」的地方都往这里推一条；收尾按它决定颜色与退出码。
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
# ★★ 2026-09-26 加（访客演练报告 F3 —— 一个**会改掉使用者生产环境**的落地路径）：
#   起因：干跑只说了「工作区=<路径>」和「[DRY-RUN] 只打印」，**没有说清它还会动 `DSH_HOME` 里的那个 profile**。
#   而实测：本机 `profiles\web` 是**使用者正在用的**（装着 `dshmarket@1.38.1`、`dsh-usage-stats@0.3.1`、
#   还有清单外的 `dsh-done-whale@1.0.0`）—— 脚本装完**会把这些顶到它锁定的版本**。
#   ⇒ 一个守规矩的 AI 看干跑输出时，**看不出"这一步会改我生产 profile"**，就会合规地继续。
#   ⇒ 修法：**无论干跑还是真装，都把"本次会动什么"逐条打出来**。
Say ""
Say "  ── 本次会动的东西（请逐条核对，尤其是第 2 条）────────────────"
Say "     [1] 工作区:  $WorkDir"
Say "     [2] ★ 既有的 DSH profile: $dshHome\profiles\$ProfileName"
Say "           · 脚本会**就地改写**它的 pnpm-workspace.yaml（allowBuilds / overrides）与 package.json"
if ($CoreOnly) { $__nAdd = $PLUGINS_CORE.Count } else { $__nAdd = $PLUGINS_CORE.Count + $PLUGINS_OPTIONAL.Count }
Say "           · 并对**同一个 profile** 执行 $__nAdd 条 dsh plugin add"
Say "           · 改写前会留 .bak-<时间戳> 备份；但**已装的其它插件版本可能被顶到脚本锁定的版本**"
# ★ 试着读一下那个 profile 现在装了什么（读不到就说读不到 —— 不假装）
$__pkg = Join-Path $dshHome "profiles\$ProfileName\package.json"
if (Test-Path $__pkg) {
  try {
    $__j = [System.IO.File]::ReadAllText($__pkg, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    $__deps = @($__j.dependencies.PSObject.Properties)
    if ($__deps.Count -gt 0) {
      Say "           · 它现在装着 $($__deps.Count) 个依赖；与本次清单不一致的会在下面标出："
      foreach ($__d in $__deps) {
        $__want = $null
        if ($PLUGINS_CORE.Contains($__d.Name)) { $__want = $PLUGINS_CORE[$__d.Name] }
        elseif ($PLUGINS_OPTIONAL.Contains($__d.Name)) { $__want = $PLUGINS_OPTIONAL[$__d.Name] }
        $__now = "$($__d.Value)"
        if ($null -eq $__want) { Say ("             ⚠️ " + $__d.Name + " = " + $__now + "   （**清单里没有它** —— 这是使用者自己的东西）") }
        elseif ($__now -notmatch [regex]::Escape($__want)) { Say ("             ⚠️ " + $__d.Name + " = " + $__now + "   ⇒ 本次要换成 " + $__want + "（**不一致**）") }
      }
      Say "           ⇒ 只要上面出现 ⚠️，就说明这个 profile 是**在使用中的** ——"
      Say "             **必须先问使用者**要不要就改它，还是换一个 profile（-Profile <名字>）。"
    } else {
      Say "           · 它现在没有任何依赖（像是个空 profile）⇒ 改动风险低"
    }
  } catch {
      # ★ 修（2026-09-26）：原来这里在字符串里用了**半角引号**（"里面可能有使用者的东西"）——
      #   PowerShell 在参数模式下会把它们当**参数拼接**，结果**整段 Say 被吞掉、语法门却报 0 错**。
      #   ⇒ 内层引号一律用中文引号。
      Say "           · （读不出它的 package.json —— 那就按「里面可能有使用者的东西」来对待）"
  }
} else {
  Say "           · （那个 profile 还没有 package.json ⇒ 像是首次建）"
}
Say "     [3] $dshHome 下的其它文件：脚本只碰上面那两处，不动凭据与会话"
Say "  ────────────────────────────────────────────────────────────"

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
$hasDsh = Have 'dsh'
$existing = if ($hasDsh) { Get-NativeVersion 'dsh' @('--version') } else { $null }
if ($existing -eq $DSH_VERSION) {
  Ok "已是 $DSH_VERSION，跳过"
} elseif ($hasDsh -and -not $existing -and -not $Force) {
  # ★★ 2026-09-26 加（独立审查抓出的 **fail-open**）：
  #   原来只有两条分支 ——「版本相同 ⇒ 跳过」与「有版本且不同 ⇒ 拒绝」——
  #   于是 `$existing` 为 `$null` / `''` 时会**掉进最后那个 else、直接覆盖安装**。
  #   而 `$null` 的来源很平常：**一个「命令找得到、但跑起来报错」的 shim**
  #   （本工作区真发生过：托管 Node 目录被整体删除，装在里面的全局命令一起消失）。
  #   ⇒ **"认不出这是什么环境"必须按最危险处理，不能按最安全处理。**
  Fail "检测到 dsh，但**读不出它的版本** —— 命令在那里，却没有给出可解析的版本号。"
  Say ""
  Say "   这说明你的 dsh **处于半坏状态**（shim 还在、跑不起来）。"
  Say "   这种情况下**不能**直接装：脚本无法判断你现有的是哪一个版本、"
  Say "   也**无法保证**覆盖之后你原有的插件还能用（宿主与插件强耦合，见下）。"
  Say ""
  Say "   为什么覆盖有风险：实测 DSH 0.1.7 的 dsh-settings 删掉了两个导出，"
  Say "   旧的 UI 插件在模块层直接失败 ⇒ 11/11 报 failed to import，"
  Say "   而**服务照样起、界面照样开 —— 只是插件全没了**。"
  Say ""
  Say "   三条出路（选一条）："
  Say "     a) 先修好你现有的 dsh（跑一下 dsh --version 看它报什么错）；"
  Say "     b) 确实想覆盖：重跑并加  -Force  （会替换全局 DSH）；"
  Say "     c) 先卸干净再装：npm uninstall -g @deepseek-ai/dsh，然后重跑本脚本。"
  Say ""
  Say "   ★ 这条分支是 2026-09-26 补的 —— 此前它会**静默走进覆盖安装**。"
  exit 1
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
# 而「值没填」会让整条安装失败 => 插件装不上，
# 但 package.json 的 dependencies 里已经有名字了 => 只看那里会以为装好了。
# 作者本机是当年手工填过 true，才一直没暴露这个问题。
# 这四个都在插件的依赖链里：node-pty(终端) / cloudflared(远程访问) / cpu-features + ssh2(SSH)。
$wsFile = Join-Path $profDir 'pnpm-workspace.yaml'
# ★★★ 2026-09-26 加：**改动 profile 之前先备份**。
#   为什么需要它（独立审查的原话）：
#     「**`-Force` 保护的是"全局 DSH 二进制"，而真正会伤人的是"我能不能动你的 profile" ——
#       这个没有任何闸门。**」
#   而第 5 步**就地改写** `pnpm-workspace.yaml`（无备份、无 diff、无确认）：
#     · `allowBuilds` 的改动等于**替使用者同意执行依赖的 build scripts**（pnpm 的任意代码执行开关）；
#     · `overrides` 是 workspace 级全局生效的 —— 使用者手上更新的版本会被这些 pin 顶回旧版。
#   ⇒ 我没有给整个流程加一道"你必须先同意"的闸门（那会拦住"开荒"这个主用途），
#     但**至少让每一步都可退回**：动手前把这两个文件各存一份带时间戳的副本。
#   ★ 为什么这是对的做法：使用者最怕的不是"被改了"，而是"**被改了还没法退回去**"。
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $DryRun) {
  $backed = @()
  foreach ($bf in @($wsFile, (Join-Path $profDir 'package.json'))) {
    if (Test-Path -LiteralPath $bf) {
      $bak = "$bf.bak-$stamp"
      try { Copy-Item -LiteralPath $bf -Destination $bak -Force -ErrorAction Stop; $backed += (Split-Path $bak -Leaf) } catch { }
    }
  }
  if ($backed.Count) {
    Ok "已备份 $($backed.Count) 份（改坏了可退回）：$($backed -join '、')"
  } else {
    Warn "没能备份 profile 配置（首次安装时文件还不存在，属正常）"
  }
}
if ($DryRun) {
  Say "   (dry-run) 预置 allowBuilds（pnpm 的 build script 白名单）"
} elseif (Test-Path $wsFile) {
  $y = [System.IO.File]::ReadAllText($wsFile, [System.Text.UTF8Encoding]::new($false))
  if ($y -match '(?m)^allowBuilds:') {
    # ★★★ 2026-09-26 修（独立审查 2.2 —— 一处"断言了从未被验证的否定"）：
    #   原来这一段是：
    #     `$y2 = $y -replace '(?m)^(\s+\S+):\s*set this to true or false\s*$', '$1: true'`
    #     `if ($y2 -ne $y) { ...写回...; Ok "已把占位符填成 true" } else { Ok "allowBuilds 已填过（无需改）" }`
    #   ⇒ 它的判据是「**替换有没有改动任何东西**」，**不是"值对不对"**。
    #     审查方实测（PS 5.1，合成字符串）—— 下面 **5 种情况全部报"已填过（无需改）"**：
    #       ① `allowBuilds:` 下四项全 `false`（build scripts 被禁用）
    #       ② 只有 `allowBuilds:`、没有子项
    #       ③ `allowBuilds:` 只出现在**注释**里（根本不写白名单）
    #       ④ 只填了 `node-pty`、缺另外三项
    #       ⑤ 占位符文案带一个句号（一个都没填）
    #   ⇒ 修法：**逐个键检查值**，并把"缺哪几个"说清楚。
    #     另外把 `-replace` **限定在 allowBuilds 块内** —— 原来是全文件替换，
    #     审查方实测：文件里另有一个不相干的缩进键取值 `set this to true or false`，**那个键也被改成了 true**。
    $WANT_AB = @('node-pty', 'cloudflared', 'cpu-features', 'ssh2')
    # ① 先把"缩进键: set this to true or false"占位符填成 true —— **只在这个块内**（块 = 从 allowBuilds: 到下一个顶层键）
    $blkStart = ([regex]::Match($y, '(?m)^allowBuilds:\s*$')).Index
    $rest = $y.Substring($blkStart)
    $nextTop = [regex]::Match($rest.Substring(1), '(?m)^\S')
    $blkLen = if ($nextTop.Success) { 1 + $nextTop.Index } else { $rest.Length }
    $blk = $rest.Substring(0, $blkLen)
    $blk2 = $blk -replace '(?m)^(\s+\S+):\s*set this to true or false\s*$', '$1: true'
    if ($blk2 -ne $blk) {
      $y = $y.Substring(0, $blkStart) + $blk2 + $y.Substring($blkStart + $blkLen)
      [System.IO.File]::WriteAllText($wsFile, $y, [System.Text.UTF8Encoding]::new($false))
      Ok "已把 allowBuilds 块内的占位符填成 true（**只改这个块**）"
    }
    # ② 现在**逐个键检查值**（这才是真判据）
    $blk = [regex]::Match($y, '(?ms)^allowBuilds:\s*\n((?:[ \t]+.*\n?)*)').Groups[1].Value
    $missing = @()
    foreach ($k in $WANT_AB) {
      # 该键必须**在本块内**、且值是 true（不是缺失、不是 false、不是"只在注释里"）
      if ($blk -notmatch ('(?m)^[ \t]+' + [regex]::Escape($k) + ':\s*true\s*(#.*)?$')) { $missing += $k }
    }
    if ($missing.Count -eq 0) {
      Ok "allowBuilds 四项都已为 true（逐键核过）"
    } else {
      $script:Problems += "allowBuilds 缺这几项（或不是 true）：$($missing -join '、')"
      Warn "allowBuilds 不完整：缺 $($missing -join '、') —— pnpm 会拒绝跑它们的 build script"
      Say "   ==> 修正：在 $wsFile 的 allowBuilds: 段里，把这几个键显式写成 true"
    }
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
#   ⇒ 这几行必须随脚本发出去；否则访客得到的是「能启动、但 UI 残缺」的半成品。
if ($DryRun) {
  Say "   (dry-run) 预置 overrides（把 @linxin666/* 子插件顶到适配 0.1.7 线的版本）"
} elseif (Test-Path $wsFile) {
  $y = [System.IO.File]::ReadAllText($wsFile, [System.Text.UTF8Encoding]::new($false))
  # ★★ 2026-09-26 修（独立审查抓出的**假绿**）：
  #   原来的判据是 `if ($y -match '(?m)^overrides:') { Ok "overrides 已存在（无需改）" }`
  #   —— 它只问"文件里有没有这个键"，**从不检查里面有没有这些 pin**。
  #   实测（本机就是这个状态）：作者的 `pnpm-workspace.yaml` 有 `overrides:` 但**只有 11 条**，
  #   而本脚本自己的清单是 **12 条** —— 缺的正是 `'@linxin666/dsh-remote-web-ui': 0.4.2`，
  #   而第 6 步**默认就要装** `@linxin666/dsh-remote-web-ui@0.4.2`（顶层装会把嵌套的旧版盖住，
  #   所以平时看不出来；一旦用 `-CoreOnly` 就暴露成 `failed to import`）。
  #   ⇒ 后果：脚本宣布"无需改"，然后去装一个**它自己没有 pin 住**的包。
  #   ★ 修法：**逐条核对 pin 是否存在**；缺的**补进去**（而不是整段跳过）。
  $PINS = [ordered]@{
    '@linxin666/dsh-client-ui-web-ui-settings' = '0.4.1'
    '@linxin666/dsh-client-ui-market'          = '0.4.1'
    '@linxin666/dsh-client-ui-task-board'      = '0.4.1'
    '@linxin666/dsh-client-ui-skin-center'     = '0.3.25'
    '@linxin666/dsh-pet'                       = '0.3.25'
    '@linxin666/dsh-ssh'                       = '0.4.1'
    '@linxin666/dsh-doctor'                    = '0.3.24'
    '@linxin666/dsh-remote-web-ui'             = '0.4.2'
    '@linxin666/dsh-tool-describe-image'       = '0.3.24'
    '@linxin666/dsh-desktop-launcher'          = '0.3.13'
    'dsh-better-sidebar'                       = '0.21.1'
    '@nanmicoder/dsh-agent-teams'              = '0.1.21'
  }
  $nl = [Environment]::NewLine
  $haveOv = $y -match '(?m)^overrides:'
  if ($haveOv) {
    $missing = @()
    foreach ($k in $PINS.Keys) { if ($y -notmatch [regex]::Escape("'$k'")) { $missing += $k } }
    if ($missing.Count -eq 0) {
      Ok "overrides 已有全部 $($PINS.Count) 条 pin（逐条核对过）"
    } else {
      # 在 `overrides:` 那一行之后插入缺的条目（缩进 2 空格，与既有风格一致）
      $lines = $y -split "\r?\n"
      $idx = -1
      for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^overrides:') { $idx = $i; break } }
      $insert = @()
      foreach ($k in $missing) { $insert += "  '$k': $($PINS[$k])" }
      $newLines = @($lines[0..$idx]) + $insert + @($lines[($idx+1)..($lines.Count-1)])
      [System.IO.File]::WriteAllText($wsFile, ($newLines -join $nl).TrimEnd() + $nl, [System.Text.UTF8Encoding]::new($false))
      Ok "overrides 已存在，但**缺 $($missing.Count) 条 pin** —— 已补进原段：$($missing -join '、')"
      Say "   （原来的判据只问「有没有 overrides 这个键」，不检查里面缺什么 —— 已修为逐条核对）"
    }
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
    Ok "已补 overrides 段（$($PINS.Count) 条）"
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
  # ★★ 2026-09-26 加：**失败自动重试一次**。
  #   依据（本轮实测）：同一份配置、同一个包、同一个版本，**两次跑结果不同** ——
  #     开荒测试那次 `@linxin666/dsh-web-ui-all@0.3.6` 失败（它带 19 个子插件，耗时最长）；
  #     受控复现（配置与之等价）**86.3 秒成功**，7 个插件全部 `exit 0`。
  #   ⇒ **这是偶发，不是配置错**。而"偶发"恰恰是最该自动重试的一类 ——
  #     否则使用者会因为一次网络抖动得到一个**少一个插件的体系**，而他自己看不出差别。
  #   ★ 只重试一次：第二次仍失败 ⇒ 那是真问题，交给使用者（脚本会把它记进 Problems 并以非 0 退出）。
  if ($r.Code -ne 0) {
    Warn "   $spec 第一次失败 —— 等 10 秒后**自动重试一次**（网络抖动是已知情况）…"
    Start-Sleep -Seconds 10
    $r2 = Invoke-Native 'dsh' @('plugin', '--profile', $ProfileName, 'add', $spec)
    if ($r2.Code -eq 0) {
      Ok "$spec  （**重试后成功** —— 第一次是偶发）"
      $r = $r2
    } else {
      Say "   ==> 重试仍失败，按真问题处理。"
      $r = $r2
    }
  }
  if ($r.Code -ne 0) {
    $failed += $spec
    $script:Problems += "插件未装上：$spec（已自动重试一次）"
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
# => 只看 dependencies 会得出「装好了」的错误结论（实测踩过）。
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
      # ★ 2026-09-26 改 Warn → Problem：**"装了但没启用"是体系不完整，不是提醒。**
      #   原实现只 Warn，而 Warn **不进 $script:Problems** ⇒ 最终仍 exit 0 报"安装流程走完" ——
      #   这正是核验方抓到的那个模式：「**所有真话都说完之后，exit 0 撒了谎**」。
      Problem ("装了但没进 bundles（等于没启用）：" + ($missing -join '、'))
      Say "   ==> 多半是 pnpm 的 build script 拦截 —— 找上面 [ERR_PNPM_IGNORED_BUILDS] 那几行"
      Say "   ==> 手动补救：在 $wsFile 里把 allowBuilds 的占位符填成 true，再重跑本次安装"
    } else {
      Ok "全部进了 bundles（核对的是本脚本要装的 $($want.Count) 个；文件里 bundles 共 $($inBundles.Count) 项）"
    }
  } else { Warn "读不到 profile 的 package.json" }
}
if ($failed.Count) {
  # ★ 2026-09-26 改 Warn → Problem：同样的理由 —— 装不上就是**少一个功能**，
  #   退出码必须诚实（不能说「走完了」却又少东西）。说明保留，供使用者判断严重性。
  Problem ("这些命令没成功：" + ($failed -join '、'))
  Say "   ==> 插件是别人的包，会变；少一个插件通常不影响主体可用 —— 但**它是真的没装上**，"
  Say "       所以本次会以非 0 退出码结束。记下名字，回头单独试。"
}

Step 8 "落一份工作区指令模板（可选启用）"
# ★ 为什么落成 AGENTS.template.md 而不是 AGENTS.md（重要）：
#   AGENTS.md 会被 DSH 类工具**自动注入每一个会话的系统提示**。而模板里全是〈占位符〉，
#   直接生效反而会干扰你的 agent（它会以为那些占位符是真策略）。
#   ⇒ 想启用：改名成 AGENTS.md，再按你的实际情况填。**不启用也完全不影响使用。**
$tplSrc = Join-Path $PSScriptRoot 'AGENTS.template.md'
$tplDst = Join-Path $WorkDir 'AGENTS.template.md'
if (-not (Test-Path $tplSrc)) {
  $script:Problems += "找不到工作区指令模板（$tplSrc）—— 已跳过"
  Warn "找不到模板（$tplSrc）—— 跳过。它应当与本脚本同一个目录。"
} elseif (Test-Path $tplDst) {
  Ok "已存在，不覆盖：$tplDst"
} else {
  if ($DryRun) { Say "   (dry-run) 落 AGENTS.template.md 到 $WorkDir" }
  else {
    # ★★ 2026-09-26 修（独立审查 2.1 —— 一处"无条件 OK"）：
    #   原来是 `Copy-Item $tplSrc $tplDst -Force; Ok "已落：$tplDst"` ——
    #   复制的成败**没有任何检查**（没有 `$?`、没有 try/catch、没有 `-ErrorAction Stop`），
    #   而本脚本把 `$ErrorActionPreference` 设成了 `'Continue'`。
    #   ★ 审查方实测（PS 5.1，模拟失败）：让 `Copy-Item` 失败后脚本**继续执行下一行**，`$? = False`，
    #     **而绿色 `OK 已落：D:\__no_such_dir__\out.md` 照样打印**，退出码也不变。
    #   ⇒ 修法：复制后立刻判 `$?`；失败就记进 `Problems`（那才影响退出码）。
    Copy-Item $tplSrc $tplDst -Force -ErrorAction SilentlyContinue
    if ($?) { Ok "已落：$tplDst" }
    else {
      $script:Problems += "工作区指令模板没落成（$tplDst）"
      Warn "落模板失败：$tplDst（不影响体系运行，但工作区少了那份可选骨架）"
    }
  }
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
    $script:Problems += "第 9 步：组合树 dump 有问题（退出码 $($dumpR.Code)）"
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
#   ⇒ 只看「装上了」会交付一个**能启动、UI 残缺**的半成品。
if ($DryRun) {
  Say "   (dry-run) 起一次服务、探活、看有没有 failed to import"
Say "             —— 端口由脚本自己挑一个没被占用的；上面这行**不是可复制的命令**"
Say "                （原实现写成 `--port <空闲端口>`，那个尖括号是字面量，照抄会报错）"
} elseif ($SkipBootVerify -or $NoBoot) {
  $script:Problems += "跳过了起服务验证 —— **那是唯一能发现插件没加载的动作**"
    Warn "跳过了起服务验证（-SkipBootVerify / -NoBoot）"
  Say "   ==> 提醒：跳过它就无法发现「装了但插件没加载」的情况。"
} elseif (-not (Have 'dsh')) {
  $script:Problems += "找不到 dsh 命令，起服务验证被跳过"
    Warn "找不到 dsh，跳过"
} else {
  # 找一个空闲端口（避开常见的 3080 和作者用过的 3099/3111）
  $port = 0
  foreach ($p in 3177..3200) {
    if (-not (Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue)) { $port = $p; break }
  }
  if (-not $port) {
    # ★★ 2026-09-26 修（独立审查 2.3）：这里原来是 `Warn` —— 而**同一件事在 3177 端口那段已是 `Problem`**，
    #   两处不一致。跳过起服务验证等于**跳过了唯一能发现"装了但没加载"的动作** ⇒ 必须进 Problems（影响退出码）。
    $script:Problems += "找不到空闲端口（3177-3200 全占），起服务验证被跳过"
    Warn "找不到空闲端口，跳过起服务验证 —— **那是唯一能发现插件没加载的动作**"
  }
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
    # ★★ 2026-09-26 修（独立审查抓出）：**原来的判据只搜 `failed to import` 一个词。**
    #   而 DSH 自己的**权威读数是聚合行**（源码 `index.js`）：
    #     `${binName}: warning: ${n} ${noun} did not activate`
    #     `startup failed: ${n} required plugins did not activate`
    #   逐条目输出的是 `<name>: pending (waiting for service: …)` / `<name>: failed` /
    #     `profile startup denies it until you grant an exemption`。
    #   ⇒ **只有 required 插件不激活才是致命错误；optional 不激活只是一条 warning，
    #     服务照起、HTTP 照样应答 —— 而那条 warning 里没有 `failed to import`** ⇒ 脚本报绿。
    #   ★ 这正是这份交付物最想防的那一类："使用者下次打开界面，发现某个插件没了，而屏幕告诉他无问题"。
    #   公平地说：原作者踩的那个坑（0.1.5 线 11 个子插件 import 失败）**确实会**打印
    #   `failed to import` —— 所以旧判据对他那一类故障有效，**它只是对其余几类失效**。
    $FATAL_PAT = 'failed to import|did not activate|startup failed|does not provide an export|is not a function|inactive context'
    $SUSPECT_PAT = 'pending \(waiting for service|denies it until you grant|did not activate\b.*optional'
    $importFails = ($svcOut -split [Environment]::NewLine) | Where-Object { $_ -match $FATAL_PAT }
    $suspicious = ($svcOut -split [Environment]::NewLine) | Where-Object { $_ -match $SUSPECT_PAT }
    if (-not $alive) {
      $script:Problems += "起服务验证：40 秒内没探到 HTTP 响应"
      Warn "40 秒内没探到 HTTP 响应 —— 服务没起来。最后几行输出："
      ($svcOut -split [Environment]::NewLine) | Where-Object { $_.Trim() } | Select-Object -Last 8 | ForEach-Object { Say "        " + $_.Trim() }
    } elseif ($importFails.Count) {
      $script:Problems += "起服务验证：$($importFails.Count) 条「插件未激活」读数"
      Warn "服务起来了，但有 $($importFails.Count) 条**插件未激活**的读数："
      $importFails | Select-Object -First 8 | ForEach-Object { Say "        " + $_.Trim() }
      Say "   ==> 多半是 overrides 没顶住版本 —— 见第 5 步那段注释"
      Say "   ==> 注意：**服务起得来不等于插件都在**。DSH 的权威读数是上面这些行，"
      # ★ 2026-09-26 修：这里原来写的是 `Say "       不是"起没起来" —— …"` ——
#   相邻的两个 token 让**全文解析 0 错误**（PowerShell 在参数模式下会自动拼接），
#   但 `function Say ($m)` 只吃**第一个参数** ⇒ **实测输出只有「不是」两个字，后面整句被静默丢弃**。
#   ★ 而这一行的执行条件恰好是"服务起来了但插件没激活" —— **最需要把话说清楚的那一刻**。
#   修法：内层引号改用中文引号「」，不要用半角引号。
Say "       不是「起没起来」 —— 服务照常启动、HTTP 照常应答，而插件可能已经没了。"
    } else {
      Ok "服务起来了，且没有「插件未激活」的读数"
      if ($suspicious.Count) {
        Say "   （另有 $($suspicious.Count) 条可疑行，不判红但值得看一眼：）"
        $suspicious | Select-Object -First 4 | ForEach-Object { Say "        " + $_.Trim() }
      }
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
  #   注：那些「不致命但没成功」的情形（某插件装不上 / 端口没释放）都归到 2 —— 它们是"没装成"，
  #   不是"环境不满足"。
  Say ""
  Say "   （退出码 = 2，表示「流程走完但有失败」）"
  exit 2
} else {
  if ($DryRun) {
  # ★ 2026-09-26 修（独立审查抓出）：**干跑什么都没验证**，收尾却说"无问题" —— 
  #   那句话没有证据支撑（第 5/6/7/9/10 步在干跑下全部只打印）。
  Say "   [DRY-RUN] 流程演练完毕 —— **本次什么都没验证**（没装、没改、没起服务）。"
  Say "             想真装：去掉 -DryRun 重跑一次。"
} else {
  Ok "安装流程走完 —— 无问题。"
}
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

# ★★ 2026-09-26 加：**显式 exit 0**。
#   原来末尾没有这一行 ⇒ 脚本的退出码 = **最后一条原生命令残留的 $LASTEXITCODE** ⇒
#   会出现"脚本说成功、调用方（CI/批处理）看到失败"的**反向不一致**。
#   （独立审查实测过这一点。注意前几轮修的是"失败却说成功"，这是相反方向的那一半。）
exit 0
