const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = require('./app-source.cjs').readAppSource();
const turntableSource = fs.readFileSync(path.join(__dirname, "../frontend/turntable.js"), "utf8");
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const auditionSource = [
    section(appSource, "let playbackRequestVersion =", "async function loadAndPlay("),
    section(appSource, "let homeTracks =", "function setupHomeRecent("),
    section(appSource, "async function swapToMusic(", "/* End home playback */"),
    section(appSource, "async function loadAndPlay(", "function onSegmentTimeupdate("),
    section(appSource, "async function playMusic(", "async function playClip("),
    section(appSource, "async function togglePlay()", "function clearPlayer()"),
    section(appSource, "function clearPlayer()", "function pausePlayerKeepPosition("),
].join("\n");

const tracks = [1, 2, 3].map(id => ({ id: `m${id}`, name: `Track ${id}`, path: `/music/${id}.wav`, duration: 180 }));
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function audition({ onInvoke = () => {}, failPlay = false } = {}) {
    const library = tracks.slice();
    const transitions = [], needles = [], played = [], messages = [], reads = [];
    const player = { music: null, currentUrl: "", playing: false, loading: false, queue: [], candidates: [], index: -1, segment: null };
    const audio = {
        src: "", paused: true, currentTime: 0,
        pause() { this.paused = true; player.playing = false; },
        async play() { if (failPlay) throw new Error("decode failed"); this.paused = false; player.playing = true; played.push(this.src); },
        removeAttribute() { this.src = ""; }, load() {}, addEventListener() {},
    };
    let cancels = 0;
    const bodyClasses = new Set();
    const classList = {
        contains: name => bodyClasses.has(name),
        remove: name => bodyClasses.delete(name),
        toggle(name, enabled) { if (enabled) bodyClasses.add(name); else bodyClasses.delete(name); },
    };
    const context = {
        console, libraryRenderVersion: 0, libraryFilters: () => ({}), acceptLibraryPage: page => page,
        state: { currentView: "home", player },
        document: { body: { classList } },
        window: { Turntable: {
            cancelMotion() { cancels++; },
            swapRecord(track, callback) { transitions.push({ track, callback }); },
            dropNeedle(callback) { needles.push(callback); }, setTrack() {},
        } },
        $: () => null, getAudio: () => audio, convertFileSrc: value => value,
        coverArtCache: new Map(), visibleQueueMusic: [], syncHomePlayback() {}, updateBarControls() {}, renderBarMeta() {}, showPlayerBar() {}, hidePlayerBar() {}, syncPlaybackIndicators() {},
        setPlayingUI(value) { player.playing = value; },
        flyRecordToStage() {}, skipBroken() { throw new Error("Explicit audition must not skip to another track"); },
        showToast: value => messages.push(value),
        dbGet: async (_store, id) => { reads.push(id); return library.find(item => item.id === id); },
        invoke: async (command, args) => {
            const result = await onInvoke(command, args);
            if (command === "query_library_page" && result === undefined) return { items: library.slice(), total: library.length, page: 1, pageSize: 10, totalPages: 1 };
            if (command === "query_music_neighbor" && result === undefined) return library[library.findIndex(m=>m.id===args.id)+args.direction] || null;
            return result ?? (command === "file_exists" ? true : null);
        },
    };
    context.requestLibraryPage = query => context.invoke("query_library_page", { query });
    vm.createContext(context);
    vm.runInContext(auditionSource, context);
    context.tracks = tracks;
    vm.runInContext("homeTracks = tracks.slice();", context);
    return { context, player, audio, transitions, needles, played, messages, reads, library, cancels: () => cancels,
        pending: () => vm.runInContext("homeAuditionPending", context),
        finish(index = transitions.length - 1) { transitions[index].callback(); needles.at(-1)?.(); },
    };
}

