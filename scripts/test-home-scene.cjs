const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "frontend/home-scene.js"), "utf8");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source.replace("window.HomeScene =", "window.sceneFixtures = scenes; window.HomeScene ="), context);
const scenes = context.window.sceneFixtures;

// Hit testing uses the same paint order as the DOM: cat and yarn override furniture.
function contains(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
function destination(theme, x, y) {
    return [...scenes[theme].targets].reverse().find(target => contains(target.points, x, y))?.id;
}

for (const theme of ["night", "cream"]) {
    test(theme + ": original painting is bundled and each entrance stays on the artboard", () => {
        assert.ok(fs.existsSync(path.join(root, "frontend", scenes[theme].image)));
        const original = theme === "night" ? "月夜里打盹的猫咪.png" : "奶油留白里的酣睡白猫.png";
        assert.deepEqual(fs.readFileSync(path.join(root, "frontend", scenes[theme].image)), fs.readFileSync(path.join(root, "docs/design", original)));
        for (const target of scenes[theme].targets) {
            assert.ok(target.label);
            for (const [x, y] of target.points) assert.ok(x >= 0 && x <= 1586 && y >= 0 && y <= 992);
        }
    });
}

test("night: cat and yarn do not accidentally open the sofa or rug", () => {
    assert.equal(destination("night", 1100, 620), "cat");
    assert.equal(destination("night", 1400, 810), "cat");
    assert.equal(destination("night", 850, 830), "clips");
    assert.equal(destination("night", 1500, 760), "library");
    assert.equal(destination("night", 1050, 940), undefined, "the hidden Recent page has no rug shortcut");
    assert.equal(destination("night", 250, 400), undefined);
});

test("cream: the opposite cat pose uses its own entrance map", () => {
    assert.equal(destination("cream", 1320, 500), "cat");
    assert.equal(destination("cream", 970, 660), "cat");
    assert.equal(destination("cream", 750, 840), "clips");
    assert.equal(destination("cream", 1460, 680), "library");
    assert.equal(destination("cream", 1150, 930), undefined, "the hidden Recent page has no rug shortcut");
    assert.equal(destination("cream", 250, 400), undefined);
});

test("both app entry points load the illustrated scene without the old 3D dependency", () => {
    for (const entry of ["index.html", "preview.html"]) {
        const html = fs.readFileSync(path.join(root, "frontend", entry), "utf8");
        assert.match(html, /src="home-scene.js"/);
        assert.match(html, /src="home-scene-motion.js"/);
        assert.ok(html.indexOf('src="home-scene-motion.js"') < html.indexOf('src="home-scene.js"'));
        assert.match(html, /id="sceneMotionBtn"[^>]+role="menuitemcheckbox"/);
        assert.match(html, /href="home-scene.css"/);
        assert.doesNotMatch(html, /src="(?:turntable.js|vendor\/three.min.js)"/);
        assert.doesNotMatch(html, /data-view="recent"|id="filterToggleBtn"|id="filterPanel"/);
        const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
        assert.equal(ids.length, new Set(ids).size, entry + " must not duplicate control IDs");
    }
});

// Exercise the actual hotspot click handler and its DOM feedback lifecycle.
function interactiveScene({ theme = "night", animate = true } = {}) {
    const timers = new Map(), navigations = [], mountedThemes = [];
    let nextTimer = 0, pets = 0, motionMounted = false;
    class Element {
        children = []; attributes = {}; style = {}; dataset = {}; listeners = {};
        className = ""; hidden = false; isConnected = true;
        classList = {
            toggle: (name, value) => {
                const classes = new Set(this.className.split(" ").filter(Boolean));
                if (value) classes.add(name); else classes.delete(name);
                this.className = [...classes].join(" ");
            }
        };
        constructor(className = "") { this.className = className; }
        setAttribute(name, value) { this.attributes[name] = value; }
        append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
        replaceChildren(...children) { this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...children); }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        focus() {}
        querySelector(selector) {
            if (selector.includes(":focus")) return null;
            const matches = element => selector.startsWith(".")
                ? element.className.split(" ").includes(selector.slice(1))
                : element.dataset.destination === selector.match(/data-destination="([^"]+)"/)?.[1];
            for (const child of this.children) {
                if (matches(child)) return child;
                const found = child.querySelector(selector);
                if (found) return found;
            }
            return null;
        }
    }
    const root = new Element("home-scene"), board = new Element("scene-artboard"), help = new Element();
    board.append(new Element("scene-artwork"), new Element("scene-targets"));
    const hint = new Element("scene-discovery");
    hint.append(new Element("scene-discover-btn"), new Element("scene-dismiss-btn"));
    root.append(board, hint);
    const document = { body: { dataset: { theme } }, getElementById: () => help, createElement: () => new Element() };
    const context = { document, localStorage: { getItem: () => null },
        setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: id => timers.delete(id),
        window: { HomeSceneMotion: {
            mount(_board, image, theme) {
                mountedThemes.push({ theme, image: image.src });
                motionMounted = true;
                return () => { motionMounted = false; };
            },
            pet() { if (motionMounted && animate) { pets++; return true; } return false; },
            canAnimate: () => animate
        } }
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    const api = context.window.HomeScene;
    api.mount(root, { navigate: destination => navigations.push(destination) });
    return { api, root, board, timers, navigations, mountedThemes, pets: () => pets,
        click(destination) { root.querySelector('[data-destination="' + destination + '"]').listeners.click(); },
        feedback: () => root.querySelector(".scene-pet-feedback"),
        status: () => root.querySelector(".scene-pet-status"),
        finish() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } }
    };
}

