const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/home-scene-motion.js"), "utf8");
const exposed = source.replace("window.HomeSceneMotion =", "window.motionMath = { poses, breathAt, tailAt, petPoseAt, makeMesh, PERIOD, AMPLITUDE, TAIL_AMPLITUDE, PET_DURATION }; window.HomeSceneMotion =");

class Events {
    listeners = new Map();
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type, event = {}) { for (const callback of [...this.listeners.get(type) || []]) callback(event); }
    count(type) { return this.listeners.get(type)?.size || 0; }
}

function harness({ theme = "night", reduced = false, preference, complete = true, noGpu = false, shaderFailure = false } = {}) {
    const raf = new Map(), canvases = [], draws = [], tailDraws = [], petDraws = [], resources = new Set(), observers = new Set();
    const storage = new Map(preference === undefined ? [] : [["music-library-scene-motion", preference]]);
    let sequence = 0;
    const media = Object.assign(new Events(), { matches: reduced });
    const window = Object.assign(new Events(), { devicePixelRatio: 2, matchMedia: () => media });
    const document = Object.assign(new Events(), { hidden: false });
    const board = {
        isConnected: true, children: [],
        getBoundingClientRect: () => ({ width: 1240 }),
        querySelector: () => null,
        insertBefore(canvas) { this.children.push(canvas); canvas.parent = this; }
    };
    const imagePath = "assets/home-cat-" + theme + ".png";
    const painting = Object.assign(new Events(), { complete, naturalWidth: 1586, naturalHeight: 992, src: imagePath, currentSrc: imagePath });
    const control = { attributes: {}, disabled: false, label: {}, setAttribute(key, value) { this.attributes[key] = value; }, querySelector() { return this.label; } };
    window.ResizeObserver = class {
        constructor(callback) { this.callback = callback; }
        observe() { observers.add(this); }
        disconnect() { observers.delete(this); }
    };
    document.createElement = () => {
        const canvas = Object.assign(new Events(), {
            style: {}, setAttribute() {},
            remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
        });
        let amount = 0, tail = [0, 0], pet = 0;
        const gl = new Proxy({
            NO_ERROR: 0, getError: () => 0,
            getShaderParameter: () => !shaderFailure,
            getProgramParameter: () => true,
            getAttribLocation: (_program, name) => name === "a_vertex" ? 0 : 1,
            getUniformLocation: (_program, name) => name,
            uniform1f: (location, value) => {
                if (location === "u_breath") amount = value;
                if (location === "u_pet") pet = value;
            },
            uniform2f: (location, x, y) => { if (location === "u_tail") tail = [x, y]; },
            uniform4f: (location, ...values) => { if (location === "u_patch") canvas.patch = values; },
            bufferData: (target, data) => { if (target === "ARRAY_BUFFER") canvas.vertices = Array.from(data); },
            drawElements: () => { draws.push(amount); tailDraws.push(tail); petDraws.push(pet); },
            texImage2D: (...args) => { canvas.textureImage = args.at(-1); },
            getExtension: () => ({ loseContext() { canvas.released = true; } })
        }, {
            get(target, key) {
                if (key in target) return target[key];
                if (key.startsWith("create")) return () => { const value = { kind: key }; resources.add(value); return value; };
                if (key.startsWith("delete")) return value => resources.delete(value);
                if (key === key.toUpperCase()) return key;
                return () => {};
            }
        });
        canvas.getContext = () => noGpu ? null : gl;
        canvases.push(canvas);
        return canvas;
    };
    const context = { window, document, Float32Array, Uint16Array,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        requestAnimationFrame: callback => { raf.set(++sequence, callback); return sequence; },
        cancelAnimationFrame: id => raf.delete(id),
    };
    vm.createContext(context);
    vm.runInContext(exposed, context);
    const api = window.HomeSceneMotion;
    api.setupControl(control);
    const sharedMath = window.motionMath, pose = sharedMath.poses[theme];
    const math = { ...sharedMath, ...pose, PATCH: pose.patch, makeMesh: () => sharedMath.makeMesh(pose) };
    return { api, math, raf, draws, tailDraws, petDraws, resources, canvases, observers, storage, media, document, board, painting, control,
        mount: () => api.mount(board, painting, theme),
        step(time) { for (const [id, callback] of [...raf]) { raf.delete(id); callback(time); } },
        hide(value) { document.hidden = value; document.emit("visibilitychange"); },
        reduce(value) { media.matches = value; media.emit("change"); },
    };
}

