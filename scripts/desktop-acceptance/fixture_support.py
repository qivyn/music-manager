"""Ownership manifest for disposable acceptance artifacts; never infers production paths."""
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit


def validate_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port
            or parsed.netloc != f'127.0.0.1:{parsed.port}' or parsed.path not in ('', '/')
            or parsed.query or parsed.fragment):
        raise ValueError('Test origin must be http://127.0.0.1:<port>')
    return value.rstrip('/')


def manifest(root):
    root = root.resolve()
    if root.parent != Path('/private/tmp') or not root.name.startswith('music-manager-desktop-'):
        raise ValueError('Acceptance root must be isolated under /private/tmp')
    path = root / 'acceptance-run.json'
    if path.is_file():
        data = json.loads(path.read_text())
        if data.get('root') != str(root) or data.get('format') != 1:
            raise ValueError('Acceptance ownership manifest is invalid')
        return data
    existing = list(root.glob('source-*/fixture-manifest.json'))
    identifier = 'com.musicmanager.acceptance.' + hashlib.sha256(root.name.encode()).hexdigest()[:12]
    if existing:
        previous = json.loads(existing[0].read_text())
        if previous.get('root') != str(root):
            raise ValueError('Existing fixture belongs to another root')
        identifier = previous['identifier']
    data = {'format':1, 'root':str(root), 'identifier':identifier, 'artifacts':[]}
    path.write_text(json.dumps(data, indent=2))
    return data


def record(root, *paths):
    data = manifest(root)
    for path in paths:
        relative = str(path.relative_to(root))
        if path.is_symlink() or path.resolve() != root / relative or relative in ('', '.'):
            raise ValueError('Refusing unmanaged artifact')
        if relative not in data['artifacts']:
            data['artifacts'].append(relative)
    (root/'acceptance-run.json').write_text(json.dumps(data, indent=2))


def has_running_apps(root, commands):
    prefixes=(str(root),str(root).replace('/private/tmp/','/tmp/'))
    return any(line.strip().startswith(prefixes) and '.app/Contents/MacOS/' in line for line in commands.splitlines())
