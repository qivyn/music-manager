/* =========================================================
   声场档案
   Tauri 桌面应用 + SQLite
========================================================= */

const __TAURI__ = window.__TAURI__;

let databaseSwitchInProgress = false;
let applicationUpdateInProgress = false;
const pendingCommands = new Set();
const pendingLibraryOperations = new Set();
function invoke(command, args, operation = null) {
    if (applicationUpdateInProgress && !pendingLibraryOperations.has(operation)) {
        return Promise.reject(new Error("正在准备更新，请稍候"));
    }
    if (databaseSwitchInProgress && command !== "set_database_location") {
        return Promise.reject(new Error("正在切换音乐库，请稍候"));
    }
    const request = __TAURI__.core.invoke(command, args);
    pendingCommands.add(request);
    request.then(result => {
        pendingCommands.delete(request);
        if (typeof invalidateLibraryQueries === "function") invalidateLibraryQueries(command, result);
    }, () => pendingCommands.delete(request));
    return request;
}
const convertFileSrc = __TAURI__.core.convertFileSrc;

// Track a complete read/modify/write operation, including time spent queued or
// probing a file. Only operations accepted before update preparation may finish.
function runLibraryOperation(work) {
    if (applicationUpdateInProgress || databaseSwitchInProgress) {
        return Promise.reject(new Error(applicationUpdateInProgress ? "正在准备更新，请稍候" : "正在切换音乐库，请稍候"));
    }
    const task = Promise.resolve().then(() => work((command, args) => invoke(command, args, task)));
    pendingLibraryOperations.add(task);
    const done = () => pendingLibraryOperations.delete(task);
    task.then(done, done);
    return task;
}

async function prepareApplicationUpdate(needsAuthorization = false, onConfirmed = null) {
    if (databaseSwitchInProgress || applicationUpdateInProgress) throw new Error("其他操作尚未完成，请稍后更新");
    const accepted = await __TAURI__.dialog.ask(
        "声场档案将退出，安装新版后自动重新打开。未保存的输入不会保留，音乐库和音频不受影响。"
            + (needsAuthorization ? "\n当前账户不能直接写入安装位置，系统会请求管理员密码。" : ""),
        { title: "退出并安装更新？", kind: "info", okLabel: "现在重启", cancelLabel: "稍后" }
    );
    if (!accepted) return null;
    if (databaseSwitchInProgress || applicationUpdateInProgress) throw new Error("其他操作尚未完成，请稍后更新");
    if (onConfirmed) onConfirmed();
    applicationUpdateInProgress = true;
    const previousInert = document.body.inert;
    document.body.inert = true;
    const release = () => {
        applicationUpdateInProgress = false;
        document.body.inert = previousInert;
        if (typeof refreshAfterApplicationUpdate === "function") void refreshAfterApplicationUpdate().catch(console.error);
    };
    let timeout;
    const drained = Promise.allSettled([...pendingLibraryOperations, ...pendingCommands]);
    const results = typeof setTimeout === "function"
        ? await Promise.race([drained, new Promise(resolve => {timeout = setTimeout(() => resolve(null), 60000);})]) : await drained;
    if (timeout) clearTimeout(timeout);
    if (!results) {release(); throw new Error("操作仍未完成，更新已取消，可稍后重试。");}
    if (results.some(result => result.status === "rejected")) {
        release();
        throw new Error("正在进行的操作未能完成，请处理错误后再更新。");
    }
    try { await __TAURI__.core.invoke("prepare_update_exit"); }
    catch(error) {release(); throw error;}
    return () => {release(); void __TAURI__.core.invoke("abort_update_exit").catch(console.error);};
}

const TAG_GROUP_COLLAPSED_STORAGE_KEY = "music-library-tag-groups-collapsed";
const SIDEBAR_TAG_MANAGE_STORAGE_KEY = "music-library-sidebar-tag-manage";
const PAGE_SIZES_STORAGE_KEY = "music-library-page-sizes";

let state = {
    currentView: "home",
    search: "",
    albumSearch: "",
    movieSearch: "",
    movieMusicSearch: "",
    selectedMovieId: null,
    movieUsageStatus: "all",
    layout: "list",
    tagResultTab: null,
    recentMode: "added",
    /* 侧栏内联编辑：新增/重命名维度与 Tag 都在原位输入，不再弹浮层。
       { type: "create-category" | "edit-category" | "create-tag" | "edit-tag",
         categoryId?, categoryName?, parentId?, tagId?, tagName?, value? } */
    tagDraft: null,
    tagDraftSaving: false,
    tagGroupCollapsed: new Set(getSavedTagGroupCollapsed()),
    sidebarTagManage: getSavedSidebarTagManage(),
    activeTagIds: [],
    selectionMode: false,
    selectedMusicIds: new Set(),
    selectedClipIds: new Set(),

    pages: {},
    pageSizes: getSavedPageSizes(),
    importAlbumPage: 1,
    importTrackPage: 1,
    candidatePage: 1,

    catalogSelection: null,
    albumDirectoryScroll: 0,
    movieDirectoryScroll: 0,

    selectedMusic: null,
    clipsPanelMusic: null,
    playOnRowClick: true,
    quickTagMusicId: null,
    quickTagAlbumKey: null,
    quickTagSuggestions: [],

    importFiles: [],
    importAlbumSource: "metadata",
    importSelectedAlbum: null,

    editTags: [],
    editTagIds: [],
    clipTags: [],
    clipTagIds: [],

    clipMusic: null,
    editingClip: null,
    clipPreviewing: false,
    clipFullPreviewing: false,
    clipNameAutoGenerated: false,
    clipDuration: 0,
    clipStart: 0,
    clipEnd: 0,
    clipInitialState: null,

    draggingHandle: null,
    draggingTagId: null,
    tagPointerDrag: null,

    player: {
        queue: [],
        queueSource: "view",
        index: -1,
        music: null,
        segment: null,
        playing: false,
        loading: false,
        audio: null,
        currentUrl: "",
        candidates: []
    }
};

/* 最近一次内容渲染展示的、可播放、按显示顺序的音乐数组 */
let visibleQueueMusic = [];
let visibleClipIds = [];
let databasePath = "";
let importAlbumRefreshTimer = null;
let importAlbumNameScrollTimer = null;
let importAlbumNameScrollElement = null;
let locationSyncPromise = null;
let tagRecordsCache = [];
/* 专辑名 → [tagId]。专辑没有独立实体，Tag 关联按专辑名存（后端 album_tags 表）。 */
let albumTagsCache = new Map();
let searchRenderTimer = null;
/* 双击判定（J/L shuttle） */
let lastShuttleKey = null;
let lastShuttleAt = 0;
/* IME（中文/日文输入法）组词期间不入库筛选，避免拼音串先触发重渲染把候选框顶掉 */
const libraryCache = { versions: { music: 0, clips: 0 } };
const coverArtCache = new Map();
const PAGE_SIZE = 50;
const COMPACT_PAGE_SIZE = 30;
const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100];

function getSavedPageSizes() {
    try {
        const saved = JSON.parse(localStorage.getItem(PAGE_SIZES_STORAGE_KEY) || "{}");
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
        return Object.fromEntries(Object.entries(saved).filter(([, value]) => [10, 20, 30, 50, 100].includes(Number(value))));
    } catch (_) {
        return {};
    }
}

function savePageSizes() {
    try {
        localStorage.setItem(PAGE_SIZES_STORAGE_KEY, JSON.stringify(state.pageSizes));
    } catch (_) {
        // 存储不可用时，仅在本次运行中保留设置。
    }
}

function resetPagination() {
    state.pages = {};
    state.candidatePage = 1;
}

function restoreCatalogScroll({ list = 0, detail = 0 } = {}) {
    requestAnimationFrame(() => {
        const catalogList = document.querySelector(".catalog-list");
        const catalogDetail = document.querySelector(".catalog-detail");
        if (catalogList) catalogList.scrollTop = list;
        if (catalogDetail) catalogDetail.scrollTop = detail;
    });
}

/* 快速打 Tag 后的重渲染不该挪动任何滚动位置：目录视图的两个滚动列
   每次 render 都会重建，主列表滚动容器也可能被内容替换重置，
   统一在渲染后恢复到原处。 */
async function renderPreservingScroll() {
    const mainTop = document.querySelector(".main-scroll-area")?.scrollTop ?? 0;
    const listTop = document.querySelector(".catalog-list")?.scrollTop ?? 0;
    const detailTop = document.querySelector(".catalog-detail")?.scrollTop ?? 0;
    await render();
    requestAnimationFrame(() => {
        const main = document.querySelector(".main-scroll-area");
        if (main) main.scrollTop = mainTop;
        const list = document.querySelector(".catalog-list");
        if (list) list.scrollTop = listTop;
        const detail = document.querySelector(".catalog-detail");
        if (detail) detail.scrollTop = detailTop;
    });
}

function scrollMainContentToTop() {
    requestAnimationFrame(() => {
        const scroller = document.querySelector(".main-scroll-area");
        const content = $("contentArea");
        scroller?.scrollTo({ top: Math.max(0, content.offsetTop), behavior: "auto" });
    });
}

async function hydrateVisibleArtwork(music) {
    const ids = music.filter(item => !item.coverArt && !coverArtCache.has(item.id)).map(item => item.id);
    if (ids.length) {
        const covers = await invoke("get_music_cover_arts", { ids });
        covers.forEach(item => coverArtCache.set(item.id, item.coverArt || ""));
    }
    music.forEach(item => {
        const coverArt = item.coverArt || coverArtCache.get(item.id);
        if (!coverArt) return;
        document.querySelectorAll(`[data-music-id="${CSS.escape(item.id)}"] .music-icon, [data-music-id="${CSS.escape(item.id)}"] .card-icon`).forEach(container => {
            container.classList.toggle("has-artwork", container.classList.contains("card-icon"));
            container.innerHTML = `<img src="${escapeHTML(coverArt)}" alt="${escapeHTML(item.album || item.name)} 封面">`;
        });
    });
}

function stopImportAlbumNameScroll() {
    if (importAlbumNameScrollTimer) clearInterval(importAlbumNameScrollTimer);
    if (importAlbumNameScrollElement) importAlbumNameScrollElement.scrollLeft = 0;
    importAlbumNameScrollTimer = null;
    importAlbumNameScrollElement = null;
}

function startImportAlbumNameScroll(element) {
    stopImportAlbumNameScroll();
    if (element.scrollWidth <= element.clientWidth) return;
    importAlbumNameScrollElement = element;
    let direction = 1;
    let pauseUntil = Date.now() + 500;
    importAlbumNameScrollTimer = setInterval(() => {
        if (!importAlbumNameScrollElement) return;
        if (Date.now() < pauseUntil) return;
        const max = element.scrollWidth - element.clientWidth;
        if (element.scrollLeft >= max) {
            direction = -1;
            pauseUntil = Date.now() + 700;
        } else if (element.scrollLeft <= 0 && direction < 0) {
            direction = 1;
            pauseUntil = Date.now() + 700;
        }
        element.scrollLeft = Math.max(0, Math.min(max, element.scrollLeft + direction * 0.8));
    }, 16);
}


/* =========================================================
   DOM
========================================================= */

const $ = id => document.getElementById(id);

/* =========================================================
   外观与设置
========================================================= */

const THEME_STORAGE_KEY = "music-library-theme";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "music-library-sidebar-collapsed";
const THEMES = {
    cream: { label: "奶油留白" },
    night: { label: "月夜打盹" }
};

function setSidebarCollapsed(collapsed, { persist = true } = {}) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);

    const button = $("sidebarCollapseBtn");
    button.setAttribute("aria-expanded", String(!collapsed));
    updateSidebarFilterIndicator();
    button.querySelector("span:last-child").textContent = collapsed
        ? "展开 Tag 筛选"
        : "收起 Tag 筛选";

    if (persist) {
        try {
            localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
        } catch (_) {
            // 仅本次运行保持当前状态。
        }
    }
}

function getSavedSidebarCollapsed() {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
    } catch (_) {
        return false;
    }
}

/* 折叠键统一为带前缀字符串："c:<维度id>" / "t:<Tag id>"；兼容旧版纯数字（视为维度 id）。 */
function getSavedTagGroupCollapsed() {
    try {
        const saved = JSON.parse(localStorage.getItem(TAG_GROUP_COLLAPSED_STORAGE_KEY) || "[]");
        if (!Array.isArray(saved)) return [];
        return saved.map(value => typeof value === "number" ? `c:${value}` : String(value));
    } catch (_) {
        return [];
    }
}

function saveTagGroupCollapsed() {
    try {
        localStorage.setItem(TAG_GROUP_COLLAPSED_STORAGE_KEY, JSON.stringify([...state.tagGroupCollapsed]));
    } catch (_) {
        // 仅本次运行保持当前状态。
    }
}

function getSavedSidebarTagManage() {
    try {
        return localStorage.getItem(SIDEBAR_TAG_MANAGE_STORAGE_KEY) === "true";
    } catch (_) {
        return false;
    }
}

