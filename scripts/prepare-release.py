#!/usr/bin/env python3
"""Sign/verify a complete candidate, or reuse and reverify a saved candidate.

Used by both the PR rehearsal (temporary key) and main (release key).
Private keys are supplied only through the Tauri signer's environment.
"""
import sys
sys.dont_write_bytecode = True
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('update_manifest', ROOT/'scripts/create-update-manifest.py')
manifest = importlib.util.module_from_spec(spec); spec.loader.exec_module(manifest)


def prepare(version, directory, public_key, notes, target, run=subprocess.run):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Expected stable release version')
    payloads = [directory/f'music-manager_{version}_{arch}.dmg{suffix}'
                for arch in ('aarch64', 'x64') for suffix in ('', '.metadata.json')]
    allowed = {p.name for p in payloads} | {p.name+'.sig' for p in payloads} | {'latest.json', 'install-macos.sh'}
    for path in directory.iterdir():
        if path.name not in allowed or path.is_symlink() or not path.is_file():
            raise ValueError('Unexpected release candidate file: '+path.name)
    if any(not p.is_file() for p in payloads):
        raise ValueError('Both architectures and metadata are required')
    verifier = ['cargo', 'run', '--locked', '--release', '--manifest-path', str(ROOT/'src-tauri/Cargo.toml')]
    if target:
        verifier += ['--target', target]
    verifier += ['--example', 'verify-update', '--']
    for payload in payloads:
        signature = Path(str(payload)+'.sig')
        if not signature.exists():
            run(['cargo', 'tauri', 'signer', 'sign', str(payload)], check=True)
        run(verifier+[str(payload), str(signature), '--trusted-key', str(public_key)], check=True)
    manifest.write_manifest(version, directory, notes.read_text())
    installer = directory/'install-macos.sh'
    expected_installer = (ROOT/'scripts/install-macos.sh').read_bytes()
    if installer.exists() and installer.read_bytes() != expected_installer:
        raise ValueError('Saved installer entry does not match this commit')
    installer.write_bytes(expected_installer)


def saved_candidate_id(artifacts, sha):
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid commit')
    matches = [a for a in artifacts if a['name'] == f'release-candidate-{sha}' and not a.get('expired', True)]
    if len(matches) > 1:
        raise ValueError('Ambiguous saved release candidate')
    if not matches:
        return ''
    identifier = matches[0]['id']
    if not isinstance(identifier, int) or identifier <= 0:
        raise ValueError('Invalid candidate artifact ID')
    return str(identifier)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--find-saved', action='store_true')
    parser.add_argument('--version')
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--public-key', type=Path)
    parser.add_argument('--notes', type=Path)
    parser.add_argument('--target', default='')
    args = parser.parse_args()
    if args.find_saved:
        # Only this workflow run: never search PR or unrelated workflow artifacts.
        endpoint = f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}/artifacts"
        pages = json.loads(subprocess.run(['gh', 'api', '--paginate', '--slurp', endpoint], check=True, capture_output=True, text=True).stdout)
        artifacts = [a for page in pages for a in page['artifacts']]
        identifier = saved_candidate_id(artifacts, os.environ['GITHUB_SHA'])
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write(f'candidate_id={identifier}\n')
    else:
        if not all((args.version, args.directory, args.public_key, args.notes)):
            parser.error('version, directory, public-key and notes are required')
        prepare(args.version, args.directory, args.public_key, args.notes, args.target)
