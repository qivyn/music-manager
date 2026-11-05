//! Download signed releases; hand off only to the verified standalone installer.
//! The updater never opens, copies, or migrates a music library.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use crate::update_store::{self, CachedUpdate, SignedMetadata};
use futures_util::future::{AbortHandle, Abortable};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const PUBLIC_KEY: &str = include_str!("../updater-public-key.txt");
const APP_NAME: &str = "声场档案.app";
const INSTALLER_NAME: &str = "安装与更新声场档案.app";
#[path = "update_diagnostics.rs"]
mod diagnostics;

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct UpdateError { pub error_code:&'static str, pub message:String }
impl From<String> for UpdateError {
    fn from(message:String)->Self {
        let code=if message.contains("签名")||message.contains("公钥")||message.contains("摘要"){ "SIGNATURE" }
        else if message.contains("空间"){ "SPACE" }
        else if message.contains("权限")||message.contains("授权"){ "PERMISSION" }
        else if message.contains("协议")||message.contains("系统")||message.contains("芯片")||message.contains("架构"){ "COMPATIBILITY" }
        else if message.contains("网络")||message.contains("获取更新"){ "NETWORK" }
        else if message.contains("冲突")||message.contains("正在")||message.contains("另一"){ "CONFLICT" }
        else if message.contains("退出"){ "EXIT" }
        else if message.contains("启动"){ "STARTUP" }
        else if message.contains("清理"){ "CLEANUP" }
        else if message.contains("状态")||message.contains("事务"){ "TRANSACTION" }
        else { "IO" };
        Self{error_code:code,message}
    }
}
impl From<&str> for UpdateError {fn from(message:&str)->Self{message.to_string().into()}}
impl From<UpdateError> for String {fn from(error:UpdateError)->Self{error.message}}
type CommandResult<T> = Result<T,UpdateError>;

#[tauri::command]
pub async fn export_update_diagnostics(app: tauri::AppHandle, destination: PathBuf, context: serde_json::Value) -> CommandResult<()> {
    if serde_json::to_vec(&context).map_err(|e|e.to_string())?.len()>32_768 {return Err("诊断上下文过长".into());}
    let logs=installer_log_root(&app)?;
    let states=installer_state_roots(&app)?;let cache=cache_root(&app)?;
    Ok(tauri::async_runtime::spawn_blocking(move || diagnostics::export_to(&destination,&logs,&states,&cache,&context))
        .await.map_err(|e|e.to_string())??)
}
fn installer_log_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let id=if app.config().identifier=="com.musicmanager.app" {"com.musicmanager.installer".to_string()}
        else {format!("{}.installer",app.config().identifier)};
    let logs=app.path().home_dir().map_err(|e|e.to_string())?.join("Library/Logs").join(id);
    Ok(logs)
}

#[derive(Default)]
pub struct UpdateManager {
    busy: AtomicBool,
    available: Mutex<Option<Update>>,
    downloaded: Mutex<Option<CachedUpdate>>,
    cancellation: Mutex<Option<AbortHandle>>,
    preparing: Mutex<Option<PathBuf>>,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) { self.0.store(false, Ordering::Release); }
}
impl UpdateManager {
    fn begin(&self) -> Result<Busy<'_>, String> {
        self.busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "更新操作正在进行，请稍候".to_string())?;
        Ok(Busy(&self.busy))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    version: Option<String>,
    notes: String,
    downloaded: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
    transaction_id: Option<String>,
}
fn progress(app: &tauri::AppHandle, phase: &'static str, downloaded: u64, total: Option<u64>) {
    let _ = app.emit("app-update-progress", Progress { phase, downloaded, total, transaction_id: None });
}
fn asset_arch() -> Result<&'static str, String> {
    // An Intel app running under Rosetta must still fetch the native Apple Silicon release.
    if Command::new("/usr/sbin/sysctl").args(["-n", "hw.optional.arm64"]).output()
        .is_ok_and(|o| o.status.success() && o.stdout.starts_with(b"1")) {
        return Ok("aarch64");
    }
    match std::env::consts::ARCH {
        "aarch64" => Ok("aarch64"),
        "x86_64" => Ok("x64"),
        _ => Err("这台设备暂不支持应用内更新".into()),
    }
}
fn validate_release(version: &str, url: &str, arch: &str, current: &str) -> Result<(), String> {
    let next = semver::Version::parse(version).map_err(|_| "更新版本号无效")?;
    let current = semver::Version::parse(current).map_err(|_| "当前版本号无效")?;
    if next <= current || !next.pre.is_empty() || !next.build.is_empty() {
        return Err("更新版本必须是高于当前版本的正式版本".into());
    }
    let expected = format!("https://github.com/qivyn/music-manager/releases/download/v{version}/music-manager_{version}_{arch}.dmg");
    let legacy = expected.replace("qivyn/music-manager", "AI-AQI/music-manager");
    if url != expected && url != legacy { return Err("更新包地址与版本或设备架构不匹配".into()); }
    Ok(())
}
pub fn verify_cached(bytes: &[u8], signature: &str, public_key: &str) -> Result<(), String> {
    let decode = |value: &str| -> Result<String, String> {
        String::from_utf8(STANDARD.decode(value.trim()).map_err(|_| "更新签名编码无效")?)
            .map_err(|_| "更新签名内容无效".into())
    };
    let key = minisign_verify::PublicKey::decode(&decode(public_key)?).map_err(|_| "更新公钥无效")?;
    let signature = minisign_verify::Signature::decode(&decode(signature)?).map_err(|_| "更新签名无效")?;
    key.verify(bytes, &signature, true).map_err(|_| "更新包签名校验失败，请重新下载".into())
}