test("breathing lifts only the torso; the face, paws, tail and patch perimeter stay fixed", () => {
    const { math } = harness();
    for (const [x, y] of [[1090, 600], [1140, 550], [1120, 725], [1250, 680], [1410, 740], [1410, 850], [1250, 470]]) {
        assert.equal(math.bodyWeight(x, y), 0, `fixed landmark ${x},${y}`);
    }
    assert.equal(math.bodyWeight(1250, 585), 1);
    for (let time = 0; time <= math.PERIOD; time += 8) {
        assert.ok(math.breathAt(time) >= 0 && math.breathAt(time) <= math.AMPLITUDE);
    }
    assert.equal(math.breathAt(0), 0);
    assert.equal(math.breathAt(math.PERIOD), 0);
    assert.equal(math.breathAt(math.PERIOD * 0.95), 0);
    const mesh = math.makeMesh(), { x, y, width, height } = math.PATCH;
    for (let i = 0; i < mesh.vertices.length; i += 6) {
        const [vx, vy, weight] = mesh.vertices.slice(i, i + 3);
        if (vx === x || vx === x + width || vy === y || vy === y + height) assert.equal(weight, 0);
    }
    // No gesture may fold a triangle, including when all their peaks overlap.
    for (const breath of [0, math.AMPLITUDE]) {
        for (const sway of [-math.TAIL_AMPLITUDE, 0, math.TAIL_AMPLITUDE]) {
          for (const pet of [0, 1]) {
            for (let i = 0; i < mesh.indices.length; i += 3) {
                const points = Array.from(mesh.indices.slice(i, i + 3), index => {
                    const offset = index * 6;
                    return [mesh.vertices[offset] + sway * mesh.vertices[offset + 3] + pet * mesh.vertices[offset + 4],
                        mesh.vertices[offset + 1] - breath * mesh.vertices[offset + 2] - 2.2 * mesh.vertices[offset + 3] + pet * mesh.vertices[offset + 5]];
                });
                const [a, b, c] = points;
                assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0);
            }
          }
        }
    }
});

test("tail bending grows toward the tip and leaves the root, face, paws and sofa seams fixed", () => {
    const { math } = harness();
    for (const [x, y] of [[1090, 600], [1120, 725], [1250, 680], [1375, 675], [1400, 720], [1330, 835], [1530, 830]]) {
        assert.equal(math.tailWeight(x, y), 0, `fixed landmark ${x},${y}`);
    }
    assert.ok(math.tailWeight(1410, 760) < math.tailWeight(1410, 800));
    assert.ok(math.tailWeight(1410, 800) < math.tailWeight(1410, 845));
    assert.equal(math.tailWeight(1410, 845), 1);
    const { vertices } = math.makeMesh(), { x, y, width, height } = math.PATCH;
    for (let i = 0; i < vertices.length; i += 6) {
        const [vx, vy, body, tail] = vertices.slice(i, i + 4);
        assert.equal(body * tail, 0, "gestures act on separate regions");
        if (vx === x || vx === x + width || vy === y || vy === y + height) assert.equal(tail, 0);
    }
});

