//! Authenticated, resumable download records. Never reads the music library.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::{Path, PathBuf}};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedMetadata { pub data: String, pub signature: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    pub version: String, pub arch: String, pub minimum_system_version: String,
    pub minimum_client_version: String, pub installer_protocol: u8, pub startup_protocol: u8,
    pub schema: i64, pub package_size: u64, pub expanded_size: u64, pub sha256: String,
    pub public_key_fingerprint: String,
    #[serde(default)] pub next_public_key: Option<String>,
}
impl SignedMetadata {
    pub fn verify(&self, key: &str) -> Result<Compatibility, String> {
        let bytes = STANDARD.decode(&self.data).map_err(|_| "更新兼容信息编码错误")?;
        crate::updater::verify_cached(&bytes, &self.signature, key)?;
        let meta: Compatibility = serde_json::from_slice(&bytes).map_err(|_| "更新兼容信息无效")?;
        if meta.installer_protocol != 2 || meta.startup_protocol != 1 || meta.schema < 1 || meta.package_size == 0 || meta.expanded_size == 0 || meta.sha256.len() != 64 {
            return Err("更新协议或包信息不受支持".into());
        }
        if meta.public_key_fingerprint != digest(key.trim().as_bytes()) {
            let next=meta.next_public_key.as_deref().ok_or("下一版更新公钥缺少旧钥授权")?;
            let decoded=STANDARD.decode(next.trim()).map_err(|_|"下一版公钥编码无效")?;
            let decoded=String::from_utf8(decoded).map_err(|_|"下一版公钥无效")?;
            minisign_verify::PublicKey::decode(&decoded).map_err(|_|"下一版公钥无效")?;
            if digest(next.trim().as_bytes()) != meta.public_key_fingerprint{return Err("下一版更新公钥指纹不匹配".into());}
        }
        Ok(meta)
    }
}
pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedUpdate {
    pub format_version: u8, pub transaction_id: String, pub version: String,
    pub signature: String, pub metadata: SignedMetadata, pub notes: String,
}
pub fn reject_links(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        if part == Path::new("/var") || part == Path::new("/tmp") { continue; }
        match fs::symlink_metadata(part) {
            Ok(meta) if meta.file_type().is_symlink() => return Err("安装或缓存路径包含符号链接".into()),
            Ok(_) => (), Err(e) if e.kind() == std::io::ErrorKind::NotFound => (), Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    reject_links(path)?;
    fs::create_dir_all(path.parent().ok_or("状态路径无效")?).map_err(|e| e.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    temporary.write_all(bytes).and_then(|_| temporary.as_file().sync_all()).map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    fs::File::open(path.parent().unwrap()).and_then(|f| f.sync_all()).map_err(|e| e.to_string())
}
pub fn job_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !id.starts_with("update-") || id.len() > 100 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("更新事务标识无效".into());
    }
    let path = root.join(id); reject_links(&path)?; Ok(path)
}
impl CachedUpdate {
    pub fn validate(&self, root: &Path, key: &str, current: &str, arch: &str) -> Result<PathBuf, String> {
        if self.format_version != 2 { return Err("缓存格式不受支持".into()); }
        let meta = self.metadata.verify(key)?;
        if meta.version != self.version || meta.arch != arch || semver::Version::parse(&self.version).map_err(|e|e.to_string())? <= semver::Version::parse(current).map_err(|e|e.to_string())? {
            return Err("缓存版本或架构不匹配".into());
        }
        let job = job_path(root, &self.transaction_id)?;
        reject_links(&job.join("update.dmg"))?;
        let bytes = fs::read(job.join("update.dmg")).map_err(|e|e.to_string())?;
        if bytes.len() as u64 != meta.package_size || digest(&bytes) != meta.sha256 { return Err("更新缓存摘要不匹配，请重新下载".into()); }
        crate::updater::verify_cached(&bytes, &self.signature, key)?;
        Ok(job)
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn paths_cannot_escape_or_follow_links() {
        let temp = tempfile::tempdir().unwrap();
        for id in ["../update-a", "update-a/b", "update-.", "x"] { assert!(job_path(temp.path(),id).is_err()); }
        std::os::unix::fs::symlink("/Applications",temp.path().join("update-link")).unwrap();
        assert!(job_path(temp.path(),"update-link").is_err());
    }
    #[test] fn atomic_records_survive_reopening_and_refuse_symlinks() {
        let temp = tempfile::tempdir().unwrap(); let path=temp.path().join("state.json");
        atomic_write(&path,b"first").unwrap(); atomic_write(&path,b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(),b"second"); fs::remove_file(&path).unwrap();
        let sentinel=temp.path().join("sentinel");fs::write(&sentinel,b"safe").unwrap();
        std::os::unix::fs::symlink(&sentinel,&path).unwrap();assert!(atomic_write(&path,b"unsafe").is_err());
        assert_eq!(fs::read(sentinel).unwrap(),b"safe");
    }
}