#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle, state: tauri::State<'_, UpdateManager>) -> CommandResult<UpdateInfo> {
    let _busy = state.begin()?;
    installation(&app)?;
    let arch = asset_arch()?;
    let target = if arch == "x64" { "darwin-x86_64" } else { "darwin-aarch64" };
    let mut update = app.updater_builder().target(target).timeout(Duration::from_secs(20))
        .build().map_err(|e| {
            eprintln!("初始化更新失败：{e}");
            "无法初始化更新。请从“应用程序”中打开已安装的声场档案后重试。".to_string()
        })?
        .check().await.map_err(|e| {
            eprintln!("检查更新失败：{e}");
            "暂时无法获取更新。请检查网络后重试；也可能暂未发布支持应用内升级的新版本。".to_string()
        })?;
    if let Some(next) = &mut update {
        validate_release(&next.version, next.download_url.as_str(), arch, crate::db::APP_VERSION)?;
        let signed = metadata_for(next, arch)?;
        let meta = signed.verify(PUBLIC_KEY)?;
        check_compatibility(&meta, arch)?;
        next.timeout = Some(Duration::from_secs(600));
    }
    let cached = load_cached(&app).unwrap_or(None);
    let downloaded = cached.as_ref().is_some_and(|c| update.as_ref().is_some_and(|u| u.version == c.version));
    let info = UpdateInfo {
        current_version: crate::db::APP_VERSION.into(),
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.as_ref().and_then(|u| u.body.clone()).unwrap_or_default(),
        downloaded,
    };
    *state.downloaded.lock().map_err(|e| e.to_string())? = cached;
    *state.available.lock().map_err(|e| e.to_string())? = update;
    Ok(info)
}

#[tauri::command]
pub async fn download_app_update(app: tauri::AppHandle, state: tauri::State<'_, UpdateManager>) -> CommandResult<()> {
    let _busy = state.begin()?;
    let update = state.available.lock().map_err(|e| e.to_string())?.clone()
        .ok_or("请先检查更新")?;
    let arch = asset_arch()?;
    let metadata = metadata_for(&update, arch)?;
    let meta = metadata.verify(PUBLIC_KEY)?;
    check_compatibility(&meta, arch)?;
    if let Some(cached) = load_cached(&app).unwrap_or(None) {
        if cached.version == update.version { *state.downloaded.lock().map_err(|e| e.to_string())? = Some(cached); return Ok(()); }
    }
    let cache = cache_root(&app)?;
    fs::create_dir_all(&cache).map_err(|e|e.to_string())?;
    ensure_space(&cache, meta.package_size + 100*1024*1024)?;
    let job = tempfile::Builder::new().prefix("update-").tempdir_in(&cache).map_err(|e|e.to_string())?;
    let transaction_id = job.path().file_name().unwrap().to_string_lossy().into_owned();
    let (abort, registration) = AbortHandle::new_pair();
    let size_abort=abort.clone();
    *state.cancellation.lock().map_err(|e| e.to_string())? = Some(abort);

    let mut received = 0u64;
    let mut last_event = Instant::now() - Duration::from_secs(1);
    let _=app.emit("app-update-progress",Progress{phase:"downloading",downloaded:0,total:None,transaction_id:Some(transaction_id.clone())});
    let transfer = update.download(|size, total| {
        received += size as u64;
        if received > meta.package_size {size_abort.abort();}
        if last_event.elapsed() >= Duration::from_millis(100) || total == Some(received) {
            let _ = app.emit("app-update-progress", Progress{phase:"downloading",downloaded:received,total,transaction_id:Some(transaction_id.clone())});
            last_event = Instant::now();
        }
    }, || progress(&app, "verifying", 0, None));
    let result = Abortable::new(transfer, registration).await;
    state.cancellation.lock().map_err(|e| e.to_string())?.take();
    let bytes = result.map_err(|_| if received>meta.package_size {"更新包大小超过已签名声明".to_string()}else{"下载已取消".to_string()})?
        .map_err(|e| format!("下载或签名校验失败，当前应用未被更改。\n{e}"))?;
    if bytes.len() as u64 != meta.package_size || update_store::digest(&bytes) != meta.sha256 { return Err("更新包与兼容信息不匹配".into()); }
    update_store::atomic_write(&job.path().join("update.dmg"), &bytes)?;
    let record = CachedUpdate { format_version: 2,
        transaction_id: job.path().file_name().unwrap().to_string_lossy().into_owned(),
        version: update.version.clone(), signature: update.signature.clone(), metadata,
        notes: update.body.clone().unwrap_or_default() };
    update_store::atomic_write(&job.path().join("update.json"), &serde_json::to_vec(&record).map_err(|e|e.to_string())?)?;
    // Keep the handoff payload alive after the main application exits.
    let _path = job.keep();
    update_store::atomic_write(&cache.join("active.json"), &serde_json::to_vec(&record).map_err(|e|e.to_string())?)?;
    *state.downloaded.lock().map_err(|e| e.to_string())? = Some(record);
    progress(&app, "ready", received, Some(received));
    Ok(())
}