test("the tail gestures have long quiet gaps, smooth returns and varied timing", () => {
    const { math } = harness();
    let resting = 0, starts = [], wasMoving = false, previous = { x: 0, y: 0 };
    const directions = new Set();
    for (let time = 0; time < 64000; time += 16) {
        const tail = math.tailAt(time), moving = tail.x !== 0 || tail.y !== 0;
        assert.ok(Math.abs(tail.x) <= math.TAIL_AMPLITUDE && tail.y >= -2.2 && tail.y <= 0);
        assert.ok(Math.abs(tail.x - previous.x) < 0.5 && Math.abs(tail.y - previous.y) < 0.1, "no snap at a gesture boundary");
        if (moving && !wasMoving) { starts.push(time); directions.add(Math.sign(tail.x)); }
        if (!moving) resting++;
        wasMoving = moving;
        previous = tail;
    }
    assert.ok(resting / (64000 / 16) > 0.75, "the tail should usually rest");
    assert.ok(starts[0] >= 2600 && starts[0] < 2800, "first gesture is discoverable soon after entry");
    assert.ok(new Set(starts.slice(1).map((start, i) => start - starts[i])).size > 1);
    assert.equal(directions.size, 2);
});

test("petting tilts the head toward the armrest with fixed paws and smooth start and return", () => {
    const { math } = harness();
    const head = math.headOffset(1095, 600);
    assert.ok(head[0] < 0 && head[1] > 0 && Math.hypot(...head) < 7);
    for (const [x, y] of [[1120, 725], [1250, 680], [1410, 845], [950, 650], [1300, 480]]) {
        assert.ok(math.headOffset(x, y).every(value => value === 0));
    }
    const { vertices } = math.makeMesh(), { x, y, width, height } = math.PATCH;
    for (let i = 0; i < vertices.length; i += 6) {
        const [vx, vy, , , hx, hy] = vertices.slice(i, i + 6);
        if (vx === x || vx === x + width || vy === y || vy === y + height) {
            assert.equal(Math.abs(hx) + Math.abs(hy), 0);
        }
    }
    let previous = math.petPoseAt(-16);
    for (let time = 0; time <= math.PET_DURATION + 16; time += 16) {
        const pose = math.petPoseAt(time);
        assert.ok(pose.head >= 0 && pose.head <= 1 && pose.blend >= 0 && pose.blend <= 1);
        assert.ok(Math.abs(pose.head - previous.head) < 0.04);
        previous = pose;
    }
    assert.equal(math.petPoseAt(math.PET_DURATION).head, 0);
});

test("petting is immediate, ignores repeat clicks and leaves breathing amplitude and clock alone", () => {
    const app = harness();
    assert.equal(app.api.pet(), false);
    const destroy = app.mount();
    assert.equal(app.api.pet(), true);
    assert.equal(app.api.pet(), false);
    app.step(0);
    for (let time = 100; time <= 800; time += 100) app.step(time);
    assert.ok(app.petDraws.at(-1) > 0.9);
    assert.ok(app.tailDraws.at(-1)[0] > 0, "tail responds without waiting for its idle gesture");
    assert.equal(app.draws.at(-1), app.math.breathAt(800));
    assert.equal(app.api.pet(), false);
    for (let time = 900; time <= 2500; time += 100) app.step(time);
    assert.equal(app.petDraws.at(-1), 0);
    assert.equal(app.api.pet(), true);
    destroy();
    assert.equal(app.api.pet(), false);
});

test("petting blends into a moving tail, pauses when hidden and cancels on reduced motion", () => {
    const app = harness();
    const destroy = app.mount();
    app.step(0);
    for (let time = 100; time <= 3600; time += 100) app.step(time);
    const before = app.tailDraws.at(-1);
    app.api.pet();
    app.step(3616);
    assert.ok(Math.abs(app.tailDraws.at(-1)[0] - before[0]) < 0.25);
    app.step(3716);
    const pose = app.petDraws.at(-1);
    app.hide(true);
    assert.equal(app.api.pet(), false);
    app.hide(false);
    app.step(30000);
    assert.equal(app.petDraws.at(-1), pose);
    app.reduce(true);
    assert.equal(app.api.pet(), false);
    assert.equal(app.api.canAnimate(), false);
    app.reduce(false);
    assert.equal(app.petDraws.at(-1), 0, "an old reaction must not resume after motion is disabled");
    destroy();
});

