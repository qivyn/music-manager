#!/usr/bin/env python3
"""Build an isolated native fixture from current sources; never alter release config.

Usage: python3 scripts/desktop-acceptance/build-fixture.py /private/tmp/mm-... 0.2.6
Generate ROOT/fixture-updater.key(.pub) with `cargo tauri signer generate` first.
Only copied Rust configuration and a separate IPC latency adapter differ from the app.
"""
import hashlib
import json
import plistlib
import io
import tarfile
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
sys.dont_write_bytecode=True
from fixture_support import manifest, record

REPO = Path(__file__).resolve().parents[2]
root = Path(sys.argv[1]).resolve()
version = sys.argv[2]
assert root.parent == Path('/private/tmp') and root.name.startswith('music-manager-desktop-')
assert re.fullmatch(r'\d+\.\d+\.\d+', version)
identifier = manifest(root)['identifier']
origin = 'http://127.0.0.1:18764'
work = root / ('source-' + version)
assert not work.exists(), f'Preserve existing fixture: {work}'
source_repo=REPO
if len(sys.argv)>3:
    ref=sys.argv[3]
    assert re.fullmatch(r'v0\.2\.[67]',ref)
    source_repo=root/('historical-'+ref)
    source_repo.mkdir(exist_ok=True)
    archive=subprocess.run(['git','archive',ref,'frontend','src-tauri'],cwd=REPO,check=True,capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(source_repo,filter='data')
shutil.copytree(source_repo / 'frontend', work / 'frontend')
shutil.copytree(source_repo / 'src-tauri', work / 'src-tauri', ignore=shutil.ignore_patterns('target', 'gen'))
rust = work / 'src-tauri'
public = (root / 'fixture-updater.key.pub').read_text().strip()
(rust / 'updater-public-key.txt').write_text(public + '\n')
config = json.loads((rust / 'tauri.conf.json').read_text())
config.update(productName='声场档案交叉验收', identifier=identifier, version=version)
config['app']['windows'][0]['title'] = '声场档案 · 隔离交叉验收 ' + version
config['plugins']['updater'] = {'pubkey': public, 'endpoints': [origin + '/latest.json']}
(rust / 'tauri.conf.json').write_text(json.dumps(config, ensure_ascii=False, indent=2))
for name in ['Cargo.toml', 'Cargo.lock']:
    p = rust / name
    text = p.read_text()
    text, n = re.subn(r'(name = "music-manager"\nversion = ")[^"]+', lambda m:m[1] + version, text, count=1)
    assert n == 1
    p.write_text(text)
support = 'std::path::PathBuf::from(' + json.dumps(str(root / 'support')) + ')'
for name in ['lib.rs', 'db.rs']:
    p = rust / 'src' / name
    text = p.read_text()
    text, n = re.subn(r'app\s*\.path\(\)\s*\.app_data_dir\(\)\s*\.map_err\(\|e\| format!\("无法获取数据目录: \{e\}"\)\)\?', support, text)
    assert n > 0
    if name == 'lib.rs':
        text = 'mod acceptance;\n' + text
        text = text.replace('.invoke_handler(tauri::generate_handler![', '.invoke_handler(tauri::generate_handler![\n            acceptance::acceptance_gate,\n            acceptance::acceptance_event,')
    p.write_text(text)
p = rust / 'src/main.rs'
text = p.read_text()
text = re.sub(r'let dir = std::path::PathBuf::from\(home\).*?;', 'let dir = ' + support + ';', text)
p.write_text(text)
p = rust / 'src/updater.rs'
text = p.read_text().replace('com.musicmanager.installer', identifier + '.installer').replace('com.musicmanager.app', identifier)
text = text.replace('https://github.com/qivyn/music-manager/releases/download', origin + '/releases/download').replace('https://github.com/AI-AQI/music-manager/releases/download', origin + '/releases/download')
text = text.replace('app.path().app_cache_dir().map_err(|e| e.to_string())?', 'PathBuf::from(' + json.dumps(str(root / 'cache')) + ')')
state_pattern='vec![PathBuf::from("/Library/Application Support/com.musicmanager.installer/system"),home.join("Library/Application Support/com.musicmanager.installer/user")]'
state_pattern=state_pattern.replace('com.musicmanager.installer',identifier+'.installer')
text = text.replace(state_pattern,'vec![PathBuf::from(' + json.dumps(str(root / 'logs/state')) + ')]')
if 'fn installer_state_roots' in text:
    assert str(root/'logs/state') in text, 'Installer transaction reads must stay isolated'

text = text.replace('PathBuf::from("/Applications").join(APP_NAME), home.join("Applications").join(APP_NAME)', 'PathBuf::from(' + json.dumps(str(root / 'Applications')) + ').join(APP_NAME)')
p.write_text(text)
(root / 'gates').mkdir(exist_ok=True)
(rust / 'src/acceptance.rs').write_text('''use std::{fs::{self,OpenOptions},io::Write,path::PathBuf,time::{Duration,SystemTime,UNIX_EPOCH}};
fn root()->PathBuf { PathBuf::from(ROOT) }
fn record(event:serde_json::Value) -> Result<(),String> {
 let mut f=OpenOptions::new().create(true).append(true).open(root().join("native-events.jsonl")).map_err(|e|e.to_string())?;
 let data=serde_json::json!({"at":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis(),"pid":std::process::id(),"event":event});
 writeln!(f,"{}",data).map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn acceptance_gate(command:String)->Result<(),String> {
 tauri::async_runtime::spawn_blocking(move|| {
  if !command.chars().all(|c|c.is_ascii_alphanumeric() || c=='_') {return Err("invalid gate".into());}
  record(serde_json::json!({"phase":"before","command":command}))?;
  let gate=root().join("gates").join(&command);
  while fs::metadata(&gate).is_ok() {std::thread::sleep(Duration::from_millis(50));}
  Ok(())
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub fn acceptance_event(event:serde_json::Value)->Result<(),String>{record(event)}
'''.replace('ROOT', json.dumps(str(root))))
(work / 'frontend/acceptance-fixture.js').write_text('''// Isolated native acceptance only: production UI and native commands remain real.
(() => {
 const original = window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
 window.__TAURI__.core.invoke = async (command,args) => {
  await original('acceptance_gate',{command});
  try {
   const value=await original(command,args);
   await original('acceptance_event',{event:{phase:'completed',command,args}});
   return value;
  } catch(error) {
   await original('acceptance_event',{event:{phase:'failed',command,error:String(error)}});
   throw error;
  }
 };
})();
''')
p = work / 'frontend/index.html'
p.write_text(p.read_text().replace('<script src="app.js"></script>', '<script src="acceptance-fixture.js"></script>\n<script src="app.js"></script>'))
manifest = {'version': version, 'identifier':identifier, 'sourceAppSha256':hashlib.sha256((REPO/'frontend/app.js').read_bytes()).hexdigest(), 'fixtureAppSha256':hashlib.sha256((work/'frontend/app.js').read_bytes()).hexdigest(), 'root':str(root), 'origin':origin}
(work / 'fixture-manifest.json').write_text(json.dumps(manifest,indent=2))
env=os.environ.copy(); env['CARGO_TARGET_DIR']=str(REPO/'src-tauri/target'); env['CARGO_NET_OFFLINE']='true'
with (root / ('build-' + version + '.log')).open('w') as log:
 result=subprocess.run(['cargo','tauri','build','--debug','--bundles','app','--ci'],cwd=rust,env=env,stdout=log,stderr=subprocess.STDOUT)
if result.returncode: print('Build failed, see',log.name); sys.exit(result.returncode)
out=root / ('app-' + version + '.app')
assert not out.exists()
subprocess.run(['/usr/bin/ditto',str(REPO/'src-tauri/target/debug/bundle/macos/声场档案交叉验收.app'),str(out)],check=True)
subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(out)],check=True)
# Remove only this build's verified acceptance bundle from the shared Cargo output.
bundle=REPO/'src-tauri/target/debug/bundle/macos/声场档案交叉验收.app'
with (bundle/'Contents/Info.plist').open('rb') as file:
    assert plistlib.load(file)['CFBundleIdentifier']==identifier
shutil.rmtree(bundle)
record(root,work,out)
print(out)