function saveSidebarTagManage() {
    try {
        localStorage.setItem(SIDEBAR_TAG_MANAGE_STORAGE_KEY, String(state.sidebarTagManage));
    } catch (_) {
        // 仅本次运行保持当前状态。
    }
}

function getSavedTheme() {
    try {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        return THEMES[saved] ? saved : saved === "sky" ? "night" : "cream";
    } catch (_) {
        return "cream";
    }
}

function applyTheme(themeName, { persist = true } = {}) {
    const theme = THEMES[themeName] ? themeName : "cream";
    document.body.dataset.theme = theme;
    const nextTheme = theme === "cream" ? "night" : "cream";
    const appearance = $("themeToggleBtn");
    appearance.title = `切换到${THEMES[nextTheme].label}`;
    appearance.setAttribute("aria-label", `当前外观：${THEMES[theme].label}，${appearance.title}`);

    if (persist) {
        try {
            localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch (_) {
            // 主题仍可在当前次运行中正常切换。
        }
    }

    window.HomeScene?.refresh(theme);
}

function setupThemeSwitcher() {
    const appearance = $("themeToggleBtn");
    const toggle = $("settingsToggleBtn");
    const menu = $("settingsMenu");

    window.HomeSceneMotion?.setupControl($("sceneMotionBtn"));
    applyTheme(getSavedTheme(), { persist: false });
    window.ThemeTransition?.prepare(document.body.dataset.theme === "cream" ? "night" : "cream");

    const close = () => {
        menu.classList.add("hidden");
        toggle.setAttribute("aria-expanded", "false");
    };
    appearance.addEventListener("click", () => {
        close();
        const theme = document.body.dataset.theme === "cream" ? "night" : "cream";
        if (window.ThemeTransition) {
            window.ThemeTransition.change(theme, applyTheme).catch(console.error);
        } else applyTheme(theme);
    });
    const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled)')];
    const open = () => {
        menu.classList.remove("hidden");
        toggle.setAttribute("aria-expanded", "true");
        items()[0]?.focus();
    };

    toggle.addEventListener("click", event => {
        event.stopPropagation();
        if (menu.classList.contains("hidden")) open();
        else close();
    });

    toggle.addEventListener("keydown", event => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) event.stopPropagation();
        if (event.key === "Escape" && !menu.classList.contains("hidden")) {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            open();
            if (event.key === "ArrowUp") items().at(-1)?.focus();
        }
    });

    menu.addEventListener("click", event => {
        if (event.target.closest(".settings-action")) {
            close();
            toggle.focus();
        }
    });

    menu.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape") {
            event.preventDefault();
            close();
            toggle.focus();
            return;
        }
        const choices = items();
        const index = choices.indexOf(document.activeElement);
        let next;
        if (event.key === "ArrowDown") next = (index + 1) % choices.length;
        if (event.key === "ArrowUp") next = (index - 1 + choices.length) % choices.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = choices.length - 1;
        if (next !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            choices[next]?.focus();
        }
    });

    toggle.parentElement.addEventListener("focusout", event => {
        if (!toggle.parentElement.contains(event.relatedTarget)) close();
    });

    document.addEventListener("click", event => {
        if (!event.target.closest(".theme-switcher")) close();
    });
}

const importModal = $("importModal");
const editModal = $("editModal");
const shortcutsModal = $("shortcutsModal");
const clipEditorPanel = $("clipEditorPanel");


/* =========================================================
   初始化
========================================================= */

function ensureTauri() {

    if (!window.__TAURI__) {

        alert(
            "请使用「声场档案」桌面应用打开，而不是浏览器。"
        );

        throw new Error("not running in Tauri");
    }
}


/* =========================================================
   数据访问层（Tauri command 封装）
========================================================= */

async function initDB() {
    document.body.inert = true;
    while (true) {
        try {
            if (!await invoke("init_db")) {
                const configured = await configureStartupLibrary();
                if (configured === null) continue;
                if (!configured) return false;
            }
            document.body.inert = false;
            return true;
        } catch (error) {
            await reportStartupState("library_unavailable");
            const retry = await __TAURI__.dialog.ask(
                `${getErrorMessage(error)}\n\n如果数据库在移动硬盘，请先连接硬盘并确认它已在 Finder 中显示，再点击“重试”。未打开音乐库前不会创建替代空库。`,
                { title: "音乐库暂不可用", kind: "warning", okLabel: "重试", cancelLabel: "退出" }
            );
            if (!retry) {
                await invoke("cancel_database_startup");
                return false;
            }
        }
    }
}

async function configureStartupLibrary() {
    await reportStartupState("waiting_library");
    const open = "打开已有音乐库";
    const create = "创建新音乐库";
    const choice = await __TAURI__.dialog.message(
        "未找到本机的音乐库位置配置。如果已有音乐库（例如在移动硬盘上），请连接硬盘后选择“打开已有音乐库”。只有主动选择创建，才会生成新库。",
        { title: "选择音乐库", kind: "info", buttons: { yes: open, no: create, cancel: "退出" } }
    );
    if (choice !== open && choice !== create) {
        await invoke("cancel_database_startup");
        return false;
    }
    const createNew = choice === create;
    const selected = await __TAURI__.dialog.open({
        directory: true,
        multiple: false,
        title: createNew ? "选择新音乐库的保存文件夹" : "选择已有 library.db 所在文件夹"
    });
    if (!selected) return null;
    if (createNew && !await __TAURI__.dialog.ask(
        `确认在此文件夹创建一个空音乐库？\n${String(selected)}\n\n如果已有音乐库，请返回并选择“打开已有音乐库”。已有 library.db 不会被覆盖。`,
        { title: "创建新音乐库", kind: "warning", okLabel: "创建空音乐库", cancelLabel: "返回" }
    )) return null;
    await invoke("configure_database_startup", { dir: String(selected), createNew });
    return true;
}

async function reportStartupState(state) {
    // Diagnostic failure must not prevent opening an otherwise usable music library.
    try { await invoke("report_startup_state", { state }); } catch (error) { console.error(error); }
}

async function refreshLocationsAfterFinderChanges() {
    if (locationSyncPromise) return locationSyncPromise;
    const contextVersion = detailRequestVersion;
    const contextRequest = musicContextRequest;
    const selectedMusicId = state.selectedMusic?.id;
    const clipsMusicId = state.clipsPanelMusic?.id;

    locationSyncPromise = (async () => {
        const result = await invoke("sync_library_locations");
        if (!result.updatedPaths && !result.updatedAlbums) return;
        invalidateLibraryCache("music");

        // Finder 改名会让专辑 Tag 迁到新名字，缓存也要跟着刷新。
        await refreshWhileInteractive(updateCounts, renderSidebarTags, loadAlbumTags, render);
        if (contextVersion !== detailRequestVersion || applicationUpdateInProgress || databaseSwitchInProgress) return;
        if (contextRequest?.id === selectedMusicId && contextRequest.kind === "detail" && state.selectedMusic?.id === selectedMusicId && !$("detailPanel").classList.contains("hidden")) {
            await readMusicContext(selectedMusicId, contextVersion, context => {
                const before = { ...state.selectedMusic };
                syncDetailMusic(context.music, (field, control) => !control || control.value === (before[field] || ""));
            });
        } else if (clipsMusicId && state.clipsPanelMusic?.id === clipsMusicId) {
            await refreshMusicContext(contextRequest, clipsMusicId);
        }
    })();

    try {
        await locationSyncPromise;
    } finally {
        locationSyncPromise = null;
    }
}

async function setupDatabasePath() {
    databasePath = await invoke("get_database_path");
    $("databasePath").textContent = databasePath;
    $("databasePathLink").title = `在 Finder 中显示 ${databasePath}`;
}

async function revealDatabaseFile() {
    try {
        if (!databasePath) {
            await setupDatabasePath();
        }
        await __TAURI__.opener.revealItemInDir(databasePath);
    } catch (error) {
        console.error(error);
        await showMessage(
            `无法在 Finder 中显示数据库文件：${getErrorMessage(error)}`,
            "无法定位数据库",
            "error"
        );
    }
}

async function changeDatabaseLocation() {
    const button = $("changeDbLocationBtn");
    if (button.disabled || databaseSwitchInProgress) return;
    button.disabled = true;
    try {
        const selected = await __TAURI__.dialog.open({
            directory: true,
            multiple: false,
            title: "选择音乐库所在文件夹"
        });
        if (!selected) return;
        const dir = String(selected);

        const exists = await invoke("file_exists", { path: `${dir}/library.db` });
        if (!await confirm(
            exists
                ? `打开此文件夹中的音乐库：\n${dir}\n\n当前音乐库会保留，不会复制、合并或覆盖数据。切换后将刷新界面，未保存的编辑会被丢弃。`
                : `此文件夹中没有 library.db：\n${dir}\n\n是否在这里创建一个空音乐库？当前音乐库会保留，不会搬迁。切换后将刷新界面，未保存的编辑会被丢弃。`,
            exists ? "打开已有音乐库" : "创建空音乐库"
        )) return;

        databaseSwitchInProgress = true;
        document.body.inert = true;
        showToast("正在切换音乐库…", 60000);
        // 等在途命令结束，并阻止旧界面的异步后续操作写入新库。
        await Promise.allSettled([...pendingCommands]);
        await invoke("set_database_location", { dir, createIfMissing: !exists });
        // 全量重载，丢弃旧库的音乐、标签、候选、播放器和编辑状态。
        window.location.reload();
    } catch (error) {
        databaseSwitchInProgress = false;
        document.body.inert = false;
        console.error(error);
        $("toast").classList.remove("show");
        await showMessage(
            `切换音乐库失败，仍在使用原音乐库：${getErrorMessage(error)}`,
            "切换失败",
            "error"
        );
    } finally {
        if (!databaseSwitchInProgress) button.disabled = false;
    }
}


/* =========================================================
   ID
========================================================= */

function createId(prefix = "") {

    return (
        prefix +
        Date.now().toString(36) +
        "_" +
        Math.random()
            .toString(36)
            .substring(2, 10)
    );
}


/* =========================================================
   工具
========================================================= */

