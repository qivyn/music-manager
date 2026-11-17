/* Import selection, bounded metadata reads and cancellation. Shared application state lives in app.js. */

function openImportModal() {
    if (importSelectedFiles.isImporting || importScanRequest) {
        importModal.classList.remove("hidden");
        return;
    }
    // Keep unfinished files when the user closes and reopens the dialog.
    $("importProgress").classList.add("hidden");
    if (!state.importFiles.length) {
        state.importAlbumSource = "metadata";
        state.importSelectedAlbum = null;
    }
    Object.keys(state.pages).filter(key => key.startsWith("import:")).forEach(key => delete state.pages[key]);
    document.querySelector(`input[name="albumSource"][value="${state.importAlbumSource}"]`).checked = true;
    $("confirmImportBtn").textContent = "导入";

    renderSelectedFiles();

    importModal.classList.remove("hidden");
}


function closeImportModal() {

    importModal.classList.add("hidden");
}


/* =========================================================
   选择文件
========================================================= */

async function chooseFiles() {

    try {

        const selected =
            await __TAURI__.dialog.open({
                multiple: true,
                filters: [
                    {
                        name: "MP3 音乐文件",
                        extensions: [
                            "mp3"
                        ]
                    }
                ]
            });

        if (!selected) {

            return;
        }


        appendImportItems(
            await getNewImportItems(selected.map(String))
        );


        renderSelectedFiles();

    } catch (error) {

        console.error(error);
    }
}

async function chooseFolders() {
    try {
        const selected = await __TAURI__.dialog.open({ multiple: true, directory: true });
        if (!selected) return;
        appendImportItems(
            await getNewImportItems(selected.map(String))
        );
        renderSelectedFiles();
    } catch (error) {
        console.error(error);
        showToast("读取文件夹失败");
    }
}

function makeImportItems(infos) {
    return infos.filter(info => info.exists).map(info => ({
        path: info.path,
        name: info.name,
        fileName: info.fileName,
        fileSize: info.fileSize,
        mimeType: info.mimeType,
        album: state.importAlbumSource === "folder" ? info.folderAlbum : (info.album || ""),
        albumSource: state.importAlbumSource,
        metadataAlbum: info.album || "",
        folderAlbum: info.folderAlbum || "",
        artist: info.artist || "",
        genre: info.genre || "",
        year: info.year || "",
        channels: info.channels || "",
        sampleRate: info.sampleRate || 0,
        bitrate: info.bitrate || 0,
        duration: info.duration || 0,
        coverArt: info.coverArt || "",
        tags: [],
        tagIds: []
    }));
}

function appendImportItems(items) {
    const pendingPaths = new Set(
        state.importFiles.map(item => item.path)
    );
    const newItems = items.filter(item => {
        if (pendingPaths.has(item.path)) return false;
        pendingPaths.add(item.path);
        return true;
    });

    state.importFiles.push(...newItems);

    if (items.length > newItems.length) {
        showToast(`已忽略 ${items.length - newItems.length} 个重复的待导入文件`);
    }
}