fn run(command: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let output = tempfile::tempfile().map_err(|e|e.to_string())?;
    let mut child = Command::new(command).args(args).stdout(output.try_clone().map_err(|e|e.to_string())?)
        .stderr(output).spawn().map_err(|e|e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(status) = child.try_wait().map_err(|e|e.to_string())? {
            if !status.success() { return Err(format!("{command} 未完成：{status}")); } break;
        }
        if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err(format!("{command} 执行超时")); }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}
fn plist(app: &Path, key: &str) -> Result<String, String> {
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", &format!("Print :{key}")]).arg(app.join("Contents/Info.plist"))
        .output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err("更新包的应用信息不完整".into()); }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
fn validate_payload(installer: &Path, version: &str) -> Result<(), String> {
    run("/usr/bin/codesign", &["--verify".as_ref(), "--deep".as_ref(), "--strict".as_ref(), installer.as_os_str()])?;
    let application = installer.join("Contents/Resources").join(APP_NAME);
    // The entire DMG is signed. Check its authenticated inner version against the
    // unsigned feed, so an old signed package cannot be relabelled as a newer release.
    for (bundle, id) in [(installer, "com.musicmanager.installer"), (application.as_path(), "com.musicmanager.app")] {
        if plist(bundle, "CFBundleIdentifier")? != id || plist(bundle, "CFBundleShortVersionString")? != version {
            return Err("更新包的身份或实际版本与更新清单不符，已停止更新".into());
        }
    }
    if plist(installer, "MusicManagerInAppUpdateProtocol")? != "1" {
        return Err("此安装包不支持应用内更新".into());
    }
    Ok(())
}
fn normalize_system_path(path:&Path)->PathBuf {
    if let Ok(real)=path.canonicalize(){return real;}
    if let Ok(rest)=path.strip_prefix("/tmp"){return PathBuf::from("/private/tmp").join(rest);}
    if let Ok(rest)=path.strip_prefix("/var"){return PathBuf::from("/private/var").join(rest);}
    path.to_owned()
}
fn installed_location(executable: &Path, home: &Path) -> Result<PathBuf, String> {
    update_store::reject_links(executable)?;
    let executable_path=normalize_system_path(executable);
    let executable=executable_path.as_path();
    let app = executable.parent().and_then(Path::parent).and_then(Path::parent).ok_or("无法确认应用安装位置")?;
    // This is both the running source and the replacement target: updates happen in place.
    let _ = home;
    if app.file_name().and_then(|s|s.to_str()) != Some(APP_NAME)
        || executable != app.join("Contents/MacOS/music-manager")
        || app.starts_with("/Volumes")
        || app.components().any(|c| c.as_os_str() == "target")
        || app.parent().is_some_and(|p| p.components().any(|c| c.as_os_str().to_string_lossy().ends_with(".app"))) {
        return Err("请使用正式安装包更新。开发目录和 DMG 中的应用不能作为迁移来源。".into());
    }
    Ok(app.to_owned())
}

