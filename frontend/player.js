/* Audio playback and file rebinding. Shared application state lives in app.js. */

let lastUsedMark = { id: null, at: 0 };
function markCurrentTrackUsed() {
    const music = state.player.music;
    if (!music) return;
    const now = Date.now();
    if (lastUsedMark.id === music.id && now - lastUsedMark.at < 10000) return;
    lastUsedMark = { id: music.id, at: now };
    music.playCount = (music.playCount || 0) + 1;
    music.lastPlayedAt = now;
    invalidateLibraryCache("music");
    invoke("mark_music_played", { id: music.id }).then(() => {
        invalidateLibraryCache("music");
        if (state.currentView === "recent" && state.recentMode === "used") void render().catch(console.error);
    }).catch(error => { invalidateLibraryCache("music"); console.error(error); });
}

/* =========================================================
   底部播放器
========================================================= */

function getAudio() {

    const p = state.player;

    if (!p.audio) {

        p.audio = $("barAudio");
    }

    return p.audio;
}


function showPlayerBar() {

    $("playerBar").classList.remove("hidden");

    document.body.classList.add("has-player");
}


function hidePlayerBar() {

    $("playerBar").classList.add("hidden");

    document.body.classList.remove("has-player");
}


function renderBarMeta() {

    const p = state.player;

    const music = p.music;

    if (!music) {

        $("playerTitle").textContent =
            "未在播放";

        $("playerMeta").textContent =
            "—";

        return;
    }

    if (p.segment) {

        $("playerTitle").textContent =
            "◈ 片段：";

    } else {

        $("playerTitle").textContent =
            "";
    }

    $("playerTitle").textContent +=
        music.name || "未命名";

    const meta = [];

    if (p.segment) {

        meta.push(
            formatTime(p.segment.start) +
            " - " +
            formatTime(p.segment.end)
        );
    }

    if (music.album) {
        meta.push("专辑：" + music.album);
    }

    $("playerMeta").textContent =
        meta.join(" · ") ||
        (music.duration
            ? formatTime(music.duration)
            : "—");
}


function updateBarTime() {

    const a = getAudio();

    const p = state.player;

    const dur =
        Number.isFinite(a.duration)
            ? a.duration
            : 0;

    const cur =
        Number.isFinite(a.currentTime)
            ? a.currentTime
            : 0;

    $("playerTime").textContent =
        formatTime(cur) +
        " / " +
        formatTime(dur || (p.music && p.music.duration) || 0);
    if ($("homeTrackTime") && homeSelectedTrack()?.id === p.music?.id) {
        $("homeTrackTime").textContent = `${formatTime(cur)} / ${formatTime(dur || p.music?.duration || 0)}`;
    }
}


function updateBarControls() {

    const p = state.player;

    if (p.queueSource === "home") {
        const selected = homeSelectedTrack();
        if (selected?.libraryPosition != null) {
            $("playerPrevBtn").disabled = selected.libraryPosition <= 0;
            $("playerNextBtn").disabled = selected.libraryPosition >= selected.libraryTotal - 1;
            return;
        }
    }
    const hasQueue = p.queue.length > 0;

    const prevBtn =
        $("playerPrevBtn");

    const nextBtn =
        $("playerNextBtn");

    prevBtn.disabled =
        !hasQueue ||
        p.index <= 0;

    nextBtn.disabled =
        !hasQueue ||
        p.index >=
            p.queue.length - 1;
}


function setPlayingUI(playing) {

    state.player.playing =
        playing;

    document.body.classList.toggle(
        "is-playing",
        playing
    );

    $("playerPlayBtn").textContent =
        playing ? "⏸" : "▶";

    $("playerPlayBtn").title =
        playing ? "暂停" : "播放";

    syncPlaybackIndicators();
}

