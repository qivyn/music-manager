/* Movie usage: SQL-paged views, creatable movie multiselect and bulk music selection. */
let movieDialog = null;
let movieDialogVersion = 0;
let movieDetailVersion = 0;
const visibleMovieUsages = new Map();
const movieUsageScopes = { catalog: [], detail: [] };
const pendingMovieUsageDeletes = new Set();
const pendingMovieDeletes = new Set();

function cacheMovieUsages(scope, rows) {
    movieUsageScopes[scope] = rows;
    visibleMovieUsages.clear();
    Object.values(movieUsageScopes).forEach(page => page.forEach(row => visibleMovieUsages.set(row.id, row)));
}

function movieNameKey(name) {
    return String(name || "").trim().normalize("NFKC").toLowerCase();
}

function renderMovieSummary(music) {
    const count = Number(music.movieCount) || 0;
    if (!count) return "";
    const title = name => `<span class="movie-chip-icon" aria-hidden="true">🎬</span><span class="movie-chip-name">${escapeHTML(name)}</span>`;
    const labels = (music.moviePreview || []).map(movie => Number.isInteger(movie.usageId)
        ? `<button type="button" class="movie-chip" data-movie-action="remove-summary" data-usage-id="${movie.usageId}" data-music-name="${escapeHTML(music.name)}" data-movie-name="${escapeHTML(movie.name)}" title="移除《${escapeHTML(movie.name)}》的使用记录" aria-label="移除《${escapeHTML(movie.name)}》的使用记录" ${pendingMovieUsageDeletes.has(movie.usageId) ? "disabled" : ""}>${title(movie.name)}<span class="movie-chip-remove" aria-hidden="true">×</span></button>`
        : `<span class="movie-chip">${title(movie.name)}</span>`).join("");
    return `<div class="music-movie-summary">
        <button type="button" class="movie-summary-count" data-movie-action="show-usages" data-music-id="${escapeHTML(music.id)}">${count} 部电影</button>${labels}${count > 2 ? `<button type="button" class="movie-summary-count" data-movie-action="show-usages" data-music-id="${escapeHTML(music.id)}">＋${count - 2} 部</button>` : ""}
    </div>`;
}

async function openMoviePage(id) {
    state.movieDirectoryScroll = document.querySelector(".main-scroll-area")?.scrollTop || 0;
    state.selectedMovieId = Number(id);
    state.movieMusicSearch = "";
    state.pages[`movies:music:${id}`] = 1;
    closeMusicContextPanels();
    await render();
    if (state.currentView === "movies" && state.selectedMovieId === Number(id)) scrollMainContentToTop();
}

