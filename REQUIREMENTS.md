# 运行要求（电脑端）

> **一句话**：**一台能跑 Node 22 的普通 Windows 电脑就够。**
> 它**不吃 GPU、不吃多核、不吃大内存** —— 真正的门槛是**磁盘（约 2.6 GB）**和**能连上 npm**，**不是硬件性能**。
>
> ★ 下表里每个数字都是**实测**出来的（作者在 Windows 11 + Node 22.22.2 上跑出来的读数），不是估的。

---

## 一、必须满足（不满足跑不起来）

| 项目 | 要求 | 为什么是这个数 |
|---|---|---|
| **操作系统** | **Windows 10 / 11** | 一键部署脚本是 **PowerShell** 写的。**Linux / macOS 目前没有对应脚本** —— 你可以照 README 的十步手工做，但**没有人为你验证过** |
| **PowerShell** | **5.1 或更高** | Win10/11 自带（实测 5.1.26100）。**不需要** PowerShell 7 |
| **Node.js** | **≥ 22.19**（或 ≥ 24） | 锁定的插件 `@linxin666/dsh-pet@0.3.25` 声明 `engines.node = ^22.19.0 \|\| >=24.0.0`。**装 LTS 即可** |
| **npm** | 在 PATH 里 | 装 Node 时勾选「加入 PATH」 |
| **pnpm** | 已装，**或**让 `corepack` 启用 | 部署脚本会**自动尝试** `corepack enable pnpm`；失败会明确告诉你 `npm i -g pnpm` |
| **网络** | **能连到 npm registry** | 装插件要**下载**。实测网络抖动会让个别插件失败 —— 但那**不是脚本的问题**，脚本会明确报出是哪个、并以退出码 2 结束 |
| **磁盘** | **约 2.6 GB 可用空间** | 全局安装（DSH 本体）**0.37 GB** + `DSH_HOME`（含 profile 与旁路安装）**1.34 GB** + pnpm 共享缓存 **0.92 GB** ＝ **约 2.6 GB**（下面那段脚本在本机实测的读数）。<br>★ **这几个数会随版本与插件变**（实测：作者 2026-09-25 升级到 0.1.7 那一次，profile 从 365 MB 涨到了 805 MB）。**⇒ 所以下面给了一段脚本，你可以在自己机器上量一遍。** |

> **⚠️ 两个 Node 门槛别搞混**：本仓库里有**两样东西**，门槛不同 ——
> · **断言层（`checks/`）**：≥ **22.5**（「记忆毕业」那一项用了 `node:sqlite`，实验特性）；
> · **整套体系（`deploy/`）**：≥ **22.19**（插件要求）。
> **⇒ 想两个都用，装 Node ≥ 22.19 就行**（它同时满足 22.5）。

---

## 二、建议满足（不满足也能跑，但体验差）

| 项目 | 建议 | 说明 |
|---|---|---|
| **内存** | **≥ 4 GB 可用** | 实测占用：**刚起 202 MB**（单进程）；作者跑久了的实例 **434 MB**。日常在 **400–900 MB** 之间 |
| **CPU** | 无要求 | 作者机器 18 逻辑核**纯属过剩**。首页响应 **67 ms**；起服务、聊天都不吃 CPU |
| **磁盘类型** | SSD | pnpm 要展开两万多个小文件，机械盘会很慢 |
| **浏览器** | 任意现代浏览器 | 只是用它打开 `http://127.0.0.1:<端口>/?token=…` |

---

## 三、不需要的（可以放心）

- ❌ **不需要 GPU**；
- ❌ **不需要管理员权限**（`npm install -g` 若报权限错，才需要）；
- ❌ **不需要 API key 就能装** —— 起来之后在设置页填；DSH 原生支持 `deepseek-official`；
- ❌ **不需要 Docker / WSL / 虚拟机**；
- ❌ **不需要联网也能用** —— 只有**装的时候**要联网；装完之后断网也能起服务、聊天（取决于你用的模型是否要联网）。

---

## 四、这个数字是怎么测出来的（**可以直接复制去复核**）

> **2026-09-26 改**：本节原来写的是"方法描述"（"按端口找属主 PID ⇒ 遍历 Win32_Process…"）——
> **那读者还得自己写脚本，等于没给**。现在换成**可直接跑的命令**：**复制 → 粘贴 → 拿到数**。
> **下面每条都注明了"要替换什么"**。

### 磁盘占用

```powershell
# 把 <DSH_HOME> 换成你的（默认 %USERPROFILE%\.dsh）
$h = "$env:USERPROFILE\.dsh"
"DSH_HOME = " + [math]::Round((Get-ChildItem $h -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB, 2) + " GB"
"其中 profile = " + [math]::Round((Get-ChildItem "$h\profiles" -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB, 2) + " GB"
```

### 内存 / 首页响应（**必须按端口定位属主，别按进程名**）

> ⚠️ **先读这句：内存这个数会随运行时长涨，别拿一次读数当"它吃多少"。**
> 上面表里写的 **202 MB 是"刚起服务"**；作者另一次在**跑了很久的实例**上实测是 **737 MB**。
> **两个数都对，只是问的问题不同** —— 你要比的是**同一台机器上、同一状态下、改动前后**的差，
> 而不是"我测出来为什么和文档不一样"。
> **内存随会话长、插件多、上下文长而增长，这是正常的。**

```powershell
# 把 3080 换成你实例的端口
$port = 3080
$conn = Get-NetTCPConnection -LocalPort $port -State Listen -EA SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  "该端口没有 LISTEN 进程 —— 服务没起，或换端口了"
} else {
  $owner = $conn.OwningProcess
  # 只算属主 + 它的直接子进程（**不再递归遍历整棵树** —— 那一步在有些机器上会卡住，见下方说明）
  $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$owner" -EA SilentlyContinue | ForEach-Object { $_.ProcessId })
  $ids = @($owner) + $kids | Sort-Object -Unique
  $mem = (Get-Process -Id $ids -EA SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum
  "实例内存 ≈ " + [math]::Round($mem / 1MB) + " MB（" + $ids.Count + " 个进程：属主 $owner + 子进程）"
  $ms = (Measure-Command { try { Invoke-WebRequest "http://127.0.0.1:$port" -UseBasicParsing -TimeoutSec 5 -EA Stop | Out-Null } catch {} }).TotalMilliseconds
  "首页响应 = " + [math]::Round($ms) + " ms（返回 401 也算通了 —— 那说明服务活着、只是没带 token）"
}
```

> ⚠️ **上面那段我写成完整命令，是因为"按端口找属主"这一步最容易被简化成错的**：
> 直接 `Get-Process node` 会把**别人的 node 进程**也算进去。

> **一个测量上的坑（作者踩过，上面那段命令就是为了避开它）**：直接 `Get-Process node` 求和会**把别的 node 进程也算进去** ——
> 作者第一次测得 911 MB，其实那一半是**他自己的生产实例**；按端口定位属主后真实值只有 **202 MB**。
> ⇒ **测"这套东西吃多少资源"之前，先确认测量范围里没有别人的进程。**
>
> ⚠️ **上面那条命令我改过一次**（2026-09-26）：第一版**递归遍历整棵进程树**（`while` 循环里反复调 `Get-CimInstance`），
> **实测在作者的机器上会卡住**（两分钟无输出）。写进文档的"可直接跑"命令，**必须真的跑过一遍** ——
> 否则读者照抄就卡住，比不给命令更糟。现在只算**属主 + 直接子进程**：够用，且秒回。
