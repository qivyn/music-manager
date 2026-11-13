/* SQLite page rendering and library navigation controls. Shared application state lives in app.js. */

function updateLibrarySearch(value) {
    if (state.currentView === "movies") {
        if (state.selectedMovieId == null) { state.movieSearch = value.trim();state.pages["movies:groups"] = 1; }
        else { state.movieMusicSearch = value.trim();state.pages[`movies:music:${state.selectedMovieId}`] = 1; }
    } else if (state.currentView === "albums") {
        if (state.catalogSelection == null) { state.albumSearch = value;state.pages["catalog:album:groups"] = 1; }
        else { state.search = value.trim();state.pages[`catalog:album:${state.catalogSelection}`] = 1; }
    } else { state.search = value.trim();resetPagination(); }
}

function updatePageHeader() {

    $("viewButtons").classList.toggle(
        "hidden",
        state.currentView === "clips" || state.currentView === "home" || state.currentView === "movies" || (state.currentView === "albums" && state.catalogSelection == null)
    );
    updateSidebarFilterIndicator();
    const movieView = state.currentView === "movies";
    const directory = isCatalogDirectory();
    document.body.classList.toggle("catalog-directory-view", directory);
    $("catalogMovieActionBtn").classList.toggle("hidden", !movieView);
    $("catalogMovieActionBtn").textContent = directory ? "＋ 新建电影" : "＋ 添加音乐";
    $("selectionToggleBtn").classList.toggle("hidden", movieView || directory);
    $("rowPlayToggleBtn").classList.toggle("hidden", directory);
    $("movieUsageControl").classList.toggle("hidden", movieView || state.currentView === "home" || state.currentView === "clips");
    syncMovieUsageFilter();
    const searchScope = movieView ? (directory ? "movie-directory" : `movie:${state.selectedMovieId}`)
        : state.currentView === "albums" ? (directory ? "album-directory" : `album:${state.catalogSelection}`) : "music";
    if ($("searchInput").dataset.searchScope !== searchScope) {
        $("searchInput").dataset.searchScope = searchScope;
        $("searchInput").value = movieView ? (directory ? state.movieSearch : state.movieMusicSearch)
            : state.currentView === "albums" && directory ? state.albumSearch : state.search;
    }

    let title = "全部音乐";
    let description = "你的本地音乐素材";
    let searchPlaceholder = "搜索音乐名、专辑、作者、类型、年份或 Tag";


    if (state.currentView === "home") {

        title = "首页";
        description = "声场档案的起始页";
    }


    if (state.currentView === "clips") {

        title = "音乐片段";
        description =
            "所有已经标记过时间轴的音乐片段";
        searchPlaceholder = "搜索片段名、原音乐、专辑、作者或 Tag";
    }


    if (state.currentView === "recent") {

        title = state.recentMode === "used" ? "最近播放" : "最近添加";
        description = state.recentMode === "used" ? "再听听那些熟悉的旋律" : "最近导入的音乐";
        searchPlaceholder = "搜索最近的音乐、作者、专辑或 Tag";
    }


    if (state.currentView === "albums") {

        title = "专辑";
        description =
            "按照专辑查看音乐";
        searchPlaceholder = "搜索音乐名、作者、类型或 Tag";
    }


    if (state.currentView === "tags") {

        title = "Tags";
        description =
            "按照 Tag 管理音乐素材";
        searchPlaceholder = "搜索音乐、专辑、作者或 Tag";
    }


    if (state.currentView.startsWith("tag:")) {
        const tag = tagRecordsCache.find(item => item.id === Number(state.currentView.substring(4)));

        title = "#" + (tag?.path || "Tag");

        description =
            "包含这个 Tag 的音乐和片段";
        searchPlaceholder = "搜索当前 Tag 下的音乐或片段";
    }


    if (movieView) { title = "电影";description = "按电影查看音乐使用记录";searchPlaceholder = directory ? "搜索电影名称" : "搜索本片音乐名、专辑、作者或 Tag"; }
    else if (state.currentView === "albums" && directory) searchPlaceholder = "搜索专辑名称";
    else if (state.currentView !== "home") searchPlaceholder += "、电影名";
    $("pageTitle").textContent = title;
    $("pageDescription").textContent = description;
    $("searchInput").placeholder = searchPlaceholder;
}