function escapeHTML(value) {

    if (value === undefined || value === null) {
        return "";
    }

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function musicArtwork(item) {
    return item.coverArt
        ? `<img src="${escapeHTML(item.coverArt)}" alt="${escapeHTML(item.album || item.name)} 封面">`
        : "♫";
}

function renderInlineMusicTags(item) {
    const tags = renderAssignedTags(item);
    const editing = state.quickTagMusicId === item.id;
    const used = new Set((item.tagIds || []).filter(Number.isInteger));
    const grouped = new Map();
    state.quickTagSuggestions
        .filter(tag => !used.has(tag.id))
        .forEach(tag => {
            const category = tag.category || "未分类";
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(tag);
        });
    const options = [...grouped.entries()].map(([category, categoryTags]) =>
        `<optgroup label="${escapeHTML(category)}">${categoryTags.map(tag => `<option value="${tag.id}">#${escapeHTML(tag.path)}</option>`).join("")}</optgroup>`
    ).join("");

    return `${tags}<span class="music-quick-actions"><button class="quick-tag-button" data-action="quick-tag" data-id="${item.id}" title="为这首音乐添加 Tag">＋ Tag</button><button type="button" class="movie-record-button" data-movie-action="add-movies" data-music-id="${escapeHTML(item.id)}" title="记录这首音乐用于哪些电影">＋ 影片</button></span>${editing ? `<span class="quick-tag-editor"><select data-quick-tag-select data-id="${item.id}" aria-label="选择已有 Tag"><option value="">选择已有 Tag</option>${options}</select><input data-quick-tag-input="${item.id}" type="text" placeholder="新 Tag，按 Enter" aria-label="输入新 Tag"><button data-action="quick-tag-save" data-id="${item.id}" title="保存新 Tag">添加</button></span>` : ""}`;
}

async function saveQuickTag(musicId, rawValue, tagId = null) {
    let selected = Number.isInteger(Number(tagId)) && tagId !== null
        ? tagRecordsCache.find(item => item.id === Number(tagId))
        : null;
    const tag = selected?.name || normalizeTag(rawValue);
    if (!tag) {
        showToast("请输入 Tag 名称");
        return;
    }

    /* 手输入的名字命中已有 Tag 时直接关联它，而不是按新 Tag 处理。 */
    if (!selected) {
        const typed = tag.toLowerCase();
        selected = tagRecordsCache.find(item => item.name.toLowerCase() === typed) || null;
    }

    let duplicate = false;
    const music = await mutateMusic(musicId, music => {
        duplicate = selected ? (music.tagIds || []).includes(selected.id) : (music.tags || []).includes(tag);
        return duplicate ? null : {
            tags: [...(music.tags || []), tag],
            tagIds: [...(music.tagIds || []), selected?.id ?? null]
        };
    });
    if (!music) return;
    state.quickTagMusicId = null;
    if (applicationUpdateInProgress) return;
    await refreshWhileInteractive(updateCounts, renderSidebarTags, renderPreservingScroll);
    if (!applicationUpdateInProgress) showToast(duplicate ? "该 Tag 已添加" : `已添加 #${tag}`);
}


/* =========================================================
   专辑 Tag（专辑页右侧标题下方）
   与音乐的快速 Tag 同一套交互：选已有 Tag 或直接输入新 Tag。
========================================================= */

function renderAlbumTags(album) {
    const tagIds = albumTagsCache.get(album) || [];
    const chips = tagIds
        .map(id => {
            const record = tagRecordsCache.find(tag => tag.id === id);
            if (!record) return "";
            return `<span class="tag album-tag" title="${escapeHTML(record.path || record.name)}">#${escapeHTML(record.name)}<button type="button" class="album-tag-remove" data-album-tag-remove="${id}" data-album="${escapeHTML(album)}" title="从专辑移除该 Tag" aria-label="从专辑移除 Tag ${escapeHTML(record.name)}">×</button></span>`;
        })
        .join("");

    const editing = state.quickTagAlbumKey === album;
    const used = new Set(tagIds.filter(Number.isInteger));
    const grouped = new Map();
    state.quickTagSuggestions
        .filter(tag => !used.has(tag.id))
        .forEach(tag => {
            const category = tag.category || "未分类";
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(tag);
        });
    const options = [...grouped.entries()].map(([category, categoryTags]) =>
        `<optgroup label="${escapeHTML(category)}">${categoryTags.map(tag => `<option value="${tag.id}">#${escapeHTML(tag.path)}</option>`).join("")}</optgroup>`
    ).join("");

    return `${chips}<button type="button" class="quick-tag-button" data-action="album-quick-tag" data-album="${escapeHTML(album)}" title="为这张专辑添加 Tag">＋ Tag</button>${editing ? `<span class="quick-tag-editor"><select data-album-tag-select aria-label="选择已有 Tag"><option value="">选择已有 Tag</option>${options}</select><input data-album-tag-input type="text" placeholder="新 Tag，按 Enter" aria-label="输入新 Tag"><button type="button" data-action="album-quick-tag-save" data-album="${escapeHTML(album)}" title="保存新 Tag">添加</button></span>` : ""}`;
}

async function saveAlbumQuickTag(album, rawValue, tagId = null) {
    if (!album) return;
    let selected = Number.isInteger(Number(tagId)) && tagId !== null
        ? tagRecordsCache.find(item => item.id === Number(tagId))
        : null;
    const tag = selected?.name || normalizeTag(rawValue);
    if (!tag) {
        showToast("请输入 Tag 名称");
        return;
    }

    /* 手输入的名字命中已有 Tag 时直接关联它，而不是按新 Tag 处理。 */
    if (!selected) {
        const typed = tag.toLowerCase();
        selected = tagRecordsCache.find(item => item.name.toLowerCase() === typed) || null;
    }

    const current = albumTagsCache.get(album) || [];
    const duplicated = selected
        ? current.includes(selected.id)
        : current.some(id => tagRecordsCache.find(record => record.id === id)?.name === tag);
    if (duplicated) {
        state.quickTagAlbumKey = null;
        await renderPreservingScroll();
        showToast("该 Tag 已添加");
        return;
    }

    const tagIds = await invoke("set_album_tags", {
        album,
        tagIds: selected ? [...current, selected.id] : current,
        newTags: selected ? [] : [tag]
    });
    albumTagsCache.set(album, tagIds);
    state.quickTagAlbumKey = null;
    await updateCounts();
    await renderSidebarTags();
    await renderPreservingScroll();
    showToast(`已添加 #${tag}`);
}

async function removeAlbumTag(album, tagId) {
    const key = assignedTagKey("album", album, tagId);
    if (assignedTagRemovals.has(key)) return;
    assignedTagRemovals.add(key);
    try {
        const tag = tagRecordsCache.find(item => item.id === tagId);
        if (!await confirmTagRemoval("album", album, tag?.path || tag?.name || `Tag ${tagId}`)) return;
        const current = albumTagsCache.get(album) || [];
        const tagIds = await invoke("set_album_tags", {
            album,
            tagIds: current.filter(id => id !== tagId),
            newTags: []
        });
        albumTagsCache.set(album, tagIds);
        await renderPreservingScroll();
    } catch (error) {
        console.error(error);
        showToast(`移除 Tag 失败：${getErrorMessage(error)}`);
    } finally {
        assignedTagRemovals.delete(key);
    }
}

function getErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }

    if (typeof error === "string" && error.trim()) {
        return error;
    }

    if (error && typeof error === "object") {
        const message = error.message || error.error || error.details;
        if (typeof message === "string" && message.trim()) {
            return message;
        }
        try {
            return JSON.stringify(error);
        } catch (_) {
            // 忽略无法序列化的异常对象，返回统一兜底文案。
        }
    }

    return "未知错误";
}


function formatTime(seconds) {

    if (!Number.isFinite(seconds)) {
        return "00:00";
    }

    seconds = Math.max(0, seconds);

    const h = Math.floor(seconds / 3600);

    const m = Math.floor(
        (seconds % 3600) / 60
    );

    const s = Math.floor(
        seconds % 60
    );

    if (h > 0) {

        return (
            String(h).padStart(2, "0") +
            ":" +
            String(m).padStart(2, "0") +
            ":" +
            String(s).padStart(2, "0")
        );
    }

    return (
        String(m).padStart(2, "0") +
        ":" +
        String(s).padStart(2, "0")
    );
}

function parseTime(value) {
    const text = String(value || "").trim();
    if (!text) return NaN;
    const parts = text.split(":").map(Number);
    if (parts.some(part => !Number.isFinite(part))) return NaN;
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
}

function normalizeTag(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}


/* =========================================================
   侧栏内联编辑
   新增/重命名维度与 Tag 都在侧栏原位输入：Enter 提交、Esc 取消、
   失焦时若已输入内容则提交。渲染由 renderSidebarTags 负责，
   这里只维护 state.tagDraft 这一份待编辑状态。
========================================================= */

/* 每一轮草稿带一个自增 id：重渲染会换掉输入框元素，提交后也要开新一轮，
   靠 id 才能分清「用户真的离开了这个输入框」和「这个输入框被重渲染换掉了」——
   后者在浏览器里也会补一个 focusout，不区分就会重复提交一次。 */
let tagDraftSeq = 0;

function startTagDraft(draft) {
    /* 默认空值 + 光标置尾；重命名时先全选，敲字即覆盖。 */
    state.tagDraft = { id: ++tagDraftSeq, value: "", selectAll: draft.type.startsWith("edit-"), ...draft };
    renderSidebarTags();
}

function cancelTagDraft() {
    if (!state.tagDraft) return;
    state.tagDraft = null;
    renderSidebarTags();
}

async function commitTagDraft(input) {
    const draft = state.tagDraft;
    if (!draft || state.tagDraftSaving) return;

    const name = normalizeTag(input ? input.value : draft.value);
    const isCreate = draft.type === "create-category" || draft.type === "create-tag";

    /* 空值等于放弃；重命名时输入原值也算放弃，避免无意义的写库。 */
    if (!name || (draft.type === "edit-category" && name === draft.categoryName)
        || (draft.type === "edit-tag" && name === draft.tagName)) {
        state.tagDraft = null;
        await renderSidebarTags();
        return;
    }

    state.tagDraftSaving = true;
    /* 先清空草稿再请求，避免失焦与回车重复提交。 */
    state.tagDraft = null;
    try {
        if (draft.type === "create-category") {
            await invoke("create_tag_category", { name });
            showToast("维度已创建");
        } else if (draft.type === "edit-category") {
            await invoke("update_tag_category", { oldName: draft.categoryName, name });
            showToast("维度已更新");
        } else if (draft.type === "create-tag") {
            await invoke("create_tag", { name, categoryId: draft.categoryId, category: null, parentId: draft.parentId ?? null });
            showToast("Tag 已创建");
        } else if (draft.type === "edit-tag") {
            await invoke("update_tag", { id: draft.tagId, name, category: null });
            showToast("Tag 已更新");
        }
        invalidateLibraryCache();
        /* 连续录入：新增后把同一个输入位重新打开，方便接着敲下一个。
           若期间用户已经点了别处的编辑，就不要再抢回来。 */
        if (isCreate && !state.tagDraft) state.tagDraft = { ...draft, id: ++tagDraftSeq, value: "", selectAll: false };
    } catch (error) {
        showToast(`保存失败：${error}`);
        /* 失败时把输入框连同刚敲的名字放回去并全选，改一个字就能重试。 */
        if (!state.tagDraft) state.tagDraft = { ...draft, id: ++tagDraftSeq, value: name, selectAll: true };
    } finally {
        state.tagDraftSaving = false;
        await renderSidebarTags();
        await render();
    }
}


function formatFileSize(bytes) {

    if (bytes < 1024) {
        return bytes + " B";
    }

    if (bytes < 1024 * 1024) {
        return (
            (bytes / 1024).toFixed(1) +
            " KB"
        );
    }

    if (bytes < 1024 * 1024 * 1024) {
        return (
            (bytes / 1024 / 1024).toFixed(1) +
            " MB"
        );
    }

    return (
        (bytes / 1024 / 1024 / 1024).toFixed(2) +
        " GB"
    );
}


async function confirm(message, title = "确认") {

    const result =
        await __TAURI__.dialog.ask(
            message,
            { title, kind: "warning" }
        );

    return result === true;
}


let toastTimer = null;

function showToast(message, duration = 2200) {

    const toast = $("toast");

    clearTimeout(toastTimer);

    toast.textContent = message;

    toast.classList.add("show");

    toastTimer = setTimeout(() => {

        toast.classList.remove("show");

    }, duration);
}

async function showMessage(message, title = "提示", kind = "info") {
    await __TAURI__.dialog.message(message, { title, kind });
}


/* =========================================================
   获取所有 Tag
========================================================= */

async function getAllTagRecords() {
    tagRecordsCache = await invoke("list_tags");
    return tagRecordsCache;
}

async function loadAlbumTags() {
    const entries = await invoke("list_album_tags");
    albumTagsCache = new Map(
        entries.map(entry => [entry.album, entry.tagIds || []])
    );
    return albumTagsCache;
}


/* =========================================================
   侧边 Tag
   按筛选维度分组的 Tag 树：维度行与有子级的 Tag 行均可折叠，
   折叠状态按 "c:<维度id>" / "t:<Tag id>" 持久化。
   开合箭头是一枚 SVG 细线箭头，指向由 CSS 依据 aria-expanded 旋转，
   这里只输出图形本身，不随状态替换字形。
========================================================= */

/* 1.5px 圆头描边箭头：字符字形要么太小看不清、要么太大太笨重，CSS border 画的
   箭头又做不出圆头，而且小于 1px 的描边会被浏览器取整。 */
const CHEVRON_SVG = '<svg class="chevron" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M1.5 4L6 8L10.5 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

