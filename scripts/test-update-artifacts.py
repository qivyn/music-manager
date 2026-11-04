import sys
sys.dont_write_bytecode=True
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import runpy
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('artifacts',Path(__file__).with_name('update-artifacts.py'))
artifacts=importlib.util.module_from_spec(spec);spec.loader.exec_module(artifacts)
ROOT=Path(__file__).resolve().parents[1]
KEY=(ROOT/'src-tauri/updater-public-key.txt').read_text()
CONFIG=json.loads((ROOT/'src-tauri/tauri.conf.json').read_text())

class ArtifactTests(unittest.TestCase):
    def test_metadata_matches_actual_binary_package_and_next_update_capability(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);app=root/'test.app';(app/'Contents/MacOS').mkdir(parents=True)
            info={'CFBundleIdentifier':'com.musicmanager.app','CFBundleShortVersionString':'0.2.7','MusicManagerStartupProtocol':1,'MusicManagerDatabaseSchema':3,'LSMinimumSystemVersion':'10.15'}
            with (app/'Contents/Info.plist').open('wb') as f:plistlib.dump(info,f)
            (app/'Contents/MacOS/music-manager').write_bytes(b'fixture')
            package=root/'music-manager_0.2.7_aarch64.dmg';package.write_bytes(b'package')
            capability={'version':'0.2.7','installerProtocol':2,'publicKeyFingerprint':hashlib.sha256(KEY.strip().encode()).hexdigest(),'endpoint':CONFIG['plugins']['updater']['endpoints']}
            with patch.object(artifacts.subprocess,'run',side_effect=[SimpleNamespace(stdout='arm64'),SimpleNamespace(stdout=json.dumps(capability))]):
                meta=artifacts.inspect(app,package,KEY)
            self.assertEqual(meta['sha256'],hashlib.sha256(b'package').hexdigest())
            self.assertEqual(meta['packageSize'],7)
            capability['publicKeyFingerprint']='wrong'
            with patch.object(artifacts.subprocess,'run',side_effect=[SimpleNamespace(stdout='arm64'),SimpleNamespace(stdout=json.dumps(capability))]):
                with self.assertRaises(ValueError):artifacts.inspect(app,package,KEY)
            with patch.object(artifacts.subprocess,'run',return_value=SimpleNamespace(stdout='x86_64')):
                with self.assertRaises(ValueError):artifacts.inspect(app,package,KEY)

    def test_nonproduction_bundle_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            app=Path(tmp)/'test.app';(app/'Contents').mkdir(parents=True)
            with (app/'Contents/Info.plist').open('wb') as f:plistlib.dump({'CFBundleIdentifier':'com.musicmanager.test'},f)
            with self.assertRaises(ValueError):artifacts.inspect(app,Path(tmp)/'x.dmg',KEY)

class FixtureOwnershipTests(unittest.TestCase):
    def test_cleanup_accepts_recorded_parent_and_child(self):
        sys.path.insert(0,str(ROOT/'scripts/desktop-acceptance'))
        from fixture_support import record
        with tempfile.TemporaryDirectory(prefix='music-manager-desktop-test-',dir='/private/tmp') as tmp:
            root=Path(tmp);parent=root/'packages';parent.mkdir()
            child=parent/'fixture.dmg';child.write_bytes(b'test')
            record(root,parent,child)
            with patch.object(sys,'argv',['cleanup-fixture.py',str(root),'--success']), patch('subprocess.run',return_value=SimpleNamespace(stdout='')):
                runpy.run_path(str(ROOT/'scripts/desktop-acceptance/cleanup-fixture.py'),run_name='__main__')
            self.assertFalse(parent.exists())
            self.assertEqual(json.loads((root/'acceptance-result.json').read_text())['status'],'passed')

    def test_run_identifiers_are_unique_and_symlinks_cannot_be_recorded(self):
        sys.path.insert(0,str(ROOT/'scripts/desktop-acceptance'))
        from fixture_support import manifest,record,has_running_apps
        with tempfile.TemporaryDirectory(prefix='music-manager-desktop-test-',dir='/private/tmp') as tmp:
            root=Path(tmp);first=manifest(root);self.assertEqual(first,manifest(root))
            self.assertFalse(has_running_apps(root,f"/bin/zsh -c echo '{root}/test.app/Contents/MacOS/test'"))
            self.assertTrue(has_running_apps(root,f"{root}/test.app/Contents/MacOS/test"))
            artifact=root/'test.app';artifact.mkdir();record(root,artifact)
            self.assertEqual(manifest(root)['artifacts'],['test.app'])
            (root/'link.app').symlink_to('/Applications')
            with self.assertRaises(ValueError):record(root,root/'link.app')
            with self.assertRaises(ValueError):record(root,root/'../outside')
        with self.assertRaises(ValueError):manifest(Path('/Applications'))

if __name__=='__main__':unittest.main()
