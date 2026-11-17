/* =========================================================
   波形 — Musicbed 式音频波形
   - 底部播放器：整曲波形 + 播放进度 + 点击/拖动跳转
   - 音乐行内：随主题配色的小波形（懒解码、限并发、按 URL 缓存）
   独立于 app.js 运行；解码失败的曲目静默留空，不影响交互。
========================================================= */

(function () {
    "use strict";

    const audio = document.getElementById("barAudio");

    /* ---------------- 峰值解码 ---------------- */

    // One bounded, reusable peak envelope per URL; PCM buffers are never cached.
    const SOURCE_BUCKETS = 2240;
    const CACHE_LIMIT = 128;
    const peaksCache = new Map();
    const peaksPending = new Map();
    const queue = [];
    let activeJobs = 0;
    let decodeContext = null;
    const cancelled = () => Object.assign(new Error("波形任务已取消"), { name: "AbortError" });

    function getDecodeContext() {
        if (!decodeContext) {
            const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
            if (!Ctx) throw new Error("OfflineAudioContext 不可用");
            decodeContext = new Ctx(1, 1, 44100);
        }
        return decodeContext;
    }

    function computePeaks(buffer, buckets) {
        const channels = Math.min(buffer.numberOfChannels, 2);
        const data = [];
        for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

        const length = buffer.length;
        const per = Math.max(1, Math.floor(length / buckets));
        const peaks = new Float32Array(buckets);

        for (let b = 0; b < buckets; b++) {
            const start = b * per;
            const end = Math.min(length, start + per);
            const step = Math.max(1, Math.floor((end - start) / 64));
            let peak = 0;
            for (let i = start; i < end; i += step) {
                for (let c = 0; c < channels; c++) {
                    const v = Math.abs(data[c][i]);
                    if (v > peak) peak = v;
                }
            }
            peaks[b] = peak;
        }

        let max = 0;
        for (let i = 0; i < buckets; i++) if (peaks[i] > max) max = peaks[i];
        if (max > 0) {
            for (let i = 0; i < buckets; i++) peaks[i] = 0.1 + 0.9 * (peaks[i] / max);
        }
        return peaks;
    }

    function resizePeaks(peaks, buckets) {
        const result = new Float32Array(buckets);
        for (let i = 0; i < buckets; i++) {
            const from = Math.floor(i * peaks.length / buckets);
            const to = Math.max(from + 1, Math.ceil((i + 1) * peaks.length / buckets));
            for (let j = from; j < to; j++) result[i] = Math.max(result[i], peaks[j] || 0);
        }
        return result;
    }

    async function decode(job) {
        const response = await fetch(job.url, { signal: job.controller?.signal });
        if (!response.ok) throw new Error("读取音频失败: " + response.status);
        const raw = await response.arrayBuffer();
        if (!job.clients.size) throw cancelled();
        const buffer = await getDecodeContext().decodeAudioData(raw);
        return computePeaks(buffer, SOURCE_BUCKETS);
    }

    function pump() {
        queue.sort((a, b) => b.priority - a.priority);
        while (activeJobs < 2 && queue.length) {
            const job = queue.shift();
            if (!job.clients.size) continue;
            job.running = true;
            activeJobs++;
            decode(job).then(peaks => {
                if (!job.clients.size) return;
                const entry = { peaks, sizes: new Map() };
                peaksCache.set(job.url, entry);
                while (peaksCache.size > CACHE_LIMIT) peaksCache.delete(peaksCache.keys().next().value);
                for (const client of job.clients) {
                    if (!entry.sizes.has(client.buckets)) entry.sizes.set(client.buckets, resizePeaks(peaks, client.buckets));
                    client.resolve(entry.sizes.get(client.buckets));
                }
            }, error => {
                for (const client of job.clients) client.reject(error);
            }).finally(() => {
                for (const client of job.clients) client.cleanup();
                job.clients.clear();
                if (peaksPending.get(job.url) === job) peaksPending.delete(job.url);
                activeJobs--;
                pump();
            });
        }
    }

    function getPeaks(url, buckets, { signal, priority = 0 } = {}) {
        buckets = Math.max(1, Math.min(4096, Math.floor(buckets) || 140));
        if (signal?.aborted) return Promise.reject(cancelled());
        const entry = peaksCache.get(url);
        if (entry) {
            peaksCache.delete(url); peaksCache.set(url, entry);
            if (!entry.sizes.has(buckets)) {
                if (entry.sizes.size >= 8) entry.sizes.delete(entry.sizes.keys().next().value);
                entry.sizes.set(buckets, resizePeaks(entry.peaks, buckets));
            }
            return Promise.resolve(entry.sizes.get(buckets));
        }
        let job = peaksPending.get(url);
        if (!job) {
            const Controller = typeof AbortController === "function" ? AbortController : null;
            job = { url, clients: new Set(), shared: new Map(), priority, controller: Controller ? new Controller() : null };
            peaksPending.set(url, job);
            queue.push(job);
        }
        job.priority = Math.max(job.priority, priority);
        if (!signal && job.shared.has(buckets)) return job.shared.get(buckets);
        const promise = new Promise((resolve, reject) => {
            const client = { buckets, resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
            const abort = () => {
                client.cleanup(); job.clients.delete(client); reject(cancelled());
                if (!job.clients.size) {
                    job.controller?.abort();
                    const index = queue.indexOf(job);
                    if (index >= 0) queue.splice(index, 1);
                    if (peaksPending.get(url) === job) peaksPending.delete(url);
                }
            };
            job.clients.add(client);
            signal?.addEventListener("abort", abort, { once: true });
        });
        if (!signal) job.shared.set(buckets, promise);
        Promise.resolve().then(pump);
        return promise;
    }

    /* ---------------- 绘制工具 ---------------- */

    function cssColor(name, fallback) {
        const value = getComputedStyle(document.body).getPropertyValue(name).trim();
        return value || fallback;
    }

    function fitCanvas(canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return null;
        const bw = Math.round(w * dpr);
        const bh = Math.round(h * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
            canvas.width = bw;
            canvas.height = bh;
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        return { ctx, w, h };
    }

    function drawBars(canvas, peaks, progressRatio, range) {
        const fitted = fitCanvas(canvas);
        if (!fitted || !peaks) return;
        const { ctx, w, h } = fitted;
        const n = peaks.length;
        const barW = w / n;
        const mid = h / 2;
        const playedColor = cssColor("--waveform-played", "#815763");
        const restColor = cssColor("--waveform-rest", "#987887");
        // Dedicated opaque colors keep fine bars visible on light surfaces.
        ctx.globalAlpha = 1;

        for (let i = 0; i < n; i++) {
            const ratio = i / n;
            const barH = Math.max(1.5, peaks[i] * (h - 4));
            const inRange = range && ratio >= range.from && ratio <= range.to;
            const played = progressRatio > 0 && ratio <= progressRatio;
            const lit = played || inRange;
            ctx.fillStyle = lit ? playedColor : restColor;
            ctx.fillRect(
                i * barW + barW * 0.18,
                mid - barH / 2,
                Math.max(1, barW * 0.64),
                barH
            );
        }
        ctx.globalAlpha = 1;
    }

    /* ---------------- 播放器波形 ---------------- */

    const waveCanvas = document.getElementById("playerWave");
    let redrawPlayer = () => {};

    if (waveCanvas && audio) {
        const PLAYER_BUCKETS = 320;
        let currentUrl = "";
        let currentPeaks = null;
        let playerJob = null;
        let dragging = false;

        function currentRatio() {
            const dur = audio.duration;
            if (!Number.isFinite(dur) || dur <= 0) return 0;
            return Math.min(1, Math.max(0, audio.currentTime / dur));
        }

        function redraw() {
            drawBars(waveCanvas, currentPeaks, currentRatio());
        }
        redrawPlayer = redraw;

        function seekTo(event) {
            const rect = waveCanvas.getBoundingClientRect();
            if (rect.width < 1) return;
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const dur = audio.duration;
            if (Number.isFinite(dur) && dur > 0) {
                audio.currentTime = ratio * dur;
                redraw();
            }
        }

        waveCanvas.addEventListener("pointerdown", event => {
            dragging = true;
            waveCanvas.setPointerCapture(event.pointerId);
            seekTo(event);
        });
        waveCanvas.addEventListener("pointermove", event => {
            if (dragging) seekTo(event);
        });
        ["pointerup", "pointercancel"].forEach(type =>
            waveCanvas.addEventListener(type, () => { dragging = false; })
        );

        audio.addEventListener("loadedmetadata", () => {
            const url = audio.currentSrc;
            if (!url || url === currentUrl) return;
            currentUrl = url;
            currentPeaks = null;
            redraw();
            playerJob?.abort();
            playerJob = new AbortController();
            getPeaks(url, PLAYER_BUCKETS, { signal: playerJob.signal, priority: 10 })
                .then(peaks => {
                    if (url !== currentUrl) return;
                    currentPeaks = peaks;
                    redraw();
                })
                .catch(error => { if (error.name !== "AbortError") console.warn("waveform: 播放器波形解码失败", error); });
        });

        audio.addEventListener("timeupdate", () => {
            if (!dragging) redraw();
        });

        audio.addEventListener("emptied", () => {
            playerJob?.abort();
            currentUrl = "";
            currentPeaks = null;
            redraw();
        });
    }

    /* ---------------- 行内小波形 ---------------- */

    const ROW_BUCKETS = 140;
    const rowWaves = new WeakMap();
    const rowJobs = new Map();

    function hydrateRowWave(canvas) {
        if (canvas.dataset.waveDone) return;
        canvas.dataset.waveDone = "1";
        const url = canvas.dataset.waveSrc;
        if (!url) return;
        const from = parseFloat(canvas.dataset.waveFrom);
        const to = parseFloat(canvas.dataset.waveTo);
        const range = (Number.isFinite(from) && Number.isFinite(to) && to > from)
            ? { from, to }
            : null;
        const controller = new AbortController();
        rowJobs.set(canvas, controller);
        getPeaks(url, ROW_BUCKETS, { signal: controller.signal })
            .then(peaks => {
                rowWaves.set(canvas, { peaks, range });
                if (canvas.isConnected) drawBars(canvas, peaks, 0, range);
            })
            .catch(() => { delete canvas.dataset.waveDone; })
            .finally(() => { if (rowJobs.get(canvas) === controller) rowJobs.delete(canvas); });
    }

    function cancelRow(canvas) {
        rowJobs.get(canvas)?.abort();
        rowJobs.delete(canvas);
        if (!rowWaves.has(canvas)) delete canvas.dataset.waveDone;
    }
    const rowObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.isIntersecting) hydrateRowWave(entry.target);
            else cancelRow(entry.target);
        }
    }, { rootMargin: "100px" }) : null;
    const observedRows = new Set();
    function observeRow(canvas) {
        observedRows.add(canvas);
        if (rowObserver) rowObserver.observe(canvas);
        else hydrateRowWave(canvas);
    }
    function scanRowWaves(root) {
        if (root.nodeType !== 1) return;
        if (root.matches?.("canvas.row-wave")) observeRow(root);
        root.querySelectorAll?.("canvas.row-wave").forEach(observeRow);
    }
    const contentArea = document.getElementById("contentArea");
    if (contentArea) {
        new MutationObserver(mutations => {
            for (const canvas of observedRows) {
                if (!canvas.isConnected) {
                    cancelRow(canvas); rowObserver?.unobserve(canvas); observedRows.delete(canvas);
                }
            }
            for (const mutation of mutations) mutation.addedNodes.forEach(scanRowWaves);
        }).observe(contentArea, { childList: true, subtree: true });
    }
    document.querySelectorAll("canvas.row-wave").forEach(observeRow);

    // Canvas pixels do not follow CSS changes; repaint cached rows as well as
    // the player, including while playback is paused. No audio decoding needed.
    function redrawWaves() {
        redrawPlayer();
        document.querySelectorAll("canvas.row-wave").forEach(canvas => {
            const wave = rowWaves.get(canvas);
            if (wave) drawBars(canvas, wave.peaks, 0, wave.range);
        });
    }
    window.addEventListener("resize", redrawWaves);
    new MutationObserver(redrawWaves)
        .observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });

    // 供唱机模块复用峰值解码（唱片纹槽）
    window.Waveform = { getPeaks };
})();