async function renderMoviesView(isCurrent) {
    const revision = libraryQueryRevision;
    const selectedId = state.selectedMovieId;
    if (selectedId == null) {
        const key = "movies:groups";
        const groups = await requestLibraryPage({ kind: "movies", search: state.movieSearch }, key, COMPACT_PAGE_SIZE);
        if (!isCurrent()) return;
        acceptLibraryPage(groups, key);
        cacheMovieUsages("catalog", []);
        visibleQueueMusic = []; visibleClipIds = [];
        $("resultInfo").textContent = `${groups.total} 部电影`;
        $("contentArea").innerHTML = `<section class="catalog-directory" aria-label="电影目录">
            <div class="catalog-directory-columns" aria-hidden="true"><span>电影名称</span><span>音乐数量</span><span></span></div>
            <div class="catalog-directory-list">${groups.items.map(movie => `<div class="catalog-directory-row"><button type="button" class="catalog-directory-open" data-movie-action="select-movie" data-movie-id="${movie.id}" title="${escapeHTML(movie.name)}"><span class="catalog-directory-icon" aria-hidden="true">▣</span><span class="catalog-directory-name">${escapeHTML(movie.name)}</span><span class="catalog-directory-count">${movie.musicCount} 首</span></button>${catalogActionsHTML("movie", movie)}</div>`).join("")
                || `<div class="empty-state"><div class="empty-title">${state.movieSearch ? "没有匹配的电影" : "还没有电影"}</div><div class="empty-description">${state.movieSearch ? "换一个片名，或清除搜索" : "新建电影后，可以在详情中添加音乐"}</div></div>`}</div>
            ${catalogPaginationHTML(groups, key, "部电影")}</section>`;
        renderSelectionToolbar();
        return;
    }
    const selected = await invoke("get_movie", { id: selectedId });
    if (!isCurrent()) return;
    if (!selected) {
        state.selectedMovieId = null;
        showToast("电影已不存在，已返回目录");
        await render();
        return;
    }
    const key = `movies:music:${selected.id}`;
    const page = await requestLibraryPage({ kind: "music", movieId: selected.id, search: state.movieMusicSearch, activeTagIds: [...state.activeTagIds] }, key);
    if (!isCurrent()) return;
    if (revision !== libraryQueryRevision) return renderMoviesView(isCurrent);
    acceptLibraryPage(page, key);
    visibleQueueMusic = page.items; visibleClipIds = [];
    $("resultInfo").textContent = `${page.total} 首音乐`;
    cacheMovieUsages("catalog", page.items.map(music => ({ id: Number(music.movieUsageId), musicId: music.id, musicName: music.name, movieId: selected.id, movieName: selected.name, note: music.movieUsageNote || "" })));
    const rows = page.items.map(music => `<div class="music-row movie-music-row" data-music-id="${escapeHTML(music.id)}">
        <div class="music-icon">${musicArtwork(music)}</div>
        <div class="music-main"><div class="music-name">${escapeHTML(music.name)}</div><div class="music-meta"><span>${escapeHTML(music.album || "未设置专辑")}</span><span>${formatTime(music.duration)}</span></div>
            <div class="music-tags">${renderInlineMusicTags(music)}</div>
            <div class="movie-usage-note">${escapeHTML(music.movieUsageNote || "未填写使用备注")}</div>
            <div class="movie-usage-actions"><button type="button" class="text-btn" data-movie-action="edit-note" data-usage-id="${music.movieUsageId}">编辑备注</button><button type="button" class="text-btn" data-movie-action="remove-usage" data-usage-id="${music.movieUsageId}">移除关联</button></div>
        </div><div class="music-actions"><button type="button" class="icon-action" data-action="play" data-id="${escapeHTML(music.id)}" title="试听">▶</button><button type="button" class="icon-action info-strong" data-action="info" data-id="${escapeHTML(music.id)}" title="音乐详情">ⓘ</button></div>
    </div>`).join("");
    $("contentArea").innerHTML = `<section class="catalog-record-page">
        <nav class="catalog-breadcrumb" aria-label="当前位置"><button type="button" class="text-btn catalog-back" data-movie-action="back-directory" aria-label="返回电影目录">‹ 电影</button><span class="catalog-breadcrumb-separator" aria-hidden="true">/</span><span class="catalog-current-name" title="${escapeHTML(selected.name)}">${escapeHTML(selected.name)}</span>${catalogActionsHTML("movie", selected)}</nav>
        ${rows ? `<div class="music-list">${rows}</div>` : `<div class="empty-state"><div class="empty-title">${state.movieMusicSearch || state.activeTagIds.length ? "没有匹配的音乐" : "这部电影还没有关联音乐"}</div></div>`}
        ${catalogPaginationHTML(page, key, "首音乐")}</section>`;
    renderSelectionToolbar(); syncPlayerQueue();
    await hydrateVisibleArtwork(page.items);
}

async function renderMusicMovieUsages(id = state.selectedMusic?.id) {
    if (!id || state.selectedMusic?.id !== id || $("detailPanel").classList.contains("hidden")) return;
    const version = ++movieDetailVersion, contextVersion = detailRequestVersion;
    const key = `movie-usages:${id}`;
    try {
        const page = await requestLibraryPage({ kind: "music_movie_usages", musicId: id }, key, COMPACT_PAGE_SIZE);
        if (version !== movieDetailVersion || contextVersion !== detailRequestVersion || state.selectedMusic?.id !== id || $("detailPanel").classList.contains("hidden")) return;
        acceptLibraryPage(page, key);
        cacheMovieUsages("detail", page.items.map(usage => ({ ...usage, musicName: state.selectedMusic.name })));
        $("detailMoviesTab").textContent = `使用记录${page.total ? `（${page.total}）` : ""}`;
        $("detailMovieUsages").innerHTML = `<div class="clip-section-heading"><strong>已用于 ${page.total} 部电影</strong><button type="button" class="primary-btn" data-movie-action="add-movies" data-music-id="${escapeHTML(id)}">＋ 记录使用</button></div>
            ${page.items.map(usage => `<article class="movie-usage-row"><span class="movie-title-label">《${escapeHTML(usage.movieName)}》</span><div class="movie-usage-note">${escapeHTML(usage.note || "未填写使用备注")}</div><div class="movie-usage-actions"><button type="button" class="text-btn" data-movie-action="edit-note" data-usage-id="${usage.id}">编辑备注</button><button type="button" class="text-btn" data-movie-action="remove-usage" data-usage-id="${usage.id}">移除关联</button></div></article>`).join("") || '<div class="detail-value movie-usage-empty">暂无使用记录</div>'}
            ${paginationHTML(page, key, "部电影")}`;
    } catch (error) {
        if (version === movieDetailVersion && contextVersion === detailRequestVersion && !applicationUpdateInProgress && !databaseSwitchInProgress)
            $("detailMovieUsages").innerHTML = `<div class="detail-value">读取失败：${escapeHTML(getErrorMessage(error))}</div><button type="button" class="secondary-btn" data-movie-action="retry-usages">重试</button>`;
    }
}

