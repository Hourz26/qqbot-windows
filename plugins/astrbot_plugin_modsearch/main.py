"""astrbot_plugin_modsearch —— 用 modsearch（keyless 引擎）替代付费网页搜索。

设计要点
--------
* 只提供 LLM 工具，不拦截消息，不改 AstrBot 内核。
* modsearch 走 firecrawl / keenable 的 keyless 额度（Firecrawl 1000 credits/月，
  按 IP 每日计量；keenable 1000 次/小时共享），因此没有按次计费的搜索 API 成本。
* 工具调用是 `node <modsearch>/dist/main.js ... -o <tmp.json>`，把结构化 JSON
  收窄成紧凑的文本再交回模型，避免整页 markdown 灌进上下文。
* 结果条数与抓页字符数都由配置控制（默认 5 条 / 8000 字），这是省 token 的关键。

要让它取代内置搜索：把 `provider_settings.web_search` 设为 false，内置的
`web_search_deepseek` / `deepseek_fetch_web_page` 就不会再注册，模型只剩这里的两个工具。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import astrbot.api.star as star
from astrbot.api import FunctionTool, logger

DEFAULTS = {
    "modsearch_bin": r"C:\Apps\astrbot\data\tools\modsearch\node_modules\@liustack\modsearch\dist\main.js",
    "workdir": r"C:\Apps\astrbot\data\tools\modsearch",
    "node_bin": r"C:\Apps\snowluma\node.exe",
    "timeout_seconds": 90,
    "max_results": 5,
    "engine": "",
    "enable_fetch_tool": True,
    "fetch_max_chars": 8000,
}

# 工具实例由框架以 dataclass 方式构造，额外字段容易被校验拒掉，
# 因此配置放在模块级，由插件初始化时写入。
_CFG: dict = dict(DEFAULTS)

_RUN_LOCK = asyncio.Lock()


def _apply_config(config) -> dict:
    cfg = dict(DEFAULTS)
    for k in DEFAULTS:
        try:
            v = config.get(k) if hasattr(config, "get") else None
        except Exception:
            v = None
        if v is not None and v != "":
            cfg[k] = v
    return cfg


async def _run_modsearch(args: list[str], cfg: dict) -> tuple[int, dict | None, str]:
    """跑一次 modsearch，返回 (returncode, parsed_json, error_text)。"""
    bin_path = str(cfg["modsearch_bin"])
    workdir = str(cfg["workdir"])
    node_bin = str(cfg["node_bin"])
    timeout = max(10, int(cfg["timeout_seconds"]))

    if not Path(bin_path).is_file():
        return 127, None, f"modsearch 入口不存在: {bin_path}"

    fd, out_path = tempfile.mkstemp(prefix="ms_", suffix=".json")
    os.close(fd)
    env = dict(os.environ)
    # 让 modsearch 的 config / cooldown 落到数据卷里，重装插件后不丢。
    # Windows 上 modsearch 会读 USERPROFILE，同时兜底给 HOME。
    env["HOME"] = workdir
    env["USERPROFILE"] = workdir
    env.setdefault("NO_COLOR", "1")

    cmd = [node_bin, bin_path, *args, "-o", out_path]
    async with _RUN_LOCK:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workdir,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            with contextlib.suppress(Exception):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()
            with contextlib.suppress(Exception):
                os.unlink(out_path)
            return 124, None, f"modsearch 超时（{timeout}s）"

    data = None
    try:
        with open(out_path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:  # noqa: BLE001
        err_tail = (err or b"").decode("utf-8", "replace").strip().splitlines()[-3:]
        return proc.returncode or 1, None, f"读取结果失败: {exc} | " + " / ".join(err_tail)
    finally:
        with contextlib.suppress(Exception):
            os.unlink(out_path)

    return proc.returncode or 0, data, ""


def _render_search(data: dict, limit: int) -> str:
    results = data.get("results") or []
    if not isinstance(results, list) or not results:
        return "没有拿到搜索结果。"
    block = results[0] if isinstance(results[0], dict) else {}
    items = block.get("items") or []
    if not items:
        summary = block.get("summary") or ""
        return f"没有拿到搜索结果。{summary}".strip()

    engine = block.get("engine") or "unknown"
    lines = [f"搜索：{data.get('query') or ''}（引擎 {engine}）"]
    for i, it in enumerate(items[:limit], 1):
        title = (it.get("title") or "").strip() or "(无标题)"
        url = (it.get("url") or "").strip()
        snip = " ".join((it.get("snippet") or "").split())
        if len(snip) > 320:
            snip = snip[:320] + "…"
        lines.append(f"{i}. {title}\n   {url}\n   {snip}")
    return "\n".join(lines)


def _render_fetch(data: dict, limit: int) -> str:
    results = data.get("results") or []
    if not isinstance(results, list) or not results:
        return "没能抓到页面内容。"
    block = results[0] if isinstance(results[0], dict) else {}
    summary = (block.get("summary") or "").strip()
    content = block.get("content") or ""
    if not content:
        return f"没能抓到页面内容。{summary}".strip()
    if len(content) > limit:
        content = content[:limit] + f"\n…（已截断，原长 {len(content)} 字）"
    head = f"页面：{data.get('url') or ''}"
    if summary:
        head += f"\n摘要：{summary}"
    return f"{head}\n\n{content}"


@dataclass
class _SearchTool(FunctionTool):
    name: str = "web_search_modsearch"
    description: str = (
        "联网搜索网页。返回带序号、标题、URL 和摘要的结果列表。"
        "需要查资料、查最新消息、核对事实时用它。"
        "如果摘要不够，可以再用 modsearch_fetch_page 抓具体某一页。"
    )
    parameters: dict = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词或问题"},
                "count": {
                    "type": "integer",
                    "description": "返回几条结果，默认 5，最多 10",
                },
            },
            "required": ["query"],
        }
    )

    async def call(self, _ctx, **kwargs):  # type: ignore[override]
        query = str(kwargs.get("query") or "").strip()
        if not query:
            return "错误：请提供 query。"
        try:
            want = int(kwargs.get("count") or _CFG.get("max_results") or 5)
        except Exception:
            want = 5
        want = max(1, min(want, 10))

        args = ["search", "-q", query, "--max-results", str(want)]
        if _CFG.get("engine"):
            args += ["-e", str(_CFG["engine"])]
        rc, data, err = await _run_modsearch(args, _CFG)
        if data is None:
            return f"搜索失败（code={rc}）：{err}"
        return _render_search(data, want)


@dataclass
class _FetchTool(FunctionTool):
    name: str = "modsearch_fetch_page"
    description: str = (
        "抓取指定网址的正文内容（转为纯文本）。"
        "适合在 web_search_modsearch 拿到链接后，读某一页的具体内容。"
    )
    parameters: dict = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "要抓取的完整 http(s) 网址"},
                "focus": {
                    "type": "string",
                    "description": "可选：想在这一页里找什么，帮你聚焦",
                },
            },
            "required": ["url"],
        }
    )

    async def call(self, _ctx, **kwargs):  # type: ignore[override]
        url = str(kwargs.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            return "错误：url 必须是完整 http(s) 地址。"
        focus = str(kwargs.get("focus") or "").strip()

        args = ["search", "-u", url]
        if focus:
            args += ["-q", focus]
        rc, data, err = await _run_modsearch(args, _CFG)
        if data is None:
            return f"抓取失败（code={rc}）：{err}"
        limit = int(_CFG.get("fetch_max_chars") or 8000)
        return _render_fetch(data, limit)


class ModSearchPlugin(star.Star):
    def __init__(self, context, config=None) -> None:
        super().__init__(context, config)
        global _CFG
        _CFG = _apply_config(config)
        self._registered: list[str] = []

    async def initialize(self) -> None:
        add = getattr(self.context, "add_llm_tools", None)
        if not callable(add):
            logger.warning("[modsearch] context.add_llm_tools 不可用，工具未注册")
            return
        tools = [_SearchTool()]
        if _CFG.get("enable_fetch_tool"):
            tools.append(_FetchTool())
        add(*tools)
        self._registered = [t.name for t in tools]
        logger.info(f"[modsearch] 已注册工具: {', '.join(self._registered)}")
        if not Path(str(_CFG["modsearch_bin"])).is_file():
            logger.warning(
                f"[modsearch] 找不到 CLI：{_CFG['modsearch_bin']}，"
                "请先 npm install @liustack/modsearch"
            )
        if not Path(str(_CFG["node_bin"])).is_file():
            logger.warning(f"[modsearch] 找不到 node：{_CFG['node_bin']}")

    async def terminate(self) -> None:
        logger.info("[modsearch] plugin terminated")