test("cancelling a slow switch preserves the loaded track, position and queue for workspace resume", async () => {
    const started = deferred(), release = deferred();
    const app = audition({ onInvoke: (command, args) => {
        if (command === "file_exists" && args.path === tracks[1].path) {
            started.resolve();
            return release.promise;
        }
    } });
    delete app.context.window.Turntable;
    await app.context.swapToMusic(tracks[0]);
    app.audio.currentTime = 47;
    const loading = app.context.swapToMusic(tracks[1]);
    await started.promise;
    app.context.cancelHomeAudition();
    release.resolve(true);
    await loading;
    app.context.state.currentView = "all";
    await app.context.togglePlay();
    assert.equal(app.player.music.id, tracks[0].id);
    assert.equal(app.player.currentUrl, app.audio.src);
    assert.equal(app.audio.src, tracks[0].path);
    assert.equal(app.audio.currentTime, 47);
    assert.equal(app.player.queueSource, "home");
    assert.equal(app.player.queue.length, 3);
    assert.equal(app.player.index, 0);
    assert.equal(app.audio.paused, false);
});

test("a missing next file preserves the prior track and queue without mismatching its audio", async () => {
    const app = audition({ onInvoke: (command, args) =>
        command === "file_exists" && args.path === tracks[1].path ? false : undefined
    });
    delete app.context.window.Turntable;
    await app.context.swapToMusic(tracks[0]);
    await app.context.stepHomeMusic(1);
    assert.equal(app.player.music.id, tracks[0].id);
    assert.equal(app.player.currentUrl, app.audio.src);
    assert.equal(app.audio.src, tracks[0].path);
    assert.equal(app.player.queueSource, "home");
    assert.equal(app.player.index, 0);
    assert.equal(app.pending(), null);
});

for (const direction of [1, -1]) {
    test(`home queue skips deleted records when stepping ${direction} from the workspace`, async () => {
        const app = audition();
        delete app.context.window.Turntable;
        await app.context.swapToMusic(tracks[direction === 1 ? 0 : 2]);
        app.context.state.currentView = "all";
        app.library.splice(1, 1);
        if (direction === 1) await app.context.nextTrack();
        else await app.context.prevTrack();
        assert.equal(app.player.music.id, tracks[direction === 1 ? 2 : 0].id);
        assert.equal(app.audio.paused, false);
        assert.deepEqual(Array.from(app.player.queue, item => item.id), ["m1", "m3"]);
    });
}

test("deleting the last upcoming record leaves current playback running at the queue boundary", async () => {
    const app = audition();
    delete app.context.window.Turntable;
    await app.context.swapToMusic(tracks[0]);
    app.context.state.currentView = "all";
    app.library.splice(1);
    await app.context.nextTrack();
    assert.equal(app.player.music.id, "m1");
    assert.equal(app.audio.paused, false);
    assert.equal(app.player.queue.length, 1);
});

test("a workspace render refreshes the home queue after a library deletion", async () => {
    const app = audition();
    delete app.context.window.Turntable;
    await app.context.swapToMusic(tracks[0]);
    await new Promise(setImmediate);
    app.context.state.currentView = "clips";
    app.library.splice(1, 1);
    app.context.document.body.classList.toggle = () => {};
    app.context.updatePageHeader = () => {};
    app.context.renderClipLibrary = () => {};
    vm.runInContext(section(appSource, "async function render()", "/* End library render */"), app.context);
    await app.context.render();
    assert.deepEqual(Array.from(app.player.queue, item => item.id), ["m1", "m3"]);
    assert.equal(app.player.index, 0);
    assert.equal(app.audio.paused, false);
});

function enableWorkspaceRender(app) {
    app.context.updatePageHeader = () => {};
    app.context.renderClipLibrary = () => {};
    vm.runInContext(section(appSource, "async function render()", "/* End library render */"), app.context);
    app.context.state.currentView = "clips";
}

