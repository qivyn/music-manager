/* Home selection and audition lifecycle. Shared application state lives in app.js. */

function goToViewFromHome(view, options = {}) {
    state.search = "";
    $("searchInput").value = "";
    state.activeTagIds = [];
    renderFilterPanel();
    renderSidebarTags();
    return navigateToView(view, options);
}

let viewNavigationVersion = 0;

async function navigateToView(view, { focusSearch = false } = {}) {
    if (!view) return;
    const version = ++viewNavigationVersion;
    const previousFocus = document.activeElement;
    document.querySelectorAll(".nav-item").forEach(button => {
        button.classList.toggle("active", button.dataset.view === view);
    });
    state.currentView = view;
    state.catalogSelection = null;
    resetPagination();
    closeMusicContextPanels();

    // render reveals the workspace synchronously; let search accept typing
    // immediately, without a late heading focus after data/artwork loads.
    const rendering = render();
    if (focusSearch) $("searchInput").focus();
    await rendering;
    if (focusSearch || version !== viewNavigationVersion || state.currentView !== view
        || document.activeElement !== previousFocus) return;
    const heading = view === "home" ? $("homeTrackTitle") : $("pageTitle");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
}

let homeTracks = [];
let homeSelectedId = null;
let homeAuditionVersion = 0;
let homeAuditionPending = null;
let homeAuditionPhase = "";
let homeLoadQueue = Promise.resolve();

function homeSelectedTrack() {
    return homeTracks.find(item => item.id === (homeAuditionPending || state.player.music?.id || homeSelectedId)) || state.player.music || homeTracks[0];
}

function syncHomeTracks(music) {
    homeTracks = [...music].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const p = state.player;
    if (p.queueSource === "home") {
        p.queue = homeTracks.slice();
        p.index = homeTracks.findIndex(item => item.id === p.music?.id);
        updateBarControls();
    }
}

function renderHome(music, clips) {
    syncHomeTracks(music);
    const empty = !homeTracks.length;
    const selected = homeSelectedTrack();
    homeSelectedId = selected?.id || null;
    visibleQueueMusic = [];
    visibleClipIds = [];
    renderSelectionToolbar();
    $("resultInfo").textContent = "";

    $("contentArea").innerHTML = `
        <section class="home-page home-scene" id="homeScene" aria-label="猫咪的音乐角落">
            <div class="scene-artboard">
                <img class="scene-artwork" alt="" draggable="false">
                <div class="scene-targets" aria-label="场景入口"></div>
            </div>
            <div class="home-now-playing">
                <div class="home-track-info">
                    <p class="scene-eyebrow">在这里，慢慢听。</p>
                    <h1 id="homeTrackTitle" tabindex="-1">${escapeHTML(selected?.name || "留一点时间给音乐")}</h1>
                    <p id="homeTrackMeta" class="home-track-meta">${escapeHTML(selected?.artist || selected?.album || "导入喜欢的音乐，让这个角落陪你一会儿。")}</p>
                </div>
                ${empty ? `<button class="primary-btn home-import-btn" type="button" data-home-action="import">导入第一首音乐 <span aria-hidden="true">↗</span></button>` : `
                <div class="home-transport" aria-label="播放控制">
                    <button id="homePrevBtn" class="home-transport-btn" type="button" aria-label="上一首"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5 9 12l10 7Z"/></svg></button>
                    <button id="homePlayBtn" class="home-play-btn" type="button" aria-label="开始播放" aria-pressed="false"><span aria-hidden="true">▶</span></button>
                    <button id="homeNextBtn" class="home-transport-btn" type="button" aria-label="下一首"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l10 7-10 7Z"/></svg></button>
                </div>
                <div class="home-timeline">
                    <input id="homeSeek" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度" disabled>
                    <div class="home-timeline-meta"><span id="homePlaybackStatus" role="status"></span><span id="homeTrackTime" class="home-track-time"></span></div>
                </div>`}
            </div>
            <div class="scene-discovery">
                <button class="scene-discover-btn" type="button"><span aria-hidden="true">✧</span> 靠近物件，发现入口</button>
                <button class="scene-dismiss-btn" type="button" aria-label="不再显示入口提示">×</button>
            </div>
        </section>`;

    scrollMainContentToTop();
    window.HomeScene.mount($("homeScene"), {
        navigate(destination) {
            if (destination === "recent") state.recentMode = "used";
            goToViewFromHome({ library: "all", recent: "recent", clips: "clips" }[destination]);
        }
    });
    $("contentArea").querySelector('[data-home-action="import"]')?.addEventListener("click", () => $("importBtn").click());
    $("homePlayBtn")?.addEventListener("click", () => void auditionHomeMusic().catch(console.error));
    $("homePrevBtn")?.addEventListener("click", () => void stepHomeMusic(-1).catch(console.error));
    $("homeNextBtn")?.addEventListener("click", () => void stepHomeMusic(1).catch(console.error));
    $("homeSeek")?.addEventListener("input", event => {
        const audio = getAudio();
        if (state.player.music?.id === homeSelectedTrack()?.id && Number.isFinite(audio.duration)) {
            audio.currentTime = Number(event.target.value) / 1000 * audio.duration;
            syncHomePlayback();
        }
    });
    syncHomePlayback();
}