#[derive(Deserialize)]
struct HandoffReply {
    token: String,
    version: String,
    pid: u32,
    error: Option<String>,
    protocol: Option<u8>,
}
fn prepare_handoff(job: &Path, update: &CachedUpdate, destination: &Path) -> Result<(), String> {
    let bytes = fs::read(job.join("update.dmg")).map_err(|e| e.to_string())?;
    verify_cached(&bytes, &update.signature, PUBLIC_KEY)?;
    let mount = tempfile::Builder::new().prefix("mount-").tempdir_in(job).map_err(|e| e.to_string())?;
    let helper_dir = tempfile::Builder::new().prefix("helper-").tempdir_in(job).map_err(|e| e.to_string())?;
    run("/usr/bin/hdiutil", &["attach".as_ref(), "-readonly".as_ref(), "-nobrowse".as_ref(),
        "-mountpoint".as_ref(), mount.path().as_os_str(), job.join("update.dmg").as_os_str()])?;
    let helper = helper_dir.path().join(INSTALLER_NAME);
    let copy_result = (|| {
        let source = mount.path().join(INSTALLER_NAME);
        validate_payload(&source, &update.version)?;
        run("/usr/bin/ditto", &[source.as_os_str(), helper.as_os_str()])?;
        validate_payload(&helper, &update.version)?;
        Ok::<_, String>(())
    })();
    let detach_result = run("/usr/bin/hdiutil", &["detach".as_ref(), mount.path().as_os_str()]);
    copy_result?;
    detach_result?;
    let helper_root = helper_dir.keep();
    let reply_path = helper_root.join("handoff.json");
    let token = helper_root.file_name().unwrap().to_string_lossy().into_owned();
    let log = fs::File::create(helper_root.join("handoff.log")).map_err(|e| e.to_string())?;
    let mut child = Command::new(helper.join("Contents/MacOS/music-manager-installer"))
        .arg("--update-protocol").arg("2")
        .arg("--update-destination").arg(destination)
        .arg("--parent-pid").arg(std::process::id().to_string())
        .arg("--expected-version").arg(&update.version)
        .arg("--handoff").arg(&reply_path).arg("--token").arg(&token)
        .stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log)
        .spawn().map_err(|e| format!("无法启动更新程序，当前应用继续运行：{e}"))?;
    let ready = (|| {
        let deadline = Instant::now() + Duration::from_secs(600);
        while Instant::now() < deadline {
            if let Ok(data) = fs::read(&reply_path) {
                let reply: HandoffReply = serde_json::from_slice(&data).map_err(|_| "更新程序响应无效")?;
                if reply.protocol != Some(2) || reply.token != token || reply.version != update.version || reply.pid != child.id() {
                    return Err("更新程序响应与本次操作不匹配".to_string());
                }
                if let Some(error) = reply.error { return Err(error); }
                return Ok(());
            }
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("更新程序启动失败，当前应用继续运行".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("更新程序未确认就绪，当前应用继续运行，请重试".into())
    })();
    if ready.is_err() {
        // The helper must wait for this parent to exit before modifying anything.
        let _ = child.kill();
        let _ = child.wait();
    }
    ready
}

#[tauri::command]
pub async fn restart_for_app_update(app: tauri::AppHandle, state: tauri::State<'_, UpdateManager>) -> CommandResult<()> {
    let _busy = state.begin()?;
    let update = load_cached(&app)?.ok_or("请先下载更新")?;
    let meta = update.metadata.verify(PUBLIC_KEY)?;
    check_compatibility(&meta, asset_arch()?)?;
    let job = update.validate(&cache_root(&app)?, PUBLIC_KEY, crate::db::APP_VERSION, asset_arch()?)?;
    let destination = installed_location(
        &std::env::current_exe().map_err(|e| e.to_string())?,
        &app.path().home_dir().map_err(|e| e.to_string())?,
    )?;
    crate::operation_gate::WRITES.pause(Duration::from_secs(60))?;
    progress(&app, "preparing", 0, None);
    let cancel_path = job.join("cancel-request");
    if cancel_path.exists() {update_store::reject_links(&cancel_path)?;fs::remove_file(&cancel_path).map_err(|e|e.to_string())?;}
    *state.preparing.lock().map_err(|e|e.to_string())?=Some(job.clone());
    let handoff = tauri::async_runtime::spawn_blocking(move || prepare_handoff(&job, &update, &destination))
        .await.map_err(|e| e.to_string()).and_then(|r|r);
    state.preparing.lock().map_err(|e|e.to_string())?.take();
    if cancel_path.exists() {crate::operation_gate::WRITES.resume();return Err("更新准备已取消，当前应用继续运行".into());}
    if let Err(error) = handoff { crate::operation_gate::WRITES.resume(); return Err(error.into()); }
    app.exit(0);
    Ok(())
}

fn ensure_space(path:&Path,required:u64)->Result<(),String>{
    use std::os::unix::ffi::OsStrExt;
    let path=std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_|"磁盘路径无效")?;
    let mut stats=std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe{libc::statvfs(path.as_ptr(),stats.as_mut_ptr())}!=0{return Err("无法检查缓存磁盘空间".into());}
    let stats=unsafe{stats.assume_init()};
    let free=(stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64);
    if free<required{return Err("缓存磁盘空间不足，请释放空间后重试".into());}Ok(())
}
fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
    update_store::reject_links(&root)?; Ok(root)
}
fn metadata_for(update: &Update, arch: &str) -> Result<SignedMetadata, String> {
    let target = if arch == "x64" { "darwin-x86_64" } else { "darwin-aarch64" };
    let signed:SignedMetadata=serde_json::from_value(update.raw_json["platforms"][target]["compatibility"].clone())
        .map_err(|_| "更新缺少已签名的兼容信息，请使用新版安装包".to_string())?;
    let meta=signed.verify(PUBLIC_KEY)?;
    if meta.version != update.version || meta.arch != arch {return Err("更新清单与已签名的实际版本不一致".into());}
    Ok(signed)
}
fn check_compatibility(meta: &update_store::Compatibility, arch: &str) -> Result<(), String> {
    if meta.arch != arch || semver::Version::parse(crate::db::APP_VERSION).map_err(|e|e.to_string())? < semver::Version::parse(&meta.minimum_client_version).map_err(|e|e.to_string())? {
        return Err("当前客户端或芯片不支持此更新，请使用安装包".into());
    }
    let os = Command::new("/usr/bin/sw_vers").arg("-productVersion").output().map_err(|e|e.to_string())?;
    let parse = |s: &str| -> Result<Vec<u32>, String> { s.trim().split('.').map(|p|p.parse::<u32>().map_err(|_|"系统版本无效".into())).collect() };
    let mut current = parse(&String::from_utf8_lossy(&os.stdout))?; current.resize(3,0);
    let mut minimum = parse(&meta.minimum_system_version)?; minimum.resize(3,0);
    if current < minimum { return Err(format!("此更新需要 macOS {} 或更新版本", meta.minimum_system_version)); }
    Ok(())
}
fn load_cached(app: &tauri::AppHandle) -> Result<Option<CachedUpdate>, String> {
    let root = cache_root(app)?; let path = root.join("active.json");
    if !path.exists() { return Ok(None); }
    update_store::reject_links(&path)?;
    let record: CachedUpdate = serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|_|"更新状态损坏，请重新下载")?;
    if semver::Version::parse(&record.version).map_err(|e|e.to_string())? <= semver::Version::parse(crate::db::APP_VERSION).map_err(|e|e.to_string())? { return Ok(None); }
    record.validate(&root, PUBLIC_KEY, crate::db::APP_VERSION, asset_arch()?)?;
    Ok(Some(record))
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct InstallationStatus {
    installation_path: String, current_version: String, arch: String, can_update: bool,
    other_installations: Vec<String>, message: String, needs_authorization: bool,
}
fn installation(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = installed_location(&std::env::current_exe().map_err(|e|e.to_string())?, &app.path().home_dir().map_err(|e|e.to_string())?)?;
    update_store::reject_links(&path)?;
    if plist(&path,"CFBundleIdentifier")? != app.config().identifier { return Err("安装身份不匹配".into()); }
    Ok(path)
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct UpdateWelcome { version: String, notes: String, launched_by_installer: bool, previous_version: Option<String> }
/// What the app shows once after it was installed or updated: this version's own notes.
#[tauri::command]
pub fn get_update_welcome() -> UpdateWelcome {
    UpdateWelcome { version: crate::db::APP_VERSION.into(), notes: include_str!("../../docs/update-notes.txt").trim().into(),
        launched_by_installer: std::env::var("MUSIC_MANAGER_STARTUP_SESSION").is_ok_and(|s| !s.is_empty()),
        previous_version: std::env::var("MUSIC_MANAGER_PREVIOUS_VERSION").ok().filter(|v| semver::Version::parse(v).is_ok()) }
}
#[tauri::command]
pub fn get_installation_status(app: tauri::AppHandle) -> CommandResult<InstallationStatus> {
    let result = installation(&app);
    let executable = std::env::current_exe().map_err(|e|e.to_string())?;
    let normalized=normalize_system_path(&executable);
    let path = normalized.parent().and_then(Path::parent).and_then(Path::parent).unwrap_or(&normalized);
    let home = app.path().home_dir().map_err(|e|e.to_string())?;
    let other_installations = [PathBuf::from("/Applications").join(APP_NAME), home.join("Applications").join(APP_NAME)]
        .into_iter().filter(|p|normalize_system_path(p) != path && p.exists()).map(|p|p.to_string_lossy().into_owned()).collect();
    // Replacing the app in place needs a password only when this user cannot write its folder.
    let needs_authorization = path.parent().is_some_and(|parent| !directory_writable(parent));
    Ok(InstallationStatus { installation_path:path.to_string_lossy().into_owned(),current_version:crate::db::APP_VERSION.into(),arch:asset_arch()?.into(),
        can_update:result.is_ok(),other_installations,message:result.err().unwrap_or_default(),needs_authorization })
}
fn directory_writable(path:&Path)->bool{
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(path.as_os_str().as_bytes()).is_ok_and(|p| unsafe{libc::access(p.as_ptr(),libc::W_OK|libc::X_OK)}==0)
}
#[tauri::command]
pub fn show_installation_in_finder(app: tauri::AppHandle) -> CommandResult<()> {
    let path = installation(&app)?;
    Ok(run("/usr/bin/open", &["-R".as_ref(),path.as_os_str()])?)
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct UpdateStatus {
    transaction_id: Option<String>, phase: &'static str, current_version: String, target_version: Option<String>,
    installation_path: String, downloaded: u64, total: Option<u64>, can_cancel: bool, can_retry: bool,
    error_code: Option<String>, message: String, cleanup_pending: bool, notes: String,
}
#[tauri::command]
pub fn get_update_status(app: tauri::AppHandle) -> CommandResult<UpdateStatus> {
    let cached = load_cached(&app)?;
    let root = cache_root(&app)?;
    let pending = cleanup_downloads(&root,&installer_state_roots(&app)?).is_err() || pending_cleanup(&root);
    Ok(UpdateStatus { transaction_id:cached.as_ref().map(|c|c.transaction_id.clone()),phase:if cached.is_some(){"ready"}else{"idle"},
        current_version:crate::db::APP_VERSION.into(),target_version:cached.as_ref().map(|c|c.version.clone()),
        installation_path:get_installation_status(app)?.installation_path,downloaded:0,total:None,can_cancel:false,can_retry:cached.is_some(),
        error_code:None,message:if cached.is_some(){"更新已下载并通过验证，可重启安装。"}else{"点击检查，获取最新版本。"}.into(),
        cleanup_pending:pending,notes:cached.map(|c|c.notes).unwrap_or_default() })
}
#[tauri::command]
pub fn cancel_app_update(state: tauri::State<'_,UpdateManager>) -> CommandResult<()> {
    if let Some(abort)=state.cancellation.lock().map_err(|e|e.to_string())?.take() { abort.abort(); return Ok(()); }
    if let Some(job)=state.preparing.lock().map_err(|e|e.to_string())?.as_ref() {
        update_store::atomic_write(&job.join("cancel-request"),b"cancel")?;return Ok(());
    }
    if state.busy.load(Ordering::Acquire) { return Err("当前阶段不能取消，请等待安全交接完成".into()); }
    crate::operation_gate::WRITES.resume(); Ok(())
}
#[tauri::command]
pub async fn prepare_update_exit() -> CommandResult<()> {
    Ok(tauri::async_runtime::spawn_blocking(|| crate::operation_gate::WRITES.pause(Duration::from_secs(60))).await.map_err(|e|e.to_string())??)
}
#[tauri::command]
pub fn abort_update_exit() { crate::operation_gate::WRITES.resume(); }
#[tauri::command]
pub fn retry_update_cleanup(app:tauri::AppHandle) -> CommandResult<()>{
    let root=cache_root(&app)?;
    if root.exists(){for entry in fs::read_dir(&root).map_err(|e|e.to_string())? {
        let job=entry.map_err(|e|e.to_string())?.path();
        if !job.file_name().unwrap_or_default().to_string_lossy().starts_with("update-"){continue;}
        update_store::reject_links(&job)?;
        let marker:serde_json::Value=fs::read(job.join("committed.json")).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
        if marker["cleanupPending"]==true {
            let record:CachedUpdate=serde_json::from_slice(&fs::read(job.join("update.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            let metadata=record.metadata.verify(PUBLIC_KEY)?;
            let bytes=fs::read(job.join("update.dmg")).map_err(|e|e.to_string())?;
            if update_store::digest(&bytes)!=metadata.sha256{return Err("清理执行器来源无法验证".into());}
            verify_cached(&bytes,&record.signature,PUBLIC_KEY)?;
            for helper in fs::read_dir(&job).map_err(|e|e.to_string())? {
                let helper=helper.map_err(|e|e.to_string())?.path().join(INSTALLER_NAME);
                if helper.exists(){validate_payload(&helper,&record.version)?;
                    run(helper.join("Contents/MacOS/music-manager-installer").to_str().ok_or("安装器路径无效")?,&["--installer-maintain".as_ref(),installation(&app)?.as_os_str()])?;break;}
            }
        }
    }}Ok(cleanup_downloads(&root,&installer_state_roots(&app)?)?)
}
pub fn automatic_cleanup(app:&tauri::AppHandle) {if let (Ok(root),Ok(states))=(cache_root(app),installer_state_roots(app)){let _=cleanup_downloads(&root,&states);}}
fn pending_cleanup(root:&Path)->bool{
    fs::read_dir(root).ok().into_iter().flatten().flatten().any(|e|e.path().join("committed.json").is_file())
}
fn installer_state_roots(app:&tauri::AppHandle)->Result<Vec<PathBuf>,String>{
    // Installation records are per user; there is no system-wide installer state.
    let home=app.path().home_dir().map_err(|e|e.to_string())?;
    Ok(vec![home.join("Library/Application Support/com.musicmanager.installer/user")])
}
fn marker_is_committed(marker:&serde_json::Value,id:&str,states:&[PathBuf])->bool{
    if marker["committed"]!=true || marker["cleanupPending"]==true || marker["jobId"]!=id{return false;}
    let Some(session)=marker["installerSession"].as_str()else{return false};
    if session.len()!=36 || !session.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-'){return false;}
    for root in states{
        if update_store::reject_links(root).is_err(){continue;}
        for path in [root.join("latest.json"),root.join("transactions").join(format!("{session}.json"))]{
            if update_store::reject_links(&path).is_err(){continue;}
            let record:serde_json::Value=fs::read(path).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
            if record["session"]==session && record["destination"]==marker["targetPath"] && record["cleanupPending"]!=true && (record["phase"]=="superseded" || (record["phase"]=="completed" && record["startupOutcome"].is_string())){return true;}
        }
    }false
}
fn cleanup_downloads(root:&Path,states:&[PathBuf])->Result<(),String>{
    if !root.exists(){return Ok(());} update_store::reject_links(root)?;
    let active:Option<CachedUpdate>=fs::read(root.join("active.json")).ok().and_then(|b|serde_json::from_slice(&b).ok());
    for entry in fs::read_dir(root).map_err(|e|e.to_string())? {
        let entry=entry.map_err(|e|e.to_string())?; let id=entry.file_name().to_string_lossy().into_owned();
        if !id.starts_with("update-"){continue;}
        let job=update_store::job_path(root,&id)?;
        let marker:serde_json::Value=fs::read(job.join("committed.json")).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
        let owned_commit=marker_is_committed(&marker,&id,states);
        let record:Option<CachedUpdate>=fs::read(job.join("update.json")).ok().and_then(|b|serde_json::from_slice(&b).ok());
        let authenticated=record.as_ref().is_some_and(|r|r.transaction_id==id && r.metadata.verify(PUBLIC_KEY).is_ok());
        if !authenticated && !owned_commit{continue;}
        let mut running=false;let mut handed_off=false;
        for helper in fs::read_dir(&job).map_err(|e|e.to_string())? {
            let helper=helper.map_err(|e|e.to_string())?.path();
            if !helper.file_name().unwrap_or_default().to_string_lossy().starts_with("helper-"){continue;}
            update_store::reject_links(&helper)?;
            if helper.is_dir(){for lease in fs::read_dir(&helper).map_err(|e|e.to_string())? {
                let lease=lease.map_err(|e|e.to_string())?.path();
                if !lease.file_name().unwrap_or_default().to_string_lossy().starts_with("active-installer-"){continue;}
                update_store::reject_links(&lease)?;
                let data:serde_json::Value=fs::read(&lease).ok().and_then(|b|serde_json::from_slice(&b).ok()).unwrap_or_default();
                if let Some(pid)=data["pid"].as_i64(){if pid>1 && pid<=i32::MAX as i64 && unsafe{libc::kill(pid as i32,0)}==0{running=true;}}
            }}
            if let Ok(data)=fs::read(helper.join("handoff.json")){
                handed_off=true;
                if let Ok(reply)=serde_json::from_slice::<HandoffReply>(&data){if unsafe{libc::kill(reply.pid as i32,0)}==0 {running=true;}}
            }
        }
        if running{continue;}
        let committed=owned_commit;
        let stale=entry.metadata().ok().and_then(|m|m.modified().ok()).and_then(|t|t.elapsed().ok()).is_some_and(|age|age>Duration::from_secs(86400));
        let referenced=active.as_ref().is_some_and(|c|c.transaction_id==id);
        if committed || (stale && !referenced && !handed_off) {
            fs::remove_dir_all(&job).map_err(|e|e.to_string())?;
            if referenced {fs::remove_file(root.join("active.json")).map_err(|e|e.to_string())?;}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_update_signature_rejects_corruption_and_wrong_keys() {
        let bytes = include_bytes!("../../scripts/fixtures/updater/signed-test.txt");
        let signature = include_str!("../../scripts/fixtures/updater/signed-test.txt.sig");
        let test_key = include_str!("../../scripts/fixtures/updater/test-public-key.txt");
        assert!(verify_cached(bytes, signature, test_key).is_ok());
        assert!(verify_cached(b"tampered", signature, test_key).is_err());
        assert!(verify_cached(bytes, signature, PUBLIC_KEY).is_err());
        assert!(verify_cached(bytes, "not a signature", test_key).is_err());
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["plugins"]["updater"]["pubkey"].as_str().unwrap(), PUBLIC_KEY.trim());
    }
    #[test]
    fn release_must_match_version_architecture_and_repository() {
        let url = "https://github.com/qivyn/music-manager/releases/download/v0.2.6/music-manager_0.2.6_aarch64.dmg";
        assert!(validate_release("0.2.6", url, "aarch64", "0.2.5").is_ok());
        assert!(validate_release("0.2.6", &url.replace("qivyn/music-manager","AI-AQI/music-manager"), "aarch64", "0.2.5").is_ok());
        for (version, arch, current) in [("0.2.6", "x64", "0.2.5"), ("0.2.7", "aarch64", "0.2.5"),
            ("0.2.6", "aarch64", "0.2.6"), ("0.2.6-beta.1", "aarch64", "0.2.5")] {
            assert!(validate_release(version, url, arch, current).is_err());
        }
        assert!(validate_release("0.2.6", &url.replace("github.com", "example.com"), "aarch64", "0.2.5").is_err());
    }
    #[test]
    fn development_and_disk_image_apps_cannot_be_replaced() {
        let home = Path::new("/Users/test");
        assert!(installed_location(Path::new("/Applications/声场档案.app/Contents/MacOS/music-manager"), home).is_ok());
        assert!(installed_location(Path::new("/Users/test/Applications/声场档案.app/Contents/MacOS/music-manager"), home).is_ok());
        assert!(installed_location(Path::new("/Users/test/Downloads/声场档案.app/Contents/MacOS/music-manager"), home).is_ok());
        for path in ["/Users/test/project/target/release/声场档案.app/Contents/MacOS/music-manager", "/Volumes/Test/声场档案.app/Contents/MacOS/music-manager", "/tmp/music-manager", "/Applications/Other.app/Contents/MacOS/music-manager"] {
            assert!(installed_location(Path::new(path), home).is_err());
        }
    }
    #[test]
    fn system_aliases_identify_the_same_installation() {
        assert_eq!(normalize_system_path(Path::new("/tmp/missing-test/app.app")),normalize_system_path(Path::new("/private/tmp/missing-test/app.app")));
    }
    #[test]
    fn legacy_cache_cleanup_requires_a_committed_matching_transaction() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("updates");let states=temp.path().join("state");
        fs::create_dir_all(&states).unwrap();fs::create_dir_all(root.join("update-owned")).unwrap();fs::create_dir_all(root.join("update-unknown")).unwrap();
        fs::write(root.join("update-owned/update.dmg"),b"legacy cache").unwrap();
        let session="AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
        let marker=serde_json::json!({"committed":true,"cleanupPending":false,"jobId":"update-owned","installerSession":session,"targetPath":"/Applications/声场档案.app"});
        fs::write(root.join("update-owned/committed.json"),serde_json::to_vec(&marker).unwrap()).unwrap();
        let mut receipt=serde_json::json!({"session":session,"destination":"/Applications/声场档案.app","phase":"starting"});
        fs::write(states.join("latest.json"),serde_json::to_vec(&receipt).unwrap()).unwrap();
        cleanup_downloads(&root,&[states.clone()]).unwrap();assert!(root.join("update-owned").exists());
        receipt["phase"]="completed".into();receipt["startupOutcome"]="ready".into();
        fs::write(states.join("latest.json"),serde_json::to_vec(&receipt).unwrap()).unwrap();
        let helper=root.join("update-owned/helper-live");fs::create_dir(&helper).unwrap();
        let lease=helper.join("active-installer-test.json");fs::write(&lease,format!("{{\"pid\":{}}}",std::process::id())).unwrap();
        cleanup_downloads(&root,&[states.clone()]).unwrap();assert!(root.join("update-owned").exists());
        fs::remove_file(lease).unwrap();
        cleanup_downloads(&root,&[states]).unwrap();assert!(!root.join("update-owned").exists());assert!(root.join("update-unknown").exists());
    }
    #[test]
    fn welcome_notes_belong_to_this_version() {
        let welcome=get_update_welcome();
        assert_eq!(welcome.version,crate::db::APP_VERSION);
        assert!(welcome.notes.contains(&format!("v{}",crate::db::APP_VERSION)),"update notes do not describe this version");
    }
    #[test]
    fn concurrent_update_operations_are_rejected_and_failures_release_lock() {
        let state = UpdateManager::default();
        let busy = state.begin().unwrap();
        assert!(state.begin().is_err());
        drop(busy);
        assert!(state.begin().is_ok());
    }
}
