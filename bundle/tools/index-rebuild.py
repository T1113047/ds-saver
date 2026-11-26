#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地索引三档位工具（草案，未上线）

用途：
  1. 从报告 front matter 生成 `00-锚点索引.md`（每份报告一行）；
  2. 刷新 `00-总索引.md` / `00-当前状态.md` 里的 AUTO 区块；
  3. 校验 facts_refs、断链、必知条数。

用法：
  python3 index-rebuild.py --root <ws>/本地索引 rebuild
  python3 index-rebuild.py --root <ws>/本地索引 add <报告.md>
  python3 index-rebuild.py --root <ws>/本地索引 check [--strict]
  python3 index-rebuild.py --root <ws>/本地索引 latest --n 10

依赖：Python 3.9+，仅标准库。
权限：建议 root 运行；生成文件 600，属主沿用当前用户。
"""

from __future__ import annotations

import argparse
import os
import re
import os
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote

_WORKSPACE = os.environ.get("DS_SAVER_WORKSPACE") or os.getcwd()
ROOT_DEFAULT = str(Path(_WORKSPACE) / "本地索引")
ANCHOR_NAME = "00-锚点索引.md"
BOOT_CARD_NAME = "00-AI启动卡.md"

# 这些目录不参与报告扫描（密钥、截图、工具、归档）
SKIP_PARTS = {"03-密钥", "07-历史截图", "99-工具", "archive", "node_modules", ".git"}
# 这些目录下的 .md 默认视为报告（即使文件名没有日期）
REPORT_DIR_MARKERS = {"02-报告", "01-审计", "02-审计"}
# 这些文件名不视为报告
EXCLUDE_NAMES = {
    "README.md",
    "00-当前状态.md",
    "00-说明.md",
    "00-总索引.md",
    "00-书写指南.md",
    ANCHOR_NAME,
}
# 自动区块会被脚本替换的文件（不存在或没有标记就跳过）
# 只有带 AUTO:latest 标记的文件会被刷新；不存在的路径自动跳过。
AUTO_FILES = [
    "00-总索引.md",
    "本机/00-当前状态.md",
    "本机/01-索引/项目资料索引.md",
    "本机/01-索引/目录索引-20261029.md",
]
AUTO_START = "<!-- AUTO:latest:start -->"
AUTO_END = "<!-- AUTO:latest:end -->"
AUTO_LIMIT = 10

VALID_TIERS = {"L1", "L2", "L3"}
# scope 默认不设白名单（任意非空字符串）；如需限制，用 DS_SAVER_SCOPES 逗号分隔
VALID_SCOPES = {x.strip() for x in os.environ.get("DS_SAVER_SCOPES", "").split(",") if x.strip()}


# ---------------------------------------------------------------------------
# 基础解析
# ---------------------------------------------------------------------------

def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def split_front_matter(text: str) -> tuple[dict, str]:
    """返回 (front_matter, 正文)。没有 front matter 时返回 ({}, 原文)。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, text

    data: dict[str, object] = {}
    key: str | None = None
    for raw in lines[1:end]:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_\-]+):\s*(.*)$", raw)
        if m:
            key = m.group(1)
            val = m.group(2).strip()
            if val == "":
                data[key] = []
            elif val.startswith("[") and val.endswith("]"):
                inner = val[1:-1].strip()
                data[key] = (
                    [unquote(x.strip()) for x in inner.split(",") if x.strip()]
                    if inner
                    else []
                )
            else:
                data[key] = unquote(val)
        elif raw.lstrip().startswith("- ") and key is not None:
            if not isinstance(data.get(key), list):
                data[key] = []
            data[key].append(unquote(raw.lstrip()[2:].strip()))  # type: ignore[union-attr]

    return data, "\n".join(lines[end + 1 :])


def as_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "是"}
    return default


def as_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(x) for x in value]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def normalize_date(value: str) -> str:
    """把 YYYY-MM-DD / YYYYMMDD / 带时间的日期统一成 YYYY-MM-DD。"""
    value = value.strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", value)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"^(\d{4})(\d{2})(\d{2})$", value)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    return value


