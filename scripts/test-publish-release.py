import sys
sys.dont_write_bytecode=True
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location("publisher",Path(__file__).with_name("publish-release.py"))
publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)

class PublicationTests(unittest.TestCase):
    def fixture(self, directory):
        for arch in ("aarch64","x64"):
            for suffix in ("", ".sig", ".metadata.json", ".metadata.json.sig"):
                (directory/f"music-manager_0.2.8_{arch}.dmg{suffix}").write_bytes(b"fixture")
        (directory/"latest.json").write_bytes(b"feed")
        (directory/"install-macos.sh").write_bytes(b"compatibility installer entry")

    def test_partial_draft_is_verified_before_publication_and_can_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root);assets=[];calls=[]
            def run(*args):
                calls.append(args)
                if args[-1]=="repos/owner/repo/releases?per_page=100":return "[]"
                if args[:3]==("api","--method","POST"):return json.dumps({"id":1})
                if args==("api","repos/owner/repo/releases/1/assets?per_page=100"):return json.dumps(assets)
                if args[:2]==("release","upload"):
                    path=Path(args[3]);assets.append({"name":path.name,"size":path.stat().st_size,"digest":"sha256:"+hashlib.sha256(path.read_bytes()).hexdigest()});return ""
                if args[:3]==("api","--method","PATCH"):
                    self.assertEqual(len(assets),10);return ""
                raise AssertionError(args)
            publisher.publish("owner/repo","a"*40,"0.2.8",root,"notes",run)
            self.assertEqual(calls[-1][:3],("api","--method","PATCH"))
            # Re-running the same incomplete draft reuses its verified assets.
            calls.clear()
            def resumed(*args):
                if args[-1]=="repos/owner/repo/releases?per_page=100":
                    return json.dumps([{"id":1,"tag_name":"v0.2.8","draft":True,"target_commitish":"a"*40,"body":"<!-- music-manager-source:"+"a"*40+" -->"}])
                return run(*args)
            publisher.publish("owner/repo","a"*40,"0.2.8",root,"notes",resumed)
            self.assertFalse(any(c[:2]==("release","upload") for c in calls))

    def test_published_release_is_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            with self.assertRaises(ValueError):
                publisher.publish("owner/repo","a"*40,"0.2.8",root,"notes",lambda *a:json.dumps([{"tag_name":"v0.2.8","draft":False}]))

    def test_digest_mismatch_never_publishes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root);calls=[]
            assets=[{"name":p.name,"size":p.stat().st_size,"digest":"sha256:wrong"} for p in root.iterdir()]
            def run(*args):
                calls.append(args)
                if args[-1].endswith("?per_page=100") and "/assets" in args[-1]:return json.dumps(assets)
                return json.dumps([{"id":1,"tag_name":"v0.2.8","draft":True,"target_commitish":"a"*40,"body":"<!-- music-manager-source:"+"a"*40+" -->"}])
            with self.assertRaises(ValueError):publisher.publish("owner/repo","a"*40,"0.2.8",root,"notes",run)
            self.assertFalse(any("PATCH" in c for c in calls))

if __name__=="__main__":unittest.main()