test("disabled or unavailable motion never queues a pet reaction for later", () => {
    for (const options of [{ preference: "false" }, { reduced: true }, { noGpu: true }, { complete: false }]) {
        const app = harness(options), destroy = app.mount();
        assert.equal(app.api.pet(), false);
        assert.equal(app.petDraws.some(value => value > 0), false);
        destroy();
    }
});

test("the approved painting is the texture and a hidden page pauses without catching up", () => {
    const app = harness();
    const destroy = app.mount();
    assert.equal(app.canvases[0].textureImage, app.painting);
    assert.equal(app.raf.size, 1);
    app.step(0);
    for (let time = 100; time <= 3600; time += 100) app.step(time);
    const previous = app.draws.at(-1), drawCount = app.draws.length;
    const previousTail = app.tailDraws.at(-1);
    assert.ok(previous > 0);
    assert.ok(previousTail[0] > 5, "tail displacement reaches the shader");
    app.hide(true);
    assert.equal(app.raf.size, 0);
    app.step(50000);
    assert.equal(app.draws.length, drawCount);
    app.hide(false);
    app.step(60000);
    assert.equal(app.draws.at(-1), previous, "resume from the same breath, not the wall clock");
    assert.deepEqual(app.tailDraws.at(-1), previousTail, "resume the same tail pose");
    destroy();
    assert.equal(app.raf.size, 0);
    assert.equal(app.resources.size, 0);
    assert.equal(app.observers.size, 0);
    assert.equal(app.board.children.length, 0);
    assert.equal(app.document.count("visibilitychange"), 0);
});

test("unmounting while the artwork loads cannot resurrect an old canvas", () => {
    const app = harness({ complete: false });
    const destroy = app.mount();
    const lateLoad = [...app.painting.listeners.get("load")][0];
    destroy();
    lateLoad();
    app.painting.emit("load");
    assert.equal(app.canvases.length, 0);
    assert.equal(app.raf.size, 0);
    assert.equal(app.painting.count("load"), 0);
    assert.equal(app.painting.count("error"), 0);
});

test("a theme switch waits for the new image instead of uploading the previous theme", () => {
    const app = harness();
    app.painting.currentSrc = "assets/home-cat-cream.png";
    const destroy = app.mount();
    assert.equal(app.canvases.length, 0);
    app.painting.currentSrc = app.painting.src;
    app.painting.emit("load");
    assert.equal(app.board.children.length, 1);
    destroy();
});

test("repeated mounts leave one renderer; a detached homepage releases it", () => {
    const app = harness();
    app.mount();
    app.mount();
    assert.equal(app.canvases[0].released, true);
    assert.equal(app.raf.size, 1);
    assert.equal(app.board.children.length, 1);
    assert.equal(app.document.count("visibilitychange"), 1);
    app.board.isConnected = false;
    app.step(100);
    assert.equal(app.raf.size, 0);
    assert.equal(app.resources.size, 0);
    assert.equal(app.document.count("visibilitychange"), 0);
});

test("the saved switch and live reduced-motion preference stop work and release resources", () => {
    const app = harness({ preference: "false" });
    const destroy = app.mount();
    assert.equal(app.canvases.length, 0);
    assert.equal(app.control.attributes["aria-checked"], "false");
    app.control.onclick();
    assert.equal(app.storage.get("music-library-scene-motion"), "true");
    assert.equal(app.raf.size, 1);
    app.reduce(true);
    assert.equal(app.control.disabled, true);
    assert.equal(app.raf.size, 0);
    assert.equal(app.resources.size, 0);
    app.reduce(false);
    assert.equal(app.raf.size, 1);
    app.control.onclick();
    assert.equal(app.storage.get("music-library-scene-motion"), "false");
    assert.equal(app.raf.size, 0);
    assert.equal(app.resources.size, 0);
    destroy();
});