/* =========================================================
   渲染主列表
========================================================= */

function libraryEmptyHTML(kind = "music") {
    const search = kind === "album" && state.catalogSelection == null ? state.albumSearch : state.search;
    const filtered = Boolean(search || state.activeTagIds.length || state.movieUsageStatus !== "all");
    const recent = state.currentView === "recent";
    const title = filtered ? "没有匹配结果" : recent && state.recentMode === "used" ? "暂无播放记录"
        : kind === "clips" ? "还没有音乐片段" : kind === "tag" ? "还没有 Tag" : kind === "album" ? "还没有专辑" : "还没有音乐";
    const description = filtered ? "试试其他关键词，或清除筛选条件" : recent && state.recentMode === "used" ? "试听音乐后会显示在这里"
        : kind === "clips" ? "在音乐详情中创建你的第一个片段" : kind === "tag" ? "给音乐或片段添加 Tag" : "导入音乐，开始整理你的素材";
    return `<div class="empty-state"><div class="empty-icon">${filtered ? "⌕" : "♫"}</div><div class="empty-title">${title}</div><div class="empty-description">${description}</div>
        ${filtered ? '<button class="secondary-btn" data-clear-library-filters>清除筛选</button>' : ''}</div>`;
}
function recentModeHTML() {
    return `<div class="recent-mode-bar"><button class="recent-mode-btn ${state.recentMode !== "used" ? "active" : ""}" data-recent-mode="added">最近添加</button>
        <button class="recent-mode-btn ${state.recentMode === "used" ? "active" : ""}" data-recent-mode="used">最近播放</button></div>`;
}
async function render() {
    closeCatalogMenu();
    const version = ++libraryRenderVersion;
    const current = () => version === libraryRenderVersion;
    const leavingHome = document.body.classList.contains("view-home") && state.currentView !== "home";
    document.body.classList.toggle("view-home", state.currentView === "home");
    if (leavingHome) cancelHomeAudition();
    if (state.currentView !== "home") { window.HomeScene?.unmount(); window.Turntable?.sleep(); }
    updatePageHeader();
    if (state.player.queueSource === "home" && state.currentView !== "home") await refreshHomeQueue();
    if (!current()) return;
    if (state.currentView === "movies") { await renderMoviesView(current);return; }
    const query = libraryFilters();
    if (state.currentView === "home") {
        const page = await requestLibraryPage({ kind: "music", newest: true }, "home", 10);
        if (current()) renderHome(page.items, []);
        return;
    }
    if (state.currentView === "albums" || state.currentView === "tags") {
        await renderCatalogView(state.currentView === "albums" ? "album" : "tag", query, current);
        return;
    }
    if (state.currentView.startsWith("tag:")) {
        await renderTagResults(Number(state.currentView.substring(4)), query, current);
        return;
    }
    if (state.currentView === "clips") {
        const page = await requestLibraryPage({ ...query, kind: "clips" }, "clips:library");
        if (current()) renderClipLibrary(acceptLibraryPage(page, "clips:library"));
        return;
    }
    const key = `music:${state.currentView}`;
    const page = await requestLibraryPage({ ...query, kind: "music", recent: state.currentView === "recent" ? state.recentMode : null }, key);
    if (!current()) return;
    acceptLibraryPage(page, key);
    $("resultInfo").textContent = `${page.total} 个音乐`;
    visibleQueueMusic = page.items;
    visibleClipIds = [];
    if (!page.total) $("contentArea").innerHTML = libraryEmptyHTML();
    else {
        if (state.layout === "grid") renderGrid(page.items, []);
        else renderList(page.items, []);
        $("contentArea").insertAdjacentHTML("beforeend", paginationHTML(page, key, "首音乐"));
    }
    if (state.currentView === "recent") $("contentArea").insertAdjacentHTML("afterbegin", recentModeHTML());
    renderSelectionToolbar();
    syncPlayerQueue();
    await hydrateVisibleArtwork(page.items);
}