function syncPlaybackIndicators() {
    const p = state.player;
    const activeMusicId = !p.segment && p.playing ? p.music?.id : null;
    const activeClipId = p.segment && p.playing ? p.segment.clipId : null;

    document.querySelectorAll('[data-action="play"][data-id]').forEach(button => {
        const isPlaying = button.dataset.id === activeMusicId;
        button.classList.toggle("is-playing", isPlaying);
        button.textContent = isPlaying ? "Ⅱ" : "▶";
        button.title = isPlaying ? "暂停试听" : "试听";
    });

    document.querySelectorAll('[data-clip-action="play"], [data-panel-clip-action="play"]').forEach(button => {
        const clipId = button.dataset.clipId || button.dataset.panelClipId;
        const isPlaying = clipId === activeClipId;
        button.classList.toggle("is-playing", isPlaying);
        button.textContent = isPlaying ? "Ⅱ" : "▶";
        button.title = isPlaying ? "暂停试听" : "试听片段";
    });

    document.querySelectorAll(".music-row, .music-card").forEach(row => {
        row.classList.toggle("is-playing", row.dataset.musicId === activeMusicId);
    });

    syncHomePlayback();

    document.querySelectorAll(".clip-library-row, .clip-item").forEach(row => {
        const clipId = row.dataset.clipId || row.dataset.panelClipId;
        row.classList.toggle("is-playing", clipId === activeClipId);
    });
}


function skipBroken(music) {

    showToast(
        "文件不存在，已跳过：" +
        (music && music.name
            ? music.name
            : "未知音乐")
    );

    nextTrack(true);
}


let playbackRequestVersion = 0;
let playbackRequest = null;

function trackPlaybackRequest(version, musicId, clipId = null) {
    if (version === playbackRequestVersion) playbackRequest = { version, musicId, clipId };
}

function playbackObsolete(opts) {
    return opts.playbackVersion !== playbackRequestVersion ||
        (opts.auditionVersion !== undefined && opts.auditionVersion !== homeAuditionVersion);
}

async function loadAndPlay(music, segment = null, opts = {}) {
    opts = { ...opts, playbackVersion: opts.playbackVersion ?? ++playbackRequestVersion };
    const obsolete = () => playbackObsolete(opts);
    if (obsolete()) return false;
    trackPlaybackRequest(opts.playbackVersion, music.id, segment?.clipId);

    const p = state.player;

    const a = getAudio();

    // 队列中的对象可能是在 Finder 移动文件前生成的，播放前总是取最新地址。
    const synced = await invoke("sync_library_locations");
    if (synced?.updatedPaths || synced?.updatedAlbums) invalidateLibraryCache("music");
    if (obsolete()) return false;
    music = await dbGet("music", music.id);
    if (obsolete() || !music) return false;

    p.loading = true;

    try {

        const exists =
            await invoke("file_exists", {
                path: music.path
            });

        if (obsolete()) return false;

        if (!exists) {

            p.loading = false;

            if (opts.deferPlay) {
                showToast("音乐文件不存在，请在曲库中重新绑定文件");
                return false;
            }
            skipBroken(music);

            return;
        }

        const url =
            convertFileSrc(music.path);

        // Keep the currently loaded track and its metadata together until the
        // replacement is accessible and the audition is still current.
        p.music = music;
        p.segment = segment;
        renderBarMeta();
        showPlayerBar();

        // 唱机联动：标签换当前曲封面，纹槽换当前曲波形。
        // deferPlay 时纹理由 swapRecord 在换片动画中替换。
        if (window.Turntable && !opts.deferPlay) {
            const cachedCover = music.coverArt || coverArtCache.get(music.id) || "";
            window.Turntable.setTrack({ coverArt: cachedCover, grooveUrl: url, title: music.name, artist: music.artist || music.album || "" });
            if (!cachedCover) {
                invoke("get_music_cover_arts", { ids: [music.id] })
                    .then(covers => {
                        const art = covers[0]?.coverArt || "";
                        if (art) {
                            coverArtCache.set(music.id, art);
                            if (state.player.music?.id === music.id) window.Turntable?.setTrack({ coverArt: art });
                        }
                    })
                    .catch(() => {});
            }
        }

        if (p.currentUrl === url) {

            if (segment) {

                a.currentTime = segment.start;

            } else {

                a.currentTime = 0;
            }

        } else {

            p.currentUrl = url;

            a.src = url;
        }

        if (segment) {

            const handleMeta = () => {

                a.removeEventListener(
                    "loadedmetadata",
                    handleMeta
                );

                if (obsolete()) return;
                a.currentTime = segment.start;
                updateBarTime();
            };

            a.addEventListener(
                "loadedmetadata",
                handleMeta
            );
        }

        if (opts.deferPlay) {

            /* 只装载不出声：
               等唱机换片、落针后由唱机驱动 a.play()，
               UI 状态由新增的 play/pause 事件监听同步。 */
            setPlayingUI(false);

            return true;
        }

        try {

            await a.play();
            if (!obsolete()) setPlayingUI(true);

        } catch (error) {

            /*
             * 自动播放可能被拦:
             * 停在"已加载未播放"状态,等用户点 ▶
             */

            if (!obsolete()) setPlayingUI(false);
        }

    } catch (error) {

        if (obsolete()) return false;
        console.error(error);

        showToast(
            "文件无法访问，可能已经被移动或删除"
        );

    } finally {

        if (!obsolete()) p.loading = false;
        syncHomePlayback();
    }
}