async function getNewImportItems(paths) {
    if (importScanRequest || importSelectedFiles.isImporting) { showToast("请先完成或停止当前导入任务"); return []; }
    const task = { id: createId("scan_"), cancelled: false };
    importScanRequest = task;
    $("confirmImportBtn").disabled = true;
    updateImportProgress("正在扫描文件夹…", 0, 0, true);
    let unlisten;
    try {
        unlisten = await __TAURI__.event?.listen("import-scan-progress", event => {
            const progress = event.payload;
            if (progress.requestId !== task.id || importScanRequest !== task) return;
            if (task.cancelled) {
                if (progress.started) void invoke("cancel_import_scan", { requestId: task.id }).catch(console.error);
            } else if (progress.total) {
                updateImportProgress(`正在读取 ${progress.completed} / ${progress.total} 个文件`, progress.completed, progress.total, true);
            }
        });
        if (task.cancelled) { updateImportProgress("已停止扫描，音乐库未改变"); return []; }
        const result = await invoke("scan_import_sources", { paths, requestId: task.id });
        if (task.cancelled || result.cancelled) { updateImportProgress("已停止扫描，音乐库未改变"); return []; }
        if (result.warnings.length) await showMessage(result.warnings.join("\n"), "部分文件无法读取", "warning");
        const infos = result.items;
        const existingPaths = new Set(await invoke("find_existing_music_paths", { paths: infos.map(info => info.path) }));
        if (task.cancelled) { updateImportProgress("已停止扫描，音乐库未改变"); return []; }
        // Include pending drafts so the summary counts actual additions and
        // selecting the same file again never replaces its unsaved edits.
        const knownPaths = new Set([...existingPaths, ...state.importFiles.map(item => item.path)]);
        const newInfos = infos.filter(info => {
            if (knownPaths.has(info.path)) return false;
            knownPaths.add(info.path);
            return true;
        });
        const skippedCount = infos.length - newInfos.length;
        const addedSummary = newInfos.length ? `新增 ${newInfos.length} 首待导入` : "本次没有新增音乐";
        const summary = skippedCount
            ? `已跳过 ${skippedCount} 首重复音乐，${addedSummary}`
            : newInfos.length ? addedSummary : "未找到可导入的 MP3 音乐";
        updateImportProgress(summary, infos.length, infos.length);
        return makeImportItems(newInfos);
    } catch (error) {
        updateImportProgress(`读取失败：${getErrorMessage(error)}`);
        throw error;
    } finally {
        unlisten?.();
        importScanRequest = null;
        $("cancelImportTaskBtn").classList.add("hidden");
        $("confirmImportBtn").disabled = !state.importFiles.length;
    }
}

/* =========================================================
   拖入
========================================================= */

async function probePaths(paths) {
    return getNewImportItems(paths);
}


function setupDropZone() {

    const zone = $("dropZone");

    const modalOpen = () =>
        !importModal.classList.contains("hidden");

    const zoneAdd = () =>
        zone.classList.add("dragover");

    const zoneRemove = () =>
        zone.classList.remove("dragover");


    const appWindow =
        __TAURI__.window.getCurrentWindow();

    appWindow.onDragDropEvent(
        async event => {

            if (!modalOpen()) {
                return;
            }

            if (event.payload.type === "over") {

                zoneAdd();

            } else if (
                event.payload.type === "leave"
            ) {

                zoneRemove();

            } else if (
                event.payload.type === "drop"
            ) {

                zoneRemove();

                appendImportItems(
                    await probePaths(
                        event.payload.paths
                    )
                );

                renderSelectedFiles();
            }
        }
    );
}


/* =========================================================
   已选择文件
========================================================= */

