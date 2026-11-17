/* Music details and metadata editing. Shared application state lives in app.js. */

let detailRequestVersion = 0;
let musicContextRequest = null;
let detailSaveRevision = 0;
const detailSaveQueues = new Map();
let detailFieldRevisions = new Map();
const DETAIL_CONTROLS = { name: "detailEditName", album: "detailEditAlbum", albumSource: "detailEditAlbumSource",
    artist: "detailEditArtist", genre: "detailEditGenre", year: "detailEditYear" };

function beginMusicContextRequest(id, kind) {
    const version = ++detailRequestVersion;
    musicContextRequest = { id, kind, version };
    return version;
}

function invalidateMusicContextRequest() {
    detailRequestVersion++;
    musicContextRequest = null;
}

async function readMusicContext(id, version, commit) {
    while (version === detailRequestVersion) {
        // Wait again if a newer edit joined the queue while an earlier one ended.
        while (musicMutationQueues.has(id)) {
            await musicMutationQueues.get(id).catch(() => {});
            if (version !== detailRequestVersion) return null;
        }
        const musicVersion = libraryCache.versions.music;
        const clipVersion = libraryCache.versions.clips;
        const music = await dbGet("music", id);
        if (version !== detailRequestVersion || !music) return null;
        const clips = await getMusicClips(id);
        if (version !== detailRequestVersion) return null;
        // Navigation versions alone cannot detect saves/deletions during a read.
        if (musicMutationQueues.has(id) || musicVersion !== libraryCache.versions.music || clipVersion !== libraryCache.versions.clips) continue;
        // Validate and commit in the same microtask. Another asynchronous
        // follow-up must not change the context between validation and display.
        return commit({ music, clips });
    }
    return null;
}

async function refreshMusicContext(request, id) {
    if (!request || request !== musicContextRequest || request.version !== detailRequestVersion || request.id !== id) return;
    if (applicationUpdateInProgress || databaseSwitchInProgress) return;
    if (request.kind === "detail" && state.selectedMusic?.id === id) await openDetail(id);
    else if (request.kind === "clips" && state.clipsPanelMusic?.id === id) await openMusicClipsPanel(id);
}

function captureDetailDrafts(id) {
    if (state.selectedMusic?.id !== id || $("detailPanel").classList.contains("hidden")) return null;
    const values = {};
    for (const [field, control] of Object.entries(DETAIL_CONTROLS)) {
        if ($(control).value !== (state.selectedMusic[field] || "")) values[control] = $(control).value;
    }
    values.detailEditTagInput = $("detailEditTagInput").value;
    const active = document.activeElement;
    return { values, moviesTab: $("detailMoviesTab")?.classList.contains("active"), clipsTab: $("detailClipsTab").classList.contains("active"),
        focus: active && [...Object.values(DETAIL_CONTROLS), "detailEditTagInput"].includes(active.id)
            ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null };
}

function restoreDetailDrafts(drafts) {
    if (!drafts) return;
    for (const [id, value] of Object.entries(drafts.values)) $(id).value = value;
    if (drafts.moviesTab || drafts.clipsTab) selectDetailTab(drafts.moviesTab ? "movies" : "clips");
    if (drafts.focus) {
        const control = $(drafts.focus.id);
        control.focus();
        if (drafts.focus.start !== null && drafts.focus.start !== undefined) control.setSelectionRange(drafts.focus.start, drafts.focus.end);
    }
}

function syncDetailMusic(saved, shouldSync) {
    for (const [field, id] of Object.entries(DETAIL_CONTROLS)) {
        const control = $(id);
        if (shouldSync(field, control) && control.value !== (saved[field] || "")) control.value = saved[field] || "";
    }
    const specs = { path: ["detailPath", value => value || "本地文件"], duration: ["detailDuration", formatTime],
        fileSize: ["detailFileSize", formatFileSize], mimeType: ["detailMimeType", value => value || "—"] };
    for (const [field, [id, format]] of Object.entries(specs)) {
        if (shouldSync(field, null)) $(id).textContent = format(saved[field]);
    }
    const heading = $("detailContent").querySelector(".detail-name");
    if (heading) heading.textContent = saved.name;
    Object.assign(state.selectedMusic, saved);
}