async function renderSidebarTags() {

    updateSidebarFilterIndicator();
    const container = $("sidebarTags");

    const tags = await getAllTagRecords();
    const categories = await invoke("list_tag_category_records");

    const groups = new Map();
    categories.forEach(category => groups.set(category.id, category));
    tags.forEach(tag => {
        if (!groups.has(tag.categoryId)) {
            groups.set(tag.categoryId, { id: tag.categoryId, name: tag.category || "未分类" });
        }
    });

    const byParent = new Map();
    tags.forEach(tag => {
        const key = tag.parentId ?? "root";
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(tag);
    });
    byParent.forEach(list => list.sort((a, b) =>
        (b.musicCount ?? 0) - (a.musicCount ?? 0) ||
        a.name.localeCompare(b.name, "zh-Hans-CN")
    ));

    /* 自底向上累加：每个 Tag 的计数包含所有后代子 Tag。 */
    const inclusiveCount = new Map();
    const computeCount = tag => {
        let total = tag.musicCount ?? 0;
        (byParent.get(tag.id) || []).forEach(child => {
            total += computeCount(child);
        });
        inclusiveCount.set(tag.id, total);
        return total;
    };
    (byParent.get("root") || []).forEach(computeCount);

    const renderCaret = (key, hasChildren) => {
        if (!hasChildren) return `<span class="sidebar-tag-caret-spacer" aria-hidden="true"></span>`;
        const collapsed = state.tagGroupCollapsed.has(key);
        return `<button class="sidebar-tag-caret" data-collapse-toggle="${key}" title="${collapsed ? "展开" : "折叠"}" aria-expanded="${!collapsed}">${CHEVRON_SVG}</button>`;
    };

    const draft = state.tagDraft;

    /* 内联输入框：新增空着（用 placeholder 说明用途），重命名带上原名并全选。 */
    const renderDraftInput = placeholder => `<input
        class="sidebar-tag-input"
        data-tag-draft-input
        data-tag-draft-id="${draft?.id ?? 0}"
        type="text"
        autocomplete="off"
        spellcheck="false"
        aria-label="${placeholder}"
        placeholder="${placeholder}"
        value="${escapeHTML(draft?.value || "")}"
    >`;

    /* 新增 Tag 的占位行：与普通 Tag 行同样的缩进和 checkbox 位置。 */
    const renderTagDraftRow = depth => `
        <div class="sidebar-tag-row is-draft" style="--tag-depth:${depth}">
            <span class="sidebar-tag-caret-spacer" aria-hidden="true"></span>
            <span class="sidebar-tag">
                <span class="sidebar-tag-checkbox is-draft" aria-hidden="true"></span>
                ${renderDraftInput("新 Tag 名称")}
            </span>
        </div>
    `;

    const renderTagRow = (tag, depth) => {
        const children = byParent.get(tag.id) || [];
        const key = `t:${tag.id}`;
        const collapsed = state.tagGroupCollapsed.has(key);
        const selected = state.activeTagIds.includes(tag.id);
        const editing = draft?.type === "edit-tag" && draft.tagId === tag.id;
        /* 新增子 Tag 时输入框放在该 Tag 的第一个子级位置。 */
        const childDraft = draft?.type === "create-tag" && draft.parentId === tag.id;
        return `
        <div
            class="sidebar-tag-row"
            style="--tag-depth:${depth}"
            data-tag-id="${tag.id}"
            data-tag-name="${escapeHTML(tag.name)}"
        >
            ${renderCaret(key, children.length > 0)}
            ${editing ? `
            <div class="sidebar-tag is-editing">
                <span class="sidebar-tag-checkbox${selected ? " is-selected" : ""}" aria-hidden="true">✓</span>
                ${renderDraftInput("Tag 名称")}
                <span class="sidebar-tag-count">${inclusiveCount.get(tag.id) ?? 0}</span>
            </div>
            ` : `
            <button
                class="sidebar-tag${selected ? " is-selected" : ""}"
                data-tag-id="${tag.id}"
                title="# ${escapeHTML(tag.path)}"
                aria-pressed="${selected}"
            >
                <span class="sidebar-tag-checkbox" aria-hidden="true">✓</span>
                <span class="sidebar-tag-name">${escapeHTML(tag.name)}</span>
                <span class="sidebar-tag-count">${inclusiveCount.get(tag.id) ?? 0}</span>
            </button>
            `}
            <span class="sidebar-tag-ops">
                <button data-sidebar-tag-edit="${tag.id}" title="编辑 Tag">✎</button>
                <button data-sidebar-tag-add="${tag.id}" data-category-id="${tag.categoryId}" title="新增子 Tag">＋</button>
                <button data-sidebar-tag-delete="${tag.id}" title="删除 Tag">×</button>
            </span>
        </div>
        ${children.length || childDraft ? `<div class="sidebar-tag-children${collapsed ? " is-collapsed" : ""}" data-tag-children="${tag.id}">${childDraft ? renderTagDraftRow(depth + 1) : ""}${children.map(child => renderTagRow(child, depth + 1)).join("")}</div>` : ""}
    `;
    };

    const renderDimensionBody = categoryId => {
        const roots = (byParent.get("root") || []).filter(tag => tag.categoryId === categoryId);
        /* 新增根 Tag 时输入框放在该维度第一个 Tag 的位置。 */
        const rootDraft = draft?.type === "create-tag" && draft.categoryId === categoryId && !draft.parentId
            ? renderTagDraftRow(0)
            : "";
        if (rootDraft) return rootDraft + roots.map(tag => renderTagRow(tag, 0)).join("");
        return roots.length
            ? roots.map(tag => renderTagRow(tag, 0)).join("")
            : `<div class="empty-small">暂无 Tag</div>`;
    };

    cancelSidebarTagDrag();
    container.innerHTML = `<div class="sidebar-tag-tree${state.sidebarTagManage ? " is-managing" : ""}">` +
        [...groups.values()].map(category => {
            const key = `c:${category.id}`;
            const collapsed = state.tagGroupCollapsed.has(key);
            const selectedTags = tags.filter(tag => tag.categoryId === category.id && state.activeTagIds.includes(tag.id));
            const editing = draft?.type === "edit-category" && draft.categoryName === category.name;
            return `
                <div class="sidebar-tag-dimension${collapsed ? " is-collapsed" : ""}" data-dimension-id="${category.id}">
                    <div class="sidebar-tag-dimension-row" data-dimension-row="${category.id}">
                        <span class="sidebar-tag-dimension-icon" aria-hidden="true">#</span>
                        ${editing
                            ? renderDraftInput("维度名称")
                            : `<span class="sidebar-tag-dimension-name">${escapeHTML(category.name)}</span>
                        <span class="sidebar-tag-dimension-selected">${escapeHTML(selectedTags.map(tag => tag.name).join(", "))}</span>`}
                        ${selectedTags.length ? `<span class="sidebar-tag-dimension-pill">${selectedTags.length}</span>` : ""}
                        <span class="sidebar-tag-ops">
                            <button data-dimension-edit="${escapeHTML(category.name)}" title="编辑维度">✎</button>
                            <button data-dimension-delete="${escapeHTML(category.name)}" title="删除维度">×</button>
                            <button data-dimension-add data-category-id="${category.id}" data-category-name="${escapeHTML(category.name)}" title="新增根 Tag">＋</button>
                        </span>
                        <button class="sidebar-tag-dimension-toggle" data-collapse-toggle="${key}" title="${collapsed ? "展开" : "折叠"}" aria-expanded="${!collapsed}">${CHEVRON_SVG}</button>
                    </div>
                    <div class="sidebar-tag-dimension-body">
                        ${renderDimensionBody(category.id)}
                    </div>
                </div>
            `;
        }).join("") +
        (draft?.type === "create-category"
            ? `<div class="sidebar-tag-dimension-row is-draft">
                    <span class="sidebar-tag-dimension-icon" aria-hidden="true">#</span>
                    ${renderDraftInput("新维度名称")}
               </div>`
            : state.sidebarTagManage ? `<button class="sidebar-tag-add-dimension" data-dimension-create>＋ 新增维度</button>` : "") +
        (groups.size ? "" : `<div class="empty-small">还没有筛选维度，先新增一个维度再创建 Tag</div>`) +
        `</div>`;

    $("sidebarTagClearBtn").classList.toggle("hidden", !state.activeTagIds.length);

    /* 重渲染后把光标放回草稿输入框：重命名全选一次，新增时光标置尾。 */
    const draftInput = container.querySelector("[data-tag-draft-input]");
    if (draftInput && state.tagDraft) {
        draftInput.focus();
        if (state.tagDraft.selectAll) {
            state.tagDraft.selectAll = false;
            draftInput.select();
        } else {
            draftInput.setSelectionRange(draftInput.value.length, draftInput.value.length);
        }
    }
}

/* =========================================================
   打 Tag 时的「已有 Tag」分组选择器
   按筛选维度分组展示；chip 的 data-* 属性由调用方通过 attr 指定。
========================================================= */

async function loadTagPickerData() {
    const [records, categories] = await Promise.all([
        getAllTagRecords(),
        invoke("list_tag_category_records")
    ]);
    return { records, categories };
}

function renderTagPickerGroups({ exclude = [], excludeIds = [], query = "", attr, data }) {
    const excluded = new Set(exclude);
    const excludedIds = new Set(excludeIds.filter(Number.isInteger));
    const needle = query.trim().toLowerCase();
    const categoryNames = new Map(data.categories.map(category => [category.id, category.name]));
    const grouped = new Map();
    data.records
        .filter(tag =>
            !excludedIds.has(tag.id) && !excluded.has(tag.name) &&
            (!needle || tag.name.toLowerCase().includes(needle))
        )
        .forEach(tag => {
            const category = categoryNames.get(tag.categoryId) || tag.category || "未分类";
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(tag);
        });
    return [...grouped.entries()].map(([category, tags]) => `
        <div class="tag-pick-group">
            <div class="tag-pick-group-title">${escapeHTML(category)}</div>
            <div class="tag-pick-group-tags">${tags.map(tag => `
                <button
                    class="suggestion-tag"
                    data-${attr}="${tag.id}"
                    title="${escapeHTML(tag.path)}"
                >
                    #${escapeHTML(tag.name)}
                </button>
            `).join("")}</div>
        </div>
    `).join("");
}

function cancelSidebarTagDrag() {
    const drag = state.tagPointerDrag;
    if (!drag) return;
    drag.tagElement?.classList.remove("is-dragging");
    drag.ghost?.remove();
    document.querySelectorAll("#sidebarTags .is-drop-target")
        .forEach(item => item.classList.remove("is-drop-target"));
    state.draggingTagId = null;
    state.tagPointerDrag = null;
    showToast("拖拽已取消");
}

