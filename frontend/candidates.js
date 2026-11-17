/* Candidate list and library deletion coordination. Shared application state lives in app.js. */

function isCandidate(id) {

    return state.player.candidates
        .some(c => c.id === id);
}


function isClipCandidate(clipId) {

    return state.player.candidates
        .some(
            c =>
                c.kind === "clip" &&
                c.id === clipId
        );
}

function syncCandidateIndicators() {
    document.querySelectorAll('[data-action="candidate"][data-id]').forEach(button => {
        const selected = isCandidate(button.dataset.id);
        button.classList.toggle("is-candidate", selected);
        button.textContent = selected ? "★" : "☆";
        button.title = selected ? "移出候选" : "加入候选";
    });

    document.querySelectorAll('[data-clip-action="candidate"], [data-panel-clip-action="candidate"]').forEach(button => {
        const clipId = button.dataset.clipId || button.dataset.panelClipId;
        const selected = isClipCandidate(clipId);
        button.classList.toggle("is-candidate", selected);
        button.textContent = selected ? "★" : "☆";
        button.title = selected ? "移出候选" : "加入候选";
    });
}


async function addCandidate(item) {

    const p = state.player;

    if (
        isCandidate(item.id) ||
        isClipCandidate(item.id)
    ) {
        return;
    }

    const entry = { kind: item.kind || "music", id: item.id };
    p.candidates.push(entry);
    await invoke("create_candidate", { targetId: entry.id, kind: entry.kind, createdAt: Date.now() });

    syncCandidateIndicators();
    renderCandidateBadge();

    renderCandidatePanel();

    render();
}


async function removeCandidate(id) {

    const p = state.player;

    p.candidates =
        p.candidates.filter(
            c => c.id !== id
        );

    await invoke("delete_candidate", { targetId: id });

    syncCandidateIndicators();
    renderCandidateBadge();

    renderCandidatePanel();

    render();
}

function removeDeletedDetailClips(clipIds) {
    const list = $("detailClipList");
    if (!state.selectedMusic || !list) return;
    let removed = 0;
    list.querySelectorAll(".clip-item").forEach(row => {
        if (clipIds.has(row.dataset.clipId)) {
            row.remove();
            removed++;
        }
    });
    if (!removed) return;
    // Patch only the deleted rows and counts: preserve the active tab, focus,
    // and unsaved metadata/tag drafts elsewhere in the detail panel.
    const count = Math.max(0, (state.detailClipTotal || 0) - removed);
    state.detailClipTotal = count;
    const label = `音乐片段${count ? `（${count}）` : ""}`;
    $("detailClipsTab").textContent = label;
    $("detailClipsHeading").textContent = label;
    if (!count) list.innerHTML = '<div class="detail-value">暂无片段</div>';
}

async function deleteLibraryEntries(storeName, ids, { exitSelection = false } = {}) {
    const contextRequest = musicContextRequest;
    const clipsPanelId = state.clipsPanelMusic?.id;
    const musicIds = new Set(storeName === "music" ? ids : []);
    const clipIds = new Set(storeName === "clips" ? ids :
        (await invoke("library_related_ids", { musicIds: [...musicIds], album: null })));
    await invoke(storeName === "music" ? "delete_music_batch" : "delete_clip_batch", { ids });
    invalidateLibraryCache(storeName === "music" ? null : "clips");
    musicIds.forEach(id => coverArtCache.delete(id));
    const p = state.player;
    const requested = playbackRequest?.version === playbackRequestVersion ? playbackRequest : null;
    const requestDeleted = requested && (musicIds.has(requested.musicId) || clipIds.has(requested.clipId));
    if (requestDeleted || musicIds.has(homeAuditionPending)) {
        playbackRequestVersion++;
        playbackRequest = null;
        cancelHomeAudition();
        p.loading = false;
    }
    if (musicIds.has(p.music?.id) || clipIds.has(p.segment?.clipId)) {
        // A surviving replacement may already be loading while the old track is
        // removed. Clear the old audio without cancelling that newer request.
        resetLoadedPlayer(Boolean(requested && !requestDeleted));
    }
    p.candidates = p.candidates.filter(entry => !musicIds.has(entry.id) && !clipIds.has(entry.id));
    p.queue = p.queue.filter(entry => !musicIds.has(entry.id) && !clipIds.has(entry.id));
    const currentId = requested && !requestDeleted
        ? requested.clipId || requested.musicId
        : p.segment?.clipId || p.music?.id;
    p.index = p.queue.findIndex(entry => entry.id === currentId);
    musicIds.forEach(id => state.selectedMusicIds.delete(id));
    clipIds.forEach(id => state.selectedClipIds.delete(id));
    if (exitSelection) {
        state.selectedMusicIds.clear();
        state.selectedClipIds.clear();
        state.selectionMode = false;
    }
    if (musicContextRequest?.version === detailRequestVersion && musicIds.has(musicContextRequest.id)) invalidateMusicContextRequest();
    if (musicIds.has(state.selectedMusic?.id)) {
        state.selectedMusic = null;
        $("detailPanel").classList.add("hidden");
    }
    removeDeletedDetailClips(clipIds);
    if (musicIds.has(state.clipsPanelMusic?.id)) {
        state.clipsPanelMusic = null;
        $("musicClipsPanel").classList.add("hidden");
    }
    if (musicIds.has(state.clipMusic?.id) || clipIds.has(state.editingClip?.id)) await closeClipEditor(true, true);
    if (musicIds.has(editModalDraft.original?.id)) closeEditModal(true);
    renderCandidateBadge();
    updateBarControls();
    syncCandidateIndicators();
    await updateCounts();
    await renderSidebarTags();
    await renderCandidatePanel();
    await render();
    if (contextRequest?.kind === "detail" && contextRequest === musicContextRequest && state.selectedMusic?.id === contextRequest.id)
        await refreshDetailClipPage(contextRequest.id, contextRequest.version);
    if (clipsPanelId) await refreshMusicContext(contextRequest?.kind === "clips" ? contextRequest : null, clipsPanelId);
}