for (const direction of [1, -1]) {
    test(`workspace refresh preserves a pending home queue step ${direction}`, async () => {
        const started = deferred(), release = deferred();
        const app = audition({ onInvoke: (command, args) => {
            if (command === "file_exists" && args.path === tracks[1].path) {
                started.resolve(); return release.promise;
            }
        } });
        delete app.context.window.Turntable;
        await app.context.swapToMusic(tracks[direction === 1 ? 0 : 2]);
        enableWorkspaceRender(app);
        const stepping = direction === 1 ? app.context.nextTrack() : app.context.prevTrack();
        await started.promise;
        await app.context.render();
        assert.equal(app.pending(), "m2");
        release.resolve(true);
        await stepping;
        await new Promise(setImmediate);
        assert.equal(app.player.music.id, "m2");
        assert.equal(app.audio.paused, false);
        assert.equal(app.pending(), null);
    });
}

test("workspace refresh while audio play is pending does not pause the new track", async () => {
    const app = audition();
    delete app.context.window.Turntable;
    await app.context.swapToMusic(tracks[0]);
    enableWorkspaceRender(app);
    const playing = deferred();
    const play = app.audio.play.bind(app.audio);
    app.audio.play = async () => { await play(); await playing.promise; };
    await app.context.nextTrack();
    assert.equal(app.pending(), "m2");
    await app.context.render();
    assert.equal(app.audio.paused, false);
    assert.equal(app.pending(), "m2");
    playing.resolve();
    await new Promise(setImmediate);
    assert.equal(app.pending(), null);
    assert.equal(app.audio.paused, false);
});

test("actually leaving home still cancels a pending audition", async () => {
    const started = deferred(), release = deferred();
    const app = audition({ onInvoke: command => {
        if (command === "file_exists") { started.resolve(); return release.promise; }
    } });
    delete app.context.window.Turntable;
    app.context.document.body.classList.toggle("view-home", true);
    const loading = app.context.swapToMusic(tracks[0]);
    await started.promise;
    enableWorkspaceRender(app);
    await app.context.render();
    assert.equal(app.pending(), null);
    release.resolve(true);
    await loading;
    assert.equal(app.player.music, null);
    assert.equal(app.played.length, 0);
});

test("closing the player during a queue refresh cannot restart playback", async () => {
    const app = audition();
    delete app.context.window.Turntable;
    await app.context.swapToMusic(tracks[0]);
    const read = deferred();
    const invoke = app.context.invoke;
    app.context.invoke = (command,args) => command === "query_music_neighbor" ? read.promise : invoke(command,args);
    const next = app.context.nextTrack();
    app.context.clearPlayer();
    read.resolve(app.library[1]);
    await next;
    assert.equal(app.player.music, null);
    assert.equal(app.audio.src, "");
    assert.equal(app.played.length, 1);
});

test("a newer selection replaces a slow load and only that selection reaches the stylus", async () => {
    const started = deferred(), release = deferred();
    const app = audition({ onInvoke: async (command, args) => {
        if (command === "file_exists" && args.path === tracks[0].path) { started.resolve(); return release.promise; }
    } });
    const first = app.context.swapToMusic(tracks[0]);
    await started.promise;
    const second = app.context.swapToMusic(tracks[1]);
    release.resolve(true);
    await Promise.all([first, second]);
    assert.deepEqual(app.transitions.map(item => item.track.title), ["Track 2"]);
    assert.equal(app.played.length, 0, "Loading must stay silent until the stylus has landed");
    app.finish();
    await Promise.resolve();
    assert.deepEqual(app.played, [tracks[1].path]);
    assert.equal(app.player.queueSource, "home");
    assert.equal(app.player.index, 1);
});

test("a stale animation callback cannot play after another record is selected", async () => {
    const app = audition();
    await app.context.swapToMusic(tracks[0]);
    const old = app.transitions[0].callback;
    await app.context.swapToMusic(tracks[2]);
    old();
    assert.equal(app.needles.length, 0);
    app.finish();
    await Promise.resolve();
    assert.deepEqual(app.played, [tracks[2].path]);
});

test("cancelling during stylus movement prevents sound and clears the pending state", async () => {
    const app = audition();
    await app.context.swapToMusic(tracks[0]);
    app.transitions[0].callback();
    const old = app.needles[0];
    app.context.cancelHomeAudition();
    old();
    await Promise.resolve();
    assert.equal(app.played.length, 0);
    assert.equal(app.pending(), null);
    assert.equal(app.audio.paused, true);
});

