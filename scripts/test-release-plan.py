import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

root = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_plan", root / "release-plan.py")
release_plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_plan)

SHA = "a" * 40
# 模拟 gh api：发布列表来自 FAKE_RELEASES，标签来自 FAKE_TAG（type:sha，空表示不存在）
FAKE_GH = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
path = next(a for a in args[1:] if a.startswith("repos/"))
if path.endswith("/releases"):
    for release in json.loads(os.environ["FAKE_RELEASES"]):
        print(json.dumps(release))
elif "/git/ref/tags/" in path:
    if not os.environ.get("FAKE_TAG"):
        sys.stderr.write("gh: Not Found (HTTP 404)\\n"); sys.exit(1)
    kind, sha = os.environ["FAKE_TAG"].split(":")
    print(json.dumps({"object": {"type": kind, "sha": sha}}))
elif "/git/tags/" in path:
    print(json.dumps({"object": {"type": "commit", "sha": os.environ["FAKE_ANNOTATED_TARGET"]}}))
"""


def release(tag, draft=False, prerelease=False):
    return {"tag_name": tag, "draft": draft, "prerelease": prerelease}


def write_versions(directory, cargo, lock, tauri):
    rust = directory / "src-tauri"
    rust.mkdir(parents=True)
    (rust / "Cargo.toml").write_text(f'[package]\nname = "music-manager"\nversion = "{cargo}"\n')
    (rust / "Cargo.lock").write_text(
        f'version = 4\n\n[[package]]\nname = "hound"\nversion = "3.5.1"\n\n'
        f'[[package]]\nname = "music-manager"\nversion = "{lock}"\n')
    (rust / "tauri.conf.json").write_text(json.dumps({"version": tauri}))


class PlanTests(unittest.TestCase):
    def test_newer_version_builds(self):
        newer, _ = release_plan.plan("0.2.8", [release("v0.2.7"), release("v0.2.6")], None, SHA)
        self.assertTrue(newer)

    def test_first_release_builds(self):
        self.assertTrue(release_plan.plan("0.1.0", [], None, SHA)[0])

    def test_published_or_older_version_skips(self):
        releases = [release("v0.2.6"), release("v0.10.0"), release("v0.2.7")]
        self.assertFalse(release_plan.plan("0.2.7", releases, SHA, SHA)[0])
        # 0.10.0 按数字比较大于 0.9.0
        self.assertFalse(release_plan.plan("0.9.0", releases, None, SHA)[0])

    def test_drafts_prereleases_and_odd_tags_do_not_count_as_published(self):
        releases = [release("v0.3.0", prerelease=True), release("v0.4.0-beta"), release("nightly"), release("v0.2.7")]
        self.assertTrue(release_plan.plan("0.2.8", releases, None, SHA)[0])

    def test_existing_draft_for_this_version_stops(self):
        with self.assertRaises(ValueError):
            release_plan.plan("0.2.8", [release("v0.2.8", draft=True), release("v0.2.7")], None, SHA)

    def test_same_commit_draft_can_be_retried(self):
        draft = {**release("v0.2.8", draft=True), "body":"<!-- music-manager-source:" + SHA + " -->", "target_commitish":SHA}
        self.assertTrue(release_plan.plan("0.2.8", [draft], None, SHA)[0])
        draft["body"] = "<!-- music-manager-source:" + "b" * 40 + " -->"
        with self.assertRaises(ValueError):
            release_plan.plan("0.2.8", [draft], None, SHA)

    def test_tag_must_point_to_tested_commit(self):
        self.assertTrue(release_plan.plan("0.2.8", [release("v0.2.7")], SHA, SHA)[0])
        with self.assertRaises(ValueError):
            release_plan.plan("0.2.8", [release("v0.2.7")], "b" * 40, SHA)


class VersionTests(unittest.TestCase):
    def test_reads_repository_version(self):
        self.assertRegex(release_plan.read_version(root.parent), r"^\d+\.\d+\.\d+$")

    def test_rejects_mismatched_or_unstable_versions(self):
        for versions in [("0.2.8", "0.2.7", "0.2.8"), ("0.2.8", "0.2.8", "0.2.7"), ("0.2.8-beta",) * 3]:
            with tempfile.TemporaryDirectory() as tmp, self.subTest(versions=versions):
                write_versions(Path(tmp), *versions)
                with self.assertRaises(ValueError):
                    release_plan.read_version(Path(tmp))


class CommandTests(unittest.TestCase):
    def run_plan(self, releases, tag="", *extra, annotated_target=""):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            write_versions(tmp / "repo", "0.2.8", "0.2.8", "0.2.8")
            bin_dir = tmp / "bin"
            bin_dir.mkdir()
            (bin_dir / "gh").write_text(FAKE_GH)
            (bin_dir / "gh").chmod(0o755)
            output = tmp / "output"
            env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                   "GITHUB_REPOSITORY": "owner/music-manager", "GITHUB_SHA": SHA, "GITHUB_OUTPUT": str(output),
                   "FAKE_RELEASES": json.dumps(releases), "FAKE_TAG": tag, "FAKE_ANNOTATED_TARGET": annotated_target}
            result = subprocess.run([sys.executable, "-I", str(root / "release-plan.py"), "--root", str(tmp / "repo"), *extra],
                                    env=env, capture_output=True, text=True)
            return result, output.read_text() if output.exists() else ""

    def test_writes_outputs_for_a_new_version(self):
        result, output = self.run_plan([release("v0.2.7")])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output, "version=0.2.8\nnewer=true\n")

    def test_already_published_version_fails_only_when_required(self):
        result, output = self.run_plan([release("v0.2.8")], f"commit:{SHA}")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("newer=false", output)
        result, _ = self.run_plan([release("v0.2.8")], f"commit:{SHA}", "--require-newer")
        self.assertEqual(result.returncode, 1)

    def test_annotated_tag_is_followed_to_its_commit(self):
        result, _ = self.run_plan([release("v0.2.7")], "tag:" + "c" * 40, annotated_target=SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        result, _ = self.run_plan([release("v0.2.7")], "tag:" + "c" * 40, annotated_target="d" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不是本次测试的提交", result.stderr)


if __name__ == "__main__":
    unittest.main()