async function deleteClip(clipId) {
    const clip = await dbGet("clips", clipId);
    if (!clip || !await confirm("确定删除这个音乐片段吗？")) return;
    await deleteLibraryEntries("clips", [clipId]);
    showToast("片段已删除");
}


async function toggleClipCandidate(clipId) {
    const contextRequest = musicContextRequest;

    const clip =
        await dbGet("clips", clipId);

    if (!clip) {
        return;
    }

    const music =
        await dbGet("music", clip.musicId);

    if (!music) {
        return;
    }

    if (isClipCandidate(clipId)) {

        await removeCandidate(clipId);

        showToast("已移出候选");

    } else {

        await addCandidate({ kind: "clip", id: clip.id });

        showToast("已加入候选");
    }

    await refreshMusicContext(contextRequest, music.id);
}


async function toggleCandidate(id) {

    const music =
        await dbGet("music", id);

    if (!music) {
        return;
    }

    if (isCandidate(id)) {

        await removeCandidate(id);

        showToast("已移出候选");

    } else {

        await addCandidate({ kind: "music", id: music.id });

        showToast("已加入候选");
    }
}


function renderCandidateBadge() {

    const count = state.player.candidates.length;
    $("candidateBadge").textContent = count;
    $("candidateNavCount").textContent = count;
}

async function clearCandidates() {
    if (!state.player.candidates.length) {
        return;
    }

    const confirmed = await confirm("确定清空全部候选吗？此操作不会删除音乐或片段。", "清空候选");
    if (!confirmed) {
        return;
    }

    await invoke("clear_candidates");
    state.player.candidates = [];
    if (state.player.queueSource === "candidates") {
        state.player.queue = [];
        state.player.index = -1;
        state.player.queueSource = "view";
        updateBarControls();
    }
    syncCandidateIndicators();
    renderCandidateBadge();
    await renderCandidatePanel();
    await render();
    showToast("候选清单已清空");
}


let candidateRenderVersion = 0;
async function renderCandidatePanel() {
    const version = ++candidateRenderVersion;
    const page = await requestLibraryPage({ kind: "candidates" }, "candidates", COMPACT_PAGE_SIZE);
    if (version !== candidateRenderVersion) return;
    acceptLibraryPage(page, "candidates");
    const body = $("candidatePanelBody");
    $("candidatePanelCount").textContent = page.total ? `（${page.total}）` : "";
    $("clearCandidatesBtn").disabled = !page.total;
    if (!page.total) { body.innerHTML = '<div class="candidate-empty">还没有候选<br>试听时点播放条的「＋」加入候选</div>'; return; }
    const entries = page.items;
    body.innerHTML = entries
        .map(c => {

            const isClip =
                c.kind === "clip";

            const meta = isClip
                ? `片段 · ${escapeHTML(c.musicName || "")} ` +
                  `${formatTime(c.start)}-${formatTime(c.end)}`
                : (c.album ? escapeHTML(c.album) : "");

            return `

            <div
                class="candidate-item ${isClip ? "is-clip" : ""}"
                data-candidate-id="${c.id}"
            >

                <div class="candidate-item-header">

                    <div class="candidate-item-name">
                        ${
                            isClip ? "◈ " : ""
                        }${escapeHTML(c.name)}
                    </div>

                    <div class="candidate-item-time">
                        ${formatTime(c.duration)}
                    </div>

                </div>

                <div class="candidate-item-meta">
                    ${meta || "—"}
                </div>

                ${(c.tags || []).length ? `<div class="candidate-item-tags">${renderAssignedTags(c, c.kind === "clip" ? "clip" : "music")}</div>` : ""}

                <div class="candidate-item-actions">

                    <button
                        class="icon-action"
                        data-action="play-candidate"
                        data-id="${c.id}"
                        title="试听"
                    >
                        ▶
                    </button>

                    <button
                        class="icon-action"
                        data-action="remove-candidate"
                        data-id="${c.id}"
                        title="移出候选"
                    >
                        ✕
                    </button>

                </div>

            </div>
            `;
        })
        .join("") + paginationHTML(page, "candidates", "项候选");
}


function openCandidatePanel() {

    renderCandidatePanel();

    $("candidatePanel").classList.remove("hidden");
    $("openCandidatePanelBtn").classList.add("is-active");
    $("openCandidatePanelBtn").setAttribute("aria-expanded", "true");
}


function closeCandidatePanel() {

    $("candidatePanel").classList.add("hidden");
    $("openCandidatePanelBtn").classList.remove("is-active");
    $("openCandidatePanelBtn").setAttribute("aria-expanded", "false");
}