function movieDialogCurrent(dialog) {
    return movieDialog === dialog && dialog.version === movieDialogVersion;
}

function closeMovieDialog() {
    if (movieDialog?.saving) return false;
    clearTimeout(movieDialog?.timer);
    const focus = movieDialog?.focus;
    movieDialog = null;
    movieDialogVersion++;
    $("movieUsageModal").classList.add("hidden");
    $("movieDialogBody").inert = false;
    if (focus?.isConnected) focus.focus();
    return true;
}

async function openMovieDialog(mode, id) {
    if (applicationUpdateInProgress || databaseSwitchInProgress) return;
    if (movieDialog?.saving) { showToast("正在保存使用记录，请稍候"); return; }
    closeMovieDialog();
    const dialog = { version: ++movieDialogVersion, mode, id, selected: new Map(), drafts: new Map(), search: "", requestVersion: 0,
        loading: false, saving: false, page: null, exact: null, lookupKey: null, timer: null, focus: document.activeElement };
    movieDialog = dialog;
    $("movieUsageModal").classList.remove("hidden");
    $("movieDialogTitle").textContent = mode === "create" ? "新建电影" : mode === "rename" ? "修改电影名称" : mode === "note" ? "编辑使用备注" : "记录电影使用";
    $("movieDialogBody").innerHTML = '<div class="detail-value">正在读取…</div>';
    $("movieDialogError").textContent = "";
    $("movieDialogSave").disabled = true;
    $("movieDialogSave").textContent = "保存";
    try {
        if (mode === "create") {
            dialog.owner = { name: "" };
        } else if (mode === "movies") {
            dialog.owner = await dbGet("music", id);
            dialog.key = `movie-dialog:movies:${id}`;
        } else if (mode === "music" || mode === "rename") {
            dialog.owner = await invoke("get_movie", { id: Number(id) });
            dialog.key = `movie-dialog:music:${id}`;
        } else {
            dialog.owner = visibleMovieUsages.get(Number(id));
        }
        if (!movieDialogCurrent(dialog)) return;
        if (!dialog.owner) throw new Error("记录已不存在，请刷新后重试");
        if (["create", "rename", "note"].includes(mode)) {
            $("movieDialogBody").innerHTML = mode !== "note"
                ? `<label class="movie-dialog-field">电影名称<input id="movieDialogName" type="text" autocomplete="off"></label><p class="movie-dialog-hint">${mode === "create" ? "同名电影会复用已有记录。创建后可添加音乐。" : "所有关联处的电影名称会同步更新。"}</p>`
                : `<div class="movie-dialog-context">${escapeHTML(dialog.owner.musicName || "音乐")} · 《${escapeHTML(dialog.owner.movieName)}》</div><label class="movie-dialog-field">使用备注<textarea id="movieDialogNote" rows="4"></textarea></label>`;
            if (mode !== "note") $("movieDialogName").value = dialog.owner.name;
            else $("movieDialogNote").value = dialog.owner.note;
            $("movieDialogSave").disabled = false;
            (mode !== "note" ? $("movieDialogName") : $("movieDialogNote")).focus();
            return;
        }
        state.pages[dialog.key] = 1;
        if (mode === "movies") state.pageSizes[dialog.key] = 10;
        const label = mode === "movies" ? `音乐：${dialog.owner.name}` : `电影：《${dialog.owner.name}》`;
        $("movieDialogBody").innerHTML = `<div class="movie-dialog-context">${escapeHTML(label)}</div>
            <div class="movie-selection-toolbar"><strong id="movieDialogSelectedCount"></strong><button type="button" class="text-btn" data-movie-dialog-action="clear">清空已选</button></div>
            ${mode === "movies" ? '<div id="movieDialogSelections" class="movie-dialog-selections"></div>' : ''}
            <div class="movie-picker-list">
                <label class="movie-dialog-field"><span>${mode === "movies" ? "搜索已有电影，或输入新片名" : "搜索已有音乐"}</span><input id="movieDialogSearch" type="search" autocomplete="off" placeholder="${mode === "movies" ? "电影名称" : "音乐名称、专辑、作者或 Tag"}"></label>
                <div class="movie-picker-toolbar"><button id="movieSelectPageBtn" type="button" class="text-btn" data-movie-dialog-action="select-page">全选当前页</button><span id="movieDialogPageCount"></span></div>
                <div id="movieDialogResults"></div>
                <div id="movieDialogCreate"></div>
                <div id="movieDialogPagination"></div>
            </div>
            <label class="movie-dialog-field movie-note-field">统一备注（选填，仅用于本次新增关联）<textarea id="movieDialogNote" rows="2" placeholder="例如：片尾、开场、预告片"></textarea></label>`;
        $("movieDialogSearch").value = "";
        $("movieDialogNote").value = "";
        updateMovieSelection(dialog);
        await loadMoviePickerPage(dialog);
        if (movieDialogCurrent(dialog)) $("movieDialogSearch").focus();
    } catch (error) {
        if (movieDialogCurrent(dialog)) $("movieDialogError").textContent = getErrorMessage(error);
    }
}

