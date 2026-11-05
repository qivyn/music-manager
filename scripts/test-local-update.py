import importlib.util
import json
import os
import sys
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('local_update', Path(__file__).with_name('local-update-test.py'))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class LocalUpdateTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='music-manager-desktop-local-test-', dir='/private/tmp')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        state = lab.LocalUpdateLab(root, '0.2.8', '0.2.9', 'http://127.0.0.1:18999')
        app = root / 'app-0.2.8.app/Contents'
        app.mkdir(parents=True)
        with (app / 'Info.plist').open('wb') as out:
            plistlib.dump({'CFBundleIdentifier': state.identifier, 'CFBundleShortVersionString': '0.2.8'}, out)
        package = root / 'packages/releases/download/v0.2.9/music-manager_0.2.9_aarch64.dmg'
        package.parent.mkdir(parents=True)
        package.write_bytes(b'signed original package')
        (root / 'signed-master.dmg').write_bytes(package.read_bytes())
        (root / 'packages/latest.json').write_text(json.dumps({'version': '0.2.9', 'platforms': {
            'darwin-aarch64': {'url': state.origin + '/releases/download/v0.2.9/' + package.name}}}))
        state.seed_library()
        return state, package

    def test_version_plan_does_not_change_release_files(self):
        self.assertEqual(lab.version_plan('0.2.8', None), ('0.2.8', '0.2.9'))
        self.assertEqual(lab.version_plan('0.2.8', '0.2.6'), ('0.2.6', '0.2.8'))
        for version in ['../0.2.8', '0.2.8-beta', 'garbage']:
            with self.assertRaises(ValueError): lab.version_plan(version, None)
        with self.assertRaises(ValueError): lab.version_plan('0.2.8', '0.1.0')

    def test_dev_environment_cannot_override_fixture_identity_or_signing_key(self):
        env = lab.child_environment({'PATH': '/usr/bin', 'TAURI_CONFIG': 'production config',
            'TAURI_ENV_DEBUG': 'true', 'TAURI_SIGNING_PRIVATE_KEY': 'secret', 'CARGO_TARGET_DIR': '/cache'})
        self.assertNotIn('TAURI_CONFIG', env)
        self.assertNotIn('TAURI_ENV_DEBUG', env)
        self.assertNotIn('TAURI_SIGNING_PRIVATE_KEY', env)
        self.assertEqual(env['PATH'], '/usr/bin')

    def test_scenarios_and_repair_preserve_library_and_signed_master(self):
        state, package = self.fixture()
        library = (state.root / 'library/library.db').read_bytes()
        with patch.object(state, 'stop_apps'), patch.object(state, 'running', return_value=[]):
            state.reset('install-failure', launch=False)
            with self.assertRaises(json.JSONDecodeError): json.loads((state.root / 'logs/latest.json').read_text())
            state.repair()
            receipt = json.loads((state.root / 'logs/latest.json').read_text())
            self.assertEqual(receipt['version'], '0.2.8')
            self.assertEqual(receipt['phase'], 'completed')
            state.reset('bad-signature', launch=False)
            self.assertNotEqual(package.read_bytes(), (state.root / 'signed-master.dmg').read_bytes())
            state.repair()
            self.assertEqual(package.read_bytes(), (state.root / 'signed-master.dmg').read_bytes())
            state.reset('success', launch=False)
        self.assertEqual((state.root / 'library/library.db').read_bytes(), library)
        self.assertTrue((state.root / 'Applications/声场档案.app').exists())

    def test_reset_refuses_running_installer_and_keeps_evidence(self):
        state, package = self.fixture()
        installer = str(state.root / 'cache/updates/update-x/helper-x/test.app/Contents/MacOS/music-manager-installer')
        with patch.object(state, 'running', return_value=[(99, installer)]):
            with self.assertRaisesRegex(RuntimeError, '安装器'): state.reset('success', launch=False)
        self.assertEqual(package.read_bytes(), b'signed original package')

    def test_unknown_application_is_not_removed_during_reset(self):
        state, _ = self.fixture()
        foreign = state.root / 'Applications/声场档案.app/Contents'
        foreign.mkdir(parents=True)
        with (foreign / 'Info.plist').open('wb') as out:
            plistlib.dump({'CFBundleIdentifier': 'unrelated.app'}, out)
        with patch.object(state, 'stop_apps'), patch.object(state, 'running', return_value=[]):
            with self.assertRaisesRegex(ValueError, '身份'): state.reset('success', launch=False)
        self.assertTrue(foreign.exists())

    def test_roots_and_origins_cannot_target_production_or_remote_servers(self):
        for root in [Path('/Applications'), Path('/private/tmp/ordinary-directory')]:
            with self.assertRaises(ValueError): lab.LocalUpdateLab(root, '0.2.8', '0.2.9', 'http://127.0.0.1:18999')
        for origin in ['https://example.com', 'http://0.0.0.0:1234', 'http://127.0.0.1:1234/path']:
            with self.assertRaises(ValueError): lab.validate_origin(origin)

    def test_symlinked_state_is_rejected_before_any_reset_changes(self):
        state, _ = self.fixture()
        outside = state.root / 'sentinel'
        outside.mkdir(); (outside / 'keep').write_text('safe')
        (state.root / 'logs').symlink_to(outside, target_is_directory=True)
        with patch.object(state, 'stop_apps'), patch.object(state, 'running', return_value=[]):
            with self.assertRaises(ValueError): state.reset('success', launch=False)
        self.assertEqual((outside / 'keep').read_text(), 'safe')

    def test_nested_unknown_application_is_not_removed(self):
        state, _ = self.fixture()
        foreign = state.root / 'Applications/.music-manager-backups/unknown/Other.app/Contents'
        foreign.mkdir(parents=True)
        with (foreign / 'Info.plist').open('wb') as out:
            plistlib.dump({'CFBundleIdentifier': 'unrelated.app'}, out)
        with patch.object(state, 'stop_apps'), patch.object(state, 'running', return_value=[]):
            with self.assertRaises(ValueError): state.reset('success', launch=False)
        self.assertTrue(foreign.exists())

    def test_process_matching_is_scoped_to_this_run_including_system_alias(self):
        state, _ = self.fixture()
        own = str(state.root / 'Applications/声场档案.app/Contents/MacOS/music-manager')
        output = f'123 {own}\n124 {own.replace("/private/tmp/", "/tmp/")}\n125 /Applications/声场档案.app/Contents/MacOS/music-manager\n126 {state.root}-other/App.app/Contents/MacOS/music-manager\n'
        with patch.object(lab.subprocess, 'check_output', return_value=output):
            self.assertEqual([pid for pid, _ in state.running()], [123, 124])

    def test_help_is_available_without_building_or_opening_any_app(self):
        result = lab.subprocess.run([sys.executable, str(Path(lab.__file__)), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--from-version', result.stdout)
        self.assertIn('--scenario', result.stdout)

    def test_missing_base_package_does_not_discard_current_receipt(self):
        state, _ = self.fixture()
        (state.root / 'logs').mkdir()
        receipt = state.root / 'logs/latest.json'; receipt.write_text('recovery evidence')
        (state.root / 'signed-master.dmg').unlink()
        with patch.object(state, 'running', return_value=[]):
            with self.assertRaisesRegex(ValueError, '基础包缺失'): state.reset('success', launch=False)
        self.assertEqual(receipt.read_text(), 'recovery evidence')

    def test_quit_refuses_to_clean_foreign_applications(self):
        state, _ = self.fixture()
        app = state.root / 'Applications/Other.app/Contents'; app.mkdir(parents=True)
        with (app / 'Info.plist').open('wb') as out:
            plistlib.dump({'CFBundleIdentifier': 'foreign'}, out)
        with patch.object(state, 'stop_apps'), patch.object(lab.subprocess, 'run') as run:
            with self.assertRaises(ValueError): state.close()
            run.assert_not_called()
        self.assertTrue(app.exists())


if __name__ == '__main__': unittest.main()
