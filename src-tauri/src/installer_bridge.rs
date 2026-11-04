//! Same-user manual installer exit requests; the frontend still asks before quitting.
use crate::update_store;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Emitter,Manager};
#[derive(Default)] pub struct ExitRequests(pub Mutex<Option<String>>);
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Request { token:String, pid:u32, application_path:String }
fn root(app:&tauri::AppHandle)->Result<PathBuf,String>{
    let id=if app.config().identifier=="com.musicmanager.app" {"com.musicmanager.installer".into()} else {format!("{}.installer",app.config().identifier)};
    Ok(app.path().home_dir().map_err(|e|e.to_string())?.join("Library/Application Support").join(id).join("runtime"))
}
pub fn start(app:&tauri::AppHandle)->Result<(),String>{
    let root=root(app)?;update_store::reject_links(&root)?;fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;
    let app=app.clone();let pid=std::process::id();
    let path=root.join(format!("{pid}-request.json"));
    // Forget stale requests left by a previous process that used this PID.
    if path.exists(){fs::remove_file(&path).map_err(|e|e.to_string())?;}
    std::thread::spawn(move||{
        let mut seen=String::new();
        loop {
            if let Ok(bytes)=fs::read(&path){
                if let Ok(request)=serde_json::from_slice::<Request>(&bytes){
                    let exe=std::env::current_exe().ok().and_then(|p|p.canonicalize().ok());
                    let target=exe.as_ref().and_then(|p|p.parent()?.parent()?.parent());
                    if request.pid==pid && request.token.len()==36 && request.token.bytes().all(|c|c.is_ascii_hexdigit()||c==b'-') && target.is_some_and(|p|p.to_string_lossy()==request.application_path) && request.token!=seen {
                        seen=request.token.clone();
                        if let Ok(mut pending)=app.state::<ExitRequests>().0.lock(){*pending=Some(request.token.clone());}
                        let _=app.emit("installer-exit-request",request);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });Ok(())
}
#[tauri::command]
pub fn respond_installer_exit(app:tauri::AppHandle, token:String, approved:bool)->Result<(),String>{
    let state=app.state::<ExitRequests>();
    let mut pending=state.0.lock().map_err(|e|e.to_string())?;
    if pending.as_deref()!=Some(&token){return Err("安装退出请求已失效".into());}
    if approved && !crate::operation_gate::WRITES.is_paused(){return Err("应用尚未完成退出准备".into());}
    let reply=serde_json::json!({"token":token,"pid":std::process::id(),"approved":approved});
    update_store::atomic_write(&root(&app)?.join(format!("{}-reply.json",std::process::id())),&serde_json::to_vec(&reply).map_err(|e|e.to_string())?)?;
    *pending=None;
    if approved {app.exit(0);}else{crate::operation_gate::WRITES.resume();} Ok(())
}
pub fn check_launch_lock()->Result<(),String>{
    let exe=std::env::current_exe().map_err(|e|e.to_string())?;
    let Some(target)=exe.parent().and_then(|p|p.parent()).and_then(|p|p.parent())else{return Ok(())};
    if target.extension().and_then(|s|s.to_str())!=Some("app"){return Ok(())}
    let lock=if target==std::path::Path::new("/Applications/声场档案.app"){
        PathBuf::from("/Library/Application Support/com.musicmanager.installer/system/target.lock")
    }else{target.parent().unwrap().join(".music-manager-installer.lock")};
    update_store::reject_links(&lock)?;
    let Ok(file)=fs::File::open(lock)else{return Ok(())};
    use std::os::fd::AsRawFd;
    if unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}==0{return Ok(())}
    // A child explicitly launched by the lock holder may report startup. Normal launches wait.
    let session=std::env::var("MUSIC_MANAGER_STARTUP_SESSION").unwrap_or_default();
    let report=std::env::var_os("MUSIC_MANAGER_STARTUP_REPORT").map(PathBuf::from);
    if session.len()==36 && session.bytes().all(|b|b.is_ascii_hexdigit()||b==b'-') && report.as_ref().and_then(|p|p.parent()).is_some_and(|p|p.file_name().is_some_and(|s|s==session.as_str())) {return Ok(())}
    Err("声场档案正在安装或更新，请等待安装窗口完成后再打开。".into())
}