test("reduced motion on first load does not allocate a canvas", () => {
    const app = harness({ reduced: true });
    const destroy = app.mount();
    assert.equal(app.raf.size, 0);
    assert.equal(app.canvases.length, 0);
    destroy();
});

test("missing GPU, shader failure and lost context leave the original painting visible", () => {
    for (const options of [{ noGpu: true }, { shaderFailure: true }, {}]) {
        const app = harness(options);
        const destroy = app.mount();
        if (!options.noGpu && !options.shaderFailure) app.canvases[0].emit("webglcontextlost", { preventDefault() {} });
        assert.equal(app.raf.size, 0);
        assert.equal(app.resources.size, 0);
        assert.equal(app.board.children.length, 0);
        destroy();
    }
});

test("an artwork load error does not start an animation", () => {
    const app = harness({ complete: false });
    const destroy = app.mount();
    app.painting.emit("error");
    app.painting.emit("load");
    assert.equal(app.raf.size, 0);
    assert.equal(app.canvases.length, 0);
    destroy();
});

test("cream: breathing, left tail and right-facing nuzzle use their own anatomical regions", () => {
    const { math } = harness({ theme: "cream" });
    assert.equal(math.bodyWeight(1100, 508), 1);
    for (const [x, y] of [[1300, 493], [1195, 574], [1275, 560], [980, 580], [985, 700], [1120, 340]]) {
        assert.equal(math.bodyWeight(x, y), 0, `breathing anchor ${x},${y}`);
    }
    assert.ok(math.tailWeight(953, 610) < math.tailWeight(965, 650));
    assert.ok(math.tailWeight(965, 650) < math.tailWeight(985, 700));
    assert.equal(math.tailWeight(985, 700), 1);
    assert.equal(math.tailDirection, -1);
    for (const [x, y] of [[980, 580], [1100, 508], [1275, 560], [1320, 500], [1070, 700], [800, 700]]) {
        assert.equal(math.tailWeight(x, y), 0, `tail anchor ${x},${y}`);
    }
    const nuzzle = math.headOffset(1320, 500);
    assert.ok(nuzzle[0] > 0 && nuzzle[1] > 0 && Math.hypot(...nuzzle) < 7, "lean toward the right armrest");
    for (const [x, y] of [[1195, 574], [1275, 560], [1100, 508], [985, 700], [1450, 500], [1300, 350]]) {
        assert.ok(math.headOffset(x, y).every(value => value === 0), `nuzzle anchor ${x},${y}`);
    }
});

test("cream: patch borders stay fixed and combined peak gestures cannot fold the mesh", () => {
    const { math } = harness({ theme: "cream" });
    const { vertices, indices } = math.makeMesh(), { x, y, width, height } = math.PATCH;
    for (let i = 0; i < vertices.length; i += 6) {
        const [vx, vy, body, tail, hx, hy] = vertices.slice(i, i + 6);
        assert.ok(vx >= x && vx <= x + width && vy >= y && vy <= y + height);
        assert.equal(body * tail, 0);
        if (vx === x || vx === x + width || vy === y || vy === y + height) {
            assert.equal(body + tail + Math.abs(hx) + Math.abs(hy), 0, "patch perimeter must not expose a seam");
        }
    }
    for (const breath of [0, math.AMPLITUDE]) {
        for (const tail of [-math.TAIL_AMPLITUDE, 0, math.TAIL_AMPLITUDE]) {
            for (const pet of [0, 1]) {
                for (let i = 0; i < indices.length; i += 3) {
                    const points = Array.from(indices.slice(i, i + 3), index => {
                        const offset = index * 6;
                        return [vertices[offset] + tail * vertices[offset + 3] + pet * vertices[offset + 4],
                            vertices[offset + 1] - breath * vertices[offset + 2] - 2.2 * vertices[offset + 3] + pet * vertices[offset + 5]];
                    });
                    const [a, b, c] = points;
                    assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0);
                }
            }
        }
    }
});