test("closing the player during a file check does not resurrect the track or assign a source", async () => {
    const started = deferred(), release = deferred();
    const app = audition({ onInvoke: async command => {
        if (command === "file_exists") { started.resolve(); return release.promise; }
    } });
    const loading = app.context.swapToMusic(tracks[0]);
    await started.promise;
    app.context.clearPlayer();
    release.resolve(true);
    await loading;
    assert.equal(app.player.music, null);
    assert.equal(app.audio.src, "");
    assert.equal(app.player.loading, false);
    assert.equal(app.transitions.length, 0);
});

test("resuming the same record preserves position and does not load or swap again", async () => {
    const app = audition();
    Object.assign(app.player, { music: tracks[0], currentUrl: tracks[0].path });
    app.audio.src = tracks[0].path;
    app.audio.currentTime = 47;
    await app.context.auditionHomeMusic(tracks[0]);
    assert.equal(app.reads.length, 0);
    assert.equal(app.transitions.length, 0);
    app.needles[0]();
    await Promise.resolve();
    assert.equal(app.audio.currentTime, 47);
    assert.deepEqual(app.played, [tracks[0].path]);
});

test("a missing file stays silent, does not stage a record, and can be retried", async () => {
    const app = audition({ onInvoke: command => command === "file_exists" ? false : undefined });
    await app.context.swapToMusic(tracks[0]);
    assert.equal(app.transitions.length, 0);
    assert.equal(app.audio.src, "");
    assert.equal(app.pending(), null);
    assert.match(app.messages[0], /文件不存在/);
    const reads = app.reads.length;
    await app.context.auditionHomeMusic(tracks[0]);
    assert.ok(app.reads.length > reads, "An unplayable prior selection must be loaded again, not resumed");
});

test("play rejection restores a stopped stylus and releases the audition controls", async () => {
    const app = audition({ failPlay: true });
    await app.context.swapToMusic(tracks[0]);
    const before = app.cancels();
    app.finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(app.cancels() > before);
    assert.equal(app.pending(), null);
    assert.match(app.messages[0], /无法播放/);
});

test("a failed library read releases the load queue so the next audition can proceed", async () => {
    let fail = true;
    const app = audition({ onInvoke: command => {
        if (command === "sync_library_locations" && fail) { fail = false; throw new Error("drive unavailable"); }
    } });
    await assert.rejects(app.context.swapToMusic(tracks[0]), /drive unavailable/);
    assert.equal(app.pending(), null);
    assert.match(app.messages[0], /硬盘连接/);
    await app.context.swapToMusic(tracks[1]);
    assert.equal(app.transitions.at(-1).track.title, "Track 2");
});

test("previous and next audition stay inside the home collection boundaries", async () => {
    const app = audition();
    await app.context.swapToMusic(tracks[0]);
    await app.context.stepHomeMusic(-1);
    assert.equal(app.transitions.length, 1);
    await app.context.stepHomeMusic(1);
    assert.equal(app.transitions.at(-1).track.title, "Track 2");
    await app.context.stepHomeMusic(1);
    assert.equal(app.transitions.at(-1).track.title, "Track 3");
    await app.context.stepHomeMusic(1);
    assert.equal(app.transitions.length, 3);
});

test("the illustrated home plays without loading artwork or waiting for a turntable", async () => {
    const commands = [];
    const app = audition({ onInvoke: command => { commands.push(command); } });
    delete app.context.window.Turntable;
    await app.context.swapToMusic(tracks[0]);
    await Promise.resolve();
    assert.deepEqual(app.played, [tracks[0].path]);
    assert.equal(app.pending(), null);
    assert.equal(commands.includes("get_music_cover_arts"), false);
    const readsAfterStart = app.reads.length;
    app.audio.currentTime = 47;
    await app.context.auditionHomeMusic(tracks[0]);
    assert.equal(app.audio.paused, true);
    await app.context.auditionHomeMusic(tracks[0]);
    assert.equal(app.audio.currentTime, 47);
    assert.equal(app.reads.length, readsAfterStart);
    assert.deepEqual(app.played, [tracks[0].path, tracks[0].path]);
});

