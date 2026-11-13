/* IPC data access and mutation queues. Shared application state lives in app.js. */

function invalidateLibraryCache(storeName = null) {
    for (const name of ["music", "clips"]) {
        if (!storeName || storeName === name) {
            libraryCache.versions[name]++;
        }
    }
}

const getLibraryCounts = async () => invoke("get_library_counts");

const dbGet = async (storeName, id, request = invoke) =>
    storeName === "music"
        ? request("get_music", { id })
        : request("get_clip", { id });

function withTagWritePayload(value) {
    const tags = [...(value.tags || [])];
    const alignedIds = [...(value.tagIds || [])];
    return {
        ...value,
        tags,
        tagIds: alignedIds.filter(Number.isInteger),
        newTags: tags.filter((_, index) => !Number.isInteger(alignedIds[index]))
    };
}

const dbAdd = async (storeName, value, request = invoke) => {
    await (storeName === "music"
        ? request("create_music", { music: withTagWritePayload(value) })
        : request("create_clip", { clip: withTagWritePayload(value) }));
    invalidateLibraryCache(storeName);
    if (storeName === "music") coverArtCache.delete(value.id);
};

const dbPut = async (storeName, value, request = invoke) => {
    await (storeName === "music"
        ? request("update_music", { music: withTagWritePayload(value) })
        : request("update_clip", { clip: withTagWritePayload(value) }));
    invalidateLibraryCache(storeName);
    if (storeName === "music") coverArtCache.delete(value.id);
};

const musicMutationQueues = new Map();
const clipMutationQueues = new Map();
function mutateMusic(id, change, request = null) {
    return mutateRecord("music", musicMutationQueues, id, change, request);
}

function mutateClip(id, change, request = null) {
    return mutateRecord("clips", clipMutationQueues, id, change, request);
}

function mutateRecord(storeName, queues, id, change, request = null) {
    if (!request && (applicationUpdateInProgress || databaseSwitchInProgress)) {
        return runLibraryOperation(() => {});
    }
    const previous = queues.get(id) || Promise.resolve();
    const work = request => {
        return previous.catch(() => {}).then(async () => {
            const item = await dbGet(storeName, id, request);
            if (!item) return null;
            const patch = await change(item, request);
            if (patch === null) return item;
            Object.assign(item, patch, { updatedAt: Date.now() });
            await dbPut(storeName, item, request);
            return dbGet(storeName, id, request);
        });
    };
    const task = request ? work(request) : runLibraryOperation(work);
    queues.set(id, task);
    const done = () => { if (queues.get(id) === task) queues.delete(id); };
    task.then(done, done);
    return task;
}

function mergeTagDraft(current, original, draft) {
    const entries = item => (item.tags || []).map((name, index) => ({ name, id: item.tagIds?.[index] ?? null }));
    const key = entry => Number.isInteger(entry.id) ? `id:${entry.id}` : `name:${entry.name}`;
    const before = entries(original), after = entries(draft);
    const beforeKeys = new Set(before.map(key)), afterKeys = new Set(after.map(key));
    let tagged = current;
    for (const entry of before.filter(entry => !afterKeys.has(key(entry)))) tagged = { ...tagged, ...musicTagPatch(tagged, entry.name, entry.id, false) };
    for (const entry of after.filter(entry => !beforeKeys.has(key(entry)))) tagged = { ...tagged, ...musicTagPatch(tagged, entry.name, entry.id) };
    return { tags: [...(tagged.tags || [])], tagIds: [...(tagged.tagIds || [])] };
}

function musicTagPatch(music, name, id = null, add = true) {
    let entries = (music.tags || []).map((name, index) => ({ name, id: music.tagIds?.[index] ?? null }));
    const matches = entry => Number.isInteger(id) ? entry.id === id : entry.name === name;
    if (add) {
        if (!entries.some(matches)) entries.push({ name, id });
    } else entries = entries.filter(entry => !matches(entry));
    return { tags: entries.map(entry => entry.name), tagIds: entries.map(entry => entry.id) };
}

async function refreshWhileInteractive(...steps) {
    for (const step of steps) {
        if (applicationUpdateInProgress || databaseSwitchInProgress) return;
        try { await step(); }
        catch (error) {
            if (applicationUpdateInProgress || databaseSwitchInProgress) return;
            throw error;
        }
    }
}

async function refreshAfterApplicationUpdate() {
    await refreshWhileInteractive(renderSelectedFiles, updateCounts, renderSidebarTags, render);
}

const dbDelete = async (storeName, id) => {
    await (storeName === "music"
        ? invoke("delete_music", { id })
        : invoke("delete_clip", { id }));
    invalidateLibraryCache(storeName);
    if (storeName === "music") {
        coverArtCache.delete(id);
        invalidateLibraryCache("clips");
    }
};

let libraryQueryRevision = 0;
const libraryQueryWrites = new Set([
    "create_music", "update_music", "delete_music", "delete_music_batch", "mark_music_played",
    "create_clip", "update_clip", "delete_clip", "delete_clip_batch",
    "create_tag", "update_tag", "move_tag", "delete_tag", "create_tag_category", "update_tag_category", "delete_tag_category",
    "add_music_movie_usages", "add_movie_music_usages", "create_movie", "delete_movie", "update_movie", "update_movie_usage", "delete_movie_usage",
    "set_album_tags", "delete_album_tags", "create_candidate", "delete_candidate", "clear_candidates"
]);
function invalidateLibraryQueries(command, result) {
    if (libraryQueryWrites.has(command) || (command === "sync_library_locations" && (result?.updatedPaths || result?.updatedAlbums))) libraryQueryRevision++;
}
let libraryRenderVersion = 0;
const libraryPageRequests = new Map();
function libraryFilters() {
    return { search: state.search, activeTagIds: [...state.activeTagIds], movieUsageStatus: state.movieUsageStatus };
}
async function requestLibraryPage(query, key, defaultSize = PAGE_SIZE) {
    const request = { ...query, page: state.pages[key] || 1, pageSize: Number(state.pageSizes[key]) || defaultSize };
    while (true) {
        const revision = `${libraryQueryRevision}:${libraryCache.versions.music}:${libraryCache.versions.clips}`;
        const cacheKey = revision + JSON.stringify(request);
        let pending = libraryPageRequests.get(cacheKey);
        if (!pending) {
            pending = invoke("query_library_page", { query: request });
            libraryPageRequests.set(cacheKey, pending);
            const clear = () => { if (libraryPageRequests.get(cacheKey) === pending) libraryPageRequests.delete(cacheKey); };
            pending.then(clear, clear);
        }
        const result = await pending;
        if (revision === `${libraryQueryRevision}:${libraryCache.versions.music}:${libraryCache.versions.clips}`) return result;
    }
}
function acceptLibraryPage(page, key) { state.pages[key] = page.page; return page; }