function updateSidebarFilterIndicator() {
    const count = state.activeTagIds.length;
    const collapsed = document.body.classList.contains("sidebar-collapsed");
    const button = $("sidebarCollapseBtn");
    const label = `${collapsed ? "展开" : "收起"} Tag 筛选${count ? `（已选 ${count} 个）` : ""}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    $("sidebarFilterCount").textContent = String(count);
    $("sidebarFilterCount").classList.toggle("hidden", !count);
}

function setActiveTag(tagId) {
    tagId = Number(tagId);
    if (!Number.isInteger(tagId)) return;
    state.activeTagIds = state.activeTagIds.includes(tagId)
        ? state.activeTagIds.filter(item => item !== tagId)
        : [...state.activeTagIds, tagId];
    resetPagination();
    renderSidebarTags();
    render();
}

function renderSelectionToolbar() {
    const selectingClips = state.currentView === "clips";
    const available = selectingClips ? visibleClipIds.length : visibleQueueMusic.length;
    const selected = selectingClips ? state.selectedClipIds : state.selectedMusicIds;
    if (!available && state.selectionMode) {
        state.selectionMode = false;
        selected.clear();
    }
    const toolbar = $("bulkToolbar");
    toolbar.classList.toggle("hidden", !state.selectionMode);
    $("selectionCount").textContent = selectingClips ? `已选择 ${selected.size} 个片段` : `已选择 ${selected.size} 首`;
    $("selectionToggleBtn").textContent = state.selectionMode ? "取消选择" : "选择";
    $("selectionToggleBtn").disabled = !available;
    $("bulkTagControls").classList.toggle("hidden", selectingClips);
    $("bulkDeleteBtn").disabled = !selected.size;
}


/* =========================================================
   统计
========================================================= */

async function updateCounts() {
    const counts = await getLibraryCounts();
    $("allCount").querySelector(".nav-count-value").textContent = counts.music;
    $("clipCount").querySelector(".nav-count-value").textContent = counts.clips;
}


/* =========================================================
   获取音乐片段
========================================================= */

async function getMusicClips(musicId) {
    const key = `music-clips:${musicId}`;
    const page = await requestLibraryPage({ kind: "clips", musicId }, key, COMPACT_PAGE_SIZE);
    const clips = page.items.map(item => item.clip);
    clips.pagination = page;
    return clips;
}

async function openMusicClipsPanel(musicId) {
    const version = beginMusicContextRequest(musicId, "clips");
    return readMusicContext(musicId, version, renderMusicClipsContext);
}

function renderMusicClipsContext({ music, clips }) {
    clips.sort((a, b) => a.start - b.start);
    state.clipsPanelMusic = music;
    state.selectedMusic = null;
    $("detailPanel").classList.add("hidden");
    $("musicClipsPanel").classList.remove("hidden");
    $("musicClipsSource").textContent = music.name;
    const pageKey = `music-clips:${music.id}`;
    const page = acceptLibraryPage({ ...clips.pagination, items: clips }, pageKey);
    $("musicClipsBody").innerHTML = `
        <div class="clip-section-heading"><strong>${escapeHTML(music.name)}</strong><button class="primary-btn" data-clips-panel-action="create">＋ 新建片段</button></div>
        <div class="clip-list">${clips.length ? page.items.map(clip => `
            <div class="clip-item" data-panel-clip-id="${clip.id}">
                <div class="clip-item-header"><div class="clip-item-name">${escapeHTML(clip.name || "未命名片段")}</div><div class="clip-time">${formatTime(clip.start)} - ${formatTime(clip.end)}</div></div>
                <div class="clip-tags">${renderAssignedTags(clip, "clip")}</div>
                <div class="clip-item-actions">
                    <button class="icon-action" data-panel-clip-action="play" data-panel-clip-id="${clip.id}" title="试听">▶</button>
                    <button class="icon-action" data-panel-clip-action="edit" data-panel-clip-id="${clip.id}" title="编辑">✎</button>
                    <button class="icon-action ${isClipCandidate(clip.id) ? "is-candidate" : ""}" data-panel-clip-action="candidate" data-panel-clip-id="${clip.id}" title="候选">${isClipCandidate(clip.id) ? "★" : "☆"}</button>
                    <button class="icon-action" data-panel-clip-action="delete" data-panel-clip-id="${clip.id}" title="删除">🗑</button>
                </div>
            </div>`).join("") : `<div class="detail-value">暂无片段，创建一个开始标记。</div>`}</div>
        ${paginationHTML(page, pageKey, "个片段")}`;
}


/* =========================================================
   搜索
========================================================= */

async function deleteMusic(music, id) {
    if (!await confirm(`确定删除「${music?.name || "这首音乐"}」吗？\n它的片段和电影使用记录也会一起删除，电影和原始音频会保留。`)) return;
    await deleteLibraryEntries("music", [id || music.id]);
    showToast("已删除");
}


/* =========================================================
   Tag 视图跳转
========================================================= */

function goToTagView(tagId) {

    closeMusicContextPanels();
    state.tagResultTab = null;

    state.currentView =
        "tag:" + Number(tagId);
    resetPagination();

    document
        .querySelectorAll(
            ".nav-item"
        )
        .forEach(
            b =>
                b.classList.remove(
                    "active"
                )
        );

    render();
}

function closeMusicContextPanels() {
    invalidateMusicContextRequest();
    $("detailPanel").classList.add("hidden");
    $("musicClipsPanel").classList.add("hidden");
    state.selectedMusic = null;
    state.clipsPanelMusic = null;
}


/* =========================================================
   事件绑定
========================================================= */

function setupEvents() {
    setupCatalogControls();
    setupMovieUsageEvents();
    setupClipEditorControls();

    // Finder 完成改名后，用户切回应用即自动同步并刷新已渲染的专辑。
    window.addEventListener("focus", () => {
        void refreshLocationsAfterFinderChanges().catch(console.error);
    });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) void refreshLocationsAfterFinderChanges().catch(console.error);
    });

    document.addEventListener("change", async event => {
        const select = event.target.closest("[data-page-size-key]");
        if (!select) return;
        const key = select.dataset.pageSizeKey;
        const size = Number(select.value);
        if (!PAGE_SIZE_OPTIONS.includes(size)) return;
        const listScroll = document.querySelector(".catalog-list")?.scrollTop || 0;
        state.pageSizes[key] = size;
        state.pages[key] = 1;
        savePageSizes();

        if (key.startsWith("movie-dialog:")) {
            if (movieDialog?.mode === "music") await loadMoviePickerPage(movieDialog);
        } else if (key.startsWith("movie-usages:")) {
            await renderMusicMovieUsages();
        } else if (key.startsWith("import:")) {
            await renderSelectedFiles();
        } else if (key === "candidates") {
            await renderCandidatePanel();
        } else if (key.startsWith("music-clips:")) {
            if (state.clipsPanelMusic) await openMusicClipsPanel(state.clipsPanelMusic.id);
            else if (state.selectedMusic) await openDetail(state.selectedMusic.id);
        } else {
            await render();
            if (key.startsWith("catalog:tag:")) {
                restoreCatalogScroll({
                    list: key.endsWith(":groups") ? 0 : listScroll,
                    detail: 0
                });
            } else {
                scrollMainContentToTop();
            }
        }
    });

    $("sidebarCollapseBtn").addEventListener("click", () => {
        setSidebarCollapsed(
            !document.body.classList.contains("sidebar-collapsed")
        );
    });

    /* 维度与 Tag 的新增/重命名都改在侧栏原位输入（见 startTagDraft / commitTagDraft），
       这里不再有 Tag 操作浮层需要初始化。 */


    /* 导入 */

    $("importBtn")
        .addEventListener(
            "click",
            openImportModal
        );

    $("shortcutHelpBtn")
        .addEventListener("click", () => shortcutsModal.classList.remove("hidden"));

    $("databasePathLink")
        .addEventListener(
            "click",
            revealDatabaseFile
        );

    $("changeDbLocationBtn")
        .addEventListener(
            "click",
            changeDatabaseLocation
        );


    $("chooseFileBtn")
        .addEventListener(
            "click",
            chooseFiles
        );

    $("chooseFolderBtn")
        .addEventListener(
            "click",
            chooseFolders
        );

    document.querySelectorAll('input[name="albumSource"]').forEach(input => {
        input.addEventListener("change", event => {
            if (importSelectedFiles.isImporting) return;
            state.importAlbumSource = event.target.value;
            state.importFiles.forEach(item => {
                if (item.albumSource === "manual") return;
                item.albumSource = state.importAlbumSource;
                item.album = state.importAlbumSource === "folder"
                    ? item.folderAlbum
                    : item.metadataAlbum;
            });
            renderSelectedFiles();
        });
    });


    $("cancelImportTaskBtn").addEventListener("click", cancelImportTask);

    $("confirmImportBtn")
        .addEventListener(
            "click",
            importSelectedFiles
        );


    /* 已选文件的逐首属性编辑 */

    const fileList =
        $("selectedFiles");

    fileList.addEventListener(
        "input",
        event => {

            if (importSelectedFiles.isImporting) return;

            const field =
                event.target.dataset.fileField;

            if (!field) {
                return;
            }

            const card =
                event.target.closest(
                    "[data-file-index]"
                );

            const index =
                Number(
                    card.dataset.fileIndex
                );

            const item =
                state.importFiles[index];

            if (!item) {
                return;
            }

            if (["sampleRate", "bitrate"].includes(field)) {
                item[field] = Math.max(0, Number(event.target.value) || 0);
                return;
            }

            if (["name", "album", "artist", "genre", "year", "channels"].includes(field)) {
                item[field] = event.target.value.replace(/\s+/g, " ").trim();
                if (field === "album") {
                    item.albumSource = "manual";
                    const selectionStart = event.target.selectionStart;
                    clearTimeout(importAlbumRefreshTimer);
                    importAlbumRefreshTimer = setTimeout(async () => {
                        state.importSelectedAlbum = item.album || "未归档音乐";
                        await renderSelectedFiles();
                        const input = fileList.querySelector(`[data-file-index="${index}"] [data-file-field="album"]`);
                        if (input) {
                            input.focus();
                            input.setSelectionRange(selectionStart, selectionStart);
                        }
                    }, 350);
                }
            }
        }
    );


    fileList.addEventListener(
        "click",
        async event => {

            if (importSelectedFiles.isImporting) return;

            const albumButton = event.target.closest("[data-import-album]");
            if (albumButton) {
                state.importSelectedAlbum = albumButton.dataset.importAlbum;
                state.pages[`import:tracks:${state.importSelectedAlbum}`] = 1;
                renderSelectedFiles();
                return;
            }

            const pageButton = event.target.closest("[data-page-key]");
            if (pageButton) {
                state.pages[pageButton.dataset.pageKey] = Number(pageButton.dataset.page);
                renderSelectedFiles();
                return;
            }

            const removeImportFile = event.target.closest("[data-remove-import-file]");
            if (removeImportFile) {
                const index = Number(removeImportFile.dataset.removeImportFile);
                clearTimeout(importAlbumRefreshTimer);
                state.importFiles.splice(index, 1);
                await renderSelectedFiles();
                return;
            }

            const addBtn =
                event.target.closest(
                    "[data-file-add-tag]"
                );

            if (addBtn) {

                const card =
                    addBtn.closest(
                        "[data-file-index]"
                    );

                const index =
                    Number(
                        card.dataset.fileIndex
                    );

                const item =
                    state.importFiles[index];

                const input =
                    card.querySelector(
                        "[data-file-tag-input]"
                    );

                const value = normalizeTag(input.value);

                if (value) {

                    if (
                        !item.tags.includes(value)
                    ) {

                        item.tags.push(value);
                        item.tagIds = [...(item.tagIds || []), null];
                    }

                    input.value = "";

                    renderSelectedFiles(index);
                }

                return;
            }


            const suggBtn =
                event.target.closest(
                    "[data-file-suggest-tag]"
                );

            if (suggBtn) {

                const card =
                    suggBtn.closest(
                        "[data-file-index]"
                    );

                const index =
                    Number(
                        card.dataset.fileIndex
                    );

                const item =
                    state.importFiles[index];

                const tagId = Number(suggBtn.dataset.fileSuggestTag);
                const record = tagRecordsCache.find(tag => tag.id === tagId);
                if (!record) return;

                if (
                    !(item.tagIds || []).includes(tagId)
                ) {

                    item.tags.push(record.name);
                    item.tagIds = [...(item.tagIds || []), record.id];
                }

                renderSelectedFiles(index);

                return;
            }


            const removeBtn =
                event.target.closest(
                    "[data-file-remove-tag]"
                );

            if (removeBtn) {

                const card =
                    removeBtn.closest(
                        "[data-file-index]"
                    );

                const index =
                    Number(
                        card.dataset.fileIndex
                    );

                const item =
                    state.importFiles[index];

                const ti =
                    Number(
                        removeBtn.dataset.fileRemoveTag
                    );

                item.tags.splice(ti, 1);
                item.tagIds?.splice(ti, 1);

                renderSelectedFiles(index);
            }
        }
    );

    fileList.addEventListener("mouseover", event => {
        const name = event.target.closest(".import-album-item span");
        if (name && !name.contains(event.relatedTarget)) startImportAlbumNameScroll(name);
    });
    fileList.addEventListener("mouseout", event => {
        const name = event.target.closest(".import-album-item span");
        if (name && !name.contains(event.relatedTarget)) stopImportAlbumNameScroll();
    });


    fileList.addEventListener(
        "keydown",
        event => {

            const input =
                event.target.closest(
                    "[data-file-tag-input]"
                );

            if (
                !input ||
                event.key !== "Enter"
            ) {
                return;
            }

            event.preventDefault();

            input
                .closest(
                    "[data-file-index]"
                )
                .querySelector(
                    "[data-file-add-tag]"
                )
                .click();
        }
    );


    /* 搜索 */

    const scheduleLibrarySearch = event => {
        if (event.isComposing) return;
        updateLibrarySearch(event.target.value);
        libraryRenderVersion++;
        clearTimeout(searchRenderTimer);
        searchRenderTimer = setTimeout(() => render().catch(console.error), 160);
    };
    $("searchInput").addEventListener("input", scheduleLibrarySearch);
    $("searchInput").addEventListener("compositionend", scheduleLibrarySearch);
    $("clearSearch").addEventListener("click", () => {
        clearTimeout(searchRenderTimer);
        $("searchInput").value = "";
        updateLibrarySearch("");
        void render().catch(console.error);
    });

    $("selectionToggleBtn").addEventListener("click", () => {
        if (!(state.currentView === "clips" ? visibleClipIds.length : visibleQueueMusic.length)) return;
        state.selectionMode = !state.selectionMode;
        state.selectedMusicIds.clear();
        state.selectedClipIds.clear();
        renderSelectionToolbar();
        render();
    });

    $("rowPlayToggleBtn").addEventListener("click", () => {
        state.playOnRowClick = !state.playOnRowClick;
        const btn = $("rowPlayToggleBtn");
        btn.textContent = `点击试听：${state.playOnRowClick ? "开" : "关"}`;
        btn.setAttribute("aria-pressed", String(state.playOnRowClick));
    });

    $("exitSelectionBtn").addEventListener("click", () => $("selectionToggleBtn").click());
    $("selectAllVisibleBtn").addEventListener("click", () => {
        if (state.currentView === "clips") visibleClipIds.forEach(id => state.selectedClipIds.add(id));
        else visibleQueueMusic.forEach(music => state.selectedMusicIds.add(music.id));
        renderSelectionToolbar();
        render();
    });

    $("bulkDeleteBtn").addEventListener("click", async () => {
        const deletingClips = state.currentView === "clips";
        const ids = [...(deletingClips ? state.selectedClipIds : state.selectedMusicIds)];
        if (!ids.length) return;
        const noun = deletingClips ? "片段" : "音乐";
        const extra = deletingClips ? "" : "，以及这些音乐下的所有片段和电影使用记录";
        const ok = await confirm(`确定删除选中的 ${ids.length} 个${noun}${extra}吗？此操作无法撤销。`, `批量删除${noun}`);
        if (!ok) return;
        await deleteLibraryEntries(deletingClips ? "clips" : "music", ids, { exitSelection: true });
        showToast(`已删除 ${ids.length} 个${noun}`);
    });

    async function applyBulkTags(add) {
        const tag = normalizeTag($("bulkTagInput").value);
        if (!tag || !state.selectedMusicIds.size) return;
        const selected = [...state.selectedMusicIds];
        await runLibraryOperation(async request => {
            for (const id of selected) {
                await mutateMusic(id, music => musicTagPatch(music, tag, null, add), request);
            }
        });
        if (applicationUpdateInProgress) return;
        $("bulkTagInput").value = "";
        await refreshWhileInteractive(renderSidebarTags, render);
        if (!applicationUpdateInProgress) showToast(add ? "已批量添加 Tag" : "已批量移除 Tag");
    }
    $("bulkAddTagBtn").addEventListener("click", () => applyBulkTags(true));
    $("bulkRemoveTagBtn").addEventListener("click", () => applyBulkTags(false));


    /* 视图 */

    document
        .querySelectorAll(
            ".view-btn"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    document
                        .querySelectorAll(
                            ".view-btn"
                        )
                        .forEach(
                            b =>
                                b.classList
                                    .remove(
                                        "active"
                                    )
                        );


                    button.classList
                        .add("active");


                    state.layout =
                        button.dataset.layout;


                    render();
                }
            );
        });


    /* 左侧导航 */

    document
        .querySelectorAll(
            ".nav-item"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => navigateToView(button.dataset.view)
            );
        });


    /* sidebar tag 树：折叠、跳转、管理操作、拖拽调层级 */

    const sidebarTags = $("sidebarTags");
    let suppressSidebarTagClick = false;

    const sidebarTagManageBtn = $("sidebarTagManageBtn");
    const updateSidebarTagManageButton = () => {
        sidebarTagManageBtn.textContent = state.sidebarTagManage ? "完成" : "管理";
    };
    updateSidebarTagManageButton();

    sidebarTagManageBtn.addEventListener("click", async () => {
        state.sidebarTagManage = !state.sidebarTagManage;
        /* 退出管理态时收掉没提交的输入框：那时已经没有 ✎/＋ 入口了。 */
        if (!state.sidebarTagManage) state.tagDraft = null;
        saveSidebarTagManage();
        updateSidebarTagManageButton();
        await renderSidebarTags();
    });

    $("sidebarTagClearBtn").addEventListener("click", async () => {
        state.activeTagIds = [];
        resetPagination();
        await renderSidebarTags();
        render();
    });

    sidebarTags.addEventListener("click", async event => {

        if (suppressSidebarTagClick) {
            suppressSidebarTagClick = false;
            event.preventDefault();
            return;
        }

        const toggleCollapse = key => {
            const collapsed = !state.tagGroupCollapsed.has(key);
            if (collapsed) state.tagGroupCollapsed.add(key);
            else state.tagGroupCollapsed.delete(key);
            saveTagGroupCollapsed();
            const caret = sidebarTags.querySelector(`[data-collapse-toggle="${key}"]`);
            if (caret) {
                /* 箭头方向由 CSS 根据 aria-expanded 旋转，这里只维护状态与提示。 */
                caret.title = collapsed ? "展开" : "折叠";
                caret.setAttribute("aria-expanded", String(!collapsed));
            }
            if (key.startsWith("c:")) {
                const dimension = sidebarTags.querySelector(`[data-dimension-id="${key.slice(2)}"]`);
                dimension?.classList.toggle("is-collapsed", collapsed);
            } else {
                const children = sidebarTags.querySelector(`[data-tag-children="${key.slice(2)}"]`);
                children?.classList.toggle("is-collapsed", collapsed);
            }
        };

        const toggle = event.target.closest("[data-collapse-toggle]");
        if (toggle) {
            toggleCollapse(toggle.dataset.collapseToggle);
            return;
        }

        const createCategory = event.target.closest("[data-dimension-create]");
        if (createCategory) {
            startTagDraft({ type: "create-category" });
            return;
        }

        const editCategory = event.target.closest("[data-dimension-edit]");
        if (editCategory) {
            const categoryName = editCategory.dataset.dimensionEdit;
            startTagDraft({ type: "edit-category", categoryName, value: categoryName });
            return;
        }

        const deleteCategory = event.target.closest("[data-dimension-delete]");
        if (deleteCategory) {
            const name = deleteCategory.dataset.dimensionDelete;
            const ok = await confirm(`删除筛选维度「${name}」吗？非空维度不能删除。`, "删除筛选维度");
            if (!ok) return;
            try {
                await invoke("delete_tag_category", { name });
                await renderSidebarTags();
                await render();
                showToast("维度已删除");
            } catch (error) {
                showToast(`删除失败：${getErrorMessage(error)}`);
            }
            return;
        }

        const addRootTag = event.target.closest("[data-dimension-add]");
        if (addRootTag) {
            const categoryId = Number(addRootTag.dataset.categoryId);
            /* 收起态的维度要先展开，否则输入框会落在折叠区域里。 */
            state.tagGroupCollapsed.delete(`c:${categoryId}`);
            saveTagGroupCollapsed();
            startTagDraft({ type: "create-tag", categoryId, parentId: null });
            return;
        }

        const editTag = event.target.closest("[data-sidebar-tag-edit]");
        if (editTag) {
            const tag = tagRecordsCache.find(item => item.id === Number(editTag.dataset.sidebarTagEdit));
            if (tag) startTagDraft({ type: "edit-tag", tagId: tag.id, tagName: tag.name, value: tag.name });
            return;
        }

        const addChildTag = event.target.closest("[data-sidebar-tag-add]");
        if (addChildTag) {
            const parentId = Number(addChildTag.dataset.sidebarTagAdd);
            const parent = tagRecordsCache.find(item => item.id === parentId);
            if (parent) {
                /* 收起态的父 Tag 要先展开，子级输入框才可见可聚焦。 */
                state.tagGroupCollapsed.delete(`t:${parentId}`);
                saveTagGroupCollapsed();
                startTagDraft({ type: "create-tag", categoryId: parent.categoryId, parentId });
            }
            return;
        }

        const deleteTag = event.target.closest("[data-sidebar-tag-delete]");
        if (deleteTag) {
            const tag = tagRecordsCache.find(item => item.id === Number(deleteTag.dataset.sidebarTagDelete));
            if (!tag) return;
            const ok = await confirm(`删除 Tag「${tag.path}」吗？它会从所有音乐和片段中移除。`, "删除 Tag");
            if (!ok) return;
            try {
                await invoke("delete_tag", { id: tag.id });
                await loadAlbumTags();
                invalidateLibraryCache();
                state.activeTagIds = state.activeTagIds.filter(value => value !== tag.id);
                await renderSidebarTags();
                await render();
                showToast("Tag 已删除");
            } catch (error) {
                showToast(`删除失败：${getErrorMessage(error)}`);
            }
            return;
        }

        const dimensionRow = event.target.closest("[data-dimension-row]");
        if (dimensionRow) {
            toggleCollapse(`c:${dimensionRow.dataset.dimensionRow}`);
            return;
        }

        const button = event.target.closest(".sidebar-tag");
        if (button) setActiveTag(button.dataset.tagId);
    });

    /* 内联编辑：Enter 提交、Esc 取消、失去焦点时若已改动则提交。 */
    sidebarTags.addEventListener("input", event => {
        const draft = state.tagDraft;
        if (!draft || !event.target.matches("[data-tag-draft-input]")) return;
        /* 只认当前这一轮草稿的输入框，被换掉的旧输入框不该再写入状态。 */
        if (event.target.dataset.tagDraftId !== String(draft.id)) return;
        draft.value = event.target.value;
    });

    sidebarTags.addEventListener("keydown", event => {
        const draft = state.tagDraft;
        if (!draft || !event.target.matches("[data-tag-draft-input]")) return;
        if (event.target.dataset.tagDraftId !== String(draft.id)) return;
        if (event.key === "Enter") {
            event.preventDefault();
            commitTagDraft(event.target);
        } else if (event.key === "Escape") {
            /* 拦在这里，免得全局 Esc 顺手把搜索词和已选 Tag 一起清掉。 */
            event.preventDefault();
            event.stopPropagation();
            cancelTagDraft();
        }
    });

    sidebarTags.addEventListener("focusout", event => {
        const input = event.target;
        const draft = state.tagDraft;
        if (!draft || !input.matches?.("[data-tag-draft-input]")) return;
        /* 只认当前这一轮草稿的输入框。重渲染换掉旧输入框时浏览器也会补一个
           focusout，那一份带着上一轮的 id，放过去就会把同一个名字提交两次。 */
        if (input.dataset.tagDraftId !== String(draft.id)) return;
        commitTagDraft(input);
    });

    const clearTagPointerDrag = () => {
        const drag = state.tagPointerDrag;
        drag?.tagElement?.classList.remove("is-dragging");
        drag?.ghost?.remove();
        sidebarTags.querySelectorAll(".is-drop-target")
            .forEach(item => item.classList.remove("is-drop-target"));
        state.draggingTagId = null;
        state.tagPointerDrag = null;
    };

    sidebarTags.addEventListener("pointerdown", event => {
        if (!state.sidebarTagManage) return;
        const row = event.target.closest("[data-tag-id]");
        /* 内联输入框里不触发拖拽，否则在输入框里选字会被当成拖动 Tag。 */
        if (!row || event.button !== 0 || event.target.closest(".sidebar-tag-ops") || event.target.closest("input")) return;
        state.tagPointerDrag = {
            pointerId: event.pointerId,
            tagId: Number(row.dataset.tagId),
            tagName: row.dataset.tagName,
            tagElement: row,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            targetParentId: undefined,
            targetCategoryId: undefined,
            targetEl: null,
            highlightEl: null,
            ghost: null
        };
        row.setPointerCapture?.(event.pointerId);
    });

    sidebarTags.addEventListener("pointermove", event => {
        const drag = state.tagPointerDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (!drag.moved && distance < 5) return;
        if (!drag.moved) {
            drag.moved = true;
            state.draggingTagId = drag.tagId;
            drag.tagElement.classList.add("is-dragging");
            drag.ghost = document.createElement("div");
            drag.ghost.className = "tag-drag-ghost";
            drag.ghost.textContent = `#${drag.tagName}`;
            document.body.appendChild(drag.ghost);
        }
        event.preventDefault();
        drag.ghost.style.left = `${event.clientX}px`;
        drag.ghost.style.top = `${event.clientY}px`;
        const pointEl = document.elementFromPoint(event.clientX, event.clientY);
        const targetRow = pointEl?.closest("[data-tag-id]");
        const targetDimension = pointEl?.closest("[data-dimension-row]");
        if (targetRow && sidebarTags.contains(targetRow) && Number(targetRow.dataset.tagId) !== drag.tagId) {
            /* 拖到某个 Tag 上 = 成为它的子级，维度跟着那个 Tag 走。 */
            drag.crossDimension = false;
            drag.targetParentId = Number(targetRow.dataset.tagId);
            drag.targetCategoryId = undefined;
            drag.targetEl = targetRow;
        } else if (targetDimension && sidebarTags.contains(targetDimension)) {
            /* 拖到维度行 = 落到该维度根层；换成别的维度就是改维度。 */
            const targetCategoryId = Number(targetDimension.dataset.dimensionRow);
            const dragTag = tagRecordsCache.find(item => item.id === drag.tagId);
            drag.crossDimension = Boolean(dragTag) && targetCategoryId !== dragTag.categoryId;
            drag.targetParentId = null;
            drag.targetCategoryId = targetCategoryId;
            drag.targetEl = targetDimension;
        } else {
            drag.crossDimension = false;
            drag.targetParentId = undefined;
            drag.targetCategoryId = undefined;
            drag.targetEl = null;
        }
        /* 只查 .is-drop-target 是查不到「还没高亮过」的元素的，落点提示会永远不出现；
           记住上一次高亮的元素，逐个换。 */
        if (drag.highlightEl && drag.highlightEl !== drag.targetEl) drag.highlightEl.classList.remove("is-drop-target");
        if (drag.targetEl) drag.targetEl.classList.add("is-drop-target");
        drag.highlightEl = drag.targetEl;
    });

    const finishTagPointerDrag = async event => {
        const drag = state.tagPointerDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const moved = drag.moved;
        const targetParentId = drag.targetParentId;
        const targetCategoryId = drag.targetCategoryId;
        const hasTarget = Boolean(drag.targetEl);
        const crossDimension = Boolean(drag.crossDimension);
        if (moved) suppressSidebarTagClick = true;
        clearTagPointerDrag();
        if (!moved) return;
        if (!hasTarget) {
            showToast("未放入目标 Tag 或维度");
            return;
        }
        try {
            await invoke("move_tag", { id: drag.tagId, parentId: targetParentId ?? null, categoryId: targetCategoryId ?? null });
            /* 目标维度或目标父 Tag 若是折叠的，移过去就看不见了，等于白拖，先展开。 */
            if (targetCategoryId != null) state.tagGroupCollapsed.delete(`c:${targetCategoryId}`);
            if (targetParentId != null) state.tagGroupCollapsed.delete(`t:${targetParentId}`);
            saveTagGroupCollapsed();
            await renderSidebarTags();
            if (crossDimension) {
                const category = (await invoke("list_tag_category_records")).find(item => item.id === targetCategoryId);
                showToast(`已移动到「${category?.name ?? "目标"}」维度`);
            } else {
                showToast(targetParentId != null ? "已移动到目标 Tag 下" : "已移动到维度根层");
            }
        } catch (error) {
            showToast(`移动失败：${getErrorMessage(error)}`);
        }
    };

    sidebarTags.addEventListener("pointerup", finishTagPointerDrag);
    sidebarTags.addEventListener("pointercancel", event => {
        if (state.tagPointerDrag?.pointerId === event.pointerId) clearTagPointerDrag();
    });


    /* 主列表 */

    $("contentArea")
        .addEventListener(
            "click",
            async event => {
                if (handleCatalogMenuClick(event)) return;
                if (event.target.closest("[data-back-album-directory]")) {
                    state.catalogSelection = null;
                    await render();restoreDirectoryScroll("albums");return;
                }
                if (event.target.closest("[data-movie-action]")) return handleMovieAction(event);
                if (event.target.closest("[data-remove-assigned-tag]")) return handleAssignedTagClick(event);


                if (event.target.closest("[data-clear-library-filters]")) {
                    state.search = ""; state.albumSearch = ""; state.activeTagIds = []; state.movieUsageStatus = "all";
                    $("searchInput").value = ""; resetPagination();
                    await renderSidebarTags(); await render(); return;
                }
                const recentMode = event.target.closest("[data-recent-mode]");
                if (recentMode) {
                    state.recentMode = recentMode.dataset.recentMode;
                    state.pages["music:recent"] = 1;
                    await render(); return;
                }
                if (event.target.closest("[data-quick-tag-input], [data-quick-tag-select], [data-album-tag-input], [data-album-tag-select]")) {
                    event.stopPropagation();
                    return;
                }

                const albumTagRemove = event.target.closest("[data-album-tag-remove]");
                if (albumTagRemove) {
                    event.stopPropagation();
                    await removeAlbumTag(albumTagRemove.dataset.album, Number(albumTagRemove.dataset.albumTagRemove));
                    return;
                }

                const tagTab = event.target.closest("[data-tag-result-tab]");
                if (tagTab) {
                    state.tagResultTab = tagTab.dataset.tagResultTab;
                    render();
                    return;
                }

                const pageButton = event.target.closest("[data-page-key]");
                if (pageButton) {
                    const listScroll = document.querySelector(".catalog-list")?.scrollTop || 0;
                    state.pages[pageButton.dataset.pageKey] = Number(pageButton.dataset.page);
                    await render();
                    if (pageButton.dataset.pageKey.startsWith("catalog:tag:")) {
                        restoreCatalogScroll({
                            list: pageButton.dataset.pageKey.endsWith(":groups") ? 0 : listScroll,
                            detail: 0
                        });
                    } else {
                        scrollMainContentToTop();
                    }
                    return;
                }

                const selection = event.target.closest("[data-select-music]");
                if (selection) {
                    event.stopPropagation();
                    const id = selection.dataset.selectMusic;
                    if (selection.checked) state.selectedMusicIds.add(id);
                    else state.selectedMusicIds.delete(id);
                    renderSelectionToolbar();
                    return;
                }

                const clipSelection = event.target.closest("[data-select-clip]");
                if (clipSelection) {
                    event.stopPropagation();
                    const id = clipSelection.dataset.selectClip;
                    if (clipSelection.checked) state.selectedClipIds.add(id);
                    else state.selectedClipIds.delete(id);
                    renderSelectionToolbar();
                    return;
                }

                const clipAction =
                    event.target.closest(
                        "[data-clip-action]"
                    );

                if (clipAction) {

                    event.stopPropagation();

                    const clipId = clipAction.dataset.clipId;
                    const act = clipAction.dataset.clipAction;
                    return handleClipAction(clipId, act);
                }


                const clipRow =
                    event.target.closest(".clip-library-row");

                if (clipRow) {
                    if (state.selectionMode) {
                        const id = clipRow.dataset.clipId;
                        state.selectedClipIds.has(id) ? state.selectedClipIds.delete(id) : state.selectedClipIds.add(id);
                        renderSelectionToolbar();
                        render();
                        return;
                    }

                    if (state.playOnRowClick) return handleClipAction(clipRow.dataset.clipId, "play");

                    return;
                }

                const action =
                    event.target.closest(
                        "[data-action]"
                    );


                if (action) {

                    event.stopPropagation();

                    const act =
                        action.dataset.action;

                    const id =
                        action.dataset.id;

                    if (act === "quick-tag") {
                        state.quickTagMusicId = id;
                        state.quickTagSuggestions = await getAllTagRecords();
                        await render();
                        requestAnimationFrame(() =>
                            document.querySelector(`[data-quick-tag-input="${id}"]`)?.focus()
                        );
                        return;
                    }

                    if (act === "quick-tag-save") {
                        const input = action.closest(".quick-tag-editor")?.querySelector("[data-quick-tag-input]");
                        await saveQuickTag(id, input?.value);
                        return;
                    }

                    if (act === "album-quick-tag") {
                        state.quickTagAlbumKey = action.dataset.album;
                        state.quickTagSuggestions = await getAllTagRecords();
                        await render();
                        requestAnimationFrame(() =>
                            document.querySelector("[data-album-tag-input]")?.focus()
                        );
                        return;
                    }

                    if (act === "album-quick-tag-save") {
                        const input = action.closest(".quick-tag-editor")?.querySelector("[data-album-tag-input]");
                        await saveAlbumQuickTag(action.dataset.album, input?.value);
                        return;
                    }

                    if (act === "show-clips") {
                        await openMusicClipsPanel(id);
                        return;
                    }


                    if (act === "play") {
                        if (state.player.music?.id === id && !state.player.segment) return togglePlay();
                        return playMusic(id);
                    }
                    if (act === "clip") return openClipEditorForMusic(id);
                    if (act === "edit") return openEditModalForMusic(id);
                    if (act === "candidate") return toggleCandidate(id);


                    if (
                        act === "delete"
                    ) {

                        const music =
                            await dbGet(
                                "music",
                                id
                            );

                        if (!music) {
                            return;
                        }

                        deleteMusic(
                            music,
                            id
                        );

                        return;
                    }


                    if (
                        act === "info"
                    ) {

                        openDetail(id);

                        return;
                    }


                    if (
                        act === "play-candidate" ||
                        act === "remove-candidate"
                    ) {

                        if (act === "play-candidate") {

                            const cand =
                                state.player.candidates
                                    .find(c => c.id === id);

                            if (
                                cand &&
                                cand.kind === "clip"
                            ) {

                                playClip(cand, { source: "candidates" });

                            } else {

                                playMusic(
                                    id,
                                    { source: "candidates" }
                                );
                            }

                        } else {

                            removeCandidate(id);
                        }

                        return;
                    }
                }


                const pageTag =
                    event.target.closest(
                        "[data-page-tag]"
                    );


                if (pageTag) {

                    goToTagView(
                        pageTag.dataset.pageTag
                    );

                    return;
                }


                const catalogItem =
                    event.target.closest(
                        "[data-catalog-key]"
                    );


                if (catalogItem) {

                    const listScroll = document.querySelector(".catalog-list")?.scrollTop || 0;
                    if (state.currentView === "albums") { state.albumDirectoryScroll = document.querySelector(".main-scroll-area")?.scrollTop || 0;state.search = "";closeMusicContextPanels(); }

                    state.catalogSelection =
                        catalogItem.dataset.catalogKey;
                    state.pages[`catalog:${state.currentView === "albums" ? "album" : "tag"}:${state.catalogSelection}`] = 1;

                    await render();
                    if (state.currentView === "albums") scrollMainContentToTop();
                    else restoreCatalogScroll({ list: listScroll, detail: 0 });

                    return;
                }

                const deleteAlbum = event.target.closest("[data-delete-album]");
                if (deleteAlbum) {
                    const album = deleteAlbum.dataset.deleteAlbum;
                    const ids = await invoke("library_related_ids", { musicIds: [], album });
                    if (!ids.length) return;
                    const ok = await confirm(`确定删除专辑「${album}」及其 ${ids.length} 首音乐、全部片段和电影使用记录吗？此操作无法撤销。`, "删除专辑");
                    if (!ok) return;
                    await deleteLibraryEntries("music", ids, { exitSelection: true });
                    await invoke("delete_album_tags", { album });
                    albumTagsCache.delete(album);
                    invalidateLibraryCache();
                    state.catalogSelection = null;
                    await updateCounts();
                    await render();
                    showToast("专辑已删除");
                    return;
                }


                const row =
                    event.target.closest(
                        "[data-music-id]"
                    );

                // 最近添加自行处理播放，避免全局行点击逻辑重复触发。
                if (row && row.closest(".home-recent")) return;

                if (row) {

                    const rowId =
                        row.dataset.musicId;

                    if (state.selectionMode) {
                        state.selectedMusicIds.has(rowId) ? state.selectedMusicIds.delete(rowId) : state.selectedMusicIds.add(rowId);
                        renderSelectionToolbar();
                        render();
                        return;
                    }

                    if (state.playOnRowClick) playMusic(rowId);
                    /* 点音乐行不再自动弹出片段栏：片段改从行尾的 ◈ 按钮或详情页进入。 */
                }
            }
        );

    $("contentArea").addEventListener("keydown", async event => {
        const input = event.target.closest("[data-quick-tag-input]");
        if (input) {

            if (event.key === "Escape" && !event.isComposing) {
                event.preventDefault();
                state.quickTagMusicId = null;
                await renderPreservingScroll();
                return;
            }

            /* 中文输入法组词中的 Enter 是选字，不能当成提交——否则拼音串
               会被当成新 Tag 存进去，而用户想打的其实是已有的那个中文 Tag。 */
            if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault();
                await saveQuickTag(input.dataset.quickTagInput, input.value);
            }
            return;
        }

        const albumTagInput = event.target.closest("[data-album-tag-input]");
        if (!albumTagInput) return;

        if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            state.quickTagAlbumKey = null;
            await renderPreservingScroll();
            return;
        }

        /* 中文输入法组词中的 Enter 是选字，不能当成提交。 */
        if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            await saveAlbumQuickTag(state.quickTagAlbumKey, albumTagInput.value);
        }
    });

    $("contentArea").addEventListener("change", async event => {
        const select = event.target.closest("[data-quick-tag-select]");
        if (select?.value) {
            event.stopPropagation();
            await saveQuickTag(select.dataset.id, "", Number(select.value));
            return;
        }
        const albumSelect = event.target.closest("[data-album-tag-select]");
        if (!albumSelect?.value) return;
        event.stopPropagation();
        await saveAlbumQuickTag(state.quickTagAlbumKey, "", Number(albumSelect.value));
    });


    /* 关闭详情 */

    $("closeDetail")
        .addEventListener(
            "click",
            () => {

                invalidateMusicContextRequest();
                $("detailPanel").classList.add("hidden");
                state.selectedMusic = null;
            }
        );

    $("closeMusicClips").addEventListener("click", () => {
        invalidateMusicContextRequest();
        $("musicClipsPanel").classList.add("hidden");
        state.clipsPanelMusic = null;
    });

    $("musicClipsBody").addEventListener("click", async event => {
        if (event.target.closest("[data-remove-assigned-tag]")) return handleAssignedTagClick(event);
        const pageButton = event.target.closest("[data-page-key]");
        if (pageButton && state.clipsPanelMusic) {
            state.pages[pageButton.dataset.pageKey] = Number(pageButton.dataset.page);
            await openMusicClipsPanel(state.clipsPanelMusic.id);
            return;
        }
        const create = event.target.closest("[data-clips-panel-action]");
        if (create && state.clipsPanelMusic) {
            await openClipEditor(state.clipsPanelMusic);
            return;
        }
        const action = event.target.closest("[data-panel-clip-action]");
        const row = event.target.closest("[data-panel-clip-id]");
        const clipId = action?.dataset.panelClipId || row?.dataset.panelClipId;
        if (!clipId) return;
        if (!action) {
            if (state.playOnRowClick) return handleClipAction(clipId, "play");
            return;
        }
        event.stopPropagation();
        return handleClipAction(clipId, action.dataset.panelClipAction);
    });


    /* 编辑 Tag */

    $("addEditTagBtn")
        .addEventListener(
            "click",
            addEditTag
        );


    $("editTagInput")
        .addEventListener(
            "keydown",
            event => {

                if (
                    event.key ===
                    "Enter"
                ) {

                    event.preventDefault();

                    addEditTag();
                }
            }
        );


    $("editTags")
        .addEventListener(
            "click",
            event => {

                const button =
                    event.target.closest(
                        "[data-remove-edit-tag]"
                    );

                if (!button) {
                    return;
                }


                const index =
                    Number(
                        button.dataset
                            .removeEditTag
                    );


                editModalDraft.tags
                    .splice(
                        index,
                        1
                    );
                editModalDraft.tagIds.splice(index, 1);


                renderEditTags();
            }
        );


    $("saveEditBtn")
        .addEventListener(
            "click",
            saveEdit
        );


    /* Clip Tag */

    $("addClipTagBtn")
        .addEventListener(
            "click",
            addClipTag
        );


    $("clipTagInput")
        .addEventListener(
            "keydown",
            event => {

                if (
                    event.key ===
                    "Enter"
                ) {

                    event.preventDefault();

                    addClipTag();
                }
            }
        );


    $("clipTags")
        .addEventListener(
            "click",
            event => {

                const button =
                    event.target.closest(
                        "[data-remove-clip-tag]"
                    );

                if (!button) {
                    return;
                }


                const index =
                    Number(
                        button.dataset
                            .removeClipTag
                    );


                state.clipTags
                    .splice(
                        index,
                        1
                    );
                state.clipTagIds.splice(index, 1);


                renderClipTags();
            }
        );


    $("clipTagSuggestions")
        .addEventListener(
            "click",
            event => {

                const button =
                    event.target.closest(
                        "[data-suggestion-tag]"
                    );

                if (!button) {
                    return;
                }


                const tagId = Number(button.dataset.suggestionTag);
                const record = tagRecordsCache.find(tag => tag.id === tagId);
                if (!record) return;


                if (
                    !state.clipTagIds.includes(tagId)
                ) {

                    state.clipTags.push(record.name);
                    state.clipTagIds.push(record.id);

                    renderClipTags();
                }
            }
        );


    $("saveClipBtn")
        .addEventListener(
            "click",
            saveClip
        );

    /* 导出当前选区为 WAV（无需先保存片段） */
    $("clipExportBtn")
        .addEventListener("click", () => {
            if (!state.clipMusic) return;
            void exportClip(
                {
                    name: $("clipName").value || "片段",
                    start: state.clipStart,
                    end: state.clipEnd
                },
                state.clipMusic
            );
        });

    $("previewClipBtn")
        .addEventListener(
            "click",
            previewClipSelection
        );

    $("playFullTrackBtn").addEventListener("click", playFullTrack);

    $("closeClipEditor")
        .addEventListener(
            "click",
            () => closeClipEditor()
        );

    $("cancelClipEditor")
        .addEventListener(
            "click",
            () => closeClipEditor()
        );

    $("clipStartInput").addEventListener("change", () => applyClipTimeInput("start"));
    $("clipEndInput").addEventListener("change", () => applyClipTimeInput("end"));
    $("clipName").addEventListener("input", () => { state.clipNameAutoGenerated = false; });

    document.addEventListener("keydown", event => {
        const isTyping = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "");
        if (!$("updateModal").classList.contains("hidden")) return;
        if (!$("movieUsageModal").classList.contains("hidden")) {
            if (event.key === "Escape") { event.preventDefault();closeMovieDialog(); }
            return;
        }
        const editorOpen = !clipEditorPanel.classList.contains("hidden");
        if (editorOpen && !isTyping) {
            if (event.key === " ") {
                event.preventDefault();
                playFullTrack();
            } else if (event.key.toLowerCase() === "i") {
                event.preventDefault();
                $("setStartBtn").click();
            } else if (event.key.toLowerCase() === "o") {
                event.preventDefault();
                $("setEndBtn").click();
            }
            return;
        }
        if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.target.closest("button") && [" ", "Enter"].includes(event.key)) return;
        if (event.key === "?") {
            event.preventDefault();
            shortcutsModal.classList.toggle("hidden");
            return;
        }
        if (event.key === "/") {
            event.preventDefault();
            if (state.currentView === "home") {
                void goToViewFromHome("all", { focusSearch: true }).catch(console.error);
            } else $("searchInput").focus();
            return;
        }

        /* 剪辑师快捷键：J/K/L shuttle + 空格播放暂停 + ←→ 快进倒退 + M 边听边裁。
           J/L 按住自动连发；双击 L 切倍速，双击 J 退 15 秒。 */
        const key = event.key.toLowerCase();
        const a = state.player.music ? getAudio() : null;

        if (key === " " || key === "k") {
            if (state.currentView === "home" && !event.repeat) {
                event.preventDefault();
                void auditionHomeMusic().catch(console.error);
                return;
            }
            if (!a || event.repeat) return;
            event.preventDefault();
            void togglePlay();
            return;
        }

        if (!a || !Number.isFinite(a.duration)) return;

        const now = Date.now();
        const dbl = !event.repeat && lastShuttleKey === key && now - lastShuttleAt < 350;
        if (!event.repeat) {
            lastShuttleKey = key;
            lastShuttleAt = now;
        }

        if (key === "j" || event.key === "ArrowLeft") {
            event.preventDefault();
            a.currentTime = Math.max(0, a.currentTime - (dbl ? 15 : 5));
        } else if (key === "l" || event.key === "ArrowRight") {
            event.preventDefault();
            if (dbl) {
                /* 双击 L：1 → 1.5 → 2 → 1 倍速试听 */
                const rates = [1, 1.5, 2];
                const cur = rates.findIndex(r => Math.abs(a.playbackRate - r) < 0.01);
                a.playbackRate = rates[(cur + 1) % rates.length];
                showToast(a.playbackRate === 1 ? "恢复原速" : `${a.playbackRate}× 倍速试听`);
            } else {
                a.currentTime = Math.min(a.duration, a.currentTime + 5);
            }
        } else if (key === "m") {
            event.preventDefault();
            void openClipEditor(state.player.music);
        }
    });


    /* Modal 关闭 */

    document
        .querySelectorAll(
            "[data-close-modal]"
        )
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    importModal
                        .classList
                        .add("hidden");

                    closeEditModal();

                    shortcutsModal
                        .classList
                        .add("hidden");

                }
            );
        });


    /* ESC */

    document.addEventListener(
        "keydown",
        async event => {

            if (
                event.key === "Escape"
            ) {

                if (!shortcutsModal.classList.contains("hidden")) {
                    event.preventDefault();
                    shortcutsModal.classList.add("hidden");
                    return;
                }

                if (!clipEditorPanel.classList.contains("hidden")) {
                    event.preventDefault();
                    await closeClipEditor();
                    return;
                }

                if (state.selectionMode) {
                    $("selectionToggleBtn").click();
                    return;
                }

                if ($("searchInput").value || state.activeTagIds.length) {
                    const hadTagFilters = state.activeTagIds.length > 0;
                    updateLibrarySearch("");
                    state.activeTagIds = [];
                    clearTimeout(searchRenderTimer);
                    if (hadTagFilters) resetPagination();
                    $("searchInput").value = "";
                    renderSidebarTags();
                    render();
                    return;
                }

                importModal
                    .classList
                    .add("hidden");

                closeEditModal();

            }
        }
    );


    /* Drop */

    setupDropZone();


    /* Timeline */

    setupTimeline();


    /* Detail 内的片段操作 */

    $("detailContent")
        .addEventListener(
            "click",
            async event => {
                if (event.target.closest("[data-movie-action]")) return handleMovieAction(event);
                if (event.target.closest("[data-remove-assigned-tag]")) return handleAssignedTagClick(event);


                const pageButton = event.target.closest("[data-page-key]");
                if (pageButton && state.selectedMusic) {
                    state.pages[pageButton.dataset.pageKey] = Number(pageButton.dataset.page);
                    if (pageButton.dataset.pageKey.startsWith("movie-usages:")) await renderMusicMovieUsages();
                    else await openDetail(state.selectedMusic.id); return;
                }
                const clipAction =
                    event.target.closest(
                        "[data-clip-action]"
                    );

                if (clipAction) {

                    const clipId =
                        clipAction.dataset.clipId;

                    const act =
                        clipAction.dataset.clipAction;

                    return handleClipAction(clipId, act);
                }


                const clip =
                    event.target.closest(
                        ".clip-item"
                    );

                if (!clip) {
                    return;
                }


                const clipId =
                    clip.dataset.clipId;

                if (state.playOnRowClick) return handleClipAction(clipId, "play");
            }
        );


    /* 候选面板操作 */

    $("candidatePanelBody")
        .addEventListener(
            "click",
            async event => {
                if (event.target.closest("[data-movie-action]")) return handleMovieAction(event);
                if (event.target.closest("[data-remove-assigned-tag]")) return handleAssignedTagClick(event);


                const pageButton = event.target.closest("[data-page-key]");
                if (pageButton) {
                    state.pages[pageButton.dataset.pageKey] = Number(pageButton.dataset.page);
                    await renderCandidatePanel();
                    return;
                }

                const btn =
                    event.target.closest(
                        "[data-action]"
                    );

                if (!btn) {
                    return;
                }

                const act =
                    btn.dataset.action;

                const id =
                    btn.dataset.id;

                if (act === "play-candidate") {

                    const cand =
                        state.player.candidates
                            .find(c => c.id === id);

                    if (
                        cand &&
                        cand.kind === "clip"
                    ) {

                        playClip(cand, { source: "candidates" });

                    } else {

                        playMusic(
                            id,
                            { source: "candidates" }
                        );
                    }

                    return;
                }

                if (act === "remove-candidate") {

                    removeCandidate(id);
                }
            }
        );


    /* 播放器 */

    initPlayer();
}