function onSegmentTimeupdate() {

    const p = state.player;

    const a = getAudio();

    if (
        !p.segment ||
        !a.duration
    ) {
        return;
    }

    if (
        a.currentTime >=
        p.segment.end
    ) {

        a.pause();
        if (p.queueSource === "candidates") {
            nextTrack(true);
        } else {
            setPlayingUI(false);
            a.currentTime = p.segment.start;
        }
    }
}


async function playMusic(id, opts = {}) {
    if (!opts.deferPlay) cancelHomeAudition();
    opts = { ...opts, playbackVersion: opts.playbackVersion ?? ++playbackRequestVersion };
    trackPlaybackRequest(opts.playbackVersion, id);

    const p = state.player;

    const music =
        await dbGet("music", id);

    if (playbackObsolete(opts)) return false;

    if (!music) {
        return false;
    }

    // swapToMusic commits the home queue only after a successful load.
    // A cancelled or failed audition must preserve the prior queue as well.
    if (opts.deferPlay) return await loadAndPlay(music, null, opts);

    const source =
        opts.source || "view";

    if (source === "candidates") {

        p.queue =
            p.candidates.slice();

        p.queueSource =
            "candidates";

        p.index =
            p.queue.findIndex(
                m => m.id === id
            );

    } else {

        p.queue =
            visibleQueueMusic.slice();

        p.queueSource = "view";

        p.index =
            p.queue.findIndex(
                m => m.id === id
            );

        if (p.index === -1) {

            /*
             * 点击的音乐不在当前可见队列
             * (如详情/候选里点播)
             * 单独作为一首播放,不绑定队列
             */

            p.queue = [];
            p.index = -1;
        }
    }

    updateBarControls();

    return await loadAndPlay(music, null, opts);
}


async function playClip(clip, opts = {}) {
    cancelHomeAudition();
    opts = { ...opts, playbackVersion: ++playbackRequestVersion };
    trackPlaybackRequest(opts.playbackVersion, clip?.musicId, clip?.id);

    const currentClip = clip?.id
        ? await dbGet("clips", clip.id)
        : null;
    if (playbackObsolete(opts) || !currentClip) return false;
    clip = currentClip;
    trackPlaybackRequest(opts.playbackVersion, clip.musicId, clip.id);

    const music =
        await dbGet("music", clip.musicId);

    if (!music || playbackObsolete(opts)) {
        return;
    }

    const p = state.player;

    if (opts.source === "candidates") {
        p.queue = p.candidates.slice();
        p.queueSource = "candidates";
        p.index = p.queue.findIndex(item => item.id === clip.id);
    } else {
        p.queue = [];
        p.queueSource = "clip";
        p.index = -1;
    }

    const segment = {
        start: clip.start,
        end: clip.end,
        musicId: clip.musicId,
        clipId: clip.id
    };

    updateBarControls();

    await loadAndPlay(music, segment, opts);
}