function cancelHomeAudition() {
    if (!homeAuditionPending) return;
    homeAuditionVersion++;
    playbackRequestVersion++;
    playbackRequest = null;
    homeAuditionPending = null;
    homeAuditionPhase = "";
    getAudio().pause();
    state.player.loading = false;
    window.Turntable?.cancelMotion();
    syncHomePlayback();
}

async function auditionHomeMusic(item = homeSelectedTrack(), options = {}) {
    if (!item) {
        $("importBtn").click();
        return;
    }
    if (homeAuditionPending === item.id) {
        cancelHomeAudition();
        return;
    }
    if (!homeAuditionPending && state.player.music?.id === item.id && !state.player.segment && state.player.currentUrl === convertFileSrc(item.path)) {
        if (!getAudio().paused) {
            getAudio().pause();
        } else {
            await swapToMusic(item, { ...options, resume: true });
        }
        return;
    }
    await swapToMusic(item, options);
}

async function refreshHomeQueue(selected = homeSelectedTrack()) {
    const version = homeAuditionVersion;
    const page = await invoke("query_library_page", { query: { kind: "music", newest: true,
        page: Math.floor((selected?.libraryPosition || 0) / 10) + 1, pageSize: 10 } });
    if (version !== homeAuditionVersion) return;
    syncHomeTracks(page.items);
}
async function stepHomeMusic(direction) {
    const version = homeAuditionVersion;
    const loadedTrack = state.player.music;
    const selected = homeSelectedTrack();
    if (!selected) return;
    const next = await invoke("query_music_neighbor", { query: { kind: "music", newest: true }, id: selected.id, direction });
    if (version !== homeAuditionVersion || loadedTrack !== state.player.music) return;
    await refreshHomeQueue(next || selected);
    if (version !== homeAuditionVersion || loadedTrack !== state.player.music) return;
    if (!next) { showToast(direction < 0 ? "已是第一首" : "已是最后一首"); return; }
    await swapToMusic(next);
}

function setupHomeRecent(area, music) {
    const cards = [...area.querySelectorAll(".home-recent-item")];
    cards.forEach(card => {
        const item = music.find(track => track.id === card.dataset.musicId);
        card.addEventListener("click", () => {
            void auditionHomeMusic(item, { fromEl: card.querySelector(".home-recent-cover") }).catch(console.error);
        });
    });

    const renderCovers = () => {
        cards.forEach(card => {
            const item = music.find(track => track.id === card.dataset.musicId);
            const cover = item.coverArt || coverArtCache.get(item.id);
            const sleeve = card.querySelector(".home-recent-cover");
            if (!cover || sleeve.querySelector("img")) return;
            const image = document.createElement("img");
            image.alt = "";
            image.addEventListener("load", () => sleeve.classList.add("has-artwork"));
            image.addEventListener("error", () => image.remove());
            image.src = cover;
            sleeve.prepend(image);
        });
    };
    renderCovers();
    syncHomePlayback();

    const missing = music.filter(item => !item.coverArt && !coverArtCache.has(item.id)).map(item => item.id);
    if (missing.length) {
        invoke("get_music_cover_arts", { ids: missing }).then(covers => {
            covers.forEach(({ id, coverArt }) => {
                if (coverArt) coverArtCache.set(id, coverArt);
            });
            renderCovers();
            const selected = homeSelectedTrack();
            if (state.currentView === "home" && selected && !homeAuditionPending) {
                window.Turntable?.setTrack({ coverArt: selected.coverArt || coverArtCache.get(selected.id) || "" });
            }
        }).catch(() => {});
    }
}

