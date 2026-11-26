#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""脱敏镜像同步（草案，未上线）

把原始本地索引复制到脱敏镜像，供 OpenCodeRAG 送官方 embedding API。
原文不动；取证/密钥/事实页排除；IP/账号/密钥等掩码；同步后强制扫描。

用法：
  python3 rag-emb-sync.py --src <ws>/本地索引 --dst <ws>/.rag-sanitized/本地索引
  python3 rag-emb-sync.py --check --dst <ws>/.rag-sanitized/本地索引
  python3 rag-emb-sync.py --check-sync   # 源/镜像内容一致性（不写入）
"""
from __future__ import annotations

import argparse
import fnmatch
import os
import re
import shutil
import sys
from pathlib import Path

_WS = Path(os.environ.get("DS_SAVER_WORKSPACE") or Path.cwd())
SRC_DEFAULT = str(_WS / "本地索引")
DST_DEFAULT = str(_WS / ".rag-sanitized" / "本地索引")

# 整目录排除（密钥、截图、工具、归档、依赖）
# 额外目录用 DS_SAVER_EXCLUDE_DIRS 逗号分隔追加
EXCLUDE_DIRS = {
    "03-密钥", "07-历史截图", "99-工具", "archive", "rag_db",
    "node_modules", ".git", ".opencode",
} | {x.strip() for x in os.environ.get("DS_SAVER_EXCLUDE_DIRS", "").split(",") if x.strip()}
# 文件名排除（事实页/索引页，L0/L1 直接读，不进向量）
EXCLUDE_FILE_PATTERNS = ["00-*.md", "目录指引.md", "README.md"]
# 整份文件排除（安全评估/攻击分析类默认按文件名排除；额外路径用 DS_SAVER_EXCLUDE_PATHS）
EXCLUDE_PATHS = {
    x.strip() for x in os.environ.get("DS_SAVER_EXCLUDE_PATHS", "").split(",") if x.strip()
}
EXCLUDE_FILE_PATTERNS = [
    "00-*.md", "目录指引.md", "README.md",
    "*安全评估*.md", "*攻击*.md", "*爆破*.md", "*IOC*.md", "*取证*.md",
]
# 只同步 Markdown
INCLUDE_EXT = {".md"}

# 已知账号/显示名（仅用于镜像脱敏；按需用环境变量扩充，不要提交真实账号）
KNOWN_USERS = [x.strip() for x in os.environ.get("DS_SAVER_KNOWN_USERS", "").split(",") if x.strip()]
KNOWN_DISPLAY = [x.strip() for x in os.environ.get("DS_SAVER_KNOWN_DISPLAY", "").split(",") if x.strip()]
# 内部主机（公开域名 dusktyh.cn 保留）
INTERNAL_HOSTS = {
    "nbb.rainplay.cn": "[B-HOST]",
    "cn-nb2.rains3.com": "[S3-ENDPOINT]",
}

# 掩码规则（line-preserving：不增删行）
REDACTIONS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[IP]"),
    # 保守 IPv6：只匹配完整 8 组或含 :: 的压缩格式，避免误伤 HH:MM:SS
    (re.compile(r"\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b"), "[IP6]"),
    (re.compile(r"\b[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*::(?:[0-9A-Fa-f]{1,4}:)*[0-9A-Fa-f]{1,4}\b"), "[IP6]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[EMAIL]"),
    (re.compile(r"SHA256:[A-Za-z0-9+/=]{16,}"), "[KEY-FP]"),
    (re.compile(r"ssh-(?:ed25519|rsa|dss)\s+[A-Za-z0-9+/=]+"), "[SSH-KEY]"),
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"), "[SECRET]"),
    (re.compile(r"Bearer\s+[A-Za-z0-9._\-]+"), "Bearer [SECRET]"),
    (re.compile(r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^\s`]+"), r"\1=[SECRET]"),
    (re.compile(r"\b1[3-9]\d{9}\b"), "[PHONE]"),
    (re.compile(r"\b\d{17}[\dXx]\b"), "[ID]"),
]

# 校验扫描：镜像里若仍命中这些，视为脱敏失败
CHECK_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("IPv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("sk-token", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("SSH指纹", re.compile(r"SHA256:[A-Za-z0-9+/=]{16,}")),
    ("SSH公钥", re.compile(r"ssh-(?:ed25519|rsa|dss)\s+[A-Za-z0-9+/=]{20,}")),
    ("私钥", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("邮箱", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
]


def is_excluded(rel: Path) -> bool:
    if rel.as_posix() in EXCLUDE_PATHS:
        return True
    if any(part in EXCLUDE_DIRS for part in rel.parts):
        return True
    if rel.suffix.lower() not in INCLUDE_EXT:
        return True
    if any(fnmatch.fnmatch(rel.name, pat) for pat in EXCLUDE_FILE_PATTERNS):
        return True
    return False


def redact(text: str) -> str:
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    for host, repl in INTERNAL_HOSTS.items():
        text = text.replace(host, repl)
    for user in KNOWN_USERS:
        text = re.sub(re.escape(user), "[USER]", text)
    for name in KNOWN_DISPLAY:
        text = text.replace(name, "[DISPLAY]")
    return text


def sync(src: Path, dst: Path) -> int:
    if not src.is_dir():
        print(f"错误：源目录不存在 {src}", file=sys.stderr)
        return 2
    dst.mkdir(parents=True, exist_ok=True)
    os.chmod(dst, 0o700)

    written: set[str] = set()
    count = 0
    for path in src.rglob("*.md"):
        rel = path.relative_to(src)
        if is_excluded(rel):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        out = dst / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(redact(text), encoding="utf-8")
        os.chmod(out, 0o600)
        written.add(rel.as_posix())
        count += 1

    # 清理镜像中已不在源里的 stale 文件
    removed = 0
    for path in list(dst.rglob("*.md")):
        rel = path.relative_to(dst).as_posix()
        if rel not in written:
            path.unlink()
            removed += 1
    # 清理被排除目录（若历史残留）
    for d in list(dst.rglob("*")):
        if d.is_dir() and d.name in EXCLUDE_DIRS:
            shutil.rmtree(d, ignore_errors=True)

    # 统一收紧镜像权限（目录 700 / 文件 600）
    for d in dst.rglob("*"):
        if d.is_dir():
            os.chmod(d, 0o700)
    for p in dst.rglob("*.md"):
        os.chmod(p, 0o600)
    os.chmod(dst, 0o700)

    print(f"同步：{count} 份脱敏报告 -> {dst}；清理 stale {removed} 份")
    return check(dst)


def check(dst: Path) -> int:
    if not dst.is_dir():
        print(f"错误：镜像目录不存在 {dst}", file=sys.stderr)
        return 2
    violations: list[str] = []
    files = 0
    for path in dst.rglob("*.md"):
        rel = path.relative_to(dst)
        if rel.as_posix() in EXCLUDE_PATHS:
            violations.append(f"{rel}: 含被排除的敏感报告")
            continue
        if any(part in EXCLUDE_DIRS for part in rel.parts):
            violations.append(f"{rel}: 含被排除目录")
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        files += 1
        for label, pattern in CHECK_PATTERNS:
            for m in pattern.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                violations.append(f"{rel}:{line}: 残留 {label} -> {m.group(0)[:40]}")
        for user in KNOWN_USERS:
            if user in text:
                violations.append(f"{rel}: 残留已知账号 {user}")
    if violations:
        print(f"校验失败：{len(violations)} 处残留（扫描 {files} 份）", file=sys.stderr)
        for v in violations[:50]:
            print(f"  {v}", file=sys.stderr)
        return 1
    print(f"校验通过：{files} 份镜像未发现敏感残留")
    return 0


def check_sync(src: Path, dst: Path) -> int:
    """校验镜像是否与源一致（内容/缺失/多余/是否比源旧），不做写入。"""
    if not src.is_dir():
        print(f"错误：源目录不存在 {src}", file=sys.stderr)
        return 2
    if not dst.is_dir():
        print(f"错误：镜像目录不存在 {dst}", file=sys.stderr)
        return 2

    expected: set[str] = set()
    missing: list[str] = []
    drift: list[str] = []
    stale: list[str] = []
    for path in src.rglob("*.md"):
        rel = path.relative_to(src)
        if is_excluded(rel):
            continue
        expected.add(rel.as_posix())
        out = dst / rel
        if not out.exists():
            missing.append(rel.as_posix())
            continue
        try:
            source_text = path.read_text(encoding="utf-8")
            mirror_text = out.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            drift.append(f"{rel.as_posix()}（非 UTF-8）")
            continue
        if redact(source_text) != mirror_text:
            drift.append(rel.as_posix())
        if out.stat().st_mtime < path.stat().st_mtime - 1:
            stale.append(rel.as_posix())

    mirror = {p.relative_to(dst).as_posix() for p in dst.rglob("*.md")}
    extra = sorted(mirror - expected)

    problems = len(missing) + len(drift) + len(stale) + len(extra)
    if problems:
        print(
            f"镜像不同步：缺失 {len(missing)} / 内容漂移 {len(drift)} / "
            f"比源旧 {len(stale)} / 多余 {len(extra)}（应为 {len(expected)} 份，实际 {len(mirror)} 份）",
            file=sys.stderr,
        )
        for label, items in (("缺失", missing), ("漂移", drift), ("过期", stale), ("多余", extra)):
            for item in items[:10]:
                print(f"  {label}: {item}", file=sys.stderr)
        return 1
    print(f"镜像同步：{len(expected)} 份与源一致（无缺失/漂移/过期/多余）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="脱敏镜像同步（草案）")
    parser.add_argument("--src", default=SRC_DEFAULT)
    parser.add_argument("--dst", default=DST_DEFAULT)
    parser.add_argument("--check", action="store_true", help="只校验镜像残留，不同步")
    parser.add_argument("--check-sync", action="store_true", help="只校验镜像与源是否一致，不同步")
    args = parser.parse_args()
    src = Path(args.src).expanduser().resolve()
    dst = Path(args.dst).expanduser().resolve()
    if args.check_sync:
        return check_sync(src, dst)
    if args.check:
        return check(dst)
    return sync(src, dst)


if __name__ == "__main__":
    raise SystemExit(main())
