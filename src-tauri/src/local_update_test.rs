//! Debug-only CLI handoff. Runs before Tauri, production settings, or the library.
use std::{ffi::OsString, path::Path, process::Command};

fn command(manifest: &Path, arguments: impl IntoIterator<Item = OsString>) -> Result<Command, String> {
    let script = manifest.parent().ok_or("无法定位项目目录")?.join("scripts/local-update-test.py");
    if !script.is_file() { return Err("找不到本地更新测试脚本，请在项目源码中运行 cargo tauri dev".into()); }
    let mut command = Command::new("python3");
    command.arg(script).args(arguments);
    Ok(command)
}

pub fn launch(arguments: impl IntoIterator<Item = OsString>) -> ! {
    use std::os::unix::process::CommandExt;
    let result = command(Path::new(env!("CARGO_MANIFEST_DIR")), arguments);
    let error = match result {
        Ok(mut command) => command.exec().to_string(),
        Err(error) => error,
    };
    eprintln!("无法启动本地更新测试：{error}");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_passes_arguments_without_starting_the_application() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("scripts")).unwrap();
        std::fs::write(root.path().join("scripts/local-update-test.py"), "# fixture").unwrap();
        let arguments = [OsString::from("--scenario"), OsString::from("install-failure")];
        let cmd = command(&root.path().join("src-tauri"), arguments).unwrap();
        assert_eq!(cmd.get_program(), "python3");
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), [
            root.path().join("scripts/local-update-test.py").as_os_str(),
            std::ffi::OsStr::new("--scenario"), std::ffi::OsStr::new("install-failure")]);
    }
    #[test]
    fn missing_test_script_fails_without_falling_back_to_production() {
        let root = tempfile::tempdir().unwrap();
        assert!(command(&root.path().join("src-tauri"), []).is_err());
    }
}