async function renderSelectedFiles(focusTagIndex) {

    const container =
        $("selectedFiles");

    setImportEditingLocked(Boolean(importSelectedFiles.isImporting));

    const button =
        $("confirmImportBtn");

    $("dropZone").classList.toggle(
        "has-import-files",
        state.importFiles.length > 0
    );


    if (!state.importFiles.length) {

        container.innerHTML = "";

        button.disabled = true;
        button.textContent = "导入";

        return;
    }


    const tagPickerData = await loadTagPickerData();


    const groups = new Map();
    state.importFiles.forEach((item, index) => {
        const album = item.album || "未归档音乐";
        if (!groups.has(album)) groups.set(album, []);
        groups.get(album).push({ item, index });
    });
    if (!groups.has(state.importSelectedAlbum)) state.importSelectedAlbum = groups.keys().next().value;
    const albumPageKey = "import:albums";
    const albumPage = paginateImportDraft([...groups.entries()], albumPageKey, COMPACT_PAGE_SIZE);
    if (!albumPage.items.some(([album]) => album === state.importSelectedAlbum)) {
        state.importSelectedAlbum = albumPage.items[0]?.[0] || null;
    }
    const visibleItems = groups.get(state.importSelectedAlbum) || [];
    const trackPageKey = `import:tracks:${state.importSelectedAlbum}`;
    const trackPage = paginateImportDraft(visibleItems, trackPageKey, COMPACT_PAGE_SIZE);
    const renderTrack = ({ item, index }, order) => {
        const suggestions = renderTagPickerGroups({ excludeIds: item.tagIds || [], attr: "file-suggest-tag", data: tagPickerData });
        return `<article class="import-track" data-file-index="${index}">
            <div class="import-track-summary"><span class="import-track-number">${String(order + 1).padStart(2, "0")}</span><div class="import-track-main"><strong>${escapeHTML(item.name)}</strong><span>${escapeHTML(item.artist || "未知作者")} · ${item.duration ? formatTime(item.duration) : "时长读取中"}</span></div><span class="import-track-format">${item.sampleRate ? `${(item.sampleRate / 1000).toFixed(1)} kHz` : "MP3"}${item.bitrate ? ` · ${item.bitrate} kbps` : ""}</span><button class="icon-action import-track-remove" data-remove-import-file="${index}" title="不导入这首音乐" aria-label="不导入这首音乐">×</button></div>
            <details class="import-edit-details"><summary>编辑曲目资料</summary><div class="selected-file-fields import-edit-fields">
                <div class="import-basic-fields">
                    <label>音乐名称<input type="text" data-file-field="name" value="${escapeHTML(item.name)}"></label>
                    <label>作者<input type="text" data-file-field="artist" value="${escapeHTML(item.artist || "")}" placeholder="可留空"></label>
                    <label>专辑<input type="text" data-file-field="album" value="${escapeHTML(item.album || "")}" placeholder="可留空"></label>
                </div>
                <div class="import-meta-cards">
                    <div class="import-meta-card">
                        <div class="import-meta-label">音乐类型</div>
                        <input type="text" data-file-field="genre" value="${escapeHTML(item.genre || "")}" placeholder="自动识别，可修改">
                    </div>
                    <div class="import-meta-card">
                        <div class="import-meta-label">录制年份</div>
                        <input type="text" inputmode="numeric" maxlength="10" data-file-field="year" value="${escapeHTML(item.year || "")}" placeholder="如 2024">
                    </div>
                    <div class="import-meta-card">
                        <div class="import-meta-label">音频声道</div>
                        <input type="text" data-file-field="channels" value="${escapeHTML(item.channels || "")}" placeholder="自动识别，可修改">
                    </div>
                    <div class="import-meta-card">
                        <div class="import-meta-label">采样速率</div>
                        <div class="import-meta-input"><input type="number" min="0" step="1000" data-file-field="sampleRate" value="${item.sampleRate || ""}" placeholder="44100"><span class="import-meta-unit">Hz</span></div>
                    </div>
                    <div class="import-meta-card">
                        <div class="import-meta-label">码率</div>
                        <div class="import-meta-input"><input type="number" min="0" step="16" data-file-field="bitrate" value="${item.bitrate || ""}" placeholder="320"><span class="import-meta-unit">kbps</span></div>
                    </div>
                    <div class="import-meta-card is-readonly">
                        <div class="import-meta-label">文件大小</div>
                        <div class="import-meta-value">${formatFileSize(item.fileSize)}</div>
                    </div>
                </div>
                <div class="file-tag-area"><div class="tag-editor" data-file-tags>${(item.tags || []).map((tag, tagIndex) => `<span class="editing-tag">#${escapeHTML(tag)}<button data-file-remove-tag="${tagIndex}">×</button></span>`).join("")}</div><div class="tag-input-row"><input type="text" data-file-tag-input placeholder="输入 Tag"><button class="secondary-btn" data-file-add-tag>添加</button></div>${suggestions ? `<div class="tag-suggestions"><div class="suggestion-title">已有 Tag</div>${suggestions}</div>` : ""}</div>
            </div></details></article>`;
    };

    // 记录当前展开的「编辑曲目资料」面板，重绘后恢复，避免点 Tag 时被自动收起
    const openDetails = new Set(
        [...container.querySelectorAll("details.import-edit-details[open]")]
            .map(details => details.closest("[data-file-index]")?.dataset.fileIndex)
            .filter(Boolean)
    );

    stopImportAlbumNameScroll();
    container.innerHTML = `<div class="import-review"><aside class="import-album-list"><div class="import-review-label">本次识别到 ${groups.size} 张专辑 · ${state.importFiles.length} 首音乐</div>${albumPage.items.map(([album, items]) => `<button class="import-album-item ${album === state.importSelectedAlbum ? "active" : ""}" data-import-album="${escapeHTML(album)}" title="${escapeHTML(album)}"><span>${escapeHTML(album)}</span><b>${items.length}</b></button>`).join("")}${paginationHTML(albumPage, albumPageKey, "张专辑")}</aside><section class="import-album-detail"><header><div><span>正在审阅</span><h3>${escapeHTML(state.importSelectedAlbum)}</h3></div><strong>${visibleItems.length} 首</strong></header><div class="import-track-list">${trackPage.items.map((entry, index) => renderTrack(entry, (trackPage.page - 1) * trackPage.pageSize + index)).join("")}</div>${paginationHTML(trackPage, trackPageKey, "首音乐")}</section></div>`;
    openDetails.forEach(index => {
        const details = container.querySelector(`[data-file-index="${index}"] details.import-edit-details`);
        if (details) details.open = true;
    });

    if (focusTagIndex != null) {
        focusFileTagInput(focusTagIndex);
    }

    button.disabled = Boolean(importSelectedFiles.isImporting);
    button.textContent = importSelectedFiles.isImporting ? "导入中…" : `确认导入 ${state.importFiles.length} 首`;
}


function focusFileTagInput(index) {

    const card =
        document.querySelector(
            `[data-file-index="${index}"]`
        );

    if (!card) {
        return;
    }

    const input =
        card.querySelector(
            "[data-file-tag-input]"
        );

    if (input) {

        input.focus();
    }
}


/* =========================================================
   获取音频时长
========================================================= */

function getAudioDuration(path, { signal, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const audio = document.createElement("audio");
        let finished = false;
        let timeout;
        const complete = (value, error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            audio.onloadedmetadata = audio.onerror = null;
            audio.pause();
            audio.removeAttribute("src");
            audio.load();
            if (error) reject(error); else resolve(value);
        };
        const abort = () => complete(0, Object.assign(new Error("已取消导入"), { name: "AbortError" }));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => complete(0, new Error("读取音频时长超时，请检查文件或硬盘后重试")), timeoutMs);
        audio.preload = "metadata";
        audio.onloadedmetadata = () => complete(Number.isFinite(audio.duration) ? audio.duration : 0);
        audio.onerror = () => complete(0, new Error("无法读取音频，请检查文件是否损坏或不可访问"));
        audio.src = convertFileSrc(path);
    });
}

let importController = null;
let importScanRequest = null;
function updateImportProgress(message, completed = 0, total = 0, active = false) {
    $("importProgress").classList.remove("hidden");
    $("importProgressText").textContent = message;
    const meter = $("importProgressMeter");
    meter.max = Math.max(1, total);
    if (total) meter.value = completed; else meter.removeAttribute("value");
    $("cancelImportTaskBtn").classList.toggle("hidden", !active);
}
function cancelImportTask() {
    importController?.abort();
    if (importScanRequest) {
        importScanRequest.cancelled = true;
        void invoke("cancel_import_scan", { requestId: importScanRequest.id }).catch(console.error);
    }
    $("importProgressText").textContent = "正在停止，已导入的音乐会保留…";
}


/* =========================================================
   导入
========================================================= */

function setImportEditingLocked(locked) {
    $("selectedFiles").inert = locked;
    $("selectedFiles").setAttribute("aria-busy", String(locked));
    document.querySelectorAll('input[name="albumSource"]').forEach(input => { input.disabled = locked; });
}

async function importSelectedFiles() {

    if (!state.importFiles.length || importSelectedFiles.isImporting || importScanRequest) return;
    if (applicationUpdateInProgress || databaseSwitchInProgress) return;
    const batch = [...state.importFiles];
    importSelectedFiles.isImporting = true;
    importController = new AbortController();
    clearTimeout(importAlbumRefreshTimer);
    setImportEditingLocked(true);
    // Keep the whole batch visible to restart preparation, including metadata
    // loading between individual create_music commands.
    try { await runLibraryOperation(request => performImportSelectedFiles(request, batch)); }
    catch (error) { console.error(error); }
    finally {
        importController?.abort();
        importController = null;
        importSelectedFiles.isImporting = false;
        $("cancelImportTaskBtn").classList.add("hidden");
        setImportEditingLocked(false);
        if (!applicationUpdateInProgress) {
            await refreshWhileInteractive(renderSelectedFiles, updateCounts, render, renderSidebarTags);
        }
    }
}

async function performImportSelectedFiles(request, batch) {
    const button = $("confirmImportBtn");

    button.disabled = true;

    button.textContent =
        "导入中...";

    let currentItem = null;
    let completed = 0;
    const signal = importController.signal;
    const metadata = new Map();
    // Only prefetch the next three files. Writes stay ordered and committed
    // entries are removed immediately, so cancellation/retry cannot duplicate them.
    const prefetch = index => {
        for (let i = index; i < Math.min(batch.length, index + 3); i++) {
            if (!metadata.has(i)) metadata.set(i, Promise.resolve()
                .then(() => getAudioDuration(batch[i].path, { signal }))
                .then(value => ({ value }), error => ({ error })));
        }
    };
    updateImportProgress(`已导入 0 / ${batch.length}`, 0, batch.length, true);
    try {
        for (let index = 0; index < batch.length; index++) {
            if (signal.aborted) break;
            prefetch(index);
            const item = batch[index];

            currentItem = item;

            updateImportProgress(`已导入 ${completed} / ${batch.length} · ${item.fileName || item.name}`, completed, batch.length, true);
            const measured = await metadata.get(index);
            metadata.delete(index);
            if (signal.aborted) break;
            if (measured.error) throw measured.error;
            const duration = measured.value || item.duration || 0;


            /*
             * 音乐本身只保存元数据 + 绝对路径。
             *
             * 不把音频 Blob 存在数据库。
             *
             * 这样 10 万首音乐时数据库不会巨大。
             */

            const music = {

                id: createId("music_"),

                name:
                    item.name,

                fileName:
                    item.fileName,

                path:
                    item.path,

                album:
                    item.album || "",

                albumSource:
                    item.albumSource || state.importAlbumSource,

                artist:
                    item.artist || "",

                genre:
                    item.genre || "",

                year:
                    item.year || "",

                channels:
                    item.channels || "",

                sampleRate:
                    item.sampleRate || 0,

                bitrate:
                    item.bitrate || 0,

                tags:
                    [...(item.tags || [])],
                tagIds:
                    [...(item.tagIds || [])],

                duration,

                fileSize:
                    item.fileSize,

                mimeType:
                    item.mimeType,

                coverArt:
                    item.coverArt || "",

                createdAt:
                    Date.now(),

                updatedAt:
                    Date.now()
            };


            await dbAdd(
                "music",
                music,
                request
            );
            // Committed items are no longer pending, even if a later file fails.
            state.importFiles = state.importFiles.filter(pending => pending !== item);
            completed++;
        }


        const message = signal.aborted ? `已停止：导入 ${completed} / ${batch.length}，其余文件可继续导入` : `导入完成：${completed} / ${batch.length}`;
        updateImportProgress(message, completed, batch.length);
        if (!state.importFiles.length) closeImportModal();
        showToast(message);

    } catch (error) {

        console.error(error);

        const fileName =
            currentItem?.fileName ||
            currentItem?.name;

        updateImportProgress(`已导入 ${completed} / ${batch.length}；${fileName || "当前文件"}失败：${getErrorMessage(error)}。其余文件保留，可重试。`, completed, batch.length);
        await showMessage(
            `导入${fileName ? `「${fileName}」` : ""}失败：${getErrorMessage(error)}`,
            "导入失败",
            "error"
        );
        throw error;
    }
}


/* =========================================================
   编辑音乐
========================================================= */

function paginateImportDraft(items, key, pageSize = PAGE_SIZE) {
    pageSize = Number(state.pageSizes[key]) || pageSize;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const requested = Number(state.pages[key]) || 1;
    const page = Math.min(totalPages, Math.max(1, requested));
    state.pages[key] = page;
    return {
        items: items.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: items.length,
        totalPages
    };
}