test("a newer selection wins a slow file check on the illustrated home", async () => {
    const started = deferred(), release = deferred();
    const app = audition({ onInvoke: async (command, args) => {
        if (command === "file_exists" && args.path === tracks[0].path) {
            started.resolve();
            return release.promise;
        }
    } });
    delete app.context.window.Turntable;
    const first = app.context.swapToMusic(tracks[0]);
    await started.promise;
    const second = app.context.swapToMusic(tracks[1]);
    release.resolve(true);
    await Promise.all([first, second]);
    assert.deepEqual(app.played, [tracks[1].path]);
    assert.equal(app.player.index, 1);
});

test("cancelMotion cancels physical timers; reduced motion lands the stylus immediately", () => {
    const timers = new Map();
    let id = 0, callbacks = 0;
    const state = { cur: {}, motionTimers: new Set(), busy: false, awake: true, armPark: -1.59 };
    const context = {
        S: state, FULL_SPEED: 3.49, reducedMotion: { matches: false },
        isPlaying: () => false, playProgress: () => .2, grooveAngle: value => -2.13 - value,
        ledOn() {}, ledOff() {}, frame() {},
        setTimeout: callback => { timers.set(++id, callback); return id; },
        clearTimeout: timer => timers.delete(timer),
    };
    context.requestLibraryPage = query => context.invoke("query_library_page", { query });
    vm.createContext(context);
    vm.runInContext(section(turntableSource, "    function motionAfter(", "    /* 没装片时"), context);
    context.needleDropSequence(state, () => callbacks++);
    assert.equal(timers.size, 3);
    context.cancelMotion();
    for (const callback of timers.values()) callback();
    assert.equal(callbacks, 0);
    assert.equal(state.busy, false);
    assert.equal(state.needle, "parked");
    context.reducedMotion.matches = true;
    context.needleDropSequence(state, () => callbacks++);
    assert.equal(callbacks, 1);
    assert.equal(timers.size, 0);
    assert.equal(state.needle, "down");
});

test("late artwork and waveform responses cannot overwrite the selected record", async () => {
    const images = [], peaks = { a: deferred(), b: deferred() };
    const state = { coverImg: null, peaks: null };
    const context = {
        S: state, trackRevision: 0, coverRevision: 0, lastTrackInfo: {}, pendingTrack: null,
        FAKE_PEAKS: [], reducedMotion: { matches: false },
        window: { Waveform: { getPeaks: url => peaks[url].promise } },
        Image: class { constructor() { images.push(this); } },
        miniSetCover() {}, drawRecord() {}, frame() {},
    };
    context.requestLibraryPage = query => context.invoke("query_library_page", { query });
    vm.createContext(context);
    vm.runInContext(section(turntableSource, "    function setTrack(", "    function applyTheme("), context);
    context.setTrack({ title: "A", coverArt: "a", grooveUrl: "a" });
    context.setTrack({ title: "B", coverArt: "b", grooveUrl: "b" });
    images[1].onload();
    images[0].onload();
    peaks.b.resolve([2]);
    peaks.a.resolve([1]);
    await Promise.resolve();
    assert.equal(state.coverImg.src, "b");
    assert.deepEqual(state.peaks, [2]);
    context.setTrack({ title: "No artwork", coverArt: "" });
    assert.equal(state.coverImg, null);
});

