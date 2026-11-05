#!/usr/bin/env python3
"""Package only an isolated acceptance app; production packager is unchanged."""
import datetime
import argparse
import hashlib
import base64
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
sys.dont_write_bytecode=True
from fixture_support import manifest, record, validate_origin

repo=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('root',type=Path);parser.add_argument('version')
parser.add_argument('--origin',default='http://127.0.0.1:18764',type=validate_origin)
parser.add_argument('--migration',action='store_true',help='Migrate the old Applications copy into isolated SystemApplications')
args=parser.parse_args()
root=args.root.resolve(); version=args.version;origin=args.origin
assert root.parent == Path('/private/tmp') and root.name.startswith('music-manager-desktop-')
identifier=manifest(root)['identifier']
image=root/('image-'+version); image.mkdir()
installer=image/'安装与更新声场档案.app'
(installer/'Contents/MacOS').mkdir(parents=True); (installer/'Contents/Resources').mkdir()
main=(repo/'scripts/macos-installer/main.swift').read_text().replace('/private/tmp/music-manager-installer-ui',str(root)).replace('com.musicmanager.installertest',identifier)
target=root/('SystemApplications' if args.migration else 'Applications')/'声场档案.app'
if args.migration:
 main=main.replace('destination = testRoot.appendingPathComponent("Applications/声场档案.app")','destination = testRoot.appendingPathComponent("SystemApplications/声场档案.app")')
# Maintenance must use the same isolated paths and identity as installation.
main=main.replace('let shared=URL(fileURLWithPath:"/Applications/声场档案.app")','let shared=URL(fileURLWithPath:'+json.dumps(str(target),ensure_ascii=False)+')')
main=main.replace('let personal=fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/声场档案.app")','let personal=URL(fileURLWithPath:'+json.dumps(str(root/'Applications/声场档案.app'),ensure_ascii=False)+')')
main=main.replace('let state=target==shared ? URL(fileURLWithPath:"/Library/Application Support/com.musicmanager.installer/system") : fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/com.musicmanager.installer/user")','let state=URL(fileURLWithPath:'+json.dumps(str(root/'logs/state'))+')')
main=main.replace('let logs=fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/com.musicmanager.installer")','let logs=URL(fileURLWithPath:'+json.dumps(str(root/'logs'))+')')
main=main.replace('let engine=try Installer(source:source,destination:target,logRoot:logs,stateRoot:state)','let engine=try Installer(source:source,destination:target,logRoot:logs,identifier:'+json.dumps(identifier)+',stateRoot:state)')
source=root/('installer-source-'+version);source.mkdir(exist_ok=True)
(source/'main.swift').write_text(main)
(root/'swift-cache').mkdir(exist_ok=True)
subprocess.run(['xcrun','swiftc','-swift-version','5','-O','-D','INSTALLER_UI_TESTS','-module-cache-path',str(root/'swift-cache'),str(repo/'scripts/macos-installer/InstallerCore.swift'),str(source/'main.swift'),'-o',str(installer/'Contents/MacOS/music-manager-installer')],check=True)
subprocess.run(['/usr/bin/ditto',str(root/('app-'+version+'.app')),str(installer/'Contents/Resources/声场档案.app')],check=True)
shutil.copyfile(root/('app-'+version+'.app/Contents/Resources/icon.icns'),installer/'Contents/Resources/icon.icns')
with (installer/'Contents/Info.plist').open('wb') as f:
 plistlib.dump({'CFBundleIdentifier':identifier+'.installer','CFBundleName':'声场档案隔离安装验收','CFBundleDisplayName':'声场档案隔离安装验收','CFBundleExecutable':'music-manager-installer','CFBundlePackageType':'APPL','CFBundleShortVersionString':version,'CFBundleVersion':version,'CFBundleIconFile':'icon.icns','LSMinimumSystemVersion':'10.15','NSHighResolutionCapable':True,'MusicManagerInAppUpdateProtocol':1,'MusicManagerInstallerProtocol':2},f)
subprocess.run(['/usr/bin/codesign','--force','--sign','-',str(installer)],check=True)
subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(installer)],check=True)
binary=root/('app-'+version+'.app/Contents/MacOS/music-manager')
archs=subprocess.check_output(['/usr/bin/lipo','-archs',str(binary)],text=True).strip()
arch={'arm64':'aarch64','x86_64':'x64'}[archs]
package=root/'packages/releases/download'/('v'+version)/('music-manager_'+version+'_'+arch+'.dmg');package.parent.mkdir(parents=True,exist_ok=True)
subprocess.run(['hdiutil','create','-volname','声场档案隔离验收 '+version,'-srcfolder',str(image),'-fs','HFS+','-format','UDZO',str(package)],check=True)
subprocess.run(['hdiutil','verify',str(package)],check=True)
env=os.environ.copy();env['TAURI_SIGNING_PRIVATE_KEY_PATH']=str(root/'fixture-updater.key');env['TAURI_SIGNING_PRIVATE_KEY_PASSWORD']=''
with (root/'signing.log').open('w') as log:
 subprocess.run(['cargo','tauri','signer','sign',str(package)],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
metadata={'version':version,'arch':arch,'minimumSystemVersion':'10.15','minimumClientVersion':'0.2.6','installerProtocol':2,'startupProtocol':1,'schema':3,'packageSize':package.stat().st_size,'expandedSize':sum(p.stat().st_size for p in (root/('app-'+version+'.app')).rglob('*') if p.is_file()),'sha256':hashlib.sha256(package.read_bytes()).hexdigest(),'publicKeyFingerprint':hashlib.sha256((root/'fixture-updater.key.pub').read_text().strip().encode()).hexdigest()}
metadata_path=Path(str(package)+'.metadata.json');metadata_path.write_text(json.dumps(metadata,sort_keys=True)+'\n')
with (root/'metadata-signing.log').open('w') as log:
 subprocess.run(['cargo','tauri','signer','sign','-f',str(root/'fixture-updater.key'),'-p','',str(metadata_path)],stdout=log,stderr=subprocess.STDOUT,check=True)
feed={'version':version,'notes':'本地更新测试包：仅用于当前隔离环境。','pub_date':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'platforms':{'darwin-aarch64' if arch=='aarch64' else 'darwin-x86_64':{'url':origin+'/releases/download/v'+version+'/'+package.name,'signature':Path(str(package)+'.sig').read_text().strip(),'compatibility':{'data':base64.b64encode(metadata_path.read_bytes()).decode(),'signature':Path(str(metadata_path)+'.sig').read_text().strip()}}}}
(root/'packages/latest.json').write_text(json.dumps(feed,ensure_ascii=False,indent=2))
shutil.copyfile(package,root/'signed-master.dmg')
record(root,image,source,package,Path(str(package)+'.sig'),metadata_path,Path(str(metadata_path)+'.sig'),root/'signed-master.dmg')
print(package)