function syncHomePlayback() {
    const player = state.player;
    const selected = homeSelectedTrack();
    const playing = !homeAuditionPending && !player.segment && player.music?.id === selected?.id && player.playing;
    const playingClip = !homeAuditionPending && player.segment && player.music?.id === selected?.id && player.playing;
    document.querySelectorAll(".home-recent-item").forEach(card => {
        const current = card.dataset.musicId === selected?.id;
        const active = current && playing;
        card.classList.toggle("is-selected", current);
        card.classList.toggle("is-playing", !!active);
        card.setAttribute("aria-pressed", String(!!active));
        card.setAttribute("aria-current", String(current));
        const name = card.querySelector(".home-recent-name").textContent;
        card.setAttribute("aria-label", `${current && homeAuditionPending ? "取消试听" : active ? "暂停" : "试听"} ${name}`);
        card.querySelector(".home-cover-play").textContent = current && homeAuditionPending ? "■" : active ? "Ⅱ" : "▶";
    });
    if (!$("homeTrackTitle")) return;
    $("homeTrackTitle").textContent = selected?.name || "留一点时间给音乐";
    $("homeTrackTitle").title = selected?.name || "";
    $("homeTrackMeta").textContent = selected ? [selected.artist, selected.album].filter(Boolean).join(" · ") || "本地音乐" : "导入喜欢的音乐，让这个角落陪你一会儿。";
    if ($("homePlaybackStatus")) $("homePlaybackStatus").textContent = homeAuditionPending ? homeAuditionPhase : playingClip ? "片段播放中" : playing ? "正在播放" : "随时开始";
    const button = $("homePlayBtn");
    if (button) {
        button.setAttribute("aria-label", homeAuditionPending ? "取消试听" : playingClip ? "试听整曲" : playing ? "暂停试听" : "开始试听");
        button.setAttribute("aria-pressed", String(!!playing));
        button.querySelector("span").textContent = homeAuditionPending ? "■" : playing ? "Ⅱ" : "▶";
        const index = homeTracks.findIndex(item => item.id === selected?.id);
        $("homePrevBtn").disabled = selected?.libraryPosition != null ? selected.libraryPosition <= 0 : index <= 0;
        $("homeNextBtn").disabled = selected?.libraryTotal != null ? selected.libraryPosition >= selected.libraryTotal - 1 : index < 0 || index >= homeTracks.length - 1;
        const current = player.music?.id === selected?.id ? getAudio().currentTime : 0;
        const duration = Number.isFinite(getAudio().duration) && player.music?.id === selected?.id ? getAudio().duration : selected?.duration || 0;
        $("homeTrackTime").textContent = `${formatTime(current || 0)} / ${formatTime(duration)}`;
        const seek = $("homeSeek");
        if (seek) {
            seek.disabled = !!homeAuditionPending || player.music?.id !== selected?.id || !Number.isFinite(getAudio().duration) || !getAudio().duration;
            seek.value = duration ? Math.round((current || 0) / duration * 1000) : 0;
            seek.style.setProperty("--progress", seek.value / 10 + "%");
            seek.setAttribute("aria-valuetext", `${formatTime(current || 0)}，共 ${formatTime(duration)}`);
        }
    }
}

/* 唱片从最近添加飞到唱机转盘的 DOM 动画：
   克隆一张唱片掠过屏幕，落点由唱机投影给出，到位时正好
   碰上唱机换片动画里新片落下，看起来像真的装上了机。 */
