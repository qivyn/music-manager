#!/usr/bin/env python3
"""Build the Tauri update feed only after both signed architectures are present."""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import re


def create_manifest(version, directory, notes):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected a stable x.y.z version")
    platforms = {}
    for arch, target in [("aarch64", "darwin-aarch64"), ("x64", "darwin-x86_64")]:
        name = f"music-manager_{version}_{arch}.dmg"
        artifact = directory / name
        if not artifact.is_file() or artifact.stat().st_size == 0:
            raise ValueError(f"Missing update package: {name}")
        signature = (directory / (name + ".sig")).read_text().strip()
        decoded = base64.b64decode(signature, validate=True).decode("utf-8")
        if not decoded.startswith("untrusted comment:") or "trusted comment:" not in decoded:
            raise ValueError(f"Invalid signature format: {name}")
        metadata_path = Path(str(artifact) + ".metadata.json")
        metadata = metadata_path.read_bytes()
        details = json.loads(metadata)
        if details.get("version") != version or details.get("arch") != arch or details.get("sha256") != hashlib.sha256(artifact.read_bytes()).hexdigest():
            raise ValueError(f"Compatibility metadata does not match package: {name}")
        metadata_signature = Path(str(metadata_path) + ".sig").read_text().strip()
        base64.b64decode(metadata_signature, validate=True)
        platforms[target] = {
            "url": f"https://github.com/AI-AQI/music-manager/releases/download/v{version}/{name}",
            "signature": signature,
            "compatibility": {"data": base64.b64encode(metadata).decode(), "signature": metadata_signature},
        }
    return {
        "version": version,
        "notes": notes.strip(),
        "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": platforms,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--notes", type=Path, required=True)
    args = parser.parse_args()
    manifest = create_manifest(args.version, args.directory, args.notes.read_text())
    output = args.directory / "latest.json"
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Created {output}")