def first_heading(body: str) -> str | None:
    for line in body.splitlines():
        m = re.match(r"^#\s+(.+?)\s*#*\s*$", line)
        if m:
            return m.group(1).strip()
    return None


def blockquote_date_time(body: str) -> tuple[str | None, str | None]:
    """从 `> 日期：2026-11-24 02:00 CST` / `> 生成时间：...` 里兜底取日期/时间。"""
    m = re.search(
        r"^>\s*(?:日期|生成时间|创建时间|更新时间)[：:]\s*"
        r"(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?",
        body,
        re.M,
    )
    if not m:
        return None, None
    return m.group(1), m.group(2)


def body_date_time(body: str) -> tuple[str | None, str | None]:
    """兜底日期：引用块 → 列表项 `- 日期：` → 首个含日期的一级标题。"""
    d, t = blockquote_date_time(body)
    if d:
        return d, t
    m = re.search(
        r"^[-*]\s*(?:日期|生成时间|创建时间|更新时间)[：:]\s*"
        r"(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?",
        body,
        re.M,
    )
    if m:
        return m.group(1), m.group(2)
    heading = first_heading(body) or ""
    m = re.search(r"(\d{4}-\d{2}-\d{2})", heading)
    if m:
        return m.group(1), None
    return None, None


# ---------------------------------------------------------------------------
# 报告模型
# ---------------------------------------------------------------------------

@dataclass
class Report:
    path: Path
    rel: str
    fm: dict
    body: str
    date: str = "0000-00-00"
    time: str = "00:00"
    scope: str = "根"
    rtype: str = "报告"
    status: str = "历史快照"
    tier: str = "L3"
    branch: str = ""
    title: str = ""
    facts_changed: bool = False
    facts_refs: list[str] = field(default_factory=list)

    @property
    def sort_key(self) -> tuple[str, str, str]:
        return (self.date, self.time, self.rel)


def infer_scope(rel: Path, fm: dict) -> str:
    scope = str(fm.get("scope", "")).strip()
    if scope in VALID_SCOPES:
        return scope
    if rel.parts and rel.parts[0] in VALID_SCOPES:
        return rel.parts[0]
    return "根"


def infer_type(rel: Path, fm: dict) -> str:
    rtype = str(fm.get("type", "")).strip()
    if rtype:
        return rtype
    parts = set(rel.parts)
    if "交接与实施" in parts:
        return "实施"
    if "01-审计" in parts or "02-审计" in parts or "审计报告" in parts:
        return "审计"
    return "报告"


def infer_branch(rel: Path, fm: dict, scope: str) -> str:
    branch = str(fm.get("branch", "")).strip()
    if branch:
        return branch
    parent = rel.parent.as_posix()
    if parent in {".", ""}:
        return scope
    return parent


def infer_date(rel: Path, fm: dict, body: str) -> tuple[str, str]:
    raw = str(fm.get("date", "")).strip()
    if raw:
        date = normalize_date(raw)
    else:
        name = rel.name
        m = re.match(r"^(\d{4}-\d{2}-\d{2})", name)
        if m:
            date = m.group(1)
        else:
            # 20261029 / 交接-示例-20261027-最终.md
            m = re.search(r"-(\d{8})(?:-|\.md$)", name)
            if m:
                date = normalize_date(m.group(1))
            else:
                # PROJECT_REPORT_2026-11-08-16.md
                m = re.search(r"(\d{4}-\d{2}-\d{2})", name)
                if m:
                    date = m.group(1)
                else:
                    d, _ = body_date_time(body)
                    date = d or "0000-00-00"

    time = str(fm.get("time", "")).strip()
    if not time:
        _, t = body_date_time(body)
        time = t or "00:00"
    return date, time


