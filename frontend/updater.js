/* The backend owns release URLs, signature checks and the installation location. */
(function (root) {
    function updatePresentation(state) {
        if (state.errorAction) {
            const signature = signatureError(state.message);
            const title = signature ? "更新包未通过验证" : ({check:"暂时无法检查更新",download:"下载未完成",install:"更新未完成",status:"暂时无法读取更新状态",installation:"此位置暂不支持更新"}[state.errorAction] || "更新暂时遇到问题");
            const message = signature ? "请重新下载更新。当前安装的应用未被替换。"
                : state.errorAction === "installation" ? state.message
                : state.errorAction === "check" ? "请检查网络连接后重试。若仍有问题，可以导出诊断文件帮助排查。"
                : "你可以重试，或导出诊断文件交给管理员或开发者排查。";
            return { title, message, tone: "warning", symbol: "!" };
        }
        const titles = {installed:"更新完成",idle:"检查是否有可用更新",checking:"正在检查更新",available:"发现新版本",downloading:"正在下载更新",verifying:"正在验证更新包",ready:"更新已准备好",preparing:"正在准备安装",restarting:"正在重启更新",latest:"已是最新版本"};
        return {title:titles[state.phase] || "软件更新",message:state.message,
            tone:["ready","latest","installed"].includes(state.phase)?"success":"neutral",
            symbol:["ready","latest","installed"].includes(state.phase)?"✓":"↓"};
    }
    const signatureError = message => /签名|signature|公钥|摘要/i.test(message || "");
    const installerConflict = state => state.errorCode === "CONFLICT" || /安装与更新声场档案”窗口/.test(state.message || "");
    // The primary button always offers the next useful step, never a repeat of what just failed.
    function updateActions(state) {
        const none = { label: "", intent: "none" };
        if (state.errorAction === "check") return { primary: { label: "重试检查", intent: "check" }, secondary: none };
        if (state.errorAction === "download") return { primary: { label: signatureError(state.message) ? "重新下载" : "重试下载", intent: "update" }, secondary: none };
        if (state.errorAction === "install") {
            if (installerConflict(state)) return { primary: { label: "已关闭，重试", intent: "restart" }, secondary: none };
            return { primary: { label: "导出诊断信息", intent: "export" }, secondary: { label: "重试更新", intent: "restart" } };
        }
        if (["preparing", "restarting"].includes(state.phase)) return { primary: { label: "正在准备…", intent: "none" }, secondary: none };
        if (["downloading", "verifying"].includes(state.phase)) return { primary: { label: "正在下载…", intent: "none" }, secondary: none };
        if (state.phase === "ready") return { primary: { label: "重启并安装", intent: "restart" }, secondary: none };
        if (state.phase === "available") return { primary: { label: state.version ? `更新到 ${state.version}` : "下载更新", intent: "update" }, secondary: none };
        if (state.phase === "checking") return { primary: { label: "正在检查…", intent: "none" }, secondary: none };
        return { primary: { label: "检查更新", intent: "check" }, secondary: none };
    }
    function compareVersions(a, b) {
        const left = String(a).split(".").map(Number), right = String(b).split(".").map(Number);
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
            const diff = (left[i] || 0) - (right[i] || 0);
            if (diff) return diff < 0 ? -1 : 1;
        }
        return 0;
    }
    function createUpdaterController({ invoke, listen, onChange, prepareRestart, chooseDiagnosticsPath, revealDiagnostics }) {
        const state = { phase: "idle", busy: false, version: "", currentVersion: "", notes: "", message: "检查并安装声场档案的最新版本。", errorAction: "", errorCode: "", downloaded: 0, total: null, transactionId: null, cleanupPending: false,
            diagnosticsMessage: "", diagnosticsPath: "", diagnosticsError: "", diagnosticsRevealError: "", diagnosticsExporting: false, diagnosticsRevealing: false };
        const notify = () => onChange({ ...state });
        const errorMessage = error => error?.message || String(error);
        const fail = (error, action) => { state.message = errorMessage(error); state.errorAction = action; state.errorCode = error?.errorCode || ""; };
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
        // A silent check runs in the background at startup: it never shows an error.
        async function check({ silent = false } = {}) {
            if (state.busy) return;
            Object.assign(state, { phase: "checking", busy: true, message: "正在获取可用版本，请稍候。", notes: "", version: "", errorAction: "", errorCode: "" });
            notify();
            try {
                const result = await invoke("check_app_update");
                Object.assign(state, {
                    currentVersion: result.currentVersion, version: result.version || "", notes: result.notes || "",
                    phase: result.downloaded ? "ready" : result.version ? "available" : "latest",
                    message: result.version ? `发现新版本 ${result.version}` : "当前已是最新版本。"
                });
            } catch (error) {
                state.phase = "idle";
                if (silent) state.message = "检查并安装声场档案的最新版本。"; else fail(error, "check");
            } finally { state.busy = false; notify(); }
        }
        function showInstalled({ version, notes, updated = true }) {
            Object.assign(state, { phase: "installed", version: "", currentVersion: version, notes: notes || "", errorAction: "", errorCode: "",
                message: `${updated ? `已更新到 ${version}` : `声场档案 ${version} 已安装`}。下面是这个版本的更新内容。` });
            notify();
        }
        async function restore() {
            if (state.busy) return;
            state.busy = true; notify();
            try {
                const saved = await invoke("get_update_status");
                // A background check may already have found a newer version than anything downloaded.
                const found = ["available", "latest", "installed"].includes(state.phase) && saved?.phase === "idle"
                    ? { phase: state.phase, version: state.version, notes: state.notes, message: state.message } : null;
                if (saved) Object.assign(state, saved, { version: saved.targetVersion || "", busy: true, errorAction: saved.errorCode ? "status" : "", errorCode: saved.errorCode || "" }, found || {});
            } catch (error) { fail(error, "status"); }
            finally { state.busy = false; notify(); }
        }
        async function cancel() {
            try { await invoke("cancel_app_update"); }
            catch (error) { fail(error, "status"); notify(); }
        }
        async function download() {
            if (state.busy || state.phase !== "available") return;
            Object.assign(state, { phase: "downloading", busy: true, downloaded: 0, total: null, transactionId: null, message: "正在下载更新，可以继续使用音乐库。", errorAction: "", errorCode: "" });
            notify();
            try {
                await listener;
                await invoke("download_app_update");
                state.phase = "ready";
                state.message = "更新包已下载并通过签名校验，点击“重启并更新”安装。";
            } catch (error) {
                state.phase = "available"; fail(error, "download");
            } finally { state.busy = false; notify(); }
        }
        async function restart() {
            if (state.busy || state.phase !== "ready") return;
            // The confirmation dialog comes first; only then does the panel report waiting.
            state.busy = true; state.errorAction = ""; state.errorCode = ""; notify();
            let release;
            try {
                release = await prepareRestart(() => { state.message = "正在等待当前操作完成…"; notify(); });
                if (!release) { state.message = "更新已下载，你可以稍后重启安装。"; return; }
                state.phase = "preparing"; state.message = "正在准备安装，可取消；当前应用保持运行…"; notify();
                await invoke("restart_for_app_update");
                state.message = "更新程序已就绪，正在重启…";
            } catch (error) {
                state.phase = "ready"; fail(error, "install");
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
            fail(error, action); notify();
        }
        notify();
        // Event permission failures are surfaced on download, without an unhandled rejection.
        listener.catch(() => {});
        return { state, check, download, restart, restore, cancel, exportDiagnostics, showDiagnostics, reportError, showInstalled };
    }
    if (typeof module !== "undefined" && module.exports) module.exports = { createUpdaterController, updatePresentation, updateActions, compareVersions };
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
    const notice = document.getElementById("updateNoticeBtn");
    const settingsToggle = document.getElementById("settingsToggleBtn");
    const menuBadge = document.getElementById("checkUpdateBadge");
    let installation = null;
    let actions = updateActions({ phase: "idle" });
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
            actions = updateActions(state);
            action.disabled = state.busy || actions.primary.intent === "none" || installation?.canUpdate === false;
            if (cancel) {cancel.hidden = !["downloading", "verifying", "preparing"].includes(state.phase); cancel.textContent = state.phase === "preparing" ? "取消准备" : "取消下载"; cancel.disabled = !state.busy;}
            if (cleanup) cleanup.hidden = !state.cleanupPending;
            action.textContent = actions.primary.label;
            recheck.hidden = actions.secondary.intent === "none";
            recheck.textContent = actions.secondary.label;
            recheck.disabled = state.busy;
            if (state.phase === "available" && state.version) markAvailable(state.version);
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
    async function openPanel({ check = true } = {}) {
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
            if (check && controller.state.phase === "idle") await controller.check();
        } catch (error) {controller.reportError(error);}
    }
    open.addEventListener("click", () => openPanel());
    close.addEventListener("click", () => modal.classList.add("hidden"));
    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !modal.classList.contains("hidden")) {
            modal.classList.add("hidden");
        }
    });
    async function run(intent) {
        if (intent === "check") return controller.check();
        if (intent === "restart") return controller.restart();
        if (intent === "export") return controller.exportDiagnostics();
        if (intent === "update") {
            // One click downloads and then asks once whether to restart now or later.
            await controller.download();
            if (controller.state.phase === "ready" && !controller.state.errorAction) return controller.restart();
        }
    }
    recheck.addEventListener("click", () => run(actions.secondary.intent));
    action.addEventListener("click", () => run(actions.primary.intent));

    // Background discovery: at most one silent check a day, shown as a quiet badge, never an interruption.
    const STORAGE = { lastRun: "musicManager.update.lastRunVersion", checkedAt: "musicManager.update.checkedAt", available: "musicManager.update.availableVersion" };
    const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
    const write = (key, value) => { try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
    let noticeIntent = null;
    function showNotice(text, intent) {
        if (!notice) return;
        notice.textContent = text; notice.hidden = false; noticeIntent = intent;
    }
    function markAvailable(next) {
        write(STORAGE.available, next);
        if (settingsToggle) settingsToggle.dataset.updateAvailable = "true";
        if (menuBadge) { menuBadge.hidden = false; menuBadge.textContent = `新版本 ${next}`; }
        if (noticeIntent !== "installed") showNotice(`有新版本 ${next}`, "available");
    }
    if (notice) notice.addEventListener("click", () => {
        if (noticeIntent === "installed") { notice.hidden = true; noticeIntent = null; return openPanel({ check: false }); }
        return openPanel();
    });
    api.core.invoke("get_update_welcome").then(welcome => {
        const current = welcome.version, previous = read(STORAGE.lastRun);
        write(STORAGE.lastRun, current);
        const known = read(STORAGE.available);
        if (known && compareVersions(known, current) <= 0) write(STORAGE.available, null);
        else if (known) markAvailable(known);
        // The installer passes the replaced version; older clients never recorded their own.
        const before = previous || (welcome.launchedByInstaller ? welcome.previousVersion : null);
        const updated = before && compareVersions(before, current) < 0;
        if (updated || (!previous && welcome.launchedByInstaller)) {
            controller.showInstalled({ version: current, notes: welcome.notes, updated: Boolean(updated) });
            showNotice(updated ? `已更新到 ${current} · 查看更新内容` : `声场档案 ${current} 已安装 · 查看更新内容`, "installed");
            setTimeout(() => { if (noticeIntent === "installed") { notice.hidden = true; noticeIntent = null; } }, 30000);
        }
        const last = Number(read(STORAGE.checkedAt) || 0);
        if (Date.now() - last < 24 * 3600 * 1000) return;
        setTimeout(async () => {
            if (!modal.classList.contains("hidden")) return;
            await controller.check({ silent: true });
            if (!controller.state.errorAction && controller.state.phase !== "idle") write(STORAGE.checkedAt, String(Date.now()));
            // Keep the welcome notes available until the user has seen them.
            if (noticeIntent === "installed" && controller.state.phase === "latest") controller.showInstalled({ version: current, notes: welcome.notes, updated: Boolean(updated) });
        }, 5000);
    }).catch(() => {});
})(typeof window === "undefined" ? globalThis : window);
