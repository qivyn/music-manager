#!/usr/bin/env python3
"""Decide whether CI builds and publishes this commit's version.

Usage: release-plan.py [--require-newer] [--root DIR]
Reads the version from Cargo.toml, Cargo.lock and tauri.conf.json, then asks GitHub
(through the gh CLI, using GITHUB_REPOSITORY and GITHUB_SHA) for published releases
and the existing v-tag. Writes version= and newer= to $GITHUB_OUTPUT when it is set.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib

STABLE = re.compile(r"\d+\.\d+\.\d+")


def read_version(root):
    rust = root / "src-tauri"
    cargo = tomllib.loads((rust / "Cargo.toml").read_text())["package"]["version"]
    packages = tomllib.loads((rust / "Cargo.lock").read_text())["package"]
    lock = next((p["version"] for p in packages if p["name"] == "music-manager"), None)
    tauri = json.loads((rust / "tauri.conf.json").read_text())["version"]
    if not cargo == lock == tauri:
        raise ValueError(f"版本不一致：Cargo.toml={cargo}, Cargo.lock={lock}, tauri.conf.json={tauri}")
    if not STABLE.fullmatch(cargo):
        raise ValueError(f"只发布稳定的 x.y.z 版本：{cargo}")
    return cargo


def parse(version):
    return tuple(int(part) for part in version.split("."))


def plan(version, releases, tag_commit, sha):
    """Return (newer, reason); raise when publishing would reuse a tag or draft it cannot trust."""
    tag = f"v{version}"
    for release in releases:
        if release["tag_name"] == tag:
            if release["draft"]:
                if release.get("target_commitish") != sha or f"<!-- music-manager-source:{sha} -->" not in release.get("body", ""):
                    raise ValueError(f"已有 {tag} 的草稿 Release，但无法确认来自本次提交")
                if tag_commit is not None and tag_commit != sha:
                    raise ValueError(f"标签 {tag} 不是本次测试的提交")
                return True, f"继续本次提交的 {tag} 草稿发布"
            return False, f"{tag} 已发布，不再构建或发布"
    # 按版本号比较，不按 GitHub 返回的时间顺序
    published = [parse(r["tag_name"][1:]) for r in releases
                 if not r["draft"] and not r["prerelease"] and re.fullmatch(r"v\d+\.\d+\.\d+", r["tag_name"])]
    latest = max(published, default=None)
    if latest is not None and parse(version) <= latest:
        return False, f"{tag} 不比已发布的 v{'.'.join(map(str, latest))} 新，不发布"
    if tag_commit is not None and tag_commit != sha:
        raise ValueError(f"标签 {tag} 指向 {tag_commit}，不是本次测试的提交 {sha}")
    return True, f"{tag} 比已发布版本新，需要构建"


def gh(*args):
    return subprocess.run(["gh", "api", *args], check=True, capture_output=True, text=True).stdout


def fetch_releases(repo):
    lines = gh("--paginate", f"repos/{repo}/releases", "--jq", ".[] | {tag_name, draft, prerelease, target_commitish, body}")
    return [json.loads(line) for line in lines.splitlines() if line.strip()]


def fetch_tag_commit(repo, tag):
    result = subprocess.run(["gh", "api", f"repos/{repo}/git/ref/tags/{tag}"], capture_output=True, text=True)
    if result.returncode != 0:
        if "HTTP 404" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    target = json.loads(result.stdout)["object"]
    # 附注标签需要逐层解引用到提交
    for _ in range(10):
        if target["type"] != "tag":
            break
        target = json.loads(gh(f"repos/{repo}/git/tags/{target['sha']}"))["object"]
    if target["type"] != "commit":
        raise ValueError(f"标签 {tag} 没有指向提交")
    return target["sha"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-newer", action="store_true")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    version = read_version(args.root)
    repo, sha = os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"]
    newer, reason = plan(version, fetch_releases(repo), fetch_tag_commit(repo, f"v{version}"), sha)
    print(reason)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"version={version}\nnewer={str(newer).lower()}\n")
    if args.require_newer and not newer:
        sys.exit(1)
