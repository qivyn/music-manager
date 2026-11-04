import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import hashlib
from pathlib import Path
import tempfile
import unittest
import subprocess

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("manifest", root / "create-update-manifest.py")
manifest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifest)


class ManifestTests(unittest.TestCase):
    def test_cli_reuses_valid_manifest_bytes_and_rejects_changed_feed(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            signature = (root / 'fixtures/updater/signed-test.txt.sig').read_text()
            for arch in ('aarch64', 'x64'):
                package = directory / f'music-manager_0.2.8_{arch}.dmg'
                package.write_bytes(b'fixture')
                Path(str(package) + '.sig').write_text(signature)
                Path(str(package) + '.metadata.json').write_text(json.dumps({'version':'0.2.8','arch':arch,'sha256':hashlib.sha256(b'fixture').hexdigest()}))
                Path(str(package) + '.metadata.json.sig').write_text(signature)
            notes = directory / 'notes.txt'; notes.write_text('release notes')
            feed = manifest.create_manifest('0.2.8', directory, notes.read_text())
            feed['pub_date'] = '2026-01-01T00:00:00Z'
            output = directory / 'latest.json'; output.write_text(json.dumps(feed))
            original = output.read_bytes()
            command = [sys.executable, str(root/'create-update-manifest.py'), '--version', '0.2.8', '--directory', str(directory), '--notes', str(notes)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output.read_bytes(), original, 'retry must reuse the already-uploaded manifest timestamp and bytes')
            feed['platforms']['darwin-aarch64']['signature'] = 'changed'
            output.write_text(json.dumps(feed)); corrupted = output.read_bytes()
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), corrupted, 'mismatched saved feed must not be silently overwritten')

    def test_requires_both_architectures_and_signatures(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            signature = (root / "fixtures/updater/signed-test.txt.sig").read_text()
            with self.assertRaises(ValueError):
                manifest.create_manifest("0.2.6", directory, "notes")
            for arch in ("aarch64", "x64"):
                file = directory / f"music-manager_0.2.6_{arch}.dmg"
                file.write_bytes(b"fixture")
                file.with_suffix(".dmg.sig").write_text(signature)
                Path(str(file) + ".metadata.json").write_text(json.dumps({"version":"0.2.6", "arch":arch, "sha256":hashlib.sha256(b"fixture").hexdigest()}))
                Path(str(file) + ".metadata.json.sig").write_text(signature)
            result = manifest.create_manifest("0.2.6", directory, "notes")
            self.assertTrue(all(p["url"].startswith("https://github.com/AI-AQI/music-manager/releases/download/") for p in result["platforms"].values()))
            self.assertEqual(set(result["platforms"]), {"darwin-aarch64", "darwin-x86_64"})
            self.assertIn("/v0.2.6/music-manager_0.2.6_x64.dmg", result["platforms"]["darwin-x86_64"]["url"])
            (directory / "music-manager_0.2.6_x64.dmg.sig").write_text("invalid")
            with self.assertRaises(ValueError):
                manifest.create_manifest("0.2.6", directory, "")

    def test_feed_binds_signed_compatibility_information(self):
        import json, base64
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            signature = (root / "fixtures/updater/signed-test.txt.sig").read_text()
            for arch in ("aarch64", "x64"):
                file = directory / f"music-manager_0.2.8_{arch}.dmg"
                file.write_bytes(b"fixture"); Path(str(file) + ".sig").write_text(signature)
                meta = {"version":"0.2.8", "arch":arch, "installerProtocol":2, "sha256":hashlib.sha256(b"fixture").hexdigest()}
                Path(str(file) + ".metadata.json").write_text(json.dumps(meta))
                Path(str(file) + ".metadata.json.sig").write_text(signature)
            result = manifest.create_manifest("0.2.8", directory, "notes")
            signed = result["platforms"]["darwin-aarch64"]["compatibility"]
            self.assertEqual(json.loads(base64.b64decode(signed["data"]))["arch"], "aarch64")
            self.assertEqual(signed["signature"], signature.strip())

    def test_rejects_unstable_or_path_versions(self):
        for version in ("../escape", "0.2.6-beta", "0.2.6+build", "latest"):
            with self.assertRaises(ValueError):
                manifest.create_manifest(version, Path("."), "")


if __name__ == "__main__":
    unittest.main()
