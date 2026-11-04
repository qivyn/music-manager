#!/usr/bin/env python3
"""Upload a complete, verified draft; only then expose it as a release."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def publish(repo, sha, version, directory, notes, run=gh):
    tag = "v" + version
    marker = f"<!-- music-manager-source:{sha} -->"
    expected = {f"music-manager_{version}_{arch}.dmg" + suffix
                for arch in ("aarch64", "x64") for suffix in ("", ".sig", ".metadata.json", ".metadata.json.sig")}
    expected.update(("latest.json","install-macos.sh"))
    files = {p.name:p for p in directory.iterdir() if p.is_file()}
    if set(files) != expected:
        raise ValueError("Release assets are incomplete or contain unexpected files")
    pages = json.loads(run("api", "--paginate", "--slurp", f"repos/{repo}/releases?per_page=100"))
    releases = [release for page in pages for release in page] if pages and isinstance(pages[0], list) else pages
    matches = [r for r in releases if r["tag_name"] == tag]
    if matches:
        release = matches[0]
        if not release["draft"] or release.get("target_commitish") != sha or marker not in release.get("body", ""):
            raise ValueError("Refusing to alter a published or unrelated release")
    else:
        release = json.loads(run("api", "--method", "POST", f"repos/{repo}/releases",
                                 "-f", f"tag_name={tag}", "-f", f"target_commitish={sha}",
                                 "-f", f"name={tag}", "-f", f"body={marker}\n{notes}", "-F", "draft=true"))
    assets = json.loads(run("api", f"repos/{repo}/releases/{release['id']}/assets?per_page=100"))
    if any(a["name"] not in expected for a in assets):
        raise ValueError("Draft contains unrecognized assets")
    existing = {a["name"]:a for a in assets}
    for name, path in sorted(files.items()):
        if name not in existing:
            run("release", "upload", tag, str(path), "--repo", repo)
    assets = json.loads(run("api", f"repos/{repo}/releases/{release['id']}/assets?per_page=100"))
    if {a["name"] for a in assets} != expected or len(assets) != len(expected):
        raise ValueError("Remote asset list does not match the release")
    for asset in assets:
        path = files[asset["name"]]
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        if asset.get("size") != path.stat().st_size:
            raise ValueError("Remote asset size mismatch: " + path.name)
        if asset.get("digest"):
            if asset["digest"] != digest:
                raise ValueError("Remote asset digest mismatch: " + path.name)
        else:
            with tempfile.TemporaryDirectory(prefix="mm-release-verify-") as temporary:
                run("release", "download", tag, "--repo", repo, "--pattern", path.name, "--dir", temporary)
                if hashlib.sha256((Path(temporary)/path.name).read_bytes()).hexdigest() != digest[7:]:
                    raise ValueError("Downloaded asset digest mismatch: " + path.name)
    run("api", "--method", "PATCH", f"repos/{repo}/releases/{release['id']}", "-F", "draft=false", "-f", "make_latest=true")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--notes", required=True, type=Path)
    args = parser.parse_args()
    publish(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_SHA"], args.version,
            args.directory, args.notes.read_text().replace("{{version}}", args.version))