test("petting the cat responds in the scene, never navigates and ignores rapid repeated clicks", () => {
    const scene = interactiveScene();
    for (let i = 0; i < 10; i++) scene.click("cat");
    assert.equal(scene.pets(), 1);
    assert.equal(scene.timers.size, 1);
    assert.equal(scene.feedback().hidden, false);
    assert.match(scene.feedback().className, /is-animated/);
    assert.ok(scene.status().textContent);
    assert.equal(scene.status().attributes.role, "status");
    assert.deepEqual(scene.navigations, []);
    scene.finish();
    assert.equal(scene.feedback().hidden, true);
    scene.click("cat");
    assert.equal(scene.pets(), 2);
    scene.click("library");
    assert.deepEqual(scene.navigations, ["library"]);
    scene.api.unmount();
    assert.equal(scene.timers.size, 0);
});

test("a theme change or unmount removes pet feedback and any pending cleanup timer", () => {
    const scene = interactiveScene();
    scene.click("cat");
    const oldFeedback = scene.feedback(), oldPosition = oldFeedback.style.left;
    scene.api.refresh("cream");
    assert.equal(scene.timers.size, 0);
    assert.equal(oldFeedback.parent, null);
    assert.notEqual(scene.feedback().style.left, oldPosition);
    scene.click("cat");
    assert.equal(scene.feedback().hidden, false, "cream still has a visible touch response");
    assert.equal(scene.pets(), 2, "cream also responds with its own animation");
    assert.deepEqual(scene.mountedThemes, [
        { theme: "night", image: "assets/home-cat-night.png" },
        { theme: "cream", image: "assets/home-cat-cream.png" }
    ], "each painting must be paired with its matching pose");
    scene.api.unmount();
    assert.equal(scene.feedback(), null);
    assert.equal(scene.timers.size, 0);
});

test("motion disabled still gives static pet feedback in both themes", () => {
    for (const theme of ["night", "cream"]) {
        const scene = interactiveScene({ theme, animate: false });
        scene.click("cat");
        assert.equal(scene.feedback().hidden, false);
        assert.doesNotMatch(scene.feedback().className, /is-animated/);
        assert.equal(scene.pets(), 0);
        scene.api.unmount();
    }
});
