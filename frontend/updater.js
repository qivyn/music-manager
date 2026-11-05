/* The backend owns release URLs, signature checks and the installation location. */
(function (root) {
    function updatePresentation(state) {
        if (state.errorAction) {
            const signature = /签名|signature|公钥|摘要/i.test(state.message);
            const title = signature ? "更新包未通过验证" : ({check:"暂时无法检查更新",download:"下载未完成",install:"更新未完成",status:"暂时无法读取更新状态",installation:"此位置暂不支持更新"}[state.errorAction] || "更新暂时遇到问题");
            const message = signature ? "请重新下载更新。当前安装的应用未被替换。"
                : state.errorAction === "installation" ? state.message
                : state.errorAction === "check" ? "请检查网络连接后重试。若仍有问题，可以导出诊断文件帮助排查。"
                : "你可以重试，或导出诊断文件交给管理员或开发者排查。";
            return { title, message, tone: "warning", symbol: "!" };
        }
        const titles = {idle:"检查是否有可用更新",checking:"正在检查更新",available:"发现新版本",downloading:"正在下载更新",verifying:"正在验证更新包",ready:"更新已准备好",preparing:"正在准备安装",restarting:"正在重启更新",latest:"已是最新版本"};
        return {title:titles[state.phase] || "软件更新",message:state.message,
            tone:["ready","latest"].includes(state.phase)?"success":"neutral",
            symbol:["ready","latest"].includes(state.phase)?"✓":"↓"};
    }
    function createUpdaterController({ invoke, listen, onChange, prepareRestart, chooseDiagnosticsPath, revealDiagnostics }) {
        const state = { phase: "idle", busy: false, version: "", currentVersion: "", notes: "", message: "检查并安装声场档案的最新版本。", errorAction: "", downloaded: 0, total: null, transactionId: null, cleanupPending: false,
            diagnosticsMessage: "", diagnosticsPath: "", diagnosticsError: "", diagnosticsRevealError: "", diagnosticsExporting: false, diagnosticsRevealing: false };
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
            Object.assign(state, { phase: "checking", busy: true, message: "正在获取可用版本，请稍候。", notes: "", version: "", errorAction: "" });
            notify();
            try {
                const result = await invoke("check_app_update");
                Object.assign(state, {
                    currentVersion: result.currentVersion, version: result.version || "", notes: result.notes || "",
                    phase: result.downloaded ? "ready" : result.version ? "available" : "latest",
                    message: result.version ? `发现新版本 ${result.version}` : "当前已是最新版本。"
                });
            } catch (error) {
                state.phase = "idle"; state.message = errorMessage(error); state.errorAction = "check";
            } finally { state.busy = false; notify(); }
        }
        async function restore() {
            if (state.busy) return;
            state.busy = true; notify();
            try {
                const saved = await invoke("get_update_status");
                if (saved) Object.assign(state, saved, { version: saved.targetVersion || "", busy: true, errorAction: saved.errorCode ? "status" : "" });
            } catch (error) { state.message = errorMessage(error); state.errorAction = "status"; }
            finally { state.busy = false; notify(); }
        }
        async function cancel() {
            try { await invoke("cancel_app_update"); }
            catch (error) { state.message = errorMessage(error); state.errorAction = "status"; notify(); }
        }
        async function download() {
            if (state.busy || state.phase !== "available") return;
            Object.assign(state, { phase: "downloading", busy: true, downloaded: 0, total: null, transactionId: null, message: "正在下载更新，可以继续使用音乐库。", errorAction: "" });
            notify();
            try {
                await listener;
                await invoke("download_app_update");
                state.phase = "ready";
                state.message = "更新包已下载并通过签名校验，点击“重启并更新”安装。";
            } catch (error) {
                state.phase = "available"; state.message = errorMessage(error); state.errorAction = "download";
            } finally { state.busy = false; notify(); }
        }
        async function restart() {
            if (state.busy || state.phase !== "ready") return;
            // The confirmation dialog comes first; only then does the panel report waiting.
            state.busy = true; state.errorAction = ""; notify();
            let release;
            try {
                release = await prepareRestart(() => { state.message = "正在等待当前操作完成…"; notify(); });
                if (!release) { state.message = "更新已下载，你可以稍后重启安装。"; return; }
                state.phase = "preparing"; state.message = "正在准备安装，可取消；当前应用保持运行…"; notify();
                await invoke("restart_for_app_update");
                state.message = "更新程序已就绪，正在重启…";
            } catch (error) {
                state.phase = "ready"; state.message = errorMessage(error); state.errorAction = "install";
            } finally {
                if (release) release();
                state.busy = false; notify();
            }
        }
        async function exportDiagnostics() {
            if (state.busy || state.diagnosticsRevealing) return;
            state.busy = true; state.diagnosticsExporting = true; notify();
            try {
                const destination = await chooseDiagnosticsPath();
                if (!destination) return;
                state.diagnosticsError = ""; state.diagnosticsRevealError = "";
                await invoke("export_update_diagnostics", { destination, context: {
                    currentVersion: state.currentVersion, targetVersion: state.version,
                    phase: state.phase, message: state.message
                } });
                state.diagnosticsPath = destination;
                state.diagnosticsMessage = "文件已保存，正在 Finder 中显示…";
                state.diagnosticsExporting = false; notify();
                await revealSavedDiagnostics();
            } catch (error) {
                state.diagnosticsError = errorMessage(error);
                state.diagnosticsMessage = "诊断文件未能保存，请选择其他位置重试。";
            } finally { state.busy = false; state.diagnosticsExporting = false; notify(); }
        }
        async function revealSavedDiagnostics() {
            state.diagnosticsRevealing = true; state.diagnosticsRevealError = ""; notify();
            try {
                await revealDiagnostics(state.diagnosticsPath);
                state.diagnosticsMessage = "Finder 已为你选中文件，可直接发送给管理员或开发者。";
            } catch (error) {
                state.diagnosticsRevealError = errorMessage(error);
                state.diagnosticsMessage = "文件已保存，但未能打开 Finder。请点击下方按钮重试。";
            } finally { state.diagnosticsRevealing = false; notify(); }
        }
        async function showDiagnostics() {
            if (!state.diagnosticsPath || state.busy || state.diagnosticsRevealing) return;
            await revealSavedDiagnostics();
        }
        function reportError(error, action = "status") {
            state.message = errorMessage(error); state.errorAction = action; notify();
        }
        notify();
        // Event permission failures are surfaced on download, without an unhandled rejection.
        listener.catch(() => {});
        return { state, check, download, restart, restore, cancel, exportDiagnostics, showDiagnostics, reportError };
    }
    if (typeof module !== "undefined" && module.exports) module.exports = { createUpdaterController, updatePresentation };
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
    const progressRow = document.getElementById("updateProgressRow");
    const location = document.getElementById("updateInstallation");
    const reveal = document.getElementById("updateRevealBtn");
    const cancel = document.getElementById("updateCancelBtn");
    const cleanup = document.getElementById("updateCleanupBtn");
    const diagnostics = document.getElementById("updateDiagnosticsBtn");
    const diagnosticsStatus = document.getElementById("updateDiagnosticsStatus");
    const statusPanel = document.getElementById("updateStatusPanel");
    const statusTitle = document.getElementById("updateStatusTitle");
    const statusMessage = document.getElementById("updateStatusMessage");
    const statusIcon = document.getElementById("updateStatusIcon");
    const errorDetails = document.getElementById("updateErrorDetails");
    const targetVersion = document.getElementById("updateTargetVersion");
    const architecture = document.getElementById("updateArchitecture");
    const notesSection = document.getElementById("updateNotesSection");
    const diagnosticCard = document.getElementById("updateDiagnosticsCard");
    const diagnosticTitle = document.getElementById("updateDiagnosticsTitle");
    const diagnosticFile = document.getElementById("updateDiagnosticsFile");
    const diagnosticReveal = document.getElementById("updateDiagnosticsRevealBtn");
    const diagnosticDetails = document.getElementById("updateDiagnosticsDetails");
    const diagnosticPath = document.getElementById("updateDiagnosticsPath");
    const diagnosticError = document.getElementById("updateDiagnosticsError");
    let installation = null;
    const api = root.__TAURI__;
    if (!api) { open.disabled = true; return; }
    const controller = createUpdaterController({
        invoke: (command, args) => api.core.invoke(command, args),
        listen: (event, handler) => api.event.listen(event, handler),
        prepareRestart: onConfirmed => prepareApplicationUpdate(Boolean(installation?.needsAuthorization), onConfirmed),
        chooseDiagnosticsPath: () => api.dialog.save({
            title: "导出更新诊断信息（不含音乐库或音频）",
            defaultPath: `声场档案更新诊断-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
            filters: [{ name: "诊断压缩包", extensions: ["zip"] }]
        }),
        revealDiagnostics: path => api.opener.revealItemInDir(path),
        onChange: state => {
            const presentation = updatePresentation(state);
            modal.dataset.updateError = String(Boolean(state.errorAction));
            status.textContent = state.message;
            statusPanel.dataset.tone = presentation.tone;
            statusTitle.textContent = presentation.title;
            statusMessage.textContent = presentation.message;
            statusIcon.textContent = presentation.symbol;
            errorDetails.hidden = !state.errorAction;
            notes.textContent = state.notes;
            notesSection.hidden = !state.notes;
            version.textContent = state.currentVersion || "读取中…";
            targetVersion.hidden = !state.version;
            targetVersion.textContent = state.version ? `可更新至 ${state.version}` : "";
            action.disabled = state.busy || state.phase === "restarting" || installation?.canUpdate === false;
            if (cancel) {cancel.hidden = !["downloading", "verifying", "preparing"].includes(state.phase); cancel.textContent = state.phase === "preparing" ? "取消准备" : "取消下载"; cancel.disabled = !state.busy;}
            if (cleanup) cleanup.hidden = !state.cleanupPending;
            action.textContent = ["preparing", "restarting"].includes(state.phase) ? "正在准备…"
                : state.phase === "ready" ? "重启并更新"
                : ["available", "downloading", "verifying"].includes(state.phase) ? "下载更新" : state.errorAction === "check" ? "重试检查" : "检查更新";
            recheck.hidden = !["ready", "available"].includes(state.phase);
            recheck.disabled = state.busy;
            diagnostics.disabled = state.busy || state.diagnosticsRevealing;
            diagnostics.textContent = state.diagnosticsExporting ? "正在导出…" : state.diagnosticsPath ? "重新导出" : "导出诊断信息";
            diagnosticCard.dataset.saved = String(Boolean(state.diagnosticsPath));
            diagnosticTitle.textContent = state.diagnosticsError ? (state.diagnosticsPath ? "上次导出的诊断文件" : "诊断文件未能导出")
                : state.diagnosticsPath ? "诊断文件已导出" : "遇到更新问题";
            diagnosticsStatus.textContent = state.diagnosticsMessage || "导出诊断文件，便于管理员或开发者排查。";
            diagnosticFile.hidden = !state.diagnosticsPath;
            diagnosticFile.textContent = state.diagnosticsPath.split(/[\\/]/).pop();
            diagnosticFile.title = diagnosticFile.textContent;
            diagnosticReveal.hidden = !state.diagnosticsPath;
            diagnosticReveal.disabled = state.busy || state.diagnosticsRevealing;
            diagnosticReveal.textContent = state.diagnosticsRevealing ? "正在打开 Finder…" : "在 Finder 中显示诊断文件";
            diagnosticDetails.hidden = !state.diagnosticsPath && !state.diagnosticsError;
            diagnosticPath.hidden = !state.diagnosticsPath;
            diagnosticPath.textContent = state.diagnosticsPath;
            diagnosticError.hidden = !state.diagnosticsError && !state.diagnosticsRevealError;
            diagnosticError.textContent = state.diagnosticsError || state.diagnosticsRevealError;
            const downloading = ["downloading", "verifying"].includes(state.phase);
            progressRow.hidden = !downloading;
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
            controller.reportError(error, "install");
        }
    }).catch(console.error);
    if (api.app?.getVersion) {
        api.app.getVersion().then(current => {
            controller.state.currentVersion = current;
            version.textContent = current;
        }).catch(() => {});
    }
    if (reveal) reveal.addEventListener("click", () => api.core.invoke("show_installation_in_finder").catch(error => controller.reportError(error)));
    if (cancel) cancel.addEventListener("click", () => controller.cancel());
    if (diagnostics) diagnostics.addEventListener("click", () => controller.exportDiagnostics());
    diagnosticReveal.addEventListener("click", () => controller.showDiagnostics());
    if (cleanup) cleanup.addEventListener("click", async () => {
        try {await api.core.invoke("retry_update_cleanup"); await controller.restore();}
        catch(error) {controller.reportError(error);}
    });
    open.addEventListener("click", async () => {
        modal.classList.remove("hidden");
        try {
            installation = await api.core.invoke("get_installation_status");
            if (location && installation) location.textContent = installation.installationPath
                + (installation.otherInstallations?.length ? `\n发现其他安装：${installation.otherInstallations.join("、")}` : "");
            architecture.hidden = !installation?.arch;
            architecture.textContent = ({aarch64:"Apple Silicon",x64:"Intel"})[installation?.arch] || installation?.arch || "";
            if (reveal) reveal.disabled = !installation?.canUpdate;
            await controller.restore();
            if (installation?.canUpdate === false) {controller.reportError(installation.message, "installation"); action.disabled = true; return;}
            if (controller.state.phase === "idle") await controller.check();
        } catch (error) {controller.reportError(error);}
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