async function openDetail(id, { tab = null } = {}) {
    const version = beginMusicContextRequest(id, "detail");
    return readMusicContext(id, version, context => {
        renderDetailContext(context, version);
        if (tab) selectDetailTab(tab);
    });
}

function selectDetailTab(tab) {
    document.querySelectorAll("[data-detail-tab]").forEach(button => button.classList.toggle("active", button.dataset.detailTab === tab));
    $("detailClipsTab").classList.toggle("active", tab === "clips");
    $("detailMoviesTab").classList.toggle("active", tab === "movies");
    $("detailTabInfo").classList.toggle("hidden", tab !== "info");
    $("detailTabClips").classList.toggle("hidden", tab !== "clips");
    $("detailTabMovies").classList.toggle("hidden", tab !== "movies");
    if (tab === "movies") void renderMusicMovieUsages();
}

function renderDetailClipRows(clips) {
    return clips.length
                            ? clips
                                .sort(
                                    (a,b) =>
                                        a.start - b.start
                                )
                                .map(clip => `

                                    <div
                                        class="clip-item"
                                        data-clip-id="${clip.id}"
                                    >

                                        <div class="clip-item-header">

                                            <div class="clip-item-name">
                                                ${
                                                    escapeHTML(
                                                        clip.name ||
                                                        "未命名片段"
                                                    )
                                                }
                                            </div>

                                            <div class="clip-time">

                                                ${formatTime(clip.start)}
                                                -
                                                ${formatTime(clip.end)}

                                            </div>

                                        </div>


                                        <div class="clip-tags">

                                            ${renderAssignedTags(clip, "clip")}

                                        </div>


                                        <div class="clip-item-actions">

                                            <button
                                                class="icon-action"
                                                data-clip-action="play"
                                                data-clip-id="${clip.id}"
                                                title="试听这段"
                                            >
                                                ▶
                                            </button>

                                            <button
                                                class="icon-action"
                                                data-clip-action="edit"
                                                data-clip-id="${clip.id}"
                                                title="编辑片段"
                                            >
                                                ✎
                                            </button>

                                            <button
                                                class="icon-action"
                                                data-clip-action="export"
                                                data-clip-id="${clip.id}"
                                                title="导出为 WAV"
                                            >
                                                ⤓
                                            </button>

                                            <button
                                                class="icon-action ${
                                                    isClipCandidate(clip.id)
                                                        ? "is-candidate"
                                                        : ""
                                                }"
                                                data-clip-action="candidate"
                                                data-clip-id="${clip.id}"
                                                title="${
                                                    isClipCandidate(clip.id)
                                                        ? "移出候选"
                                                        : "加入候选"
                                                }"
                                            >
                                                ${
                                                    isClipCandidate(clip.id)
                                                        ? "★"
                                                        : "☆"
                                                }
                                            </button>

                                            <button
                                                class="icon-action"
                                                data-clip-action="delete"
                                                data-clip-id="${clip.id}"
                                                title="删除片段"
                                            >
                                                🗑
                                            </button>

                                        </div>

                                    </div>

                                `)
                                .join("")
                            :
                                `<div class="detail-value">
                                    暂无片段
                                </div>`;
}
async function refreshDetailClipPage(id, version) {
    const clips = await getMusicClips(id);
    if (detailRequestVersion !== version || state.selectedMusic?.id !== id || $("detailPanel").classList.contains("hidden")) return;
    const page = acceptLibraryPage(clips.pagination, `music-clips:${id}`);
    state.detailClipTotal = page.total;
    $("detailClipList").innerHTML = renderDetailClipRows(clips);
    $("detailClipPagination").innerHTML = paginationHTML(page, `music-clips:${id}`, "个片段");
    const label = `音乐片段${page.total ? `（${page.total}）` : ""}`;
    $("detailClipsTab").textContent = label;
    $("detailClipsHeading").textContent = label;
}