/* =========================================================
   空间动效
   指针只驱动 CSS 变量；低频、无依赖，并尊重系统的减少动态效果设置。
========================================================= */

function setupSpatialMotion() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight / 2;
    let activeSurface = null;

    const paint = () => {
        frame = 0;
        const x = pointerX / Math.max(window.innerWidth, 1);
        const y = pointerY / Math.max(window.innerHeight, 1);
        document.documentElement.style.setProperty("--pointer-x", `${(x * 100).toFixed(2)}%`);
        document.documentElement.style.setProperty("--pointer-y", `${(y * 100).toFixed(2)}%`);
        document.documentElement.style.setProperty("--scene-x", `${((x - .5) * 10).toFixed(2)}px`);
        document.documentElement.style.setProperty("--scene-y", `${((y - .5) * 8).toFixed(2)}px`);
        document.documentElement.style.setProperty("--scene-x-reverse", `${((.5 - x) * 7).toFixed(2)}px`);
        document.documentElement.style.setProperty("--scene-y-reverse", `${((.5 - y) * 5.6).toFixed(2)}px`);
        document.documentElement.style.setProperty("--scene-x-soft", `${((x - .5) * 3.5).toFixed(2)}px`);
        document.documentElement.style.setProperty("--scene-y-soft", `${((y - .5) * 2.8).toFixed(2)}px`);
        document.documentElement.style.setProperty("--scene-x-subtle", `${((x - .5) * 1.2).toFixed(2)}px`);
        document.documentElement.style.setProperty("--scene-y-subtle", `${((y - .5) * .96).toFixed(2)}px`);

        if (!activeSurface) return;
        const bounds = activeSurface.getBoundingClientRect();
        const localX = (pointerX - bounds.left) / Math.max(bounds.width, 1);
        const localY = (pointerY - bounds.top) / Math.max(bounds.height, 1);
        activeSurface.style.setProperty("--tilt-x", `${((.5 - localY) * 2).toFixed(2)}deg`);
        activeSurface.style.setProperty("--tilt-y", `${((localX - .5) * 2.4).toFixed(2)}deg`);
        activeSurface.style.setProperty("--glow-x", `${(localX * 100).toFixed(1)}%`);
        activeSurface.style.setProperty("--glow-y", `${(localY * 100).toFixed(1)}%`);
    };

    document.addEventListener("pointermove", event => {
        pointerX = event.clientX;
        pointerY = event.clientY;
        const nextSurface = event.target.closest(".music-card, .music-row, .album-card, .clip-library-row");
        if (nextSurface !== activeSurface) {
            activeSurface?.classList.remove("is-pointer-lit");
            activeSurface?.style.removeProperty("--tilt-x");
            activeSurface?.style.removeProperty("--tilt-y");
            activeSurface = nextSurface;
            activeSurface?.classList.add("is-pointer-lit");
        }
        if (!frame) frame = requestAnimationFrame(paint);
    }, { passive: true });

    document.addEventListener("pointerout", event => {
        if (event.relatedTarget || !activeSurface) return;
        activeSurface.classList.remove("is-pointer-lit");
        activeSurface = null;
    });
}


/* =========================================================
   初始化
========================================================= */

async function init() {

    try {

        ensureTauri();

        if (!await initDB()) return;

        await setupDatabasePath();

        state.player.candidates = (await invoke("list_candidates"))
            .map(entry => ({ id: entry.targetId, kind: entry.kind }));

        renderCandidateBadge();

        setSidebarCollapsed(getSavedSidebarCollapsed(), { persist: false });
        setupThemeSwitcher();
        setupEvents();
        setupSpatialMotion();

        renderSelectionToolbar();

        await updateCounts();

        await renderSidebarTags();

        await loadAlbumTags();

        await render();

        await reportStartupState("ready");

        // 位置同步可能需要逐一解析数千个 macOS 文件书签，不阻塞首屏。
        setTimeout(() => refreshLocationsAfterFinderChanges().catch(console.error), 0);

        console.log(
            "音乐库初始化完成"
        );

    } catch (error) {

        console.error(error);
        await reportStartupState("failed");

        const message = error instanceof Error
            ? error.message
            : String(error ?? "未知错误");

        alert(
            "音乐库初始化失败：\n" +
            message
        );
    }
}


init();
