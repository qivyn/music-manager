/* Change the whole palette together, with an illustrated-scene fallback for
   WebViews without document.startViewTransition. Audio and live DOM stay put. */
(function () {
    "use strict";

    const duration = 520;
    const assets = new Map();
    let switching = false;

    function loadAsset(source) {
        if (assets.has(source)) return assets.get(source);
        const task = new Promise(resolve => {
            const image = new Image();
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                image.onload = image.onerror = null;
                resolve(image.complete && image.naturalWidth > 0);
            };
            const timeout = setTimeout(finish, 2500);
            image.onload = () => {
                if (image.decode) image.decode().catch(() => {}).then(finish);
                else finish();
            };
            image.onerror = finish;
            image.src = source;
        });
        assets.set(source, task);
        task.then(loaded => { if (!loaded) assets.delete(source); });
        return task;
    }

    function prepare(theme) {
        return Promise.all([
            loadAsset(`assets/home-cat-${theme}.png`),
            loadAsset(`assets/home-cat-${theme}-background-v1.png`)
        ]);
    }

    function captureBackdrop() {
        const home = document.body.classList.contains("view-home");
        const scene = document.querySelector(home ? ".home-scene" : ".app");
        if (!scene) return null;
        const artwork = scene?.querySelector(".scene-artwork");
        if (home && (!artwork?.complete || !artwork.naturalWidth)) return null;
        const layer = document.createElement("div");
        layer.className = home ? "scene-theme-snapshot" : "workspace-theme-snapshot";
        layer.setAttribute("aria-hidden", "true");
        layer.style.background = getComputedStyle(scene).background;
        if (home) {
            const board = document.createElement("div");
            board.className = "scene-artboard";
            board.append(artwork.cloneNode(false));
            layer.append(board);
        }
        scene.append(layer);
        return layer;
    }

    async function change(theme, apply) {
        if (switching || document.body.dataset.theme === theme) return;
        switching = true;
        const root = document.documentElement;
        const button = document.getElementById("themeToggleBtn");
        let snapshot = null;
        let updated = false;
        const update = () => {
            if (updated) return;
            updated = true;
            apply(theme);
        };
        button?.setAttribute("aria-busy", "true");
        try {
            await prepare(theme);
            if (document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                update();
                return;
            }
            if (typeof document.startViewTransition === "function") {
                root.classList.add("theme-crossfade");
                let transition;
                try { transition = document.startViewTransition(update); }
                catch (_) { /* Fall back when snapshot capture is unavailable. */ }
                if (transition) {
                    transition.ready.catch(() => {});
                    transition.updateCallbackDone.catch(() => {});
                    await transition.finished.catch(() => {});
                    update();
                    return;
                }
                root.classList.remove("theme-crossfade");
            }
            snapshot = captureBackdrop();
            root.classList.add("theme-color-transition");
            // Commit transition rules against the old colors before changing them.
            getComputedStyle(document.body).color;
            update();
            snapshot?.classList.add("is-leaving");
            await new Promise(resolve => setTimeout(resolve, duration + 60));
        } finally {
            snapshot?.remove();
            root.classList.remove("theme-crossfade", "theme-color-transition");
            button?.removeAttribute("aria-busy");
            switching = false;
        }
    }

    window.ThemeTransition = { prepare, change };
})();
