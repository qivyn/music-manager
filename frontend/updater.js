/* The backend owns release URLs, signature checks and the installation location. */
(function (root) {
    function createUpdaterController({ invoke, listen, onChange, prepareRestart }) {
        const state = { phase: "idle", busy: false, version: "", currentVersion: "", notes: "", message: "点击检查，获取最新版本。", downloaded: 0, total: null, transactionId: null, cleanupPending: false };
        const notify = () => onChange({ ...state });
        const errorMessage = error => error?.message || String(error);
        const listener = listen("app-update-progress", event => {
            if (!state.busy || !["downloading", "verifying"].includes(state.phase)) return;
            const progress = event.payload;
            if (progress.transactionId && state.transactionId && progress.transactionId !== state.transactionId) return;
            if (progress.transactionId) state.transactionId = progress.transactionId;
            if (!["downloading", "verifying"].includes(progress.phase)) return;
            Object.assign(state, { phase: progress.phase, downloaded: progress.downloaded, total: progress.total });
            state.message = progress.phase === "verifying" ? "下载完成，正在验证更新包…" : "正在下载更新，可以继续使用音乐库。";
            notify();
        });
        async function check() {
            if (state.busy) return;
            Object.assign(state, { phase: "checking", busy: true, message: "正在检查更新…", notes: "", version: "" });
            notify();
            try {
                const result = await invoke("check_app_update");
                Object.assign(state, {
                    currentVersion: result.currentVersion, version: result.version || "", notes: result.notes || "",
                    phase: result.downloaded ? "ready" : result.version ? "available" : "latest",
                    message: result.version ? `发现新版本 ${result.version}` : "当前已是最新版本。"
                });
            } catch (error) {
                state.phase = "idle"; state.message = errorMessage(error);
            } finally { state.busy = false; notify(); }
        }
        async function restore() {
            if (state.busy) return;
            state.busy = true; notify();
            try {
                const saved = await invoke("get_update_status");
                if (saved) Object.assign(state, saved, { version: saved.targetVersion || "", busy: true });
            } catch (error) { state.message = errorMessage(error); }
            finally { state.busy = false; notify(); }
        }
        async function cancel() {
            try { await invoke("cancel_app_update"); }
            catch (error) { state.message = errorMessage(error); notify(); }
        }
        async function download() {
            if (state.busy || state.phase !== "available") return;
            Object.assign(state, { phase: "downloading", busy: true, downloaded: 0, total: null, transactionId: null, message: "正在下载更新，可以继续使用音乐库。" });
            notify();
            try {
                await listener;
                await invoke("download_app_update");
                state.phase = "ready";
                state.message = "更新包已下载并通过签名校验，点击“重启并更新”安装。";
            } catch (error) {
                state.phase = "available"; state.message = errorMessage(error);
            } finally { state.busy = false; notify(); }
        }
        async function restart() {
            if (state.busy || state.phase !== "ready") return;
            state.busy = true; state.message = "正在准备更新，等待当前操作完成…"; notify();
            let release;
            try {
                release = await prepareRestart();
                if (!release) { state.message = "更新已下载，你可以稍后重启安装。"; return; }
                state.phase = "preparing"; state.message = "正在准备安装，可取消；当前应用保持运行…"; notify();
                await invoke("restart_for_app_update");
                state.message = "更新程序已就绪，正在重启…";
            } catch (error) {
                state.phase = "ready"; state.message = errorMessage(error);
            } finally {
                if (release) release();
                state.busy = false; notify();
            }
        }
        notify();
        // Event permission failures are surfaced on download, without an unhandled rejection.
        listener.catch(() => {});
        return { state, check, download, restart, restore, cancel };
    }
    if (typeof module !== "undefined" && module.exports) module.exports = { createUpdaterController };
    if (!root.document) return;
    const modal = document.getElementById("updateModal");
    const open = document.getElementById("checkUpdateBtn");
    const close = document.getElementById("closeUpdateBtn");
    const action = document.getElementById("updateActionBtn");
    const recheck = document.getElementById("updateRecheckBtn");
    const status = document.getElementById("updateStatus");
    const notes = document.getElementById("updateNotes");
    const version = document.getElementById("updateVersion");
    const progress = document.getElementById("updateProgress");
    const meter = document.getElementById("updateProgressLabel");
    const location = document.getElementById("updateInstallation");
    const reveal = document.getElementById("updateRevealBtn");
    const cancel = document.getElementById("updateCancelBtn");
    const cleanup = document.getElementById("updateCleanupBtn");
    let installation = null;
    const api = root.__TAURI__;
    if (!api) { open.disabled = true; return; }
    const controller = createUpdaterController({
        invoke: (command) => api.core.invoke(command),
        listen: (event, handler) => api.event.listen(event, handler),
        prepareRestart: () => prepareApplicationUpdate(),
        onChange: state => {
            status.textContent = state.message;
            notes.textContent = state.notes;
            notes.hidden = !state.notes;
            version.textContent = state.currentVersion ? `当前版本 ${state.currentVersion}` : "声场档案";
            action.disabled = state.busy || state.phase === "restarting" || installation?.canUpdate === false;
            if (cancel) {cancel.hidden = !["downloading", "verifying", "preparing"].includes(state.phase); cancel.textContent = state.phase === "preparing" ? "取消准备" : "取消下载"; cancel.disabled = !state.busy;}
            if (cleanup) cleanup.hidden = !state.cleanupPending;
            action.textContent = state.phase === "ready" ? "重启并更新"
                : ["available", "downloading", "verifying"].includes(state.phase) ? "下载更新" : "检查更新";
            recheck.hidden = !["ready", "available"].includes(state.phase);
            recheck.disabled = state.busy;
            const downloading = ["downloading", "verifying"].includes(state.phase);
            progress.hidden = !downloading;
            meter.hidden = !downloading;
            if (state.total > 0) {
                progress.max = state.total; progress.value = state.downloaded;
                meter.textContent = `${Math.min(100, Math.round(state.downloaded / state.total * 100))}%`;
            } else {
                progress.removeAttribute("value");
                meter.textContent = state.downloaded ? `${(state.downloaded / 1048576).toFixed(1)} MB` : "";
            }
        }
    });
    api.event.listen("installer-exit-request", async event => {
        let release;
        try {
            release = await prepareApplicationUpdate();
            await api.core.invoke("respond_installer_exit", {token:event.payload.token,approved:Boolean(release)});
        } catch (error) {
            if (release) release();
            await api.core.invoke("respond_installer_exit", {token:event.payload.token,approved:false}).catch(() => {});
            status.textContent = String(error);
        }
    }).catch(console.error);
    if (api.app?.getVersion) {
        api.app.getVersion().then(current => {
            controller.state.currentVersion = current;
            version.textContent = `当前版本 ${current}`;
        }).catch(() => {});
    }
    if (reveal) reveal.addEventListener("click", () => api.core.invoke("show_installation_in_finder").catch(error => {status.textContent = String(error);}));
    if (cancel) cancel.addEventListener("click", () => controller.cancel());
    if (cleanup) cleanup.addEventListener("click", async () => {
        try {await api.core.invoke("retry_update_cleanup"); await controller.restore();}
        catch(error) {status.textContent = String(error);}
    });
    open.addEventListener("click", async () => {
        modal.classList.remove("hidden");
        try {
            installation = await api.core.invoke("get_installation_status");
            if (location && installation) location.textContent = `${installation.installationPath} · ${installation.arch}`
                + (installation.otherInstallations?.length ? `\n发现其他安装：${installation.otherInstallations.join("、")}` : "");
            if (reveal) reveal.disabled = !installation?.canUpdate;
            await controller.restore();
            if (installation?.canUpdate === false) {status.textContent = installation.message; action.disabled = true; return;}
            if (controller.state.phase === "idle") await controller.check();
        } catch (error) {status.textContent = String(error);}
    });
    close.addEventListener("click", () => modal.classList.add("hidden"));
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !modal.classList.contains("hidden")) {
            modal.classList.add("hidden");
        }
    });
    recheck.addEventListener("click", () => controller.check());
    action.addEventListener("click", () => {
        if (controller.state.phase === "ready") return controller.restart();
        if (controller.state.phase === "available") return controller.download();
        return controller.check();
    });
})(typeof window === "undefined" ? globalThis : window);
