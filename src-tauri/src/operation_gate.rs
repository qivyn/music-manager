//! Process-wide write barrier shared by IPC and the installer exit handshake.
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct OperationGate { state: Mutex<(bool, usize)>, changed: Condvar }
pub struct Operation<'a>(&'a OperationGate);
impl Drop for Operation<'_> {
    fn drop(&mut self) { let mut s = self.0.state.lock().unwrap_or_else(|e| e.into_inner()); s.1 -= 1; self.0.changed.notify_all(); }
}
impl OperationGate {
    pub fn enter(&self) -> Result<Operation<'_>, String> {
        let mut s = self.state.lock().map_err(|_| "操作状态不可用")?;
        if s.0 { return Err("正在准备更新，暂不接受新的写入操作".into()); }
        s.1 += 1; Ok(Operation(self))
    }
    pub fn pause(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut s = self.state.lock().map_err(|_| "操作状态不可用")?;
        s.0 = true;
        while s.1 > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { s.0 = false; return Err("操作仍在进行，更新已取消，请稍后重试".into()); }
            s = self.changed.wait_timeout(s, remaining).map_err(|_| "操作状态不可用")?.0;
        }
        Ok(())
    }
    pub fn is_paused(&self) -> bool { self.state.lock().map(|s|s.0 && s.1==0).unwrap_or(false) }
    pub fn resume(&self) { if let Ok(mut s) = self.state.lock() { s.0 = false; self.changed.notify_all(); } }
}
pub static WRITES: OperationGate = OperationGate { state: Mutex::new((false, 0)), changed: Condvar::new() };

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn pause_rejects_new_writes_and_abort_reopens() {
        let gate = OperationGate::default(); gate.pause(Duration::ZERO).unwrap(); assert!(gate.enter().is_err());
        gate.resume(); assert!(gate.enter().is_ok());
    }
    #[test] fn timeout_preserves_existing_work_and_reopens() {
        let gate = OperationGate::default(); let work = gate.enter().unwrap();
        assert!(gate.pause(Duration::from_millis(1)).is_err()); assert!(gate.enter().is_ok()); drop(work);
        gate.pause(Duration::ZERO).unwrap();
    }
    #[test] fn pause_waits_until_accepted_work_finishes() {
        let owned = OperationGate::default();
        std::thread::scope(|scope| {
            let gate = &owned; let work = gate.enter().unwrap();
            scope.spawn(move || { std::thread::sleep(Duration::from_millis(20)); drop(work); });
            gate.pause(Duration::from_secs(1)).unwrap(); assert!(gate.enter().is_err());
        });
    }
}
