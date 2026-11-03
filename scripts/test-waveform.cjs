const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const source = fs.readFileSync(path.join(__dirname, "../frontend/waveform.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../frontend/themes.css"), "utf8");
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

test("failed waveform requests are handled, release pending entries, and allow retries", () => {
    // A child process makes Node's strict unhandled-rejection check part of the
    // assertion, including promises created internally by cache cleanup.
    const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "-e", `
        const assert = require('node:assert/strict');
        const vm = require('node:vm');
        const attempts = new Map();
        const window = { addEventListener() {}, OfflineAudioContext: class {
            async decodeAudioData(url) {
                if (url === 'decode' && attempts.get(url) === 1) throw Error('damaged audio');
                return { numberOfChannels: 1, length: 4, getChannelData: () => new Float32Array([0, .5, 1, 0]) };
            }
        }};
        vm.runInNewContext(require('node:fs').readFileSync(${JSON.stringify(path.join(__dirname, "../frontend/waveform.js"))}, 'utf8'), {
            window, console,
            document: { body: {}, getElementById() { return null; }, querySelectorAll() { return []; } },
            MutationObserver: class { observe() {} },
            fetch: async url => {
                attempts.set(url, (attempts.get(url) || 0) + 1);
                if (url === 'network' && attempts.get(url) === 1) throw Error('offline');
                return { ok: url !== 'http' || attempts.get(url) > 1, status: 404, arrayBuffer: async () => url };
            }
        });
        (async () => {
            for (const url of ['http', 'network', 'decode']) {
                const first = window.Waveform.getPeaks(url, 4);
                assert.equal(window.Waveform.getPeaks(url, 4), first, 'in-flight requests are shared');
                await assert.rejects(first);
                await new Promise(resolve => setImmediate(resolve));
                const peaks = await window.Waveform.getPeaks(url, 4);
                assert.equal(peaks.length, 4);
                assert.equal(attempts.get(url), 2, 'failure is evicted so retry can decode');
                assert.equal(await window.Waveform.getPeaks(url, 4), peaks);
                assert.equal(attempts.get(url), 2, 'successful retry is cached');
            }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
});

function palette(theme) {
    const block = css.match(new RegExp(`body\\[data-theme="${theme}"\\]\\s*\\{([^}]+)`))[1];
    const tokens = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
    const get = name => tokens[name]?.replace(/var\((--[\w-]+)\)/g, (_, key) => get(key)) || "";
    return get;
}

function harness(theme = "night") {
    function events(target = {}) {
        const listeners = new Map();
        return Object.assign(target, {
            addEventListener(name, fn) { listeners.set(name, fn); },
            emit(name, event = {}) { listeners.get(name)?.(event); }
        });
    }
    function canvas(dataset = {}) {
        const ctx = { bars: [], globalAlpha: 1, fillStyle: "#000000",
            setTransform() {}, clearRect() { this.bars = []; },
            fillRect(...rect) { this.bars.push({ color: this.fillStyle, alpha: this.globalAlpha, rect }); }
        };
        return events({ dataset, ctx, clientWidth: 320, clientHeight: 44, isConnected: true,
            getContext: () => ctx, setPointerCapture() {},
            getBoundingClientRect: () => ({ left: 0, width: 320 }) });
    }
    const row = canvas({ waveSrc: "song" });
    const clip = canvas({ waveSrc: "song", waveFrom: "0.25", waveTo: "0.5" });
    const player = canvas();
    const audio = events({ currentSrc: "song", currentTime: 40, duration: 100, paused: true });
    const body = { dataset: { theme } }, area = {}, observers = [];
    let fetches = 0, decodes = 0;
    const window = events({ devicePixelRatio: 1,
        OfflineAudioContext: class {
            async decodeAudioData() {
                decodes++;
                return { numberOfChannels: 1, length: 4096,
                    getChannelData: () => Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i / 31)) };
            }
        }
    });
    vm.runInNewContext(source, {
        window, console,
        document: { body, getElementById: id => ({ barAudio: audio, playerWave: player, contentArea: area }[id]),
            querySelectorAll: () => [row, clip] },
        MutationObserver: class {
            constructor(fn) { this.fn = fn; }
            observe(target) { observers.push({ target, fn: this.fn }); }
        },
        getComputedStyle: () => ({ getPropertyValue: palette(body.dataset.theme) }),
        fetch: async () => { fetches++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; }
    });
    return { row, clip, player, audio, window,
        counts: () => [fetches, decodes],
        theme(value) {
            body.dataset.theme = value;
            observers.filter(o => o.target === body).forEach(o => o.fn([]));
        }
    };
}

function rgb(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); }
function luminance(color) {
    return color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
function contrast(bar, background) {
    const bg = rgb(background);
    const fg = rgb(bar.color).map((v, i) => v * bar.alpha + bg[i] * (1 - bar.alpha));
    const [low, high] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
    return (high + .05) / (low + .05);
}

test("rendered waveform bars stay legible on normal, hovered, selected, and player surfaces", async () => {
    for (const theme of ["cream", "night"]) {
        const h = harness(theme), color = palette(theme);
        h.audio.emit("loadedmetadata");
        await flush();
        assert.ok(h.row.ctx.bars.length && h.player.ctx.bars.length);
        for (const canvas of [h.row, h.clip, h.player]) {
            const bars = [...new Map(canvas.ctx.bars.map(b => [b.color, b])).values()];
            const surfaces = canvas === h.player ? ["--player-surface"] : ["--panel", "--hover", "--primary-light"];
            for (const bar of bars) for (const surface of surfaces) {
                assert.ok(contrast(bar, color(surface)) >= 3, `${theme}: ${bar.color} on ${surface} is too faint`);
            }
        }
    }
});

test("theme changes repaint cached rows, clip ranges, and a paused player without decoding again", async () => {
    const h = harness();
    h.audio.emit("loadedmetadata");
    await flush();
    const before = [h.row, h.clip, h.player].map(c => c.ctx.bars.map(b => b.rect));
    const counts = h.counts();
    for (const theme of ["cream", "night", "cream"]) {
        h.theme(theme);
        const color = palette(theme);
        assert.equal(h.row.ctx.bars[0].color, color("--waveform-rest"));
        assert.equal(h.clip.ctx.bars[0].color, color("--waveform-rest"));
        assert.equal(h.clip.ctx.bars[40].color, color("--waveform-played"));
        assert.equal(h.clip.ctx.bars.at(-1).color, color("--waveform-rest"));
        assert.equal(h.player.ctx.bars[0].color, color("--waveform-played"));
        assert.equal(h.player.ctx.bars.at(-1).color, color("--waveform-rest"));
        assert.deepEqual([h.row, h.clip, h.player].map(c => c.ctx.bars.map(b => b.rect)), before);
    }
    assert.deepEqual(h.counts(), counts);
    h.player.emit("pointerdown", { pointerId: 1, clientX: 240 });
    assert.equal(h.audio.currentTime, 75, "waveform seeking still works");
    assert.equal(h.player.ctx.bars[200].color, palette("cream")("--waveform-played"));
});