/* 片段导出为 WAV：弹保存对话框选目标位置，后端解码切片 */
async function exportClip(clip, music) {
    const safe = value =>
        String(value || "").replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
    const dest = await __TAURI__.dialog.save({
        defaultPath: `${safe(music.name)}-${safe(clip.name || "片段")}.wav`,
        filters: [{ name: "WAV 音频", extensions: ["wav"] }]
    });
    if (!dest) return;
    try {
        await invoke("export_clip_wav", {
            sourcePath: music.path,
            start: clip.start,
            end: clip.end,
            destPath: dest
        });
        showToast("片段已导出为 WAV");
    } catch (error) {
        showToast(String(error?.message || error || "导出失败"));
    }
}
async function togglePlay() {

    if (homeAuditionPending) { cancelHomeAudition(); return; }
    if (state.currentView === "home") { await auditionHomeMusic(); return; }

    const p = state.player;

    const a = getAudio();

    if (!p.music) {
        return;
    }

    if (a.paused) {

        try {

            await a.play();

            setPlayingUI(true);

        } catch (error) {

            showToast(
                "播放被浏览器拦截，请重试"
            );
        }

    } else {

        a.pause();

        setPlayingUI(false);
    }
}


async function nextTrack(auto = false) {

    const p = state.player;
    if (p.queueSource === "home") { await stepHomeMusic(1); return; }

    if (!p.queue.length) {
        return;
    }

    const max =
        p.queue.length - 1;

    if (p.index >= max) {

        if (!auto) {

            showToast("已是最后一首");
        }

        return;
    }

    p.index++;

    updateBarControls();

    const item = p.queue[p.index];
    const source = p.queueSource;
    if (item.kind === "clip") await playClip(item, { source });
    else await playMusic(item.id, { source });
}


async function prevTrack() {

    const p = state.player;
    if (p.queueSource === "home") { await stepHomeMusic(-1); return; }

    if (!p.queue.length) {
        return;
    }

    if (p.index <= 0) {

        showToast("已是第一首");

        return;
    }

    p.index--;

    updateBarControls();

    const item = p.queue[p.index];
    const source = p.queueSource;
    if (item.kind === "clip") await playClip(item, { source });
    else await playMusic(item.id, { source });
}


function clearPlayer() {
    resetLoadedPlayer();
}

function resetLoadedPlayer(preserveRequest = false) {
    if (!preserveRequest) {
        playbackRequestVersion++;
        playbackRequest = null;
        homeAuditionVersion++;
        cancelHomeAudition();
    }

    const p = state.player;

    const a = getAudio();

    a.pause();

    a.removeAttribute("src");

    a.load();

    p.playing = false;

    document.body.classList.remove("is-playing");

    p.music = null;

    if (!preserveRequest) {
        p.queue = [];
        p.index = -1;
        p.loading = false;
    }

    p.currentUrl = "";

    p.segment = null;

    hidePlayerBar();
    syncPlaybackIndicators();
}


function pausePlayerKeepPosition() {

    const p = state.player;

    if (!p.music) {
        syncPlaybackIndicators();
        return;
    }

    const a = getAudio();

    if (!a.paused) {

        a.pause();

        setPlayingUI(false);
    }
}


/* =========================================================
   队列与视图联动
========================================================= */

function syncPlayerQueue() {

    const p = state.player;

    if (!p.music) {
        syncPlaybackIndicators();
        return;
    }

    if (p.queueSource !== "view") {
        syncPlaybackIndicators();
        return;
    }

    const idx =
        visibleQueueMusic.findIndex(
            m => m.id === p.music.id
        );

    p.queue =
        visibleQueueMusic.slice();

    p.index = idx;

    p.viewKey =
        state.currentView +
        "|" +
        state.search;

    updateBarControls();
    syncPlaybackIndicators();
}


