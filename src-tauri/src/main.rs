// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn app_context() -> tauri::Context<tauri::Wry> { music_manager_lib::app_context() }

fn main() {
    #[cfg(target_os="macos")]
    if std::env::args().nth(1).as_deref()==Some("--installer-update-info") {
        let context=app_context();
        println!("{}",serde_json::json!({"version":music_manager_lib::db::APP_VERSION,
            "publicKeyFingerprint":music_manager_lib::update_store::digest(music_manager_lib::updater::PUBLIC_KEY.trim().as_bytes()),
            "endpoint":context.config().plugins.0.get("updater").and_then(|v|v.get("endpoints")).cloned(),
            "installerProtocol":2,"startupProtocol":1}));
        return;
    }
    // A separate read-only process, before creating any window or opening a writable DB.
    if std::env::args().nth(1).as_deref() == Some("--installer-check-rollback") {
        let result = (|| -> Result<(), String> {
            let schema = std::env::args().nth(2).and_then(|s| s.parse::<i64>().ok())
                .ok_or_else(|| "缺少旧版支持的数据库版本".to_string())?;
            let home = std::env::var_os("HOME").ok_or_else(|| "无法获取用户目录".to_string())?;
            let context=app_context();
            let identifier = context.config().identifier.clone();
            let dir = std::path::PathBuf::from(home).join("Library/Application Support").join(identifier);
            music_manager_lib::db::check_rollback_compatibility(&dir, schema)
        })();
        match result {
            Ok(()) => println!("compatible"),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
        return;
    }
    music_manager_lib::run()
}
