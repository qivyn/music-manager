import sys
sys.dont_write_bytecode=True
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
spec=importlib.util.spec_from_file_location("publisher",Path(__file__).with_name("publish-release.py"))
publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)
spec=importlib.util.spec_from_file_location('preparer',Path(__file__).with_name('prepare-release.py'))
preparer=importlib.util.module_from_spec(spec);spec.loader.exec_module(preparer)

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

    def test_upload_failure_resumes_only_missing_assets_of_same_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root);assets=[];published=[];attempt=[0]
            draft={'id':1,'tag_name':'v0.2.8','draft':True,'target_commitish':'a'*40,'body':'<!-- music-manager-source:'+'a'*40+' -->'}
            def run(*args):
                if args[-1]=='repos/owner/repo/releases?per_page=100':return json.dumps([draft])
                if args==('api','repos/owner/repo/releases/1/assets?per_page=100'):return json.dumps(assets)
                if args[:2]==('release','upload'):
                    if attempt[0]==0 and len(assets)==3:raise RuntimeError('connection lost')
                    p=Path(args[3]);self.assertNotIn(p.name,[a['name'] for a in assets])
                    assets.append({'name':p.name,'size':p.stat().st_size,'digest':'sha256:'+hashlib.sha256(p.read_bytes()).hexdigest()});return ''
                if args[:3]==('api','--method','PATCH'):published.append(True);return ''
                raise AssertionError(args)
            with self.assertRaises(RuntimeError):publisher.publish('owner/repo','a'*40,'0.2.8',root,'notes',run)
            self.assertEqual(len(assets),3);self.assertEqual(published,[])
            attempt[0]=1
            publisher.publish('owner/repo','a'*40,'0.2.8',root,'notes',run)
            self.assertEqual(len(assets),10);self.assertEqual(published,[True])


class CandidateTests(unittest.TestCase):
    def fixture(self, root):
        directory=root/'dist';directory.mkdir()
        for arch in ('aarch64','x64'):
            p=directory/f'music-manager_0.2.8_{arch}.dmg';p.write_bytes(b'package')
            Path(str(p)+'.metadata.json').write_text(json.dumps({'version':'0.2.8','arch':arch,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}))
        notes=root/'notes';notes.write_text('notes')
        key=root/'public-key';key.write_text('test public key')
        calls=[]
        def run(args,check):
            calls.append(args)
            if args[:4]==['cargo','tauri','signer','sign']:
                Path(args[4]+'.sig').write_bytes((Path(__file__).parent/'fixtures/updater/signed-test.txt.sig').read_bytes())
        return directory,key,notes,calls,run

    def test_prepare_then_resume_reverifies_without_resigning_or_changing_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory,key,notes,calls,run=self.fixture(Path(tmp))
            preparer.prepare('0.2.8',directory,key,notes,'aarch64-apple-darwin',run)
            self.assertEqual(sum(c[1]=='tauri' for c in calls),4)
            before={p.name:p.read_bytes() for p in directory.iterdir()};self.assertEqual(len(before),10)
            calls.clear()
            preparer.prepare('0.2.8',directory,key,notes,'aarch64-apple-darwin',run)
            self.assertEqual(len(calls),4);self.assertTrue(all(c[1]=='run' for c in calls))
            self.assertEqual(before,{p.name:p.read_bytes() for p in directory.iterdir()})

    def test_saved_bad_signature_is_rejected_without_replacing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory,key,notes,calls,run=self.fixture(Path(tmp))
            sig=directory/'music-manager_0.2.8_aarch64.dmg.sig';sig.write_text('bad')
            def reject(args,check):
                self.assertEqual(args[1],'run')
                raise subprocess.CalledProcessError(1,args)
            with self.assertRaises(subprocess.CalledProcessError):preparer.prepare('0.2.8',directory,key,notes,'',reject)
            self.assertEqual(sig.read_text(),'bad');self.assertFalse((directory/'latest.json').exists())

    def test_incomplete_and_unexpected_candidates_are_rejected(self):
        for case in ('missing','extra','symlink'):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as tmp:
                directory,key,notes,calls,run=self.fixture(Path(tmp))
                p=directory/'music-manager_0.2.8_x64.dmg'
                if case=='missing':p.unlink()
                if case=='extra':(directory/'unrecognized').write_text('extra')
                if case=='symlink':p.unlink();p.symlink_to(notes)
                with self.assertRaises(ValueError):preparer.prepare('0.2.8',directory,key,notes,'',run)
                self.assertEqual(calls,[])

    def test_saved_artifact_selection_rejects_ambiguity_and_other_commits(self):
        artifact={'id':42,'name':'release-candidate-'+'a'*40,'expired':False}
        self.assertEqual(preparer.saved_candidate_id([artifact],'a'*40),'42')
        self.assertEqual(preparer.saved_candidate_id([artifact],'b'*40),'')
        self.assertEqual(preparer.saved_candidate_id([{**artifact,'expired':True}],'a'*40),'')
        with self.assertRaises(ValueError):preparer.saved_candidate_id([artifact,artifact],'a'*40)
        with self.assertRaises(ValueError):preparer.saved_candidate_id([artifact],'not-a-commit')

if __name__=="__main__":unittest.main()
