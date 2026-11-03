const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/theme-transition.js"), "utf8");
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function harness({ native = true, reduced = false, hidden = false, autoLoad = true, home = true } = {}) {
    const timers = new Map(), images = [], changes = [];
    let timerId = 0, nativeCalls = 0, finishTransition;
    const classes = () => {
        const names = new Set();
        return { add: (...values) => values.forEach(v => names.add(v)),
            remove: (...values) => values.forEach(v => names.delete(v)), contains: name => names.has(name) };
    };
    class Element {
        classList = classes(); style = {}; attributes = {}; children = [];
        setAttribute(name, value) { this.attributes[name] = value; }
        removeAttribute(name) { delete this.attributes[name]; }
        append(child) { child.parent = this; this.children.push(child); }
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
        cloneNode() { return Object.assign(new Element(), { src: this.src, complete: true, naturalWidth: 1586, className: this.className }); }
    }
    const root = new Element(), button = new Element(), scene = new Element(), artwork = new Element();
    Object.assign(artwork, { src: "assets/home-cat-cream.png", complete: true, naturalWidth: 1586, className: "scene-artwork" });
    scene.querySelector = () => artwork;
    const body = new Element();
    body.dataset = { theme: "cream" };
    if (home) body.classList.add("view-home");
    const document = { body, documentElement: root, hidden,
        createElement: () => new Element(), getElementById: () => button, querySelector: () => scene };
    if (native) document.startViewTransition = update => {
        nativeCalls++;
        if (native === "throw") throw new Error("capture unavailable");
        if (native === "skip") return { ready: Promise.reject(new Error("skipped")),
            updateCallbackDone: Promise.resolve(), finished: Promise.reject(new Error("skipped")) };
        update();
        return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(),
            finished: new Promise(resolve => { finishTransition = resolve; }) };
    };
    class Image {
        complete = false; naturalWidth = 0;
        constructor() { images.push(this); }
        set src(value) { this.source = value; if (autoLoad) queueMicrotask(() => this.load()); }
        load() { this.complete = true; this.naturalWidth = 1586; this.onload?.(); }
        decode() { return Promise.resolve(); }
    }
    const window = { matchMedia: () => ({ matches: reduced }) };
    vm.runInNewContext(source, { document, window, Image,
        getComputedStyle: () => ({ color: "#604e55", background: "cream painting" }),
        setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
        clearTimeout: id => timers.delete(id) });
    const apply = theme => {
        changes.push({ theme, outgoing: scene.children[0], source: scene.children[0]?.children[0]?.children[0]?.src });
        body.dataset.theme = theme;
        artwork.src = `assets/home-cat-${theme}.png`;
    };
    return { api: window.ThemeTransition, body, root, button, scene, images, timers, changes, apply,
        nativeCalls: () => nativeCalls, finish: () => finishTransition(),
        tick: async ms => {
            for (const [id, timer] of [...timers]) if (timer.ms <= ms) { timers.delete(id); timer.fn(); }
            await flush();
        } };
}

test("native crossfade waits for both paintings, ignores repeated clicks, and cleans up", async () => {
    const h = harness({ autoLoad: false });
    const pending = h.api.change("night", h.apply);
    assert.equal(h.body.dataset.theme, "cream");
    assert.equal(h.button.attributes["aria-busy"], "true");
    assert.equal(h.images.length, 2);
    h.images[0].load();
    await flush();
    assert.equal(h.nativeCalls(), 0, "the backdrop must be ready too");
    h.images[1].load();
    await flush();
    assert.equal(h.body.dataset.theme, "night");
    assert.equal(h.root.classList.contains("theme-crossfade"), true);
    await h.api.change("cream", h.apply);
    assert.equal(h.changes.length, 1, "do not queue overlapping transitions");
    h.finish(); await pending;
    assert.equal(h.root.classList.contains("theme-crossfade"), false);
    assert.equal(h.button.attributes["aria-busy"], undefined);
    assert.equal(h.timers.size, 0);
});

test("fallback retains the old illustration until the new scene has faded in", async () => {
    const h = harness({ native: false });
    const pending = h.api.change("night", h.apply);
    await flush();
    const snapshot = h.scene.children[0];
    assert.equal(snapshot.attributes["aria-hidden"], "true");
    assert.equal(snapshot.style.background, "cream painting");
    assert.equal(h.changes[0].source, "assets/home-cat-cream.png");
    assert.equal(snapshot.classList.contains("is-leaving"), true);
    assert.equal(h.root.classList.contains("theme-color-transition"), true);
    await h.tick(580); await pending;
    assert.equal(h.scene.children.length, 0);
    assert.equal(h.root.classList.contains("theme-color-transition"), false);
    assert.equal(h.button.attributes["aria-busy"], undefined);
});

test("workspace fallback fades only the painted backdrop without cloning controls", async () => {
    const h = harness({ native: false, home: false });
    const originalBody = h.body;
    const pending = h.api.change("night", h.apply);
    await flush();
    assert.equal(h.scene.children.length, 1);
    assert.equal(h.scene.children[0].className, "workspace-theme-snapshot");
    assert.equal(h.scene.children[0].children.length, 0, "only a background, no scene or controls");
    assert.equal(h.scene.children[0].style.background, "cream painting");
    assert.equal(h.body, originalBody);
    assert.equal(h.changes.length, 1);
    await h.tick(580); await pending;
    assert.equal(h.scene.children.length, 0);
});

test("reduced motion and hidden windows apply the theme without animation", async () => {
    for (const options of [{ reduced: true }, { hidden: true }]) {
        const h = harness(options);
        await h.api.change("night", h.apply);
        assert.equal(h.body.dataset.theme, "night");
        assert.equal(h.nativeCalls(), 0);
        assert.equal(h.scene.children.length, 0);
        assert.equal(h.timers.size, 0);
    }
});

test("skipped native capture still changes the theme exactly once", async () => {
    const h = harness({ native: "skip" });
    await h.api.change("night", h.apply);
    assert.equal(h.changes.length, 1);
    assert.equal(h.body.dataset.theme, "night");
    assert.equal(h.root.classList.contains("theme-crossfade"), false);
});

test("unavailable capture and stalled images cannot leave switching stuck", async () => {
    const h = harness({ native: "throw", autoLoad: false });
    const pending = h.api.change("night", h.apply);
    await h.tick(2500);
    assert.equal(h.body.dataset.theme, "night");
    assert.equal(h.scene.children.length, 1);
    await h.tick(580); await pending;
    assert.equal(h.button.attributes["aria-busy"], undefined);
    const next = h.api.change("cream", h.apply);
    await h.tick(2500); await h.tick(580); await next;
    assert.equal(h.body.dataset.theme, "cream");
    assert.equal(h.scene.children.length, 0);
});

test("failed updates release the transition lock and fallback overlay", async () => {
    const h = harness({ native: false });
    await assert.rejects(h.api.change("night", () => { throw new Error("update failed"); }), /update failed/);
    assert.equal(h.scene.children.length, 0);
    assert.equal(h.button.attributes["aria-busy"], undefined);
    const pending = h.api.change("night", h.apply);
    await flush(); await h.tick(580); await pending;
    assert.equal(h.body.dataset.theme, "night");
});