function flyRecordToStage(fromEl, coverArt) {
    if (!fromEl || !window.Turntable?.platterScreenPoint) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = window.Turntable.platterScreenPoint();
    if (!target) return;

    const from = fromEl.getBoundingClientRect();
    if (!from.width || !from.height) return;
    const size = Math.min(from.width, from.height);

    const disc = document.createElement("div");
    disc.className = "vinyl-fly";
    if (coverArt) disc.style.setProperty("--fly-cover", `url("${coverArt}")`);
    disc.style.left = `${from.left + (from.width - size) / 2}px`;
    disc.style.top = `${from.top + (from.height - size) / 2}px`;
    disc.style.width = disc.style.height = `${size}px`;
    document.body.appendChild(disc);

    const dx = target.x - (from.left + from.width / 2);
    const dy = target.y - (from.top + from.height / 2);
    requestAnimationFrame(() => {
        disc.style.transform = `translate(${dx}px, ${dy}px) rotate(320deg) scale(0.45)`;
        disc.style.opacity = "0.2";
    });
    disc.addEventListener("transitionend", () => disc.remove(), { once: true });
    setTimeout(() => disc.remove(), 1400); // 兜底：过渡被打断也别留残影
}

/* 音频装载按顺序执行，只有最后一次选择可以落针出声。 */
async function swapToMusic(music, { fromEl, resume = false } = {}) {
    const playbackVersion = ++playbackRequestVersion;
    trackPlaybackRequest(playbackVersion, music.id);
    const version = ++homeAuditionVersion;
    homeSelectedId = music.id;
    homeAuditionPending = music.id;
    homeAuditionPhase = "正在加载…";
    getAudio().pause();
    window.Turntable?.cancelMotion({ preservePose: true });
    syncHomePlayback();

    const previous = homeLoadQueue;
    let release;
    homeLoadQueue = new Promise(resolve => { release = resolve; });
    const current = () => version === homeAuditionVersion && playbackVersion === playbackRequestVersion;
    const finish = () => {
        if (!current()) return;
        if (getAudio().paused) window.Turntable?.cancelMotion();
        homeAuditionPending = null;
        homeAuditionPhase = "";
        syncHomePlayback();
    };
    const start = async () => {
        if (!current()) return;
        try { await getAudio().play(); }
        catch (_) {
            if (current()) {
                window.Turntable?.cancelMotion();
                showToast("暂时无法播放，请重试试听");
            }
        }
        finally { finish(); }
    };
    try {
        await previous;
        if (!current()) return;
        if (!resume && !await playMusic(music.id, { deferPlay: true, auditionVersion: version, playbackVersion })) {
            finish();
            return;
        }
        if (!current()) return;
        const track = state.player.music;
        if (!track || track.id !== music.id) { finish(); return; }
        track.libraryPosition = music.libraryPosition;
        track.libraryTotal = music.libraryTotal;
        state.player.queue = homeTracks.slice();
        state.player.queueSource = "home";
        state.player.index = homeTracks.findIndex(item => item.id === track.id);
        updateBarControls();
        // The illustrated scene needs no cover fetch or turntable animation before audio starts.
        if (!window.Turntable) {
            void start();
            return;
        }
        let cover = track.coverArt || coverArtCache.get(track.id) || "";
        if (!cover && !coverArtCache.has(track.id)) {
            const covers = await invoke("get_music_cover_arts", { ids: [track.id] }).catch(() => []);
            cover = covers?.[0]?.coverArt || "";
            coverArtCache.set(track.id, cover);
        }
        if (!current()) return;
        const program = { coverArt: cover, grooveUrl: convertFileSrc(track.path), title: track.name, artist: track.artist || track.album || "" };
        if (!window.Turntable || state.currentView !== "home") {
            window.Turntable?.setTrack(program);
            void start();
            return;
        }
        const drop = () => {
            if (!current()) return;
            homeAuditionPhase = "正在落针…";
            syncHomePlayback();
            window.Turntable.dropNeedle(() => void start());
        };
        if (resume) drop();
        else {
            if (fromEl) flyRecordToStage(fromEl, cover);
            window.Turntable.swapRecord(program, drop, { keepRecord: !!fromEl });
        }
    } catch (error) {
        if (current()) showToast("无法加载音乐，请检查文件或硬盘连接");
        finish();
        throw error;
    } finally {
        release();
    }
}

/* End home playback */
