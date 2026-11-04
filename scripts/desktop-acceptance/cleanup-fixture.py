#!/usr/bin/env python3
"""Remove recorded App/DMG/source artifacts after acceptance, preserving evidence and test data."""
import sys
sys.dont_write_bytecode=True
import argparse
from pathlib import Path
import shutil
import subprocess
import tarfile
import json
from fixture_support import manifest, has_running_apps

parser=argparse.ArgumentParser()
parser.add_argument('root',type=Path)
mode=parser.add_mutually_exclusive_group()
mode.add_argument('--success',action='store_true',help='Clean after successful acceptance')
mode.add_argument('--archive-incomplete',action='store_true',help='Preserve incomplete artifacts in an archive before removing launchable copies')
args=parser.parse_args();root=args.root.resolve();data=manifest(root)
if not args.success and not args.archive_incomplete:
    print('Failure artifacts preserved:',root)
    sys.exit(0)
commands=subprocess.run(['/bin/ps','-axo','command='],check=True,capture_output=True,text=True).stdout
if has_running_apps(root,commands):
    raise RuntimeError('Quit the isolated application and installer before cleaning artifacts')
paths=[]
for relative in data['artifacts']:
    path=root/relative
    if path.is_symlink() or path.resolve()!=root/relative or not path.is_relative_to(root) or '..' in Path(relative).parts:
        raise ValueError('Artifact path escaped its ownership root')
    if path.exists():paths.append((relative,path))
if args.archive_incomplete and paths:
    archive=root/'incomplete-artifacts.tar.gz'
    if archive.exists():raise ValueError('Preserve the existing evidence archive before rerunning cleanup')
    temporary=root/'incomplete-artifacts.tar.gz.partial'
    with tarfile.open(temporary,'x:gz') as output:
        for relative,path in paths:output.add(path,arcname=relative)
    temporary.chmod(0o600);temporary.rename(archive)
for relative,path in sorted(paths,key=lambda item:len(Path(item[0]).parts),reverse=True):
    if path.is_dir():shutil.rmtree(path)
    else:path.unlink()
(root/'acceptance-result.json').write_text(json.dumps({'status':'passed' if args.success else 'incomplete','archive':'incomplete-artifacts.tar.gz' if args.archive_incomplete else None,'removedArtifacts':[relative for relative,_ in paths]},indent=2))
print('Removed recorded artifacts; logs, screenshots, settings and test library preserved:',root)
