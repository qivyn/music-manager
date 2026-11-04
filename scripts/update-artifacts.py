#!/usr/bin/env python3
"""Inspect an already-built production app and write authenticated update metadata inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess


def inspect(app, package, public_key):
    with (app / "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    if info.get("CFBundleIdentifier") != "com.musicmanager.app" or info.get("MusicManagerStartupProtocol") != 1:
        raise ValueError("Not a production app with startup reporting")
    version = info["CFBundleShortVersionString"]
    archs = subprocess.run(["/usr/bin/lipo", "-archs", str(app / "Contents/MacOS/music-manager")], check=True, capture_output=True, text=True).stdout.strip()
    arch = {"arm64":"aarch64", "x86_64":"x64"}.get(archs)
    if arch is None or package.name != f"music-manager_{version}_{arch}.dmg":
        raise ValueError("Version or architecture does not match package")
    config = json.loads((Path(__file__).resolve().parents[1] / "src-tauri/tauri.conf.json").read_text())
    if config["plugins"]["updater"]["pubkey"].strip() != public_key.strip():
        raise ValueError("Next update key does not match current signing key")
    capabilities = json.loads(subprocess.run([str(app/"Contents/MacOS/music-manager"), "--installer-update-info"], check=True, capture_output=True, text=True).stdout)
    fingerprint = hashlib.sha256(public_key.strip().encode()).hexdigest()
    if capabilities.get("publicKeyFingerprint") != fingerprint or capabilities.get("installerProtocol") != 2 or capabilities.get("version") != version or capabilities.get("endpoint") != config["plugins"]["updater"]["endpoints"]:
        raise ValueError("The built application cannot verify its next update")
    trusted_file=Path(__file__).resolve().parents[1]/"src-tauri/updater-trusted-public-key.txt"
    trusted=trusted_file.read_text().strip() if trusted_file.exists() else public_key.strip()
    return {"nextPublicKey":public_key.strip() if trusted != public_key.strip() else None,"version":version, "arch":arch, "minimumSystemVersion":info.get("LSMinimumSystemVersion", "10.15"),
            "minimumClientVersion":"0.2.6", "installerProtocol":2, "startupProtocol":1,
            "schema":info["MusicManagerDatabaseSchema"], "packageSize":package.stat().st_size,
            "expandedSize":sum(p.stat().st_size for p in app.rglob("*") if p.is_file()),
            "sha256":hashlib.sha256(package.read_bytes()).hexdigest(),
            "publicKeyFingerprint":hashlib.sha256(public_key.strip().encode()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--package", required=True, type=Path)
    args = parser.parse_args()
    key = (Path(__file__).resolve().parents[1] / "src-tauri/updater-public-key.txt").read_text()
    metadata = inspect(args.app, args.package, key)
    Path(str(args.package) + ".metadata.json").write_text(json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n")