def is_report(rel: Path, text: str, fm: dict) -> bool:
    name = rel.name
    if name in EXCLUDE_NAMES or name.startswith("00-"):
        return False
    if any(part in SKIP_PARTS for part in rel.parts):
        return False
    if fm.get("tier"):
        return True
    if any(part in REPORT_DIR_MARKERS for part in rel.parts):
        return True
    if re.match(r"^\d{4}-\d{2}-\d{2}-", name):
        return True
    if re.search(r"-\d{8}\.md$", name):
        return True
    return False


def load_report(root: Path, path: Path) -> Report | None:
    rel = path.relative_to(root)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return None
    fm, body = split_front_matter(text)
    if not is_report(rel, text, fm):
        return None

    scope = infer_scope(rel, fm)
    date, time = infer_date(rel, fm, body)
    title = str(fm.get("title", "")).strip() or first_heading(body) or path.stem
    tier = str(fm.get("tier", "L3")).strip().upper()
    if tier not in VALID_TIERS:
        tier = "L3"
    return Report(
        path=path,
        rel=rel.as_posix(),
        fm=fm,
        body=body,
        date=date,
        time=time,
        scope=scope,
        rtype=infer_type(rel, fm),
        status=str(fm.get("status", "历史快照")).strip() or "历史快照",
        tier=tier,
        branch=infer_branch(rel, fm, scope),
        title=title,
        facts_changed=as_bool(fm.get("facts_changed"), default=False),
        facts_refs=as_list(fm.get("facts_refs")),
    )


def collect_reports(root: Path) -> list[Report]:
    reports: list[Report] = []
    for path in root.rglob("*.md"):
        rel = path.relative_to(root)
        if any(part in SKIP_PARTS for part in rel.parts):
            continue
        report = load_report(root, path)
        if report:
            reports.append(report)
    reports.sort(key=lambda r: r.sort_key, reverse=True)
    return reports


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def heading_exists(root: Path, ref: str) -> tuple[bool, str]:
    """校验 facts_refs 的 `路径#标题`。支持 `#标题::行标签`。"""
    if "#" not in ref:
        return False, "缺少 #标题"
    raw_path, heading = ref.split("#", 1)
    heading = heading.split("::", 1)[0].strip()
    if not raw_path.strip():
        return False, "缺少路径"
    target = (root / unquote(raw_path.strip())).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return False, "路径越出索引根目录"
    if not target.exists():
        return False, f"文件不存在：{raw_path}"
    try:
        lines = target.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return False, "文件不是 UTF-8"
    wanted = heading.strip()
    for line in lines:
        m = re.match(r"^#{1,6}\s+(.+?)\s*#*\s*$", line)
        if m and m.group(1).strip() == wanted:
            return True, ""
    return False, f"标题不存在：{raw_path}#{heading}"