function renderDetailContext({ music, clips }, version) {
    const clipPage = clips.pagination;
    const clipTotal = clipPage.total;
    state.detailClipTotal = clipTotal;
    acceptLibraryPage(clipPage, `music-clips:${music.id}`);
    const id = music.id;
    const drafts = captureDetailDrafts(id);
    state.selectedMusic = music;
    detailFieldRevisions = new Map();
    const save = (changes, fields) => saveDetailEdit(changes, music.id, version, fields);
    $("musicClipsPanel").classList.add("hidden");
    state.clipsPanelMusic = null;

    state.editTags =
        [...(music.tags || [])];
    state.editTagIds = [...(music.tagIds || [])];

    $("detailPanel")
        .classList.remove("hidden");


    $("detailContent").innerHTML = `

        <div class="detail-tabs">

            <button
                class="detail-tab active"
                data-detail-tab="info"
            >
                详情
            </button>

            <button
                class="detail-tab"
                id="detailClipsTab"
                data-detail-tab="clips"
            >
                音乐片段
                ${
                    clipTotal
                        ? `（${clipTotal}）`
                        : ""
                }
            </button>

            <button type="button" class="detail-tab" id="detailMoviesTab" data-detail-tab="movies">使用记录</button>
        </div>


        <div
            id="detailTabInfo"
            class="detail-tab-panel"
        >

            <div class="detail-name">
                ${escapeHTML(music.name)}
            </div>


            <div id="detailPath" class="detail-path">
                ${escapeHTML(
                    music.path || "本地文件"
                )}
            </div>


            <div class="file-location">

                <button
                    id="detailPlayBtn"
                    class="primary-btn"
                >
                    ▶ 试听
                </button>

                <button
                    id="locateFileBtn"
                    class="secondary-btn"
                >
                    在 Finder 中显示
                </button>

                <button
                    id="reauthorizeBtn"
                    class="secondary-btn"
                >
                    重新授权
                </button>

                <button id="detailShowClipsBtn" class="secondary-btn">
                    音乐片段
                </button>

            </div>


            <div class="detail-section detail-edit">

                <div class="detail-section-title">
                    基本信息
                    <span class="detail-edit-hint">
                        直接修改，自动保存
                    </span>
                </div>

                <label>
                    音乐名称
                    <input
                        id="detailEditName"
                        type="text"
                        value="${escapeHTML(music.name)}"
                    >
                </label>

                <label>
                    作者
                    <input
                        id="detailEditArtist"
                        type="text"
                        value="${escapeHTML(music.artist || "")}"
                        placeholder="可留空"
                    >
                </label>

                <label>
                    专辑
                    <input
                        id="detailEditAlbum"
                        type="text"
                        value="${escapeHTML(music.album || "")}"
                        placeholder="可留空"
                    >
                </label>

                <label class="album-source-field">
                    专辑来源
                    <select id="detailEditAlbumSource">
                        <option value="folder" ${music.albumSource === "folder" ? "selected" : ""}>文件夹名称（随 Finder 同步）</option>
                        <option value="metadata" ${music.albumSource === "metadata" ? "selected" : ""}>MP3 专辑属性</option>
                        <option value="manual" ${music.albumSource === "manual" ? "selected" : ""}>手动填写（不自动同步）</option>
                    </select>
                </label>

                <label>
                    音乐类型
                    <input
                        id="detailEditGenre"
                        type="text"
                        value="${escapeHTML(music.genre || "")}"
                        placeholder="如：流行 / 古典"
                    >
                </label>

                <label>
                    录制年份
                    <input
                        id="detailEditYear"
                        type="text"
                        value="${escapeHTML(music.year || "")}"
                        placeholder="如：2024"
                    >
                </label>

                <div class="detail-specs">

                    <div class="detail-spec">
                        <span class="detail-spec-label">时长</span>
                        <span id="detailDuration" class="detail-spec-value">${formatTime(music.duration)}</span>
                    </div>

                    <div class="detail-spec">
                        <span class="detail-spec-label">音频声道</span>
                        <span class="detail-spec-value">${escapeHTML(music.channels || "—")}</span>
                    </div>

                    <div class="detail-spec">
                        <span class="detail-spec-label">采样速率</span>
                        <span class="detail-spec-value">${music.sampleRate ? escapeHTML(String(music.sampleRate)) + " Hz" : "—"}</span>
                    </div>

                    <div class="detail-spec">
                        <span class="detail-spec-label">码率</span>
                        <span class="detail-spec-value">${music.bitrate ? escapeHTML(String(music.bitrate)) + " kbps" : "—"}</span>
                    </div>

                    <div class="detail-spec">
                        <span class="detail-spec-label">文件大小</span>
                        <span id="detailFileSize" class="detail-spec-value">${formatFileSize(music.fileSize)}</span>
                    </div>

                    <div class="detail-spec">
                        <span class="detail-spec-label">格式</span>
                        <span id="detailMimeType" class="detail-spec-value">${escapeHTML(music.mimeType || "—")}</span>
                    </div>

                </div>

            </div>


            <div class="detail-section detail-edit">

                <div class="detail-section-title">
                    音乐 Tag
                </div>

                <div
                    id="detailEditTags"
                    class="tag-editor"
                ></div>

                <div class="tag-input-row">
                    <input
                        id="detailEditTagInput"
                        type="text"
                        placeholder="输入新 Tag"
                    >
                    <button
                        id="detailAddTagBtn"
                        class="secondary-btn"
                    >
                        添加
                    </button>
                </div>

                <div
                    id="detailTagSuggestions"
                    class="tag-suggestions"
                ></div>

            </div>

        </div>


        <div
            id="detailTabClips"
            class="detail-tab-panel hidden"
        >

            <div class="detail-section">

                <div class="detail-section-title clip-section-heading">

                    <span id="detailClipsHeading">音乐片段
                    ${
                        clipTotal
                            ? `（${clipTotal}）`
                            : ""
                    }
                    </span>
                    <button id="detailAddClipBtn" class="primary-btn">＋ 新建片段</button>

                </div>


                <div id="detailClipList" class="clip-list">

                    ${renderDetailClipRows(clips)}

                </div>

                <div id="detailClipPagination">${paginationHTML(clipPage, `music-clips:${music.id}`, "个片段")}</div>
            </div>


        </div>

        <div id="detailTabMovies" class="detail-tab-panel hidden"><div id="detailMovieUsages" class="detail-section"><div class="detail-value">正在读取使用记录…</div></div></div>
    `;


    /* Tab 切换 */
    document.querySelectorAll("[data-detail-tab]").forEach(button => {
        button.addEventListener("click", () => selectDetailTab(button.dataset.detailTab));
    });

    $("detailPlayBtn")
        .onclick = () => {

            const p = state.player;

            if (
                p.music &&
                p.music.id === music.id
            ) {

                togglePlay();

            } else {

                playMusic(music.id);
            }
        };


    $("locateFileBtn")
        .onclick = () =>
            revealInFinder(music);


    $("reauthorizeBtn")
        .onclick = () =>
            reauthorizeFile(music);

    $("detailShowClipsBtn").onclick = () => openMusicClipsPanel(music.id);


    $("detailAddClipBtn")
        .onclick = () =>
            openClipEditor(music);


    /* 详情内嵌编辑 */

    $("detailEditName")
        .addEventListener(
            "change",
            () => {

                const newName =
                    $("detailEditName").value
                        .trim();

                if (!newName) {
                    return;
                }

                return save({
                    name: newName
                });
            }
        );


    $("detailEditAlbum")
        .addEventListener(
            "change",
            () => {

                const newAlbum =
                    $("detailEditAlbum").value
                        .replace(/\s+/g, " ")
                        .trim();

                return save({
                    album: newAlbum
                });
            }
        );

    $("detailEditAlbumSource")
        .addEventListener(
            "change",
            async () => {
                const albumSource = $("detailEditAlbumSource").value;
                // Reserve the mutation's position before awaiting the probe.
                // A later manual edit must be applied after this source change.
                await save(async (current, request) => {
                    if (albumSource === "manual") return { albumSource };
                    const info = await request("probe_file", { path: current.path });
                    return { albumSource, album: !info.exists ? current.album
                        : albumSource === "folder" ? info.folderAlbum : info.album };
                }, ["album", "albumSource"]);
            }
        );


    $("detailEditArtist")
        .addEventListener(
            "change",
            () => {

                const newArtist =
                    $("detailEditArtist").value
                        .replace(/\s+/g, " ")
                        .trim();

                save({
                    artist: newArtist
                });
            }
        );


    $("detailEditGenre")
        .addEventListener(
            "change",
            () => {

                const newGenre =
                    $("detailEditGenre").value
                        .replace(/\s+/g, " ")
                        .trim();

                save({
                    genre: newGenre
                });
            }
        );


    $("detailEditYear")
        .addEventListener(
            "change",
            () => {

                const newYear =
                    $("detailEditYear").value
                        .replace(/\s+/g, " ")
                        .trim();

                save({
                    year: newYear
                });
            }
        );


    renderDetailEditTags();

    renderDetailTagSuggestions();

    $("detailEditTagInput")
        .addEventListener(
            "input",
            () => {

                renderDetailTagSuggestions(
                    $("detailEditTagInput").value
                        .trim()
                );
            }
        );

    $("detailAddTagBtn")
        .addEventListener(
            "click",
            addDetailEditTag
        );

    $("detailEditTagInput")
        .addEventListener(
            "keydown",
            event => {

                if (
                    event.key === "Enter" &&
                    !event.isComposing
                ) {

                    event.preventDefault();

                    addDetailEditTag();
                }
            }
        );

    $("detailEditTags")
        .addEventListener(
            "click",
            async event => {

                const btn =
                    event.target.closest(
                        "[data-remove-detail-tag]"
                    );

                if (!btn || btn.disabled) {
                    return;
                }

                const index =
                    Number(
                        btn.dataset.removeDetailTag
                    );

                const tag = state.editTags[index];
                const tagId = state.editTagIds[index] ?? null;
                if (tag === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                btn.disabled = true;
                try {
                    const label = tagRecordsCache.find(item => item.id === tagId)?.path || tag;
                    if (!await confirmTagRemoval("music", music.name, label)) return;
                    return await save(current => musicTagPatch(current, tag, tagId, false), ["tags"]);
                } catch (error) {
                    console.error(error);
                    showToast(`移除 Tag 失败：${getErrorMessage(error)}`);
                } finally {
                    btn.disabled = false;
                }
            }
        );

    $("detailTagSuggestions")
        .addEventListener(
            "click",
            event => {

                const btn =
                    event.target.closest(
                        "[data-detail-suggest-tag]"
                    );

                if (!btn) {
                    return;
                }

                const tagId = Number(btn.dataset.detailSuggestTag);
                const record = tagRecordsCache.find(tag => tag.id === tagId);
                if (!record) return;

                if (
                    !state.editTagIds.includes(tagId)
                ) {

                    state.editTags.push(record.name);
                    state.editTagIds.push(record.id);
                }

                renderDetailEditTags();

                $("detailEditTagInput").value = "";

                renderDetailTagSuggestions();

                return save(current => musicTagPatch(current, record.name, record.id), ["tags"]);
            }
        );
    restoreDetailDrafts(drafts);
}


/* =========================================================
   详情内嵌编辑
========================================================= */

function renderDetailEditTags() {

    const tags =
        state.editTags;

    $("detailEditTags").innerHTML =
        tags
            .map(
                (tag, index) => `

                    <span class="editing-tag">

                        #${escapeHTML(tag)}

                        <button
                            data-remove-detail-tag="${index}"
                        >
                            ×
                        </button>

                    </span>

                `
            )
            .join("") ||
            `<span class="detail-value">暂无 Tag</span>`;
}


async function renderDetailTagSuggestions(query = "") {

    const container =
        $("detailTagSuggestions");

    const groups = renderTagPickerGroups({
        excludeIds: state.editTagIds,
        query,
        attr: "detail-suggest-tag",
        data: await loadTagPickerData()
    });

    container.innerHTML = groups
        ? `<div class="suggestion-title">已有 Tag</div>` + groups
        : "";
}


async function addDetailEditTag() {

    const input =
        $("detailEditTagInput");

    const value = normalizeTag(input.value);

    if (!value) {
        return;
    }

    if (state.editTags.includes(value)) {
        input.value = "";
        showToast("该 Tag 已添加");
        return;
    }

    state.editTags.push(value);
    state.editTagIds.push(null);

    input.value = "";

    renderDetailEditTags();

    // 保存音乐时后端会同步创建此前不存在的 Tag，并关联到当前音乐。
    await saveDetailEdit(current => musicTagPatch(current, value), state.selectedMusic?.id, detailRequestVersion, ["tags"]);
}


function saveDetailEdit(changes, id = state.selectedMusic?.id, viewVersion = detailRequestVersion, fields = Object.keys(changes)) {
    if (!id) return Promise.resolve(false);
    const revision = ++detailSaveRevision;
    const patch = typeof changes === "function" ? changes : {
        ...changes,
        ...(changes.tags && { tags: [...changes.tags] }),
        ...(changes.tagIds && { tagIds: [...changes.tagIds] })
    };
    const controls = DETAIL_CONTROLS;
    const affected = new Set(fields);
    if (affected.has("album")) affected.add("albumSource");
    const snapshots = new Map();
    if (state.selectedMusic?.id === id && viewVersion === detailRequestVersion) {
        for (const field of affected) {
            detailFieldRevisions.set(field, revision);
            if (controls[field]) snapshots.set(field, $(controls[field]).value);
        }
    }
    const task = mutateMusic(id, async (music, request) => {
        const resolved = typeof patch === "function" ? await patch(music, request) : patch;
        if (resolved.album !== undefined && resolved.albumSource === undefined) return { ...resolved, albumSource: "manual" };
        return resolved;
    }).then(async saved => {
        if (!saved) return false;
        if (state.player.music?.id === id) {
            state.player.music = saved;
            renderBarMeta();
        }
        // Update derived values without replacing the panel, focus, or a newer draft.
        if (state.selectedMusic?.id === id && viewVersion === detailRequestVersion) {
            syncDetailMusic(saved, (field, control) => affected.has(field) && detailFieldRevisions.get(field) === revision
                && (!control || control.value === snapshots.get(field)));
            if (affected.has("tags") && detailFieldRevisions.get("tags") === revision) {
                state.editTags = [...saved.tags];
                state.editTagIds = [...saved.tagIds];
                renderDetailEditTags();
                await refreshWhileInteractive(renderDetailTagSuggestions);
            }
        }
        if (!applicationUpdateInProgress) {
            await refreshWhileInteractive(updateCounts, renderSidebarTags, render);
            if (!applicationUpdateInProgress) showToast("已保存");
        }
        return true;
    }).catch(error => {
        console.error(error);
        showToast(`保存失败：${getErrorMessage(error)}`);
        return false;
    });
    detailSaveQueues.set(id, task);
    task.then(() => { if (detailSaveQueues.get(id) === task) detailSaveQueues.delete(id); });
    return task;
}


/* =========================================================
   文件定位
========================================================= */

async function revealInFinder(music) {

    if (!music.path) {

        showToast(
            "这个音乐没有关联文件路径"
        );

        return;
    }

    try {

        // 应用保持打开时，Finder 仍可能刚刚移动了文件；访问前再解析一次书签。
        const synced = await invoke("sync_library_locations");
        if (synced?.updatedPaths || synced?.updatedAlbums) invalidateLibraryCache("music");
        music = (await dbGet("music", music.id)) || music;

        const exists =
            await invoke("file_exists", {
                path: music.path
            });

        if (!exists) {

            showToast(
                "文件不存在，可能已经被移动或删除"
            );

            return;
        }

        await __TAURI__.opener.revealItemInDir(
            music.path
        );

    } catch (error) {

        console.error(error);

        showToast(
            "无法在 Finder 中定位"
        );
    }
}


/* 使用历史打点：每曲 10s 内只记一次（resume 不算新使用） */

let editModalDraft = { tags: [], tagIds: [], original: null };
let editModalRequestVersion = 0;

async function openEditModalForMusic(id) {
    const version = ++editModalRequestVersion;
    while (version === editModalRequestVersion) {
        const dataVersion = libraryCache.versions.music;
        const music = await dbGet("music", id);
        if (!music || version !== editModalRequestVersion) return;
        if (dataVersion !== libraryCache.versions.music) continue;
        return openEditModal(music, version);
    }
}

function closeEditModal(preserveRequest = false) {
    if (!preserveRequest) editModalRequestVersion++;
    editModal.classList.add("hidden");
}

function openEditModal(music, version = null) {
    if (version !== null && version !== editModalRequestVersion) return;
    if (version === null) editModalRequestVersion++;
    editModalDraft.original = { ...music, tags: [...(music.tags || [])], tagIds: [...(music.tagIds || [])] };

    $("editMusicId").value =
        music.id;

    $("editName").value =
        music.name || "";

    $("editAlbum").value =
        music.album || "";


    editModalDraft.tags =
        [...(music.tags || [])];
    editModalDraft.tagIds = [...(music.tagIds || [])];


    renderEditTags();


    editModal.classList.remove(
        "hidden"
    );
}


function renderEditTags() {

    $("editTags").innerHTML =
        editModalDraft.tags
            .map(
                (tag, index) => `

                    <span class="editing-tag">

                        #${escapeHTML(tag)}

                        <button
                            data-remove-edit-tag="${index}"
                        >
                            ×
                        </button>

                    </span>

                `
            )
            .join("");
}


function addEditTag() {

    const input =
        $("editTagInput");

    const value = normalizeTag(input.value);

    if (!value) {
        return;
    }


    if (
        !editModalDraft.tags.includes(value)
    ) {

        editModalDraft.tags.push(value);
        editModalDraft.tagIds.push(null);
    }


    input.value = "";

    renderEditTags();
}


async function saveEdit() {
    const contextRequest = musicContextRequest;
    const modalVersion = editModalRequestVersion;

    const id =
        $("editMusicId").value;

    const name = $("editName").value.trim();
    const album = $("editAlbum").value.trim();
    const original = editModalDraft.original;
    if (!original || original.id !== id) return;
    const entries = music => (music.tags || []).map((name, index) => ({ name, id: music.tagIds?.[index] ?? null }));
    const key = entry => Number.isInteger(entry.id) ? `id:${entry.id}` : `name:${entry.name}`;
    const before = entries(original), after = entries(editModalDraft);
    const beforeKeys = new Set(before.map(key)), afterKeys = new Set(after.map(key));
    const removed = before.filter(entry => !afterKeys.has(key(entry)));
    const added = after.filter(entry => !beforeKeys.has(key(entry)));
    const music = await mutateMusic(id, current => {
        const patch = {};
        if (name && name !== original.name) patch.name = name;
        if (album !== original.album) Object.assign(patch, { album, albumSource: "manual" });
        let tagged = current;
        for (const entry of removed) tagged = { ...tagged, ...musicTagPatch(tagged, entry.name, entry.id, false) };
        for (const entry of added) tagged = { ...tagged, ...musicTagPatch(tagged, entry.name, entry.id) };
        if (removed.length || added.length) Object.assign(patch, { tags: tagged.tags, tagIds: tagged.tagIds });
        return patch;
    });
    if (!music || applicationUpdateInProgress) return;


    if (modalVersion === editModalRequestVersion) closeEditModal();

    await refreshWhileInteractive(render, renderSidebarTags, updateCounts);
    if (applicationUpdateInProgress || databaseSwitchInProgress) return;


    const p = state.player;

    if (
        p.music &&
        p.music.id === music.id
    ) {

        p.music = music;

        renderBarMeta();
    }

    await refreshWhileInteractive(() => refreshMusicContext(contextRequest, music.id));


    showToast(
        "音乐信息已保存"
    );
}


/* =========================================================
   Tag suggestion
========================================================= */
