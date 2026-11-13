//! Cancellable folder discovery, kept off Tauri's event loop.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::Emitter;

type Scans = Mutex<HashMap<String, Arc<AtomicBool>>>;
static SCANS: OnceLock<Scans> = OnceLock::new();
fn scans() -> &'static Scans {
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScan {
    items: Vec<ProbeResult>,
    warnings: Vec<String>,
    cancelled: bool,
}

fn discover(paths: Vec<String>, cancelled: &AtomicBool) -> (Vec<PathBuf>, Vec<String>) {
    let mut pending: Vec<_> = paths.into_iter().map(PathBuf::from).collect();
    let mut visited = HashSet::new();
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    while let Some(path) = pending.pop() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(error) => {
                warnings.push(format!("{}：{error}", path.display()));
                continue;
            }
        };
        // Resolve once, including symlinks. Repeated roots, aliases and cycles
        // must not revisit a directory or import the same physical path twice.
        if !visited.insert(canonical.clone()) {
            continue;
        }
        if canonical.is_dir() {
            match fs::read_dir(&canonical) {
                Ok(entries) => {
                    for entry in entries {
                        if cancelled.load(Ordering::Relaxed) {
                            break;
                        }
                        match entry {
                            Ok(entry) => pending.push(entry.path()),
                            Err(error) => {
                                warnings.push(format!("{}：{error}", canonical.display()))
                            }
                        }
                    }
                }
                Err(error) => warnings.push(format!("{}：{error}", canonical.display())),
            }
        } else if canonical.is_file()
            && canonical
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("mp3"))
        {
            files.push(canonical);
        }
    }
    files.sort();
    (files, warnings)
}

#[tauri::command]
pub async fn scan_import_sources(
    app: tauri::AppHandle,
    paths: Vec<String>,
    request_id: String,
) -> Result<ImportScan, String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("无效的导入任务".into());
    }
    let cancelled = {
        let mut running = scans().lock().map_err(|e| e.to_string())?;
        if running.len() >= 16 {
            return Err("导入任务过多，请等待当前任务完成".into());
        }
        if running.contains_key(&request_id) {
            return Err("该导入任务已经开始".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        running.insert(request_id.clone(), cancelled.clone());
        cancelled
    };
    // Acknowledge registration so an early UI cancellation can be resent after
    // the task exists. Late cancellation never creates a new registry entry.
    let _ = app.emit(
        "import-scan-progress",
        serde_json::json!({"requestId":request_id,"completed":0,"total":0,"started":true}),
    );
    let task_id = request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let (files, mut warnings) = discover(paths, &cancelled);
        let total = files.len();
        let mut items = Vec::new();
        let mut last = std::time::Instant::now();
        for (index, path) in files.into_iter().enumerate() {
            if cancelled.load(Ordering::Relaxed) {
                break;
            }
            let item = probe_path(path.to_string_lossy().into_owned());
            if item.exists {
                items.push(item);
            } else {
                warnings.push(format!("{}：文件已不可访问", path.display()));
            }
            if last.elapsed().as_millis() >= 100 || index + 1 == total {
                let _ = app.emit(
                    "import-scan-progress",
                    serde_json::json!({"requestId":task_id,"completed":index+1,"total":total}),
                );
                last = std::time::Instant::now();
            }
        }
        ImportScan {
            items,
            warnings,
            cancelled: cancelled.load(Ordering::Relaxed),
        }
    })
    .await
    .map_err(|e| format!("读取导入文件失败：{e}"));
    scans()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&request_id);
    result
}

#[tauri::command]
pub fn cancel_import_scan(request_id: String) -> Result<(), String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("无效的导入任务".into());
    }
    let running = scans().lock().map_err(|e| e.to_string())?;
    if let Some(cancelled) = running.get(&request_id) {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_finished_scans_does_not_reserve_task_slots() {
        let id = "completed-scan-regression".to_string();
        cancel_import_scan(id.clone()).unwrap();
        assert!(!scans().lock().unwrap().contains_key(&id));
    }
    #[test]
    fn scan_reports_missing_roots_and_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("track.mp3"), b"audio").unwrap();
        let roots = vec![
            dir.path().to_string_lossy().into_owned(),
            dir.path().join("missing").to_string_lossy().into_owned(),
        ];
        let (files, warnings) = discover(roots.clone(), &AtomicBool::new(false));
        assert_eq!(files.len(), 1);
        assert_eq!(warnings.len(), 1);
        assert!(discover(roots, &AtomicBool::new(true)).0.is_empty());
    }
    #[test]
    #[cfg(unix)]
    fn scan_visits_overlapping_roots_and_symlink_cycles_once() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let track = nested.join("track.mp3");
        fs::write(&track, b"audio").unwrap();
        std::os::unix::fs::symlink(dir.path(), nested.join("cycle")).unwrap();
        std::os::unix::fs::symlink(&track, dir.path().join("alias.mp3")).unwrap();
        let roots = vec![
            dir.path().to_string_lossy().into_owned(),
            nested.to_string_lossy().into_owned(),
        ];
        let (files, warnings) = discover(roots, &AtomicBool::new(false));
        assert!(warnings.is_empty());
        assert_eq!(files, vec![track.canonicalize().unwrap()]);
    }
}