test("the redesigned turntable fills the stage while its visible surfaces stay inside the frame", () => {
    const THREE = require("../frontend/vendor/three.min.js");
    const drawingContext = new Proxy({}, { get: (_target, key) => {
        if (key === "createLinearGradient" || key === "createRadialGradient") return () => ({ addColorStop() {} });
        if (key === "measureText") return () => ({ width: 100 });
        return () => {};
    } });
    const canvas = () => ({ width: 0, height: 0, style: {}, getContext: () => drawingContext, addEventListener() {} });
    class Renderer {
        constructor() { this.domElement = canvas(); this.capabilities = { getMaxAnisotropy: () => 4 }; this.shadowMap = {}; this.ratio = 1; }
        setPixelRatio(value) { this.ratio = value; }
        setClearColor() {}
        setSize(width, height) { this.domElement.width = width * this.ratio; this.domElement.height = height * this.ratio; }
        render(scene, camera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); }
    }
    const graphics = { ...THREE, WebGLRenderer: Renderer, PMREMGenerator: class {
        fromEquirectangular() { return { texture: new THREE.Texture() }; } dispose() {}
    } };
    for (const theme of ["archive", "sky"]) {
        let nextFrame;
        const context = {
            THREE: graphics, console, Image: class {},
            window: { THREE: graphics, devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {} }) },
            document: { body: { dataset: { theme } }, getElementById: () => null, querySelector: () => null, createElement: canvas, addEventListener() {}, hidden: false },
            ResizeObserver: class { observe() {} disconnect() {} },
            performance: { now: () => 0 },
            requestAnimationFrame: callback => { nextFrame = callback; return 1; }, cancelAnimationFrame() {},
            setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
        };
        context.requestLibraryPage = query => context.invoke("query_library_page", { query });
    vm.createContext(context);
        vm.runInContext(turntableSource.replace("    window.Turntable = {", "    window.inspectTurntable = () => S;\n    window.Turntable = {"), context);
        const container = { clientWidth: 1000, clientHeight: 400, appendChild(node) { node.parentElement = this; } };
        assert.equal(context.window.Turntable.mount(container), true);
        const state = context.window.inspectTurntable();
        assert.equal(state.design, theme === "sky" ? "sakura-desktop" : "cream-retro", "Cloud uses pink; Archive uses cream retro");
        assert.equal(state.recordMat.transparent, false);
        assert.equal(state.plinthMat.type, "MeshPhysicalMaterial");
        assert.ok(state.topPlateMat.metalness < .2, "Painted body panels should not reflect like bare metal");
        assert.equal(state.bodyVariants[theme].visible, true);
        assert.equal(state.bodyVariants[theme === "archive" ? "sky" : "archive"].visible, false);
        const bounds = new THREE.Box3().setFromObject(state.deck);
        assert.ok(bounds.max.y < 1.6, "A tall cover must not dominate the default framing");
        for (const [width, height, minimumWidth] of [[1000, 400, .7], [800, 330, .7], [1300, 550, .7], [420, 330, .85]]) {
            container.clientWidth = width; container.clientHeight = height;
            nextFrame();
            let left = Infinity, right = -Infinity;
            state.deck.traverseVisible(mesh => {
                if (!mesh.isMesh) return;
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                if (!materials.some(material => material.visible && (!material.transparent || material.opacity > 0))) return;
                const vertices = mesh.geometry.attributes.position;
                for (let i = 0; i < vertices.count; i++) {
                    const projected = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(mesh.matrixWorld).project(state.camera);
                    assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1, `${theme} ${width}×${height}: clipped machine`);
                    left = Math.min(left, projected.x); right = Math.max(right, projected.x);
                }
            });
            const occupancy = (right - left) / 2;
            assert.ok(occupancy >= minimumWidth, `${theme} ${width}×${height}: machine only fills ${(occupancy * 100).toFixed(1)}% of the stage width`);
        }
        const currentGeometry = state.framingPoints;
        const currentDesign = state.design;
        context.window.Turntable.setTheme(theme === "archive" ? "sky" : "archive");
        assert.equal(state.design, theme === "archive" ? "sakura-desktop" : "cream-retro");
        assert.notEqual(state.design, currentDesign, "Theme switching must change the physical design");
        assert.notEqual(state.framingPoints, currentGeometry, "Each silhouette needs its own framing");
        assert.ok(state.hitTargets.every(target => {
            for (let node = target; node; node = node.parent) if (!node.visible) return false;
            return true;
        }), "Hidden controls from the other model must not intercept clicks");
        context.window.Turntable.setTheme(theme);
        assert.equal(state.framingPoints, currentGeometry, "Switching back reuses the original stable framing");
        context.window.Turntable.sleep();
    }
});
