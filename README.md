# qqbot-windows — Windows 云服务器上的 QQ 机器人部署（SnowLuma + AstrBot）

> 这是 [qqbot-toolkit](https://github.com/Hourz26/qqbot-toolkit)（Linux 版：NapCat / LLBot + Docker）的 **Windows 分支**。
> 两条路线的协议端完全不同，所以分仓维护：Linux 版走 Docker + headless 协议端，本仓走**真实 QQ 客户端注入**。

## 为什么会有 Windows 版

Linux 上换过三种协议端，全部死在腾讯同一句「你的账号当前登录已失效」：

| 协议端 | 形态 | 云端存活时长 |
|---|---|---|
| NapCat（Shell 安装） | headless，注入 `xvfb-run` 下的 QQ | 6h03m / 1h04m / 1h12m / 27m |
| LLBot v8.3.2 `--headless` | 纯协议，不跑 QQ 客户端 | 1h37m |
| SnowLuma（本机，家宽 IP） | 注入真实 QQ 客户端 | 长期稳定 |

同一个号在小号家宽（本机 Windows + SnowLuma）上稳定，在阿里云 Linux 上反复被踢 → 判定是**机房 IP + Linux headless 形态**触发的服务端作废会话，与协议端选型无关。于是把云服务器换成 Windows Server 2022、装真实 QQ 客户端、跑 SnowLuma 注入。

NapCat 的反检测 bypass（`hook/window/module/process/container/js` 六项）实测也救不了：`/proc/<pid>/maps` 里 `napi2native` 出现 0 次说明过滤器生效了，但 utility 子进程（`--type=utility --sub-type=node.mojom.NodeService`）的 maps 里仍有 6 次，且 27 分钟后照样被踢。

## 架构

```
QQ 客户端 (session 3, 隔离 user-data-dir)
        │  SnowLuma 注入式 hook
SnowLuma :5099 (WebUI)  :3000 (OneBot HTTP)  :3001 (OneBot WS)
        │  ws://127.0.0.1:6199/ws  (Bearer token)
AstrBot 4.29.1  :6185 (WebUI，只绑 127.0.0.1)
        └─ 7 个插件 + astrbot_plugin_modsearch（网页搜索走 keyless）
```

- **协议端**：SnowLuma **必须注入真实 QQ 客户端**，headless 不可用。登录后账号信息在 `config/onebot_<uin>.json`（`mode: "snapshot"`）。
- **AstrBot**：`platform` 用 `aiocqhttp`，`ws_reverse_host: 127.0.0.1`、`ws_reverse_port: 6199`。注意 SnowLuma 是**反向连到 AstrBot**，所以 AstrBot 是 WS 服务端。
- **隔离实例**：watchdog 用 `--user-data-dir=%LOCALAPPDATA%\QQ-SnowLuma` 起第二份 QQ，避免和桌面主 QQ 抢号。

## 部署步骤

### 1. 基础环境（C 盘，没有 D 盘）

```powershell
# Python 3.12（AstrBot 4.29.1 需要 >=3.10）
curl.exe -L --silent --show-error -o $env:TEMP\py.exe `
  https://mirrors.aliyun.com/python-release/windows/python-3.12.10-amd64.exe
Start-Process -Wait -FilePath $env:TEMP\py.exe `
  -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_launcher=1 Include_pip=1 Shortcuts=0'

# pip 走阿里云镜像（机房访问 pypi 官方约 145 KB/s）
# %APPDATA%\pip\pip.ini:
#   [global]
#   index-url = https://mirrors.aliyun.com/pypi/simple/
#   trusted-host = mirrors.aliyun.com
#   timeout = 60

python -m venv C:\Apps\astrbot-venv
C:\Apps\astrbot-venv\Scripts\pip install --no-cache-dir astrbot==4.29.1
```

**坑**：`(New-Object Net.WebClient).DownloadFile` 会「0.0 MB in 0.4s」然后文件消失，必须用 `curl.exe -L`。

### 2. AstrBot 根目录（最容易卡住的一步）

`astrbot run` 要求 **当前目录下存在 `.astrbot` 文件**，否则报
`C:\... is not a valid AstrBot root directory. Use 'astrbot init' to initialize`。

源码在 `astrbot/cli/utils/basic.py`：

```python
def check_astrbot_root(path):
    if not path.exists() or not path.is_dir(): return False
    if not (path / ".astrbot").exists(): return False
    return True

def get_astrbot_root():
    return Path.cwd()
```

于是：

```powershell
New-Item -ItemType Directory -Force C:\Apps\astrbot\data | Out-Null
New-Item -ItemType File -Force C:\Apps\astrbot\.astrbot | Out-Null   # 0 字节文件，不是目录
```

然后 `scripts/run-astrbot.cmd` 里 `cd /d C:\Apps\astrbot` 再启动即可。

### 3. 数据恢复

从备份包解开到 `C:\Apps\astrbot\data`（结构：`plugins/ config/ plugin_data/ data_v4.db cmd_config.json`）。
插件依赖在首次启动时由 AstrBot 自动 pip 安装（机房约 190 KB/s，7 个插件约 14 分钟）。

### 4. SnowLuma

把 `SnowLuma-v2.0.2-win-x64.zip` 解到 `C:\Apps\snowluma`，然后：

1. 用 `config-templates/` 里的模板覆盖 `config/` 下同名文件，**填回自己的 token / 密码**；
2. `scripts/watchdog.ps1` 顶部改 `$PW`（WebUI 密码）与 `$UIN`（机器人 QQ 号）；
3. `scripts/ecosystem.config.cjs`、`bridge.mjs` 里所有 `D:\Apps\snowluma` 要改成 `C:\Apps\snowluma`（本仓已改好，只保留 C 盘路径）。

### 5. 计划任务（没有 pm2）

```powershell
schtasks /Create /TN AstrBot /TR "C:\Apps\astrbot\run-astrbot.cmd" `
  /SC ONSTART /RU SYSTEM /RL HIGHEST /F

schtasks /Create /TN SnowLuma-Watchdog `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Apps\snowluma\watchdog.ps1" `
  /SC ONLOGON /RU Administrator /RP "<密码>" /IT /RL HIGHEST /F
```

- **`/IT`（Interactive Token）是必须的**：没有它，任务跑在 session 0，起不了带 GUI 的 QQ。
- `AstrBot` 用 SYSTEM 即可（纯命令行）；`SnowLuma-Watchdog` 必须是 `Administrator` + `/IT`。
- 自动登录：`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` 设
  `AutoAdminLogon=1`、`DefaultUserName`、`DefaultDomainName`、`DefaultPassword`，否则没人登录时 logon 触发器不会响。

### 6. 网页搜索（keyless，替掉付费搜索 API）

`plugins/astrbot_plugin_modsearch/` 是本仓自带的 AstrBot 插件，用 [modsearch](https://www.npmjs.com/package/@liustack/modsearch) 的 keyless 引擎（Firecrawl + Keenable）替代 `provider_settings.websearch_provider = "deepseek"`（那条路花的是同一个 DeepSeek key 的钱）。

```powershell
# 服务器没有全局 node/npm，借 SnowLuma 自带的 node.exe（v24.21.0，modsearch 要求 >=22.13）
# 在任意有 npm 的机器上装好后打包上传：
#   npm install --no-audit --no-fund --omit=dev --registry https://registry.npmmirror.com @liustack/modsearch
# 解到 C:\Apps\astrbot\data\tools\modsearch\
$env:HOME = "C:\Apps\astrbot\data\tools\modsearch"
& C:\Apps\snowluma\node.exe C:\Apps\astrbot\data\tools\modsearch\node_modules\@liustack\modsearch\dist\main.js doctor
```

插件注册两个 LLM 工具：`web_search_modsearch`、`modsearch_fetch_page`。然后把 `cmd_config.json` 的 `provider_settings.web_search` 设为 `false`（关掉内置付费搜索）。

## 实测结论（可直接抄的经验）

| 结论 | 依据 |
|---|---|
| GUI 省不了多少内存 | GUI 相关 20 进程共 268 MB；QQ 8 进程 621 MB 才是大头。杀 explorer + Shell UI 只回收 ~270 MB |
| Terminate 计划任务不会杀子进程 | `schtasks /End /TN AstrBot` 之后 python 还活着，必须额外 `Get-Process python \| Where Path -like '*astrbot-venv*' \| Stop-Process -Force` |
| 改 `companions.json` 必须在 AstrBot **停止**时改 | 运行时改会被内存副本覆盖回去（配置有缓存），正确顺序：End → kill python → 改文件 → Run |
| 文件编码两套规矩 | AstrBot 配置与插件配置是 **UTF-8 带 BOM**（`utf-8-sig` 读）；`companions.json` 等插件数据是 **UTF-8 无 BOM** |
| 面板别裸奔 | 默认 `dashboard.host = 0.0.0.0` 且 Server 2022 的防火墙三个 profile 可能全是 Disabled。改 `127.0.0.1` + 开防火墙（放行 22/3389）+ SSH 隧道 `ssh -L 16185:127.0.0.1:6185` |
| AstrBot 面板 127.0.0.1 不通是正常的 | AstrBot 校验 Host 头，本机请用 `http://localhost:6185/` |
| 启动耗时 70~100 秒 | 期间 6185/6199 都不通；SnowLuma 的 WS 客户端每 3 秒重试，顺序无关 |
| QQ 登录后 PID 会变 | 登录完成后腾讯会重启 QQ 进程，watchdog 早先注入的那个 PID 就失效了，要对新 PID 再 `POST /api/processes/<pid>/load` |

## 目录

```
scripts/            run-astrbot.cmd / watchdog.ps1 / start-all.bat / ecosystem.config.cjs / bridge.mjs …
config-templates/   所有配置模板（token 与密码已替换成 REPLACE_WITH_*，填自己的）
plugins/            astrbot_plugin_modsearch（自写，keyless 网页搜索）
```

## 脱敏说明

本仓所有 token / 密码 / jwt_secret / pbkdf2 哈希都已替换成 `REPLACE_WITH_*` 占位符。
**不要**把填好真值的配置文件再提交回来。

## 相关

- Linux 版（NapCat / LLBot + Docker）：[Hourz26/qqbot-toolkit](https://github.com/Hourz26/qqbot-toolkit)
- WorkBuddy 渠道校验补丁：[Hourz26/dsh-workbuddy-connect-patched](https://github.com/Hourz26/dsh-workbuddy-connect-patched)

## License

MIT
