#!/usr/bin/env python3
"""Interactive local updater lab, launched before the normal Tauri app starts."""
import argparse
import functools
import http.server
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / 'scripts/desktop-acceptance'
sys.path.insert(0, str(FIXTURES))
from fixture_support import manifest, record, validate_origin

SCENARIOS = ('success', 'install-failure', 'bad-signature')
APP = '声场档案.app'


def version_plan(current, previous):
    if not re.fullmatch(r'\d+\.\d+\.\d+', current):
        raise ValueError('当前版本必须为 x.y.z')
    if previous is not None and previous not in ('0.2.6', '0.2.7'):
        raise ValueError('历史客户端仅支持 0.2.6 或 0.2.7')
    if previous and tuple(map(int, previous.split('.'))) < tuple(map(int, current.split('.'))):
        return previous, current
    major, minor, patch = map(int, current.split('.'))
    return previous or current, f'{major}.{minor}.{patch + 1}'


def child_environment(source=None):
    # cargo tauri dev passes a merged TAURI_CONFIG; inheriting it would undo isolation.
    env = {key: value for key, value in (source if source is not None else os.environ).items()
           if key != 'TAURI_CONFIG' and not key.startswith(('TAURI_ENV_', 'TAURI_SIGNING_', 'MUSIC_MANAGER_STARTUP_'))}
    env.setdefault('CARGO_NET_OFFLINE', 'false')
    return env


def run(command, log, env=None):
    print('执行：', ' '.join(map(str, command)), flush=True)
    print('构建日志：', log, flush=True)
    with log.open('w') as output:
        process = subprocess.Popen(list(map(str, command)), cwd=REPO, env=env or child_environment(),
                                   stdout=output, stderr=subprocess.STDOUT)
        try:
            while True:
                try:
                    result = process.wait(timeout=30)
                    break
                except subprocess.TimeoutExpired:
                    print('仍在准备本地测试环境，日志：', log, flush=True)
        except BaseException:
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            raise
    if result:
        raise RuntimeError(f'命令失败（{result}），请查看 {log}')