function updateMovieSelection(dialog) {
    if (!movieDialogCurrent(dialog) || !["movies", "music"].includes(dialog.mode)) return;
    const count = dialog.selected.size + dialog.drafts.size;
    $("movieDialogSelectedCount").textContent = `已选 ${count} ${dialog.mode === "movies" ? "部电影" : "首音乐"}`;
    $("movieDialogSave").disabled = !count || dialog.saving || dialog.loading;
    $("movieDialogSave").textContent = dialog.saving ? "保存中…" : `关联 ${count} ${dialog.mode === "movies" ? "部电影" : "首音乐"}`;
    if (dialog.mode === "movies") {
        $("movieDialogSelections").innerHTML = [
            ...[...dialog.selected.values()].map(movie => `<span class="movie-selected-chip">${escapeHTML(movie.name)}<button type="button" data-remove-selected-movie="${movie.id}" aria-label="取消选择 ${escapeHTML(movie.name)}">×</button></span>`),
            ...[...dialog.drafts.entries()].map(([key,name]) => `<span class="movie-selected-chip is-draft">${escapeHTML(name)}<span>待新建</span><button type="button" data-remove-movie-draft="${escapeHTML(key)}" aria-label="取消新建 ${escapeHTML(name)}">×</button></span>`)
        ].join("");
    }
    $("movieDialogResults").querySelectorAll("[data-movie-choice]").forEach(input => {
        const id = dialog.mode === "movies" ? Number(input.dataset.movieChoice) : input.dataset.movieChoice;
        input.checked = dialog.selected.has(id);
    });
}