/* =========================================================
   首页（双主题猫咪场景）
========================================================= */

/* End library render */

async function renderTagResults(tagId, query, current) {
    const tag = tagRecordsCache.find(item => item.id === tagId);
    const tagLabel = tag?.path || "Tag";
    const [musicPage, clipPage] = await Promise.all([
        requestLibraryPage({ ...query, kind: "music", tagId, directTag: true }, `tag:${tagId}:music`),
        requestLibraryPage({ ...query, kind: "clips", tagId, directTag: true }, `tag:${tagId}:clips`)
    ]);
    if (!current()) return;
    $("resultInfo").textContent = `${musicPage.total} 首音乐 · ${clipPage.total} 个片段`;
    if (!state.tagResultTab) state.tagResultTab = clipPage.total ? "clips" : "music";
    const pageKey = `tag:${tagId}:${state.tagResultTab}`;
    const page = acceptLibraryPage(state.tagResultTab === "clips" ? clipPage : musicPage, pageKey);
    visibleQueueMusic = state.tagResultTab === "clips"
        ? [...new Map(page.items.map(({ music: parent }) => [parent.id, parent])).values()]
        : page.items;
    visibleClipIds = state.tagResultTab === "clips" ? page.items.map(({ clip }) => clip.id) : [];
    renderSelectionToolbar();
    syncPlayerQueue();

    const musicRows = (state.tagResultTab === "music" ? page.items : []).map(item => `
        <div class="music-row" data-music-id="${item.id}">
            <div class="music-icon">${musicArtwork(item)}</div>
            <div class="music-main"><div class="music-name">${escapeHTML(item.name)}</div><div class="music-meta"><span>${formatTime(item.duration)}</span>${item.album ? `<span>专辑：${escapeHTML(item.album)}</span>` : ""}</div><div class="music-tags">${renderInlineMusicTags(item)}</div>${renderMovieSummary(item)}</div>
            <div class="music-actions"><button class="icon-action" data-action="play" data-id="${item.id}" title="试听">▶</button><button class="icon-action info-strong" data-action="info" data-id="${item.id}" title="详情">ⓘ</button></div>
        </div>`).join("");
    const clipRows = (state.tagResultTab === "clips" ? page.items : []).map(({ clip, music: parent }) => {
        const isCandidate = isClipCandidate(clip.id);
        return `
        <div class="clip-library-row" data-clip-id="${clip.id}">
            <div class="clip-library-icon">◈</div>
            <div class="clip-library-main"><div class="clip-library-name">${escapeHTML(clip.name || "未命名片段")}</div><div class="clip-library-source-name">${escapeHTML(parent.name)}</div><div class="clip-library-meta"><span>${formatTime(clip.start)} – ${formatTime(clip.end)}</span><span>${formatTime(clip.end - clip.start)}</span>${renderAssignedTags(clip, "clip")} </div></div>
            <div class="clip-library-actions"><button class="icon-action" data-clip-action="play" data-clip-id="${clip.id}" title="试听片段">▶</button><button class="icon-action" data-clip-action="edit" data-clip-id="${clip.id}" title="编辑片段">✎</button><button class="icon-action" data-clip-action="export" data-clip-id="${clip.id}" title="导出为 WAV">⤓</button><button class="icon-action ${isCandidate ? "is-candidate" : ""}" data-clip-action="candidate" data-clip-id="${clip.id}" title="${isCandidate ? "移出候选" : "加入候选"}">${isCandidate ? "★" : "☆"}</button></div>
        </div>`;
    }).join("");

    $("contentArea").innerHTML = `
        <div class="tag-result-groups">
            <div class="tag-result-tabs">
                <button class="tag-result-tab ${state.tagResultTab === "music" ? "active" : ""}" data-tag-result-tab="music">音乐 <span>${musicPage.total}</span></button>
                <button class="tag-result-tab ${state.tagResultTab === "clips" ? "active" : ""}" data-tag-result-tab="clips">音乐片段 <span>${clipPage.total}</span></button>
            </div>
            ${state.tagResultTab === "music" ? (musicRows ? `<div class="music-list">${musicRows}</div>` : `<div class="detail-value">没有直接标记 #${escapeHTML(tagLabel)} 的音乐</div>`) : (clipRows ? `<div class="clip-library">${clipRows}</div>` : `<div class="detail-value">没有直接标记 #${escapeHTML(tagLabel)} 的片段</div>`)}
            ${paginationHTML(page, pageKey, state.tagResultTab === "clips" ? "个片段" : "首音乐")}
        </div>`;
    hydrateVisibleArtwork(visibleQueueMusic).catch(console.error);
}


/* =========================================================
   目录视图（专辑 / Tags）
   左侧分类列表 + 右侧对应音乐
========================================================= */

function isCatalogDirectory() {
    return (state.currentView === "albums" && state.catalogSelection == null)
        || (state.currentView === "movies" && state.selectedMovieId == null);
}

function restoreDirectoryScroll(view) {
    if (state.currentView !== view || !isCatalogDirectory()) return;
    const area = document.querySelector(".main-scroll-area");
    if (area) area.scrollTop = view === "movies" ? state.movieDirectoryScroll || 0 : state.albumDirectoryScroll || 0;
}

async function renderAlbumView(query, isCurrent) {
    const album = state.catalogSelection;
    if (album == null) {
        const key = "catalog:album:groups";
        const page = await requestLibraryPage({ ...query, search: "", kind: "albums", albumSearch: state.albumSearch }, key, COMPACT_PAGE_SIZE);
        if (!isCurrent()) return;
        acceptLibraryPage(page, key);
        visibleQueueMusic = []; visibleClipIds = [];
        $("resultInfo").textContent = `${page.total} 张专辑`;
        $("contentArea").innerHTML = `<section class="catalog-directory" aria-label="专辑目录">
            <div class="catalog-directory-columns" aria-hidden="true"><span>专辑名称</span><span>音乐数量</span><span></span></div>
            <div class="catalog-directory-list">${page.items.map(item => `<div class="catalog-directory-row"><button type="button" class="catalog-directory-open" data-catalog-key="${escapeHTML(item.key)}" title="${escapeHTML(item.label || item.key)}"><span class="catalog-directory-icon" aria-hidden="true">♫</span><span class="catalog-directory-name">${escapeHTML(item.label || item.key)}</span><span class="catalog-directory-count">${item.count} 首</span></button>${catalogActionsHTML("album", item)}</div>`).join("") || libraryEmptyHTML("album")}</div>
            ${catalogPaginationHTML(page, key, "张专辑")}</section>`;
        renderSelectionToolbar();
        return;
    }
    const key = `catalog:album:${album}`;
    const page = await requestLibraryPage({ ...query, kind: "music", album }, key);
    if (!isCurrent()) return;
    acceptLibraryPage(page, key);
    visibleQueueMusic = page.items; visibleClipIds = [];
    $("resultInfo").textContent = `${page.total} 首音乐`;
    if (state.layout === "grid") renderGrid(page.items, []); else renderList(page.items, []);
    const music = $("contentArea").innerHTML;
    $("contentArea").innerHTML = `<section class="catalog-record-page"><nav class="catalog-breadcrumb" aria-label="当前位置"><button type="button" class="text-btn catalog-back" data-back-album-directory aria-label="返回专辑目录">‹ 专辑</button><span class="catalog-breadcrumb-separator" aria-hidden="true">/</span><span class="catalog-current-name" title="${escapeHTML(album || "未设置专辑")}">${escapeHTML(album || "未设置专辑")}</span>${catalogActionsHTML("album", { key: album })}</nav>
        ${album ? `<div class="catalog-detail-tags">${renderAlbumTags(album)}</div>` : ""}
        ${page.items.length ? music : '<div class="empty-state"><div class="empty-title">没有匹配的音乐</div><div class="empty-description">可以调整搜索或筛选条件，或返回专辑目录</div></div>'}
        ${catalogPaginationHTML(page, key, "首音乐")}</section>`;
    renderSelectionToolbar();syncPlayerQueue();
    await hydrateVisibleArtwork(page.items);
}

async function renderCatalogView(type, query, isCurrent) {
    if (type === "album") return renderAlbumView(query, isCurrent);
    const catalogPageKey = `catalog:${type}:groups`;
    const catalogPage = await requestLibraryPage({ ...query, kind: type === "album" ? "albums" : "tags", albumSearch: state.albumSearch }, catalogPageKey, COMPACT_PAGE_SIZE);
    if (!isCurrent()) return;
    const current = catalogPage.items.find(item => item.key === state.catalogSelection) || catalogPage.items[0];
    let musicPage;
    let musicPageKey;
    if (current) {
        musicPageKey = `catalog:${type}:${current.key}`;
        musicPage = await requestLibraryPage({ ...query, kind: "music", ...(type === "album" ? { album: current.key } : { tagId: Number(current.key) }) }, musicPageKey);
        if (!isCurrent()) return;
        acceptLibraryPage(musicPage, musicPageKey);
    }
    acceptLibraryPage(catalogPage, catalogPageKey);
    $("resultInfo").textContent = `${catalogPage.total} ${type === "album" ? "张专辑" : "个 Tag"}`;
    const albumFilterHTML = type === "album" ? `<div class="catalog-filter"><span class="catalog-filter-icon" aria-hidden="true"></span>
        <input type="search" data-album-filter value="${escapeHTML(state.albumSearch)}" placeholder="筛选专辑名" aria-label="筛选专辑名">
        ${state.albumSearch ? '<button type="button" data-clear-album-filter title="清空专辑筛选" aria-label="清空专辑筛选">×</button>' : ''}</div>` : "";
    if (!current) {
        $("contentArea").innerHTML = albumFilterHTML + libraryEmptyHTML(type);
        visibleQueueMusic = []; visibleClipIds = [];
        renderSelectionToolbar(); syncPlayerQueue(); return;
    }
    const selected = current.key;
    state.catalogSelection = selected;
    const cand = new Set(state.player.candidates.map(c => c.id));
    /* 左侧目录 */

    const listHTML = catalogPage.items
        .map(e => `

            <button
                class="catalog-item ${
                    e.key === selected ? "active" : ""
                }"
                data-catalog-key="${escapeHTML(e.key)}"
            >

                <span class="catalog-item-icon">
                    ${
                        type === "tag"
                            ? "#"
                            : type === "album"
                                ? "▣"
                                : "▤"
                    }
                </span>

                <span class="catalog-item-name">
                    ${escapeHTML(e.label || e.key)}
                </span>

                <span class="catalog-item-count">
                    ${e.count}
                </span>

            </button>
        `)
        .join("");


    /* 右侧音乐列表 / 大图 */



    const rowsHTML = musicPage.items
        .map(item => {

            const clipCount = item.clipCount || 0;

            const tags =
                item.tags || [];

            return `

                <div
                    class="music-row ${state.selectedMusicIds.has(item.id) ? "is-selected" : ""}"
                    data-music-id="${item.id}"
                >

                    ${state.selectionMode ? `<label class="music-select"><input type="checkbox" data-select-music="${item.id}" ${state.selectedMusicIds.has(item.id) ? "checked" : ""}><span></span></label>` : ""}

                    <div class="music-icon">${musicArtwork(item)}</div>

                    <div class="music-main">

                        <div class="music-name">
                            ${escapeHTML(item.name)}
                        </div>

                        <div class="music-meta">

                            ${
                                type !== "album" &&
                                item.album
                                    ? `<span>专辑：${escapeHTML(item.album)}</span>`
                                    : ""
                            }

                            <span>
                                ${formatTime(item.duration)}
                            </span>

                            ${
                                clipCount
                                    ? `<span>◈ ${clipCount} 个片段</span>`
                                    : ""
                            }

                        </div>

                        <div class="music-tags">${renderInlineMusicTags(item)}</div>
                        ${renderMovieSummary(item)}

                    </div>

                    <canvas
                        class="row-wave"
                        ${item.path ? `data-wave-src="${escapeHTML(convertFileSrc(item.path))}"` : ""}
                        aria-hidden="true"
                    ></canvas>

                    <div class="music-actions">

                        <button
                            class="icon-action ${state.player.music?.id === item.id && state.player.playing ? "is-playing" : ""}"
                            data-action="play"
                            data-id="${item.id}"
                            title="${state.player.music?.id === item.id && state.player.playing ? "暂停试听" : "试听"}"
                        >
                            ${state.player.music?.id === item.id && state.player.playing ? "Ⅱ" : "▶"}
                        </button>

                        <button
                            class="icon-action"
                            data-action="show-clips"
                            data-id="${item.id}"
                            title="打开音乐片段"
                            aria-label="打开音乐片段"
                        >
                            ◈
                        </button>

                        <button
                            class="icon-action ${
                                cand.has(item.id)
                                    ? "is-candidate"
                                    : ""
                            }"
                            data-action="candidate"
                            data-id="${item.id}"
                            title="${
                                cand.has(item.id)
                                    ? "移出候选"
                                    : "加入候选"
                            }"
                        >
                            ${
                                cand.has(item.id)
                                    ? "★"
                                    : "☆"
                            }
                        </button>

                        <button
                            class="icon-action info-strong"
                            data-action="info"
                            data-id="${item.id}"
                            title="详情"
                        >
                            ⓘ
                        </button>

                        <button
                            class="icon-action"
                            data-action="delete"
                            data-id="${item.id}"
                            title="删除"
                        >
                            🗑
                        </button>

                    </div>

                </div>
            `;

        })
        .join("");

    const detailContent =
        state.layout === "grid"
            ? `<div class="music-grid catalog-music-grid">${renderMusicCards(musicPage.items, [])}</div>`
            : `<div class="music-list">${rowsHTML}</div>`;


    $("contentArea").innerHTML = `
        <div class="catalog-view">

            <div class="catalog-list">
                ${albumFilterHTML}
                ${listHTML}
                ${paginationHTML(catalogPage, catalogPageKey, type === "album" ? "张专辑" : "个 Tag")}
            </div>

            <div class="catalog-detail">

                <div class="catalog-detail-header">
                    <span class="catalog-detail-title">
                        ${escapeHTML(current.label || current.key)}
                    </span>
                    <span class="catalog-detail-count">
                        ${current.count} 首
                    </span>
                    ${type === "album" && current.key !== "" ? `<button class="text-btn danger-btn" data-delete-album="${escapeHTML(current.label || current.key)}">删除专辑</button>` : ""}
                </div>

                ${type === "album" && current.key !== "" ? `<div class="catalog-detail-tags">${renderAlbumTags(current.key)}</div>` : ""}

                ${detailContent}
                ${paginationHTML(musicPage, musicPageKey, "首音乐")}

            </div>

        </div>
    `;

    visibleQueueMusic = musicPage.items;
    visibleClipIds = [];
    renderSelectionToolbar();

    syncPlayerQueue();
    hydrateVisibleArtwork(musicPage.items).catch(console.error);
}


/* =========================================================
   片段库
========================================================= */

function renderClipLibrary(page) {
    $("resultInfo").textContent = `${page.total} 个片段`;
    if (!page.total) {
        $("contentArea").innerHTML = libraryEmptyHTML("clips");
        visibleQueueMusic = []; visibleClipIds = [];
        renderSelectionToolbar(); syncPlayerQueue(); return;
    }
    const pageKey = "clips:library";
    $("contentArea").innerHTML = `
        <div class="clip-library">
            ${page.items.map(({ clip, music: parent }) => `
                <div class="clip-library-row ${state.selectedClipIds.has(clip.id) ? "is-selected" : ""}" data-clip-id="${clip.id}">
                    ${state.selectionMode ? `<label class="music-select"><input type="checkbox" data-select-clip="${clip.id}" ${state.selectedClipIds.has(clip.id) ? "checked" : ""}><span></span></label>` : ""}
                    <div class="clip-library-icon">◈</div>
                    <div class="clip-library-main">
                        <div class="clip-library-name">
                            ${escapeHTML(clip.name || "未命名片段")}
                        </div>
                        <div class="clip-library-source-name">
                            ${escapeHTML(parent.name)}
                        </div>
                        <div class="clip-library-meta">
                            <span>${formatTime(clip.start)} – ${formatTime(clip.end)}</span>
                            <span>${formatTime(clip.end - clip.start)}</span>
                            ${renderAssignedTags(clip, "clip")}
                        </div>
                    </div>
                    <canvas
                        class="row-wave"
                        ${parent.path ? `data-wave-src="${escapeHTML(convertFileSrc(parent.path))}"` : ""}
                        ${parent.duration ? `data-wave-from="${(clip.start / parent.duration).toFixed(4)}" data-wave-to="${(clip.end / parent.duration).toFixed(4)}"` : ""}
                        aria-hidden="true"
                    ></canvas>
                    <div class="clip-library-actions">
                        <button class="icon-action" data-clip-action="play" data-clip-id="${clip.id}" title="试听片段">▶</button>
                        <button class="icon-action" data-clip-action="edit" data-clip-id="${clip.id}" title="编辑片段">✎</button>
                        <button class="icon-action" data-clip-action="export" data-clip-id="${clip.id}" title="导出为 WAV">⤓</button>
                        <button class="icon-action ${isClipCandidate(clip.id) ? "is-candidate" : ""}" data-clip-action="candidate" data-clip-id="${clip.id}" title="${isClipCandidate(clip.id) ? "移出候选" : "加入候选"}">${isClipCandidate(clip.id) ? "★" : "☆"}</button>
                        <button class="icon-action" data-clip-action="delete" data-clip-id="${clip.id}" title="删除片段">🗑</button>
                    </div>
                </div>
            `).join("")}
        </div>
        ${paginationHTML(page, pageKey, "个片段")}
    `;

    visibleQueueMusic = [...new Map(page.items.map(({ music: parent }) => [parent.id, parent])).values()];
    visibleClipIds = page.items.map(({ clip }) => clip.id);
    renderSelectionToolbar();
    syncPlayerQueue();
    hydrateVisibleArtwork(visibleQueueMusic).catch(console.error);
}


/* =========================================================
   列表视图
========================================================= */

function renderList(music, clips) {

    const cand =
        new Set(
            state.player.candidates
                .map(c => c.id)
        );

    const html = music
        .map(item => {

            const clipCount = item.clipCount || 0;

            const tags =
                item.tags || [];

            return `

                <div
                    class="music-row ${state.selectedMusicIds.has(item.id) ? "is-selected" : ""}"
                    data-music-id="${item.id}"
                >

                    ${state.selectionMode ? `<label class="music-select"><input type="checkbox" data-select-music="${item.id}" ${state.selectedMusicIds.has(item.id) ? "checked" : ""}><span></span></label>` : ""}

                    <div class="music-icon">${musicArtwork(item)}</div>

                    <div class="music-main">

                        <div class="music-name">
                            ${escapeHTML(item.name)}
                        </div>

                        <div class="music-meta">

                            ${
                                item.album
                                    ? `<span>专辑：${escapeHTML(item.album)}</span>`
                                    : ""
                            }

                            <span>
                                ${formatTime(item.duration)}
                            </span>

                            ${
                                clipCount
                                    ? `<span>◈ ${clipCount} 个片段</span>`
                                    : ""
                            }

                        </div>

                        <div class="music-tags">${renderInlineMusicTags(item)}</div>
                        ${renderMovieSummary(item)}

                    </div>

                    <canvas
                        class="row-wave"
                        ${item.path ? `data-wave-src="${escapeHTML(convertFileSrc(item.path))}"` : ""}
                        aria-hidden="true"
                    ></canvas>


                    <div class="music-actions">

                        <button
                            class="icon-action ${state.player.music?.id === item.id && state.player.playing ? "is-playing" : ""}"
                            data-action="play"
                            data-id="${item.id}"
                            title="${state.player.music?.id === item.id && state.player.playing ? "暂停试听" : "试听"}"
                        >
                            ${state.player.music?.id === item.id && state.player.playing ? "Ⅱ" : "▶"}
                        </button>

                        <button
                            class="icon-action"
                            data-action="show-clips"
                            data-id="${item.id}"
                            title="打开音乐片段"
                            aria-label="打开音乐片段"
                        >
                            ◈
                        </button>

                        <button
                            class="icon-action ${
                                cand.has(item.id)
                                    ? "is-candidate"
                                    : ""
                            }"
                            data-action="candidate"
                            data-id="${item.id}"
                            title="${
                                cand.has(item.id)
                                    ? "移出候选"
                                    : "加入候选"
                            }"
                        >
                            ${
                                cand.has(item.id)
                                    ? "★"
                                    : "☆"
                            }
                        </button>

                        <button
                            class="icon-action info-strong"
                            data-action="info"
                            data-id="${item.id}"
                            title="详情"
                        >
                            ⓘ
                        </button>

                        <button
                            class="icon-action"
                            data-action="delete"
                            data-id="${item.id}"
                            title="删除"
                        >
                            🗑
                        </button>

                    </div>

                </div>
            `;

        })
        .join("");


    $("contentArea").innerHTML = `
        <div class="music-list">
            ${html}
        </div>
    `;
}


/* =========================================================
   Grid
========================================================= */

function renderMusicCards(music, clips) {

    return music
        .map(item => {

            const clipCount = item.clipCount || 0;

            return `

                <div
                    class="music-card ${state.selectedMusicIds.has(item.id) ? "is-selected" : ""}"
                    data-music-id="${item.id}"
                >

                    ${state.selectionMode ? `<label class="music-select card-select"><input type="checkbox" data-select-music="${item.id}" ${state.selectedMusicIds.has(item.id) ? "checked" : ""}><span></span></label>` : ""}

                    <div class="card-icon ${item.coverArt ? "has-artwork" : ""}">
                        ${musicArtwork(item)}
                    </div>

                    <div class="card-name">
                        ${escapeHTML(item.name)}
                    </div>

                    <div class="card-meta">

                        ${
                            item.album
                                ? escapeHTML(item.album)
                                : "未设置专辑"
                        }

                        ·

                        ${formatTime(item.duration)}

                        ${
                            clipCount
                                ? " · " +
                                  clipCount +
                                  " 个片段"
                                : ""
                        }

                    </div>


                    <div class="card-tags">

                        ${renderInlineMusicTags(item)}

                    </div>
                    ${renderMovieSummary(item)}
                </div>

            `;

        })
        .join("");
}


function renderGrid(music, clips) {


    $("contentArea").innerHTML = `
        <div class="music-grid">
            ${renderMusicCards(music, clips)}
        </div>
    `;
}


/* =========================================================
   音乐详情
========================================================= */

function paginationHTML(result, key, noun = "项", options = {}) {
    if (!options.always && result.total <= PAGE_SIZE_OPTIONS[0]) return "";
    const compact = options.compact ?? (key === "candidates" || key === "import:albums" || key.startsWith("music-clips:") || key.startsWith("movie-usages:") || key.endsWith(":groups"));
    const sizeOptions = PAGE_SIZE_OPTIONS.map(size =>
        `<option value="${size}" ${size === result.pageSize ? "selected" : ""}>${compact ? `${size} / 页` : `每页 ${size}`}</option>`
    ).join("");
    return `<nav class="pagination${compact ? " pagination-compact" : ""}" aria-label="分页">
        <button type="button" data-page-key="${escapeHTML(key)}" data-page="${result.page - 1}" title="上一页" aria-label="上一页" ${result.page <= 1 ? "disabled" : ""}>${compact ? "‹" : "上一页"}</button>
        <span>${compact ? `${result.page} / ${result.totalPages}` : `第 ${result.page} / ${result.totalPages} 页 · 共 ${result.total} ${noun}`}</span>
        <label class="pagination-size"><span>每页数量</span><select data-page-size-key="${escapeHTML(key)}" aria-label="每页显示数量">${sizeOptions}</select></label>
        <button type="button" data-page-key="${escapeHTML(key)}" data-page="${result.page + 1}" title="下一页" aria-label="下一页" ${result.page >= result.totalPages ? "disabled" : ""}>${compact ? "›" : "下一页"}</button>
    </nav>`;
}