class LocalUpdateLab:
    def __init__(self, root, old_version, new_version, origin):
        self.root = Path(root)
        if (self.root.parent != Path('/private/tmp') or not re.fullmatch(r'music-manager-desktop-local-[A-Za-z0-9_-]+', self.root.name)
                or self.root.is_symlink() or self.root.resolve() != self.root):
            raise ValueError('测试目录必须位于 /private/tmp/music-manager-desktop-local-*，不能使用符号链接')
        self.origin = validate_origin(origin)
        self.old_version, self.new_version = old_version, new_version
        self.root.mkdir(mode=0o700, exist_ok=True)
        self.identifier = manifest(self.root)['identifier']
        self.scenario = 'success'

    def path(self, relative):
        path = self.root / relative
        if path.resolve() != path or not path.is_relative_to(self.root):
            raise ValueError(f'测试路径不可包含符号链接：{path}')
        return path

    def seed_library(self):
        directory = self.path('library')
        if directory.exists():
            raise ValueError('测试库已存在，不覆盖已有数据')
        directory.mkdir()
        audio = directory / 'local-update-test.wav'
        with wave.open(str(audio), 'wb') as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(44100)
            output.writeframes(bytes(44100 * 2 * 3))
        with sqlite3.connect(directory / 'library.db') as database:
            database.executescript((REPO / 'src-tauri/tests/fixtures/v0.2.1.sql').read_text().replace('RELEASE_VERSION', self.old_version))
            database.execute('INSERT INTO music(id,name,file_name,path,album,album_source,artist,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                             ('local-update-test', '本地更新测试曲目', audio.name, str(audio), '测试专辑', 'manual', '测试素材', 3, 1, 1))
            database.execute("INSERT INTO clips VALUES ('local-update-clip','local-update-test','测试片段',0.5,1.5,1,1)")
            database.execute("INSERT INTO music_tags VALUES ('local-update-test',1)")
        self.path('support').mkdir()
        self.path('support/settings.json').write_text(json.dumps({'db_path': str(directory / 'library.db')}))
        self.path('evidence').mkdir(exist_ok=True)
        self.path('exports').mkdir(exist_ok=True)

    def prepare(self):
        self.seed_library()
        self.path('local-update.json').write_text(json.dumps({'oldVersion': self.old_version, 'newVersion': self.new_version,
            'origin': self.origin, 'identifier': self.identifier, 'root': str(self.root)}, indent=2))
        run(['cargo', 'tauri', 'signer', 'generate', '--ci', '-p', '', '-w', self.path('fixture-updater.key')],
            self.path('key-generation.log'))
        for version in (self.old_version, self.new_version):
            command = [sys.executable, FIXTURES / 'build-fixture.py', self.root, version]
            if version == self.old_version and version in ('0.2.6', '0.2.7'):
                command.append('v' + version)
            command += ['--origin', self.origin]
            run(command, self.path(f'prepare-{version}.log'))
        run([sys.executable, FIXTURES / 'package-fixture.py', self.root, self.new_version,
             '--origin', self.origin], self.path('package.log'))
        record(self.root, self.path('Applications'), self.path('cache'))
        historical = self.path('historical-v' + self.old_version)
        if historical.exists(): record(self.root, historical)

    def running(self):
        commands = subprocess.check_output(['/bin/ps', '-axo', 'pid=,command='], text=True)
        prefixes = (str(self.root) + '/', str(self.root).replace('/private/tmp/', '/tmp/') + '/')
        result = []
        for line in commands.splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) == 2 and parts[1].startswith(prefixes) and '.app/Contents/MacOS/' in parts[1]:
                result.append((int(parts[0]), parts[1]))
        return result

    def require_idle_installer(self):
        if any('/Contents/MacOS/music-manager-installer' in command for _, command in self.running()):
            raise RuntimeError('测试安装器仍在运行，请先完成操作或关闭安装窗口，再重置/退出。')

    def stop_apps(self):
        self.require_idle_installer()
        for pid, _ in self.running(): os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while self.running() and time.monotonic() < deadline: time.sleep(0.1)
        if self.running(): raise RuntimeError('测试应用尚未退出，已保留全部材料')

    def assert_app(self, app):
        if not app.exists(): return
        with (app / 'Contents/Info.plist').open('rb') as source:
            info = plistlib.load(source)
        if info.get('CFBundleIdentifier') != self.identifier:
            raise ValueError('应用身份不属于本次测试，不会删除：' + str(app))

    def validate_app_directories(self):
        for app in self.path('Applications').rglob('*.app'):
            self.assert_app(app)

    def package(self):
        feed = json.loads(self.path('packages/latest.json').read_text())
        url = next(iter(feed['platforms'].values()))['url']
        if not url.startswith(self.origin + '/releases/download/'):
            raise ValueError('测试包地址不属于当前本机服务')
        return self.path('packages/' + urlsplit(url).path.lstrip('/'))

    def reset(self, scenario, launch=True):
        if scenario not in SCENARIOS: raise ValueError('未知测试场景')
        self.require_idle_installer()
        # Validate every destination before deleting even the first owned artifact.
        old = self.path('Applications/' + APP)
        self.assert_app(old)
        paths = [self.path(name) for name in ('Applications', 'cache', 'logs')]
        self.validate_app_directories()
        source = self.path('app-' + self.old_version + '.app'); self.assert_app(source)
        if not source.is_dir() or not self.path('signed-master.dmg').is_file() or not self.package().is_file():
            raise ValueError('测试基础包缺失，请重新运行本地测试命令；当前材料保持不变')
        self.stop_apps()
        logs = paths[-1]
        if logs.exists():
            archive = self.path('evidence/reset-' + uuid.uuid4().hex)
            archive.mkdir(); logs.rename(archive / 'logs')
        for directory in paths[:-1]:
            if directory.exists(): shutil.rmtree(directory)
        old.parent.mkdir(parents=True)
        shutil.copytree(source, old)
        logs.mkdir()
        session = str(uuid.uuid4()).upper()
        receipt = {'session': session, 'destination': str(old), 'version': self.old_version,
            'backup': str(old.parent / '.music-manager-backups' / session / APP),
            'staging': str(old.parent / ('.music-manager-stage-' + session + '.app')),
            'diagnosticsSession': session, 'phase': 'completed', 'launched': True}
        self.path('valid-test-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False))
        self.scenario = scenario
        self.repair()
        if scenario == 'install-failure': self.path('logs/latest.json').write_text('{ deliberate local test failure')
        if scenario == 'bad-signature':
            data = bytearray(self.package().read_bytes()); data[len(data) // 2] ^= 1
            self.package().write_bytes(data)
        print(f'场景：{scenario}；测试库保留。打开更新面板即可测试 {self.old_version} → {self.new_version}。', flush=True)
        if launch: self.open_app()

    def repair(self):
        self.require_idle_installer()
        legacy = self.path('logs/latest.json')
        if legacy.exists() and legacy.read_text().startswith('{ deliberate local test failure'):
            legacy.write_bytes(self.path('valid-test-receipt.json').read_bytes())
        elif not self.path('logs/state/latest.json').exists() and not legacy.exists():
            legacy.parent.mkdir(exist_ok=True)
            legacy.write_bytes(self.path('valid-test-receipt.json').read_bytes())
        shutil.copyfile(self.path('signed-master.dmg'), self.package())

    def open_app(self):
        self.stop_apps()
        candidate = self.path('Applications/' + APP)
        self.assert_app(candidate)
        subprocess.run(['/usr/bin/open', '-n', str(candidate)], check=True, env=child_environment())

    def status(self):
        current = self.path('logs/state/latest.json')
        try:
            state = json.loads(current.read_text())
            print('安装状态：', {key: state.get(key) for key in ('version', 'phase', 'startupOutcome', 'cleanupPending')}, flush=True)
        except (FileNotFoundError, json.JSONDecodeError): print('尚无完整安装状态。', flush=True)
        print('测试目录：', self.root, '\n诊断与日志：', self.path('logs'), flush=True)

    def close(self):
        self.validate_app_directories()
        self.stop_apps()
        for name in ('fixture-updater.key', 'fixture-updater.key.pub', 'key-generation.log'):
            self.path(name).unlink(missing_ok=True)
        subprocess.run([sys.executable, str(FIXTURES / 'cleanup-fixture.py'), str(self.root), '--success'], check=True)


MENU = '''
在测试 App 内点击“检查更新 → 下载更新 → 重启并更新”。
终端可输入：
  success         重置旧版，正常升级
  install-failure 重置旧版，模拟安装记录损坏（测试失败及诊断导出）
  bad-signature   重置旧版，模拟签名不匹配
  repair          修复本次模拟故障，然后在 App 中重试
  open            重新打开当前测试 App
  status          查看安装结果和日志位置
  quit            退出测试并清理 App/更新包，保留测试库和诊断日志
场景切换会退出测试 App；请先完成或关闭测试安装器。
'''


def main():
    parser = argparse.ArgumentParser(description='本机真实更新测试；不会修改正式版本号、应用或音乐库。')
    parser.add_argument('--from-version', choices=['0.2.6', '0.2.7'])
    parser.add_argument('--scenario', choices=SCENARIOS, default='success')
    parser.add_argument('--root', type=Path, help='新的 /private/tmp/music-manager-desktop-local-* 目录')
    args = parser.parse_args()
    if sys.platform != 'darwin': parser.error('本地 App 更新测试目前需要 macOS')
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    if args.root and args.root.exists(): parser.error('测试目录已存在，请使用新的目录以保留已有证据')
    root = args.root or Path(tempfile.mkdtemp(prefix='music-manager-desktop-local-', dir='/private/tmp'))
    current = json.loads((REPO / 'src-tauri/tauri.conf.json').read_text())['version']
    old, new = version_plan(current, args.from_version)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root / 'packages'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    lab = LocalUpdateLab(root, old, new, f'http://127.0.0.1:{server.server_port}')
    prepared = False
    try:
        print(f'本地更新测试：{old} → {new}\n测试目录：{root}\n首次准备需要构建两个 App 和一个 DMG；正式应用不会启动。', flush=True)
        lab.prepare(); prepared = True
        lab.reset(args.scenario)
        print(MENU, flush=True)
        while True:
            try:
                command = input('本地更新测试> ').strip()
                if command in SCENARIOS: lab.reset(command)
                elif command == 'repair': lab.repair(); print('模拟故障已修复，请在测试 App 中重试。', flush=True)
                elif command == 'open': lab.open_app()
                elif command == 'status': lab.status()
                elif command == 'quit': lab.require_idle_installer(); break
                elif command: print(MENU, flush=True)
            except (ValueError, RuntimeError, OSError) as error: print(error, flush=True)
    except (KeyboardInterrupt, EOFError):
        print('\n停止本地更新测试。', flush=True)
    finally:
        server.shutdown(); server.server_close()
        if prepared:
            try: lab.close()
            except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
                print(f'未删除未完成的测试材料：{root}\n{error}', flush=True)
        else: print('准备未完成，日志和材料保留在：', root, flush=True)


if __name__ == '__main__':
    try: main()
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print('本地更新测试启动失败：', error, file=sys.stderr)
        sys.exit(1)