async function loadMoviePickerPage(dialog = movieDialog) {
    if (!dialog || !movieDialogCurrent(dialog) || dialog.saving || !["movies", "music"].includes(dialog.mode)) return;
    const version = ++dialog.requestVersion;
    const search = dialog.search;
    dialog.loading = true;
    dialog.page = null;
    dialog.lookupKey = null;
    $("movieDialogResults").inert = true;
    $("movieDialogResults").innerHTML = '<div class="detail-value">正在读取…</div>';
    $("movieDialogCreate").innerHTML = "";
    $("movieSelectPageBtn").disabled = true;
    updateMovieSelection(dialog);
    $("movieDialogError").textContent = "";
    try {
        const query = dialog.mode === "movies"
            ? { kind: "movies", excludeMusicId: dialog.id, search }
            : { kind: "music", excludeMovieId: Number(dialog.id), search };
        const [page, exact] = await Promise.all([
            requestLibraryPage(query, dialog.key, dialog.mode === "movies" ? 10 : PAGE_SIZE),
            dialog.mode === "movies" && search.trim() ? invoke("find_movie_by_name", { name: search, musicId: dialog.id }) : null
        ]);
        if (!movieDialogCurrent(dialog) || version !== dialog.requestVersion) return;
        acceptLibraryPage(page, dialog.key);
        dialog.page = page;
        dialog.exact = exact;
        dialog.lookupKey = movieNameKey(search);
        dialog.loading = false;
        $("movieDialogResults").inert = false;
        $("movieSelectPageBtn").disabled = !page.items.length;
        $("movieDialogPageCount").textContent = `共 ${page.total} ${dialog.mode === "movies" ? "部可选电影" : "首可选音乐"}`;
        $("movieDialogResults").innerHTML = page.items.map(item => `<label class="movie-choice-row"><input type="checkbox" data-movie-choice="${escapeHTML(String(item.id))}" ${dialog.selected.has(item.id) ? "checked" : ""}><span class="movie-choice-name">${escapeHTML(item.name)}</span><span class="movie-choice-meta">${dialog.mode === "movies" ? `${item.musicCount} 首音乐` : `${escapeHTML(item.album || "未设置专辑")} · ${formatTime(item.duration)}`}</span></label>`).join("")
            || `<div class="movie-picker-empty">${dialog.mode === "movies" ? "没有匹配的未关联电影" : "没有匹配的未关联音乐"}</div>`;
        $("movieDialogPagination").innerHTML = dialog.mode === "movies"
            ? `<nav class="movie-picker-pagination" aria-label="电影候选分页"><button type="button" class="secondary-btn" data-movie-picker-page="${page.page - 1}" ${page.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page.page} / ${page.totalPages} 页</span><button type="button" class="secondary-btn" data-movie-picker-page="${page.page + 1}" ${page.page >= page.totalPages ? "disabled" : ""}>下一页</button></nav>`
            : paginationHTML(page, dialog.key, "首可选音乐");
        renderMovieCreateOption(dialog);
        updateMovieSelection(dialog);
    } catch (error) {
        if (!movieDialogCurrent(dialog) || version !== dialog.requestVersion) return;
        dialog.loading = false;
        $("movieDialogResults").inert = false;
        $("movieDialogResults").innerHTML = '<button type="button" class="secondary-btn" data-movie-dialog-action="retry">重新读取</button>';
        $("movieDialogError").textContent = getErrorMessage(error);
        updateMovieSelection(dialog);
    }
}

function renderMovieCreateOption(dialog) {
    if (dialog.mode !== "movies" || !movieDialogCurrent(dialog)) return;
    const key = movieNameKey(dialog.search);
    let html = "";
    if (key && dialog.lookupKey === key) {
        if (dialog.exact?.alreadyLinked) html = '<span class="movie-dialog-hint">这首音乐已记录在该电影中</span>';
        else if (dialog.exact) html = `<button type="button" class="text-btn" data-movie-dialog-action="select-exact" ${dialog.selected.has(dialog.exact.movie.id) ? "disabled" : ""}>${dialog.selected.has(dialog.exact.movie.id) ? "已选中" : "选择已有电影"}《${escapeHTML(dialog.exact.movie.name)}》</button>`;
        else if (dialog.drafts.has(key)) html = '<span class="movie-dialog-hint">已加入待新建电影</span>';
        else html = `<button type="button" class="movie-create-option" data-movie-dialog-action="create">＋ 新建并选中《${escapeHTML(dialog.search.trim())}》</button>`;
    }
    $("movieDialogCreate").innerHTML = html;
}

function scheduleMoviePickerSearch(value) {
    const dialog = movieDialog;
    if (!dialog || dialog.saving) return;
    dialog.search = value;
    dialog.requestVersion++;
    dialog.loading = true;
    dialog.page = null;
    dialog.lookupKey = null;
    state.pages[dialog.key] = 1;
    $("movieDialogResults").inert = true;
    $("movieDialogCreate").innerHTML = "";
    $("movieSelectPageBtn").disabled = true;
    updateMovieSelection(dialog);
    clearTimeout(dialog.timer);
    dialog.timer = setTimeout(() => loadMoviePickerPage(dialog), 160);
}

async function refreshMovieViews() {
    await refreshWhileInteractive(renderPreservingScroll, () => state.selectedMusic ? renderMusicMovieUsages(state.selectedMusic.id) : null);
}