def validate_report(
    root: Path, report: Report, warn_legacy: bool = True
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    label = report.rel

    if not report.fm and warn_legacy:
        warnings.append(f"{label}: 缺 front matter（旧报告按 L3 处理）")
    raw_tier = str(report.fm.get("tier", "")).strip().upper()
    if raw_tier and raw_tier not in VALID_TIERS:
        errors.append(f"{label}: tier 必须是 L1/L2/L3（当前 {raw_tier}）")
    raw_scope = str(report.fm.get("scope", "")).strip()
    if raw_scope and VALID_SCOPES and raw_scope not in VALID_SCOPES:
        errors.append(f"{label}: scope 不在 DS_SAVER_SCOPES 白名单内（当前 {raw_scope}）")
    if report.tier == "L3" and report.facts_changed:
        errors.append(f"{label}: L3 不允许 facts_changed=true；有事实变化请用 L2")
    if report.fm and report.date == "0000-00-00":
        errors.append(f"{label}: date 无法识别")
    if report.facts_changed and not report.facts_refs:
        errors.append(f"{label}: facts_changed=true 但 facts_refs 为空")
    if not report.facts_changed and report.facts_refs:
        warnings.append(f"{label}: facts_changed=false 但填了 facts_refs")
    if report.tier in {"L1", "L2"} and not report.branch:
        errors.append(f"{label}: L1/L2 必须有 branch")

    for ref in report.facts_refs:
        ok, reason = heading_exists(root, ref)
        if not ok:
            errors.append(f"{label}: facts_refs 无效：{ref}（{reason}）")

    return errors, warnings


def check_links(root: Path) -> tuple[list[str], list[str], str]:
    errors: list[str] = []
    warnings: list[str] = []
    link_re = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
    checked = 0
    for path in root.rglob("*.md"):
        rel = path.relative_to(root)
        if any(part in SKIP_PARTS for part in rel.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        # 代码块/行内代码里的链接示例不是真链接，扫描前剔除（避免误报）
        text = re.sub(r"```.*?```", "", text, flags=re.S)
        text = re.sub(r"`[^`\n]*`", "", text)
        for target in link_re.findall(text):
            target = target.strip()
            if not target or target.startswith(("#", "http://", "https://", "mailto:", "tel:")):
                continue
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            target = target.split(" ", 1)[0]  # 去掉 markdown title
            if "{" in target or "}" in target:
                continue
            target = unquote(target.split("#", 1)[0])
            if not target:
                continue
            candidate = Path(target) if target.startswith("/") else (path.parent / target)
            checked += 1
            if not candidate.exists():
                errors.append(f"{rel.as_posix()}: 断链 -> {target}")
    info = f"已检查 {checked} 个本地链接，断链 {len(errors)} 个"
    return errors, warnings, info


def must_know_count(root: Path) -> int:
    path = root / "00-总索引.md"
    if not path.exists():
        return 0
    text = path.read_text(encoding="utf-8")
    return len(re.findall(r"^>\s*\d+\.\s", text, re.M))


# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------

def esc(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def facts_label(report: Report) -> str:
    if report.facts_refs:
        labels = []
        for ref in report.facts_refs:
            if "#" in ref:
                labels.append(ref.split("#", 1)[1].split("::", 1)[0].strip())
        labels = [x for x in labels if x]
        if labels:
            return "/".join(dict.fromkeys(labels))
    return "待确认" if report.facts_changed else "无"


def anchor_table(reports: Iterable[Report], limit: int | None = None) -> list[str]:
    rows = [
        "| 日期 | 部分 | 类型 | 档位 | 位置（分支） | 报告 | 事实影响 |",
        "|---|---|---|---|---|---|---|",
    ]
    for report in list(reports)[: limit or None]:
        link = f"[{esc(report.title)}]({report.rel})"
        rows.append(
            "| {date} | {scope} | {rtype} | {tier} | {branch} | {link} | {facts} |".format(
                date=report.date,
                scope=esc(report.scope),
                rtype=esc(report.rtype),
                tier=report.tier,
                branch=esc(report.branch),
                link=link,
                facts=esc(facts_label(report)),
            )
        )
    return rows


def build_anchor_text(reports: list[Report]) -> str:
    lines = [
        "# 本地索引 · 锚点索引（自动生成，勿手改）",
        "",
        "> 用途：每份报告/审计/实施记录一行，作为“树状图上游的位置标记”。",
        f"> 生成：`python3 {ROOT_DEFAULT}/99-工具/index-rebuild.py rebuild`",
        f"> 新增：`python3 {ROOT_DEFAULT}/99-工具/index-rebuild.py add <报告绝对路径>`",
        "> 边界：对象=带 front matter 或日期命名的报告；时间=front matter `date/time`；口径=一行一份，日期倒序；不包含=报告正文、密钥、说明页；权威源=报告 + 各 `00-当前状态.md`。",
        "> 规则：本文件由脚本整体重建；不要手工插入、改序或改摘要。人工只改报告 front matter，然后重跑脚本。",
        "",
        "---",
        "",
        "## 最近 10 条",
        "",
    ]
    lines.extend(anchor_table(reports, AUTO_LIMIT))
    lines.extend(
        [
            "",
            "---",
            "",
            "## 全部记录",
            "",
        ]
    )
    lines.extend(anchor_table(reports))
    lines.append("")
    return "\n".join(lines)


def build_latest_table(reports: list[Report], from_dir: Path, limit: int = AUTO_LIMIT) -> list[str]:
    rows = [
        "| 日期 | 档位 | 报告 |",
        "|---|---|---|",
    ]
    for report in reports[:limit]:
        target = os.path.relpath(report.path.resolve(), from_dir.resolve())
        rows.append(
            f"| {report.date} | {report.tier} | [{esc(report.title)}]({Path(target).as_posix()}) |"
        )
    return rows


def extract_must_know(root: Path) -> list[str]:
    """从 00-总索引.md 提取「当前必须知道」引用块（逐字，源头唯一）。"""
    path = root / "00-总索引.md"
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    started = False
    for line in lines:
        if not started:
            if line.startswith(">") and "当前必须知道" in line:
                started = True
                out.append(line)
            continue
        if line.startswith(">"):
            out.append(line)
        else:
            break
    # 最多 7 条编号项
    header = [l for l in out if not re.match(r"^>\s*\d+\.", l)]
    items = [l for l in out if re.match(r"^>\s*\d+\.", l)]
    return header[:1] + items[:7] + header[1:]


def build_boot_card(root: Path, reports: list[Report]) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    must = extract_must_know(root)
    lines = [
        "# AI 启动卡（自动生成，勿手改）",
        "",
        f"> 生成：`python3 {ROOT_DEFAULT}/99-工具/index-rebuild.py rebuild`；时间：{now} CST",
        "> 用途：**先判档（S0–S3，见工作区 `AGENTS.md`）；S1 起读本页 + 对应现状页「S1 快读」块，S0 不读本页。**",
        "> 边界：本页只放入口与“必须知道”，不复制现状页数字；“必须知道”逐字取自 `00-总索引.md`，归档时自动刷新，冲突以总索引与实测为准。",
        "",
        "## 0. 必须知道（≤7 条，源头：00-总索引.md）",
        "",
    ]
    if must:
        lines.extend(must)
    else:
        lines.append("> （未从 00-总索引.md 提取到“当前必须知道”，请检查）")
    lines.extend(
        [
            "",
            "## 1. 现状页入口（先读对应一台机）",
            "",
            "| 部分 | 现状页 |",
            "|---|---|",
            "| 本机 | [本机/00-当前状态.md](本机/00-当前状态.md) |",
            "| 远端 / 其他环境 | 对应目录下的 `00-当前状态.md`（按你的结构补充） |",
            "",
            "> S1 只读该页顶部「S1 快读」块；S2/S3 读全文。",
            "",
            "## 2. 最近 10 条（全量见 00-锚点索引.md）",
            "",
            "| 日期 | 档位 | 位置 | 报告 |",
            "|---|---|---|---|",
        ]
    )
    for report in reports[:10]:
        lines.append(
            f"| {report.date} | {report.tier} | {esc(report.branch)} | [{esc(report.title)}]({report.rel}) |"
        )
    lines.extend(
        [
            "",
            "## 3. 按档位检索（S0 不检索）",
            "",
            "| 档 | 读什么 |",
            "|---|---|",
            "| S0 咨询/小改 | 不读本页以下内容；需要历史时只 `grep` 精确词 |",
            "| S1 本机改动 | 本页 + 对应现状页「S1 快读」块；历史用 `latest --n 10` 或 `grep` |",
            "| S2 生产/运维/数据/权限 | 本页 + 对应现状页全文 + `目录指引.md` 相关节 + 锚点索引按日期/档位过滤 |",
            "| S3 跨机/安全/事故 | S2 + 对应机器现状页 + 应急入口 |",
            "",
            "- 当前事实只认 `00-当前状态.md`；`search_semantic` 只查报告（S0 不用，S1 仅在不知道关键词时用），禁止回答“现在是什么”。",
            "- 跨机索引只是快照，以源头实测为准；先复核再下结论。",
            "",
            "## 4. 归档纪律",
            "",
            "- 任务完成**必问档位**：L1 全量合并 / L2 上游挂点 / L3 仅下游报告 / D 不归档。",
            "- 有当前事实变化最低 L2；安全/数据/生产/备份/权限/公网入口变化 → L1。",
            f"- 归档命令：`python3 {ROOT_DEFAULT}/99-工具/index-rebuild.py add <报告路径>`，再 `check`。",
            "- 规则全文：[00-书写指南.md](00-书写指南.md)。",
            "",
            "## 5. 禁止",
            "",
            "- 禁止把密钥明文贴进聊天/报告/Git；密钥只放在权限 600 的配置目录。",
            "- 禁止把密钥目录、含敏感信息的安全报告、含真实 IP/日志原文的内容送外部 API。",
            "- 禁止执行历史报告里的命令而不核对现状。",
            "",
        ]
    )
    return "\n".join(lines)


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = 0o600
    if path.exists():
        mode = path.stat().st_mode & 0o777
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def update_auto_blocks(root: Path, reports: list[Report]) -> tuple[list[str], list[str]]:
    changed: list[str] = []
    found: list[str] = []
    for rel in AUTO_FILES:
        path = root / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        start = text.find(AUTO_START)
        end = text.find(AUTO_END)
        if start == -1 or end == -1 or end < start:
            continue
        found.append(rel)
        table = "\n".join(build_latest_table(reports, path.parent))
        new_text = text[: start + len(AUTO_START)] + "\n" + table + "\n" + text[end:]
        if new_text != text:
            write_atomic(path, new_text)
            changed.append(rel)
    return changed, found


def check_auto_blocks(root: Path, reports: list[Report]) -> tuple[list[str], list[str]]:
    """校验 AUTO:latest 区块与当前报告集一致（不一致由 rebuild 修复）。"""
    errors: list[str] = []
    found: list[str] = []
    for rel in AUTO_FILES:
        path = root / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        start = text.find(AUTO_START)
        end = text.find(AUTO_END)
        if start == -1 or end == -1 or end < start:
            continue
        found.append(rel)
        table = "\n".join(build_latest_table(reports, path.parent))
        actual = text[start + len(AUTO_START) : end]
        if actual != "\n" + table + "\n":
            errors.append(f"{rel}: AUTO 区块不是最新，请运行 rebuild")
    return errors, found


# ---------------------------------------------------------------------------
# 命令
# ---------------------------------------------------------------------------

def cmd_rebuild(root: Path) -> int:
    reports = collect_reports(root)
    anchor = root / ANCHOR_NAME
    write_atomic(anchor, build_anchor_text(reports))
    boot = root / BOOT_CARD_NAME
    write_atomic(boot, build_boot_card(root, reports))
    changed, found = update_auto_blocks(root, reports)
    print(f"锚点索引：{len(reports)} 条 -> {anchor}")
    print(f"启动卡  ：-> {boot}")
    if changed:
        print("已刷新 AUTO 区块：" + "、".join(changed))
    elif found:
        print("AUTO 区块已是最新：" + "、".join(found))
    else:
        print("没有找到 AUTO 区块（未加标记或文件不存在），已跳过。")
    return 0


def cmd_add(root: Path, report_path: str) -> int:
    path = Path(report_path)
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        print(f"错误：报告不在索引根目录下：{path}", file=sys.stderr)
        return 2
    if not path.exists():
        print(f"错误：文件不存在：{path}", file=sys.stderr)
        return 2
    report = load_report(root, path)
    if not report:
        print(f"错误：不是可识别的报告（缺 front matter 或文件名）：{path}", file=sys.stderr)
        return 2
    errors, warnings = validate_report(root, report)
    for warning in warnings:
        print(f"警告：{warning}")
    if errors:
        for error in errors:
            print(f"错误：{error}", file=sys.stderr)
        return 1
    others: list[str] = []
    for other in collect_reports(root):
        if other.path == report.path:
            continue
        other_errors, _ = validate_report(root, other, warn_legacy=False)
        others.extend(other_errors)
    if others:
        print(
            f"提示：索引树中另有 {len(others)} 个校验错误（未阻止本次 add），请运行 check 查看。",
            file=sys.stderr,
        )
    return cmd_rebuild(root)


def cmd_check(root: Path, strict: bool) -> int:
    reports = collect_reports(root)
    errors: list[str] = []
    warnings: list[str] = []
    legacy = 0
    for report in reports:
        if not report.fm:
            legacy += 1
        e, w = validate_report(root, report, warn_legacy=False)
        errors.extend(e)
        warnings.extend(w)
    if legacy:
        warnings.append(f"旧报告缺 front matter：{legacy} 份（按 L3 处理，不逐条列出）")

    e, w, link_info = check_links(root)
    errors.extend(e)
    warnings.extend(w)

    auto_errors, _auto_files = check_auto_blocks(root, reports)
    errors.extend(auto_errors)

    count = must_know_count(root)
    if count > 7:
        errors.append(f"00-总索引.md：当前必须知道 {count} 条，超过 7 条上限")

    anchor = root / ANCHOR_NAME
    if anchor.exists():
        expected = build_anchor_text(reports)
        if anchor.read_text(encoding="utf-8") != expected:
            warnings.append("00-锚点索引.md 不是最新，请运行 rebuild")
    else:
        warnings.append("00-锚点索引.md 不存在，请运行 rebuild")

    boot = root / BOOT_CARD_NAME
    if boot.exists():
        expected_boot = build_boot_card(root, reports)
        actual_boot = boot.read_text(encoding="utf-8")
        # 启动卡含生成时间戳，比较时忽略该行
        strip = lambda s: re.sub(r"^> 生成：.*$", "", s, flags=re.M)
        if strip(actual_boot) != strip(expected_boot):
            warnings.append("00-AI启动卡.md 不是最新，请运行 rebuild")
    else:
        warnings.append("00-AI启动卡.md 不存在，请运行 rebuild")

    print(f"报告：{len(reports)} 份；错误：{len(errors)}；警告：{len(warnings)}")
    print(f"链接：{link_info}")
    for error in errors:
        print(f"错误：{error}", file=sys.stderr)
    for warning in warnings:
        print(f"警告：{warning}")
    if errors:
        return 1
    if strict and warnings:
        return 1
    return 0


def cmd_latest(root: Path, n: int) -> int:
    reports = collect_reports(root)
    print("\n".join(anchor_table(reports, n)))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="本地索引三档位工具（草案）")
    parser.add_argument(
        "--root",
        default=os.environ.get("LOCAL_INDEX_ROOT", ROOT_DEFAULT),
        help=f"本地索引根目录，默认 {ROOT_DEFAULT}",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("rebuild", help="全量重建锚点索引与 AUTO 区块")

    p_add = sub.add_parser("add", help="新增/更新一份报告的锚点")
    p_add.add_argument("report", help="报告路径（绝对或相对当前目录）")

    p_check = sub.add_parser("check", help="校验 front matter、facts_refs、断链、必知条数")
    p_check.add_argument("--strict", action="store_true", help="警告也按失败处理")

    p_latest = sub.add_parser("latest", help="打印最近 N 条")
    p_latest.add_argument("--n", type=int, default=10)

    args = parser.parse_args(argv)
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"错误：根目录不存在：{root}", file=sys.stderr)
        return 2

    if args.command == "rebuild":
        return cmd_rebuild(root)
    if args.command == "add":
        return cmd_add(root, args.report)
    if args.command == "check":
        return cmd_check(root, args.strict)
    if args.command == "latest":
        return cmd_latest(root, max(1, args.n))
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        # 被 head/less 提前关闭管道时静默退出
        os._exit(0)