test("cream: the renderer loads the cream painting and responds immediately with a leftward tail", () => {
    const app = harness({ theme: "cream" });
    const destroy = app.mount();
    assert.equal(app.canvases[0].textureImage.src, "assets/home-cat-cream.png");
    assert.deepEqual(app.canvases[0].patch, [864, 368, 576, 392]);
    assert.deepEqual(app.canvases[0].vertices, Array.from(app.math.makeMesh().vertices));
    assert.equal(app.api.pet(), true);
    assert.equal(app.api.pet(), false, "repeat clicks must not amplify the response");
    app.step(0);
    for (let time = 100; time <= 800; time += 100) app.step(time);
    assert.equal(app.draws.at(-1), app.math.breathAt(800));
    assert.ok(app.petDraws.at(-1) > 0.9);
    assert.ok(app.tailDraws.at(-1)[0] < 0);
    for (let time = 900; time <= 2500; time += 100) app.step(time);
    assert.equal(app.petDraws.at(-1), 0);
    app.step(2600);
    for (let time = 2700; time <= 3600; time += 100) app.step(time);
    assert.ok(app.tailDraws.at(-1)[0] < -5, "idle tail animation also uses the cream direction");
    destroy();
    assert.equal(app.resources.size, 0);
    assert.equal(app.raf.size, 0);
});

test("switching themes during load cannot pair a new painting with a stale pose", () => {
    const app = harness({ complete: false });
    app.mount();
    const staleNightLoad = [...app.painting.listeners.get("load")][0];
    app.painting.src = "assets/home-cat-cream.png";
    app.api.mount(app.board, app.painting, "cream");
    staleNightLoad();
    app.painting.emit("load");
    assert.equal(app.canvases.length, 0, "wait while currentSrc still refers to the old night image");
    app.painting.currentSrc = app.painting.src;
    app.painting.complete = true;
    app.painting.emit("load");
    assert.deepEqual(app.canvases.at(-1).patch, [864, 368, 576, 392]);
    assert.equal(app.api.pet(), true);
    app.painting.src = app.painting.currentSrc = "assets/home-cat-night.png";
    const destroy = app.api.mount(app.board, app.painting, "night");
    assert.equal(app.canvases[0].released, true);
    assert.deepEqual(app.canvases.at(-1).patch, [976, 500, 516, 400]);
    assert.equal(app.petDraws.at(-1), 0, "the old theme's interaction must not carry over");
    assert.equal(app.board.children.length, 1);
    assert.equal(app.raf.size, 1);
    assert.equal(app.document.count("visibilitychange"), 1);
    destroy();
    assert.equal(app.resources.size, 0);
});

test("cream: visibility, reduced motion, the saved switch and GPU fallback remain effective", () => {
    const app = harness({ theme: "cream" });
    const destroy = app.mount();
    app.api.pet();
    app.step(0);
    for (let time = 100; time <= 800; time += 100) app.step(time);
    const head = app.petDraws.at(-1), tail = app.tailDraws.at(-1);
    app.hide(true);
    assert.equal(app.raf.size, 0);
    app.hide(false);
    app.step(20000);
    assert.equal(app.petDraws.at(-1), head);
    assert.deepEqual(app.tailDraws.at(-1), tail);
    app.reduce(true);
    assert.equal(app.api.pet(), false);
    assert.equal(app.resources.size, 0);
    assert.equal(app.raf.size, 0);
    app.reduce(false);
    assert.equal(app.petDraws.at(-1), 0);
    app.control.onclick();
    assert.equal(app.resources.size, 0);
    assert.equal(app.raf.size, 0);
    destroy();
    for (const options of [{ preference: "false" }, { reduced: true }, { noGpu: true }]) {
        const fallback = harness({ theme: "cream", ...options });
        const cleanup = fallback.mount();
        assert.equal(fallback.raf.size, 0);
        assert.equal(fallback.board.children.length, 0);
        assert.equal(fallback.api.pet(), false);
        cleanup();
    }
});