async function saveMovieDialog() {
    const dialog = movieDialog;
    if (!dialog || dialog.saving || dialog.loading || !dialog.owner) return;
    const mode = dialog.mode;
    const naming = mode === "rename" || mode === "create";
    const note = naming ? "" : $("movieDialogNote").value.trim();
    const name = naming ? $("movieDialogName").value.trim() : "";
    if (naming && !movieNameKey(name)) { $("movieDialogError").textContent = "请输入电影名称"; return; }
    if (["movies", "music"].includes(mode) && !dialog.selected.size && !dialog.drafts.size) return;
    const ids = [...dialog.selected.keys()], names = [...dialog.drafts.values()];
    dialog.saving = true;
    clearTimeout(dialog.timer);
    dialog.requestVersion++;
    $("movieDialogBody").inert = true;
    $("movieDialogSave").disabled = true;
    $("movieDialogSave").textContent = "保存中…";
    $("movieDialogError").textContent = "";
    try {
        const result = await runLibraryOperation(request => {
            if (mode === "movies") return request("add_music_movie_usages", { musicId: dialog.id, movieIds: ids, newMovieNames: names, note });
            if (mode === "music") return request("add_movie_music_usages", { movieId: Number(dialog.id), musicIds: ids, note });
            if (mode === "create") return request("create_movie", { name });
            if (mode === "rename") return request("update_movie", { movieId: Number(dialog.id), name });
            return request("update_movie_usage", { usageId: Number(dialog.id), note });
        });
        dialog.saving = false;
        if (movieDialogCurrent(dialog)) closeMovieDialog();
        if (mode === "create" && state.currentView === "movies") { state.selectedMovieId = result.id; state.movieMusicSearch = ""; }
        const message = mode === "create" ? "电影已就绪，可添加音乐" : result ? `已新增 ${result.added} 条使用记录${result.alreadyLinked ? `，跳过 ${result.alreadyLinked} 条已有记录` : ""}${result.missingMusic ? `，${result.missingMusic} 首音乐已移除而跳过` : ""}` : "已保存";
        try { await refreshMovieViews(); }
        catch (error) { console.error(error); showToast(`已保存，界面刷新失败：${getErrorMessage(error)}`); return; }
        if (!applicationUpdateInProgress && !databaseSwitchInProgress) showToast(message);
    } catch (error) {
        dialog.saving = false;
        if (movieDialogCurrent(dialog)) {
            $("movieDialogError").textContent = getErrorMessage(error);
            $("movieDialogSave").disabled = false;
            $("movieDialogSave").textContent = "重试保存";
        }
    } finally {
        if (movieDialogCurrent(dialog)) $("movieDialogBody").inert = false;
    }
}

async function removeMovieUsage(id, summary = null) {
    const usage = summary || visibleMovieUsages.get(Number(id));
    if (!usage || pendingMovieUsageDeletes.has(usage.id)) return;
    pendingMovieUsageDeletes.add(usage.id);
    try {
        if (!await __TAURI__.dialog.ask(`确定从《${usage.movieName}》移除「${usage.musicName || "这首音乐"}」的使用记录？\n音乐、电影和原始音频会保留。`, { title: "移除电影使用记录", kind: "warning", okLabel: "移除", cancelLabel: "取消" })) return;
        await runLibraryOperation(request => request("delete_movie_usage", { usageId: usage.id }));
        Object.keys(movieUsageScopes).forEach(scope => { movieUsageScopes[scope] = movieUsageScopes[scope].filter(item => item.id !== usage.id); });
        visibleMovieUsages.delete(usage.id);
        try { await refreshMovieViews(); }
        catch (error) { console.error(error);showToast(`已移除，界面刷新失败：${getErrorMessage(error)}`);return; }
        if (!applicationUpdateInProgress && !databaseSwitchInProgress) showToast("已移除使用记录");
    } catch (error) { console.error(error); showToast(`移除失败：${getErrorMessage(error)}`); }
    finally { pendingMovieUsageDeletes.delete(usage.id); }
}

