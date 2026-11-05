//! Bounded, allowlisted update evidence. Never open the music library or audio.
use super::*;
use std::io::{Read, Seek, SeekFrom};

const LIMIT: u64 = 2_000_000;
fn session(name: &str) -> bool {
    name.len()==36 && name.bytes().enumerate().all(|(i,b)|
        if [8,13,18,23].contains(&i) {b==b'-'} else {b.is_ascii_hexdigit()})
}
fn recent(root: &Path, allowed: impl Fn(&str)->bool) -> Vec<PathBuf> {
    if update_store::reject_links(root).is_err() {return vec![];}
    let mut paths:Vec<_>=fs::read_dir(root).ok().into_iter().flatten().flatten()
        .map(|e|e.path()).filter(|p|allowed(&p.file_name().unwrap_or_default().to_string_lossy())
            && update_store::reject_links(p).is_ok() && p.is_dir()).collect();
    paths.sort_by_key(|p|std::cmp::Reverse(fs::metadata(p).and_then(|m|m.modified()).ok()));
    paths.truncate(5);paths
}
fn copy_known(source: &Path, destination: &Path, omissions: &mut Vec<String>) -> Result<(), String> {
    if !source.exists() {return Ok(());}
    if update_store::reject_links(source).is_err() || !source.is_file() {
        omissions.push(format!("未读取非普通文件：{}",source.display()));return Ok(());
    }
    let result=(|| -> std::io::Result<()> {
        let mut file=fs::File::open(source)?;let size=file.metadata()?.len();
        if size>LIMIT {file.seek(SeekFrom::Start(size-LIMIT))?;}
        let mut bytes=Vec::new();file.take(LIMIT).read_to_end(&mut bytes)?;
        fs::create_dir_all(destination.parent().unwrap())?;fs::write(destination,bytes)
    })();
    if let Err(error)=result {omissions.push(format!("未读取 {}：{error}",source.display()));}
    Ok(())
}
pub(super) fn export_to(destination: &Path, logs: &Path, states: &[PathBuf], cache: &Path,
                       context: &serde_json::Value) -> Result<(), String> {
    if !destination.is_absolute() || destination.extension().and_then(|s|s.to_str())!=Some("zip") {
        return Err("请选择 ZIP 诊断文件的保存位置".into());
    }
    update_store::reject_links(destination)?;
    let temporary=tempfile::tempdir().map_err(|e|e.to_string())?;
    let bundle=temporary.path().join("update-diagnostics");fs::create_dir(&bundle).map_err(|e|e.to_string())?;
    let mut omissions=Vec::new();
    copy_known(&logs.join("latest.json"),&bundle.join("legacy/latest.json"),&mut omissions)?;
    for run in recent(logs,session) {
        for name in ["installer.log","application.log","startup.json","transaction.json","error.txt"] {
            copy_known(&run.join(name),&bundle.join("installer").join(run.file_name().unwrap()).join(name),&mut omissions)?;
        }
        // Installer.launch stores each launch beneath <transaction>/attempts/<token>.
        // Keep these reports even when the failed application never stayed open.
        for attempt in recent(&run.join("attempts"),session) {
            for name in ["application.log","startup.json","attempt.json","error.txt"] {
                let target=bundle.join("installer").join(run.file_name().unwrap())
                    .join("attempts").join(attempt.file_name().unwrap()).join(name);
                copy_known(&attempt.join(name),&target,&mut omissions)?;
            }
        }
    }
    for (i,state) in states.iter().enumerate() {
        for name in ["latest.json","previous.json"] {
            copy_known(&state.join(name),&bundle.join(format!("state-{i}")).join(name),&mut omissions)?;
        }
    }
    for job in recent(cache,|name|name.starts_with("update-")) {
        for helper in recent(&job,|name|name.starts_with("helper-")) {
            for name in ["handoff.json","handoff.log"] {
                copy_known(&helper.join(name),&bundle.join("handoff").join(job.file_name().unwrap())
                    .join(helper.file_name().unwrap()).join(name),&mut omissions)?;
            }
        }
    }
    let summary=serde_json::json!({"appVersion":crate::db::APP_VERSION,"arch":std::env::consts::ARCH,
        "context":context,"omissions":omissions,"notice":"仅包含更新状态与日志，不含音乐库、设置或音频。日志可能含本机路径，请仅发给可信的管理员或开发者。"});
    fs::write(bundle.join("summary.json"),serde_json::to_vec_pretty(&summary).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let zip=temporary.path().join("diagnostics.zip");
    run("/usr/bin/ditto",&["-c".as_ref(),"-k".as_ref(),"--keepParent".as_ref(),bundle.as_os_str(),zip.as_os_str()])?;
    let mut target=tempfile::NamedTempFile::new_in(destination.parent().ok_or("保存位置无效")?).map_err(|e|e.to_string())?;
    std::io::copy(&mut fs::File::open(zip).map_err(|e|e.to_string())?,&mut target).map_err(|e|e.to_string())?;
    target.as_file().sync_all().map_err(|e|e.to_string())?;
    target.persist(destination).map_err(|e|e.to_string())?;Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION: &str = "12345678-1234-1234-1234-123456789012";
    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path, bytes).unwrap();
    }
    fn entries(zip: &Path) -> String {
        let out=Command::new("/usr/bin/unzip").args(["-Z1"]).arg(zip).output().unwrap();
        assert!(out.status.success());String::from_utf8(out.stdout).unwrap()
    }
    #[test]
    fn exports_failure_and_known_logs_even_when_receipt_is_corrupt() {
        let root=tempfile::tempdir().unwrap();let root=root.path();
        let logs=root.join("logs");let state=root.join("state");let cache=root.join("cache");
        write(&logs.join(SESSION).join("installer.log"),b"system transaction invalid");
        write(&logs.join("latest.json"),b"broken json");
        write(&state.join("latest.json"),b"{\"phase\":\"starting\"}");
        write(&cache.join("update-test/helper-test/handoff.log"),b"handoff failed");
        for name in ["library.db","settings.json","audio.wav"] {write(&logs.join(SESSION).join(name),b"PRIVATE");}
        write(&cache.join("update-test/update.dmg"),b"PACKAGE");
        let zip=root.join("diagnostics.zip");
        export_to(&zip,&logs,&[state],&cache,&serde_json::json!({"message":"failed restart"})).unwrap();
        let list=entries(&zip);
        for name in ["summary.json","installer.log","latest.json","handoff.log"] {assert!(list.contains(name),"{list}");}
        for name in ["library.db","settings.json","audio.wav","update.dmg"] {assert!(!list.contains(name));}
        let summary=Command::new("/usr/bin/unzip").args(["-p"]).arg(&zip).arg("*/summary.json").output().unwrap();
        assert!(String::from_utf8_lossy(&summary.stdout).contains("failed restart"));
    }
    #[test]
    fn missing_logs_still_export_context_and_symlinked_evidence_is_omitted() {
        let root=tempfile::tempdir().unwrap();let root=root.path();
        let logs=root.join("logs");let outside=root.join("private");
        write(&outside,b"PRIVATE");fs::create_dir_all(logs.join(SESSION)).unwrap();
        std::os::unix::fs::symlink(&outside,logs.join(SESSION).join("installer.log")).unwrap();
        let zip=root.join("diagnostics.zip");
        export_to(&zip,&logs,&[],&root.join("missing-cache"),&serde_json::json!({"message":"download failed"})).unwrap();
        assert!(!entries(&zip).contains("installer.log"));
        assert_eq!(fs::read(outside).unwrap(),b"PRIVATE");
    }
    #[test]
    fn rejects_output_symlink_without_replacing_existing_data() {
        let root=tempfile::tempdir().unwrap();let root=root.path();let keep=root.join("keep");
        write(&keep,b"KEEP");let zip=root.join("diagnostics.zip");
        std::os::unix::fs::symlink(&keep,&zip).unwrap();
        assert!(export_to(&zip,&root.join("logs"),&[],&root.join("cache"),&serde_json::json!({})).is_err());
        assert_eq!(fs::read(keep).unwrap(),b"KEEP");
    }
    #[test]
    fn includes_real_startup_attempt_layout_without_following_links() {
        let root=tempfile::tempdir().unwrap();let root=root.path();
        let logs=root.join("logs");
        let token="87654321-4321-4321-4321-210987654321";
        let attempt=logs.join(SESSION).join("attempts").join(token);
        for (name,bytes) in [("application.log",b"startup panicked".as_slice()),
            ("startup.json",b"{\"state\":\"failed\"}".as_slice()),
            ("attempt.json",b"{\"version\":\"0.2.8\"}".as_slice()),
            ("error.txt",b"startup failed".as_slice())] {write(&attempt.join(name),bytes);}
        write(&attempt.join("library.db"),b"PRIVATE");
        write(&logs.join(SESSION).join("attempts/not-a-session/application.log"),b"UNKNOWN");
        let private=root.join("private.txt");write(&private,b"PRIVATE");
        let linked=logs.join(SESSION).join("attempts").join(SESSION);fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(&private,linked.join("application.log")).unwrap();
        let zip=root.join("diagnostics.zip");
        export_to(&zip,&logs,&[],&root.join("cache"),&serde_json::json!({})).unwrap();
        let list=entries(&zip);
        for name in ["application.log","startup.json","attempt.json","error.txt"] {
            assert!(list.contains(&format!("{SESSION}/attempts/{token}/{name}")),"{list}");
        }
        assert!(!list.contains("library.db") && !list.contains("not-a-session"));
        assert!(!list.contains(&format!("attempts/{SESSION}/application.log")));
        let output=Command::new("/usr/bin/unzip").arg("-p").arg(&zip)
            .arg(format!("*/{token}/application.log")).output().unwrap();
        assert!(output.status.success());assert_eq!(output.stdout,b"startup panicked");
    }
}
