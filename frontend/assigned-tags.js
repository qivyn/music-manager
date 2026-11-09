/* Remove an assigned tag without deleting the shared tag or opening an editor. */
const assignedTagRemovals = new Set();
const assignedTagKey = (kind, ownerId, tagId) => JSON.stringify([kind, ownerId, tagId]);

async function confirmTagRemoval(kind, ownerName, tagName) {
    if (applicationUpdateInProgress || databaseSwitchInProgress) return false;
    const owner = { music: "音乐", clip: "片段", album: "专辑" }[kind];
    const accepted = await __TAURI__.dialog.ask(
        `确定从${owner}「${ownerName}」移除 Tag「${tagName}」？\n\n仅移除当前关联，标签库及其他音乐、片段或专辑上的同一 Tag 会保留。`,
        { title: "移除 Tag", kind: "warning", okLabel: "移除", cancelLabel: "取消" }
    );
    return accepted === true && !applicationUpdateInProgress && !databaseSwitchInProgress;
}

function renderAssignedTags(item, kind = "music") {
    const owner = kind === "clip" ? "片段" : "音乐";
    return (item.tags || []).map((name, index) => {
        const tagId = item.tagIds?.[index];
        const label = tagRecordsCache.find(tag => tag.id === tagId)?.path || name;
        if (!Number.isInteger(tagId)) return `<span class="tag">#${escapeHTML(name)}</span>`;
        const pending = assignedTagRemovals.has(assignedTagKey(kind, item.id, tagId));
        return `<button type="button" class="tag removable-tag" data-remove-assigned-tag="${tagId}" data-tag-owner-kind="${kind}" data-tag-owner-id="${escapeHTML(item.id)}"
            title="从${owner}移除 #${escapeHTML(label)}" aria-label="从${owner}移除 Tag ${escapeHTML(label)}" ${pending ? "disabled" : ""}>
            <span>#${escapeHTML(name)}</span><span class="tag-remove-mark" aria-hidden="true">×</span></button>`;
    }).join("");
}

function setAssignedTagPending(kind, ownerId, tagId, pending) {
    document.querySelectorAll("[data-remove-assigned-tag]").forEach(button => {
        if (button.dataset.tagOwnerKind === kind && button.dataset.tagOwnerId === ownerId && Number(button.dataset.removeAssignedTag) === tagId)
            button.disabled = pending;
    });
}

async function handleAssignedTagClick(event) {
    const button = event.target.closest("[data-remove-assigned-tag]");
    event.preventDefault();
    event.stopPropagation();
    if (!button || button.disabled) return;
    const { tagOwnerKind, tagOwnerId, removeAssignedTag: tagId } = button.dataset;
    button.disabled = true;
    try { await removeAssignedTag(tagOwnerKind, tagOwnerId, Number(tagId)); }
    finally { button.disabled = false; }
}

async function removeAssignedTag(kind, ownerId, tagId) {
    if (!["music", "clip"].includes(kind) || !ownerId || !Number.isInteger(tagId)) return false;
    const key = assignedTagKey(kind, ownerId, tagId);
    if (assignedTagRemovals.has(key)) return false;
    assignedTagRemovals.add(key);
    setAssignedTagPending(kind, ownerId, tagId, true);
    const contextRequest = musicContextRequest;
    try {
        const mutate = kind === "music" ? mutateMusic : mutateClip;
        let saved;
        try {
            const item = await dbGet(kind === "music" ? "music" : "clips", ownerId);
            const index = item?.tagIds?.indexOf(tagId) ?? -1;
            if (index < 0) return false;
            const label = tagRecordsCache.find(tag => tag.id === tagId)?.path || item.tags[index] || `Tag ${tagId}`;
            if (!await confirmTagRemoval(kind, item.name, label)) return false;
            saved = await mutate(ownerId, item => (item.tagIds || []).includes(tagId)
                ? musicTagPatch(item, "", tagId, false) : null);
        } catch (error) {
            console.error(error);
            showToast(`移除 Tag 失败：${getErrorMessage(error)}`);
            return false;
        }
        if (!saved || applicationUpdateInProgress || databaseSwitchInProgress) return Boolean(saved);
        if (kind === "music") {
            if (state.player.music?.id === ownerId) {
                state.player.music.tags = [...saved.tags];
                state.player.music.tagIds = [...saved.tagIds];
            }
            if (contextRequest === musicContextRequest && state.selectedMusic?.id === ownerId) {
                state.selectedMusic.tags = [...saved.tags];
                state.selectedMusic.tagIds = [...saved.tagIds];
                state.editTags = [...saved.tags];
                state.editTagIds = [...saved.tagIds];
                renderDetailEditTags();
            }
        }
        try {
            await refreshWhileInteractive(renderSidebarTags, renderFilterPanel, renderPreservingScroll,
                () => $("candidatePanel").classList.contains("hidden") ? null : renderCandidatePanel(),
                () => kind === "music" && contextRequest === musicContextRequest && state.selectedMusic?.id === ownerId
                    ? renderDetailTagSuggestions() : null,
                async () => {
                    if (kind !== "clip" || contextRequest !== musicContextRequest || contextRequest?.id !== saved.musicId) return;
                    if (contextRequest.kind === "detail") await refreshDetailClipPage(saved.musicId, contextRequest.version);
                    else await refreshMusicContext(contextRequest, saved.musicId);
                });
            if (!applicationUpdateInProgress && !databaseSwitchInProgress) showToast("已移除 Tag");
        } catch (error) {
            console.error(error);
            showToast(`Tag 已移除，界面刷新失败：${getErrorMessage(error)}`);
        }
        return true;
    } finally {
        assignedTagRemovals.delete(key);
        setAssignedTagPending(kind, ownerId, tagId, false);
    }
}