async function handleMovieAction(event) {
    const button = event.target.closest("[data-movie-action]");
    event.preventDefault();event.stopPropagation();
    if (!button || button.disabled) return;
    const data = button.dataset;
    try {
        switch (data.movieAction) {
            case "select-movie": return await openMoviePage(data.movieId);
            case "back-directory": state.selectedMovieId = null; await render(); restoreDirectoryScroll("movies"); return;
            case "create": return await openMovieDialog("create");
            case "delete-movie": return await removeMovie(Number(data.movieId));
            case "remove-summary": return await removeMovieUsage(Number(data.usageId), { id: Number(data.usageId), musicName: data.musicName, movieName: data.movieName });
            case "add-movies": return await openMovieDialog("movies", data.musicId);
            case "add-music": return await openMovieDialog("music", Number(data.movieId));
            case "rename": return await openMovieDialog("rename", Number(data.movieId));
            case "show-usages": return await openDetail(data.musicId, { tab: "movies" });
            case "edit-note": return await openMovieDialog("note", Number(data.usageId));
            case "remove-usage": return await removeMovieUsage(Number(data.usageId));
            case "retry-usages": return await renderMusicMovieUsages();
            case "clear-search": state.movieSearch = "";$("searchInput").value = "";state.pages["movies:groups"] = 1;return await render();
        }
    } catch (error) { console.error(error);showToast(getErrorMessage(error)); }
}

async function removeMovie(id) {
    if (pendingMovieDeletes.has(id) || applicationUpdateInProgress || databaseSwitchInProgress) return;
    pendingMovieDeletes.add(id);
    try {
        const movie = await invoke("get_movie", { id });
        if (!movie) { await refreshMovieViews(); return; }
        if (!await __TAURI__.dialog.ask(`确定删除电影《${movie.name}》？\n将同时清除该电影的全部使用记录（当前关联 ${movie.musicCount} 首音乐）。\n音乐、音乐片段及原始音频文件会保留。此操作无法撤销。`, { title: "删除电影", kind: "warning", okLabel: "删除电影", cancelLabel: "取消" })) return;
        await runLibraryOperation(request => request("delete_movie", { movieId: id }));
        if (state.selectedMovieId === id) state.selectedMovieId = null;
        Object.keys(movieUsageScopes).forEach(scope => { movieUsageScopes[scope] = movieUsageScopes[scope].filter(usage => usage.movieId !== id); });
        cacheMovieUsages("catalog", movieUsageScopes.catalog);
        try { await refreshMovieViews(); }
        catch (error) { showToast(`电影已删除，界面刷新失败：${getErrorMessage(error)}`); return; }
        if (!applicationUpdateInProgress && !databaseSwitchInProgress) showToast("已删除电影，音乐已保留");
    } catch (error) { console.error(error);showToast(`删除失败：${getErrorMessage(error)}`); }
    finally { pendingMovieDeletes.delete(id); }
}

function closeMovieUsageFilter() {
    $("movieUsageMenu").classList.add("hidden");
    $("movieUsageFilter").setAttribute("aria-expanded", "false");
}

function syncMovieUsageFilter() {
    $("movieUsageLabel").textContent = { all: "使用记录：全部", recorded: "有使用记录", unrecorded: "未记录使用" }[state.movieUsageStatus];
    $("movieUsageFilter").classList.toggle("is-active", state.movieUsageStatus !== "all");
    $("movieUsageMenu").querySelectorAll("[data-movie-usage-status]").forEach(button => {
        button.setAttribute("aria-checked", String(button.dataset.movieUsageStatus === state.movieUsageStatus));
    });
}

function setupMovieUsageFilter() {
    const toggle = $("movieUsageFilter"), menu = $("movieUsageMenu"), container = $("movieUsageControl");
    const items = () => [...menu.querySelectorAll("[data-movie-usage-status]")];
    const open = (last = false) => {
        syncMovieUsageFilter();
        menu.classList.remove("hidden");
        toggle.setAttribute("aria-expanded", "true");
        const choices = items();
        (last ? choices.at(-1) : choices.find(button => button.dataset.movieUsageStatus === state.movieUsageStatus) || choices[0])?.focus();
    };
    toggle.addEventListener("click", event => {
        event.stopPropagation();
        if (menu.classList.contains("hidden")) open(); else closeMovieUsageFilter();
    });
    toggle.addEventListener("keydown", event => {
        if (["ArrowDown", "ArrowUp", "Enter", " ", "Escape"].includes(event.key)) event.stopPropagation();
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault();open(event.key === "ArrowUp"); }
        if (event.key === "Escape") { event.preventDefault();closeMovieUsageFilter(); }
    });
    menu.addEventListener("click", async event => {
        const option = event.target.closest("[data-movie-usage-status]");
        if (!option) return;
        event.stopPropagation();
        state.movieUsageStatus = option.dataset.movieUsageStatus;
        closeMovieUsageFilter();syncMovieUsageFilter();toggle.focus();
        resetPagination();
        try { await render(); } catch (error) { console.error(error);showToast(getErrorMessage(error)); }
    });
    menu.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault();closeMovieUsageFilter();toggle.focus();return; }
        const choices = items(), index = choices.indexOf(document.activeElement);
        const next = { ArrowDown: (index + 1) % choices.length, ArrowUp: (index - 1 + choices.length) % choices.length, Home: 0, End: choices.length - 1 }[event.key];
        if (next !== undefined) { event.preventDefault();choices[next]?.focus(); }
    });
    container.addEventListener("focusout", event => { if (!container.contains(event.relatedTarget)) closeMovieUsageFilter(); });
    document.addEventListener("click", event => { if (!event.target.closest("#movieUsageControl")) closeMovieUsageFilter(); });
}

