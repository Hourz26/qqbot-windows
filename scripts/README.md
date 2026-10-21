# Windows 云服务器上的 QQ 机器人一键启动

在一台全新的 Windows Server 2022 上，从零把 SnowLuma + AstrBot 拉起来的脚本集。
本仓所有脚本都假定安装在 `C:\Apps`（服务器没有 D 盘）。

## 前提

| 组件 | 版本 | 位置 |
|---|---|---|
| Windows Server | 2022 Datacenter (build 20348) | — |
| Python | 3.12.10 | `C:\Program Files\Python312\` |
| AstrBot | 4.29.1 | `C:\Apps\astrbot-venv`（venv）/ `C:\Apps\astrbot`（根目录） |
| QQ | 9.9.x（NT） | `C:\Program Files\Tencent\QQNT\QQ.exe` |
| SnowLuma | 2.0.2 win-x64 | `C:\Apps\snowluma` |
| node | v24.21.0 | `C:\Apps\snowluma\node.exe`（借 SnowLuma 自带的） |

QQ 安装包在机房 IP 上会 `403 Forbidden`（`qqdl.gtimg.cn` 直接返回空 body），
实测从本机装好的 `C:\Program Files\Tencent\QQNT` 整个目录打包上传可行（排除 `*.zip`，约 450 MB）。

## 脚本说明

| 文件 | 作用 |
|---|---|
| `run-astrbot.cmd` | AstrBot 启动器。`cd /d C:\Apps\astrbot`（`.astrbot` 标记文件所在目录）后跑 `astrbot.exe run` |
| `watchdog.ps1` | 核心守护：确保隔离 QQ 在跑 → 确保 SnowLuma 在跑 → HTTP 健康闸门 → WebUI 登录拿 token → 检查进程列表里账号挂错就 unload → 对目标 uin 的进程 `POST /api/processes/<pid>/load` 注入 |
| `start-all.bat` | 手动一次性拉起 QQ + SnowLuma + AstrBot |
| `autostart.bat` | 供计划任务调用，隐藏窗口跑 watchdog |
| `ecosystem.config.cjs` | pm2 配置（**服务器上没装 pm2，仅作参考**；watchdog 会走 `Start-Process` fallback） |
| `bridge.mjs` | SnowLuma → DSH headless 的桥接，与本仓主链路无关，留作参考 |
| `dsh-shim.cmd` / `dsh-restart.ps1` | 同上，DSH 相关辅助 |

## 关键参数（用之前要改）

`watchdog.ps1` 顶部：

```powershell
$PW  = 'REPLACE_WITH_PASSWORD'   # SnowLuma WebUI admin 密码
$UIN = '3799652874'              # 机器人 QQ 号
```

`config-templates/onebot.template.json` 里三处 token：

- `httpServers[0].accessToken` — OneBot HTTP（3000）
- `wsServers[0].accessToken` — OneBot WS Server（3001）
- `wsClients[0].accessToken` — **连到 AstrBot 6199 的那个**，必须和 AstrBot `platform` 里的 `ws_reverse_token` 一致

## 计划任务

见 README「计划任务」一节。要点：

- `AstrBot`：`/SC ONSTART /RU SYSTEM /RL HIGHEST`
- `SnowLuma-Watchdog`：`/SC ONLOGON /RU Administrator /IT /RL HIGHEST`（`/IT` 不能少，否则 GUI 进程起在 session 0）
- 还需要 Winlogon 自动登录，否则无人登录时 logon 触发器不响

## watchdog 的两个坑

1. **`schtasks /End` 不杀子进程**：重启用 `schtasks /End /TN AstrBot` 之后 python 仍活着，会占着 6185，必须补一刀
   `Get-Process python | Where-Object { $_.Path -like '*astrbot-venv*' } | Stop-Process -Force`。
2. **QQ 登录完成后 PID 会变**：腾讯登录成功会重启 QQ 进程，watchdog 之前注入的 pid 失效，
   要对新 pid 再 `load` 一次（watchdog 循环会自己发现并重挂，但别指望它秒级恢复）。