/* =========================================================
   候选暂存
========================================================= */

function initPlayer() {

    const a =
        getAudio();

    a.addEventListener(
        "loadedmetadata",
        () => {

            updateBarTime();
        }
    );

    /* 播放状态不只来自 app 内部：唱机（点唱片/落针）也会直接驱动 audio，
       UI 统一由事件同步，手动 setPlayingUI 调用保持幂等。 */
    a.addEventListener(
        "play",
        () => {
            setPlayingUI(true);
            markCurrentTrackUsed();
        }
    );

    a.addEventListener(
        "pause",
        () => setPlayingUI(false)
    );

    a.addEventListener(
        "timeupdate",
        () => {

            updateBarTime();
            if (state.currentView === "home") syncHomePlayback();

            onSegmentTimeupdate();
        }
    );

    a.addEventListener(
        "ended",
        () => {

            nextTrack(true);
        }
    );

    a.addEventListener(
        "error",
        () => {

            const p = state.player;

            if (p.music) {

                const broken = p.music;

                p.currentUrl = "";

                skipBroken(broken);
            }
        }
    );

    $("playerPlayBtn").addEventListener(
        "click",
        togglePlay
    );

    $("playerNextBtn").addEventListener(
        "click",
        () => nextTrack(false)
    );

    $("playerPrevBtn").addEventListener(
        "click",
        prevTrack
    );

    $("playerCloseBtn").addEventListener(
        "click",
        clearPlayer
    );

    $("playerTitle").addEventListener(
        "click",
        () => {

            const p = state.player;

            if (p.music) {

                openDetail(
                    p.music.id
                );
            }
        }
    );

    $("playerAddCandidateBtn").addEventListener(
        "click",
        async () => {

            const p = state.player;

            if (p.segment?.clipId) {
                await toggleClipCandidate(p.segment.clipId);
            } else if (p.music) {
                await addCandidate(p.music);
            }
        }
    );

    $("playerCandidatesBtn").addEventListener(
        "click",
        () => {

            if (
                $("candidatePanel").classList
                    .contains("hidden")
            ) {

                openCandidatePanel();

            } else {

                closeCandidatePanel();
            }
        }
    );

    $("openCandidatePanelBtn").addEventListener(
        "click",
        () => {
            if ($("candidatePanel").classList.contains("hidden")) {
                openCandidatePanel();
            } else {
                closeCandidatePanel();
            }
        }
    );

    $("closeCandidatePanel").addEventListener(
        "click",
        closeCandidatePanel
    );

    $("clearCandidatesBtn").addEventListener(
        "click",
        clearCandidates
    );
}


/* =========================================================
   重新授权 / 重新选择文件
========================================================= */

async function reauthorizeFile(music) {
    const viewVersion = detailRequestVersion;

    try {

        const selected =
            await __TAURI__.dialog.open({
                multiple: false,
                filters: [
                    {
                        name: "音频文件",
                        extensions: [
                            "mp3",
                            "wav",
                            "flac",
                            "m4a",
                            "aac",
                            "ogg",
                            "opus"
                        ]
                    }
                ]
            });

        if (!selected) {

            return;
        }


        const saved = await saveDetailEdit(async (current, request) => {
            const info = await request("probe_file", { path: String(selected) });
            if (!info.exists) throw new Error("选中的文件不存在");
            const patch = { path: info.path, fileName: info.fileName, name: info.name,
                fileSize: info.fileSize, mimeType: info.mimeType };
            try { patch.duration = await getAudioDuration(info.path); }
            catch (error) { console.log(error); }
            return patch;
        }, music.id, viewVersion, ["name", "path", "duration", "fileSize", "mimeType"]);
        if (!saved || applicationUpdateInProgress) return;

        showToast("原文件已经重新绑定");

    } catch (error) {

        console.error(error);
    }
}


/* =========================================================
   导入弹窗
========================================================= */