function setupMovieUsageEvents() {
    $("catalogMovieActionBtn").addEventListener("click", () => {
        if (state.currentView !== "movies") return;
        return state.selectedMovieId == null ? openMovieDialog("create") : openMovieDialog("music", state.selectedMovieId);
    });
    const modal = $("movieUsageModal");
    modal.addEventListener("click", async event => {
        if (event.target === modal || event.target.closest("[data-close-movie-dialog]")) { closeMovieDialog();return; }
        const dialog = movieDialog;
        if (!dialog || dialog.saving) return;
        const pageButton = event.target.closest("[data-movie-picker-page], [data-page-key]");
        if (pageButton) {
            if (pageButton.disabled) return;
            state.pages[dialog.key] = Number(pageButton.dataset.moviePickerPage || pageButton.dataset.page);
            await loadMoviePickerPage(dialog);return;
        }
        const remove = event.target.closest("[data-remove-selected-movie]");
        if (remove) { dialog.selected.delete(Number(remove.dataset.removeSelectedMovie));updateMovieSelection(dialog);renderMovieCreateOption(dialog);return; }
        const draft = event.target.closest("[data-remove-movie-draft]");
        if (draft) { dialog.drafts.delete(draft.dataset.removeMovieDraft);updateMovieSelection(dialog);renderMovieCreateOption(dialog);return; }
        const action = event.target.closest("[data-movie-dialog-action]")?.dataset.movieDialogAction;
        if (action === "clear") { dialog.selected.clear();dialog.drafts.clear();updateMovieSelection(dialog);renderMovieCreateOption(dialog); }
        if (action === "retry") await loadMoviePickerPage(dialog);
        if (action === "select-page" && !dialog.loading && dialog.page) { dialog.page.items.forEach(item => dialog.selected.set(item.id, { id: item.id, name: item.name }));updateMovieSelection(dialog);renderMovieCreateOption(dialog); }
        if (action === "create" && !dialog.loading && dialog.lookupKey === movieNameKey(dialog.search) && !dialog.exact) {
            dialog.drafts.set(dialog.lookupKey, dialog.search.trim());updateMovieSelection(dialog);renderMovieCreateOption(dialog);
        }
        if (action === "select-exact" && !dialog.loading && dialog.exact && !dialog.exact.alreadyLinked) {
            dialog.selected.set(dialog.exact.movie.id, dialog.exact.movie);updateMovieSelection(dialog);renderMovieCreateOption(dialog);
        }
    });
    modal.addEventListener("change", event => {
        const dialog = movieDialog;
        if (!dialog || dialog.saving || dialog.loading) return;
        const input = event.target.closest("[data-movie-choice]");
        if (!input) return;
        const id = dialog.mode === "movies" ? Number(input.dataset.movieChoice) : input.dataset.movieChoice;
        const row = dialog.page?.items.find(item => item.id === id);
        if (!row) return;
        if (input.checked) dialog.selected.set(id, { id, name: row.name });else dialog.selected.delete(id);
        updateMovieSelection(dialog);renderMovieCreateOption(dialog);
    });
    modal.addEventListener("input", event => {
        if (event.target.id === "movieDialogSearch" && !event.isComposing) scheduleMoviePickerSearch(event.target.value);
    });
    modal.addEventListener("compositionend", event => {
        if (event.target.id === "movieDialogSearch") scheduleMoviePickerSearch(event.target.value);
    });
    modal.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')].filter(control => control.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault();last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault();first?.focus(); }
    });
    $("movieDialogSave").addEventListener("click", saveMovieDialog);
    setupMovieUsageFilter();
}