#[cfg(test)] mod signed_store_tests {
    use super::*;
    const KEY:&str=include_str!("../../scripts/fixtures/updater/lifecycle-public-key.txt");
    fn record()->CachedUpdate{
        CachedUpdate{format_version:2,transaction_id:"update-fixture".into(),version:"0.2.8".into(),
            signature:include_str!("../../scripts/fixtures/updater/lifecycle-package.txt.sig").into(),
            metadata:SignedMetadata{data:STANDARD.encode(include_bytes!("../../scripts/fixtures/updater/lifecycle-metadata.json")),signature:include_str!("../../scripts/fixtures/updater/lifecycle-metadata.json.sig").into()},notes:String::new()}
    }
    fn package(root:&Path){fs::create_dir_all(root.join("update-fixture")).unwrap();fs::write(root.join("update-fixture/update.dmg"),include_bytes!("../../scripts/fixtures/updater/lifecycle-package.txt")).unwrap();}
    #[test] fn verified_cache_survives_serialization_and_reopening(){
        let root=tempfile::tempdir().unwrap();package(root.path());let record=record();
        atomic_write(&root.path().join("active.json"),&serde_json::to_vec(&record).unwrap()).unwrap();
        let reopened:CachedUpdate=serde_json::from_slice(&fs::read(root.path().join("active.json")).unwrap()).unwrap();
        assert!(reopened.validate(root.path(),KEY,"0.2.7","aarch64").is_ok());
    }
    #[test] fn wrong_key_relabel_arch_downgrade_and_tampering_are_rejected(){
        let root=tempfile::tempdir().unwrap();package(root.path());let mut record=record();
        assert!(record.validate(root.path(),include_str!("../updater-public-key.txt"),"0.2.7","aarch64").is_err());
        assert!(record.validate(root.path(),KEY,"0.2.7","x64").is_err());
        assert!(record.validate(root.path(),KEY,"0.2.8","aarch64").is_err());
        record.version="0.2.9".into();assert!(record.validate(root.path(),KEY,"0.2.7","aarch64").is_err());record.version="0.2.8".into();
        fs::write(root.path().join("update-fixture/update.dmg"),b"tampered").unwrap();
        assert!(record.validate(root.path(),KEY,"0.2.7","aarch64").is_err());
    }
}

#[cfg(test)] mod rotation_tests {
    use super::*;
    #[test] fn next_key_requires_authorization_signed_by_the_current_key() {
        let key=include_str!("../../scripts/fixtures/updater/lifecycle-public-key.txt");
        for (bytes,signature,allowed) in [
            (include_bytes!("../../scripts/fixtures/updater/rotation-authorized.json").as_slice(),include_str!("../../scripts/fixtures/updater/rotation-authorized.json.sig"),true),
            (include_bytes!("../../scripts/fixtures/updater/rotation-unauthorized.json").as_slice(),include_str!("../../scripts/fixtures/updater/rotation-unauthorized.json.sig"),false),
            (include_bytes!("../../scripts/fixtures/updater/rotation-mismatched.json").as_slice(),include_str!("../../scripts/fixtures/updater/rotation-mismatched.json.sig"),false),
        ] {
            let signed=SignedMetadata{data:STANDARD.encode(bytes),signature:signature.into()};
            assert_eq!(signed.verify(key).is_ok(),allowed);
        }
    }
}
