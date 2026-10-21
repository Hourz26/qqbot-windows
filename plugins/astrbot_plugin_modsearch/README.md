# astrbot_plugin_modsearch

用 [modsearch](https://www.npmjs.com/package/@liustack/modsearch) 的 **keyless** 引擎给 AstrBot 提供网页搜索与整页抓取。

## 为什么

AstrBot 内置的 `websearch_provider = "deepseek"` 走 `POST https://api.deepseek.com/v1/tools/search`，
**花的是同一个 DeepSeek key 的额度**。modsearch 的默认引擎是 Firecrawl（keyless，1000 credits/月，按 IP 每日计量）
和 Keenable（keyless，1000 req/h），不花钱。

## 注册的工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `web_search_modsearch` | `query`（必填）、`count`（可选，默认取配置 `max_results`） | 编号的结果列表：标题 / URL / 摘要（每条截 320 字） |
| `modsearch_fetch_page` | `url`（必填）、`focus`（可选，聚焦问题） | 页面正文 markdown，截断到 `fetch_max_chars` |

两个工具都是 `FunctionTool` 子类，通过 `context.add_llm_tools()` 注册（同名会覆盖内置工具）。

## 配置项（`_conf_schema.json`）

| 键 | 默认值 | 说明 |
|---|---|---|
| `modsearch_bin` | `C:\Apps\astrbot\data\tools\modsearch\node_modules\@liustack\modsearch\dist\main.js` | modsearch 入口 JS |
| `workdir` | `C:\Apps\astrbot\data\tools\modsearch` | 工作目录，同时作为 `HOME`/`USERPROFILE`（让 `~/.modsearch` 落在持久卷里） |
| `node_bin` | `C:\Apps\snowluma\node.exe` | node 解释器（服务器没装全局 node，借 SnowLuma 自带的 v24.21.0） |
| `timeout_seconds` | 90 | **必须小于** AstrBot 的 `agent_runner.config.misc.tool_call_timeout`（默认 120） |
| `max_results` | 5 | 搜索结果条数 |
| `engine` | `""` | 空 = 用 modsearch 自动解析（firecrawl）。可填 `firecrawl` / `keenable` 等强制指定 |
| `enable_fetch_tool` | `true` | 是否注册 `modsearch_fetch_page` |
| `fetch_max_chars` | 8000 | 抓页正文最大字符数（越大越烧 token） |

## 安装

```powershell
# 1. 装 modsearch（在有 npm 的机器上，或直接用 registry.npmmirror.com）
npm install --no-audit --no-fund --omit=dev --registry https://registry.npmmirror.com @liustack/modsearch
# 2. 把 node_modules + package.json 解到 C:\Apps\astrbot\data\tools\modsearch\
# 3. 自检
$env:HOME = "C:\Apps\astrbot\data\tools\modsearch"
& C:\Apps\snowluma\node.exe C:\Apps\astrbot\data\tools\modsearch\node_modules\@liustack\modsearch\dist\main.js doctor
# 4. 把本插件解到 C:\Apps\astrbot\data\plugins\astrbot_plugin_modsearch\
# 5. 重启 AstrBot，日志里应出现：
#    plugin(...) added LLM tool: web_search_modsearch
#    plugin(...) added LLM tool: modsearch_fetch_page
```

最后把 `cmd_config.json` 的 `provider_settings.web_search` 设成 `false`，
内置的 `web_search_deepseek` / `deepseek_fetch_web_page` 就不再注册，搜索全量走本插件。

## 实现要点

- 配置走**模块级全局 `_CFG`**：`FunctionTool` 是 pydantic 模型，dataclass 上多塞字段会被校验拒掉。
- `_RUN_LOCK = asyncio.Lock()` 把子进程调用串行化，避免并发打爆 keyless 配额。
- 子进程用 `asyncio.create_subprocess_exec`，超时返回 `(124, None, "modsearch 超时（Ns）")`。
- 输出 JSON 结构：`{mode, query, url, results, meta}`，`results` 是 **list**，`results[0].items[*]` 才是条目。
- Windows 上 modsearch 读 `USERPROFILE` 而不是 `HOME`，两个都要设，否则 `~/.modsearch` 会跑到别处。
