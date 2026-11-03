/* Scene navigation. Coordinates refer to the original 1586 × 992 paintings.
   Artwork and hit areas share one artboard so resizing never separates them. */
(function () {
    "use strict";

    const scenes = {
        night: {
            image: "assets/home-cat-night.png",
            petAnchor: [1095, 529],
            description: "蓝紫色夜里，白猫摊在奶油色沙发上，脚边是地毯与毛线球",
            targets: [
                { id: "recent", label: "最近播放", anchor: [1110, 936], points: [[482,894],[790,822],[908,832],[938,876],[1586,878],[1586,992],[970,973],[630,931]] },
                { id: "library", label: "音乐库", anchor: [1470, 737], points: [[1136,445],[1523,443],[1548,467],[1558,560],[1586,564],[1586,871],[945,878],[914,852],[905,724],[887,674],[904,628],[946,603],[1113,583]] },
                { id: "clips", label: "音乐片段", anchor: [850, 795], points: [[814,797],[873,791],[897,824],[887,866],[845,878],[807,853]] },
                { id: "cat", label: "轻轻摸摸", anchor: [1170, 541], points: [[1038,541],[1081,557],[1142,539],[1187,559],[1293,562],[1385,605],[1427,687],[1447,822],[1420,864],[1385,853],[1371,805],[1350,698],[1178,691],[1112,685],[1070,751],[1047,750],[1055,681],[1021,635],[1014,597]] }
            ]
        },
        cream: {
            image: "assets/home-cat-cream.png",
            petAnchor: [1315, 398],
            description: "奶油色留白里，白猫枕着圆卷扶手熟睡，浅粉地毯上留着一颗毛线球",
            targets: [
                { id: "recent", label: "最近播放", anchor: [1160, 927], points: [[480,777],[756,720],[821,790],[1425,860],[1522,733],[1586,716],[1586,936],[1284,982],[886,904],[616,840]] },
                { id: "library", label: "音乐库", anchor: [1460, 681], points: [[1045,278],[1162,269],[1485,285],[1532,323],[1537,466],[1550,519],[1530,633],[1510,771],[1455,854],[1393,865],[826,788],[800,729],[800,603],[773,561],[782,501],[822,467],[1008,432]] },
                { id: "clips", label: "音乐片段", anchor: [752, 806], points: [[717,810],[768,801],[789,832],[779,866],[735,876],[709,851]] },
                { id: "cat", label: "轻轻摸摸", anchor: [1298, 415], points: [[1228,425],[1278,448],[1355,408],[1376,456],[1373,513],[1335,540],[1310,573],[1266,595],[1219,584],[1167,583],[1110,572],[1021,610],[988,624],[992,652],[1032,675],[1007,709],[970,712],[935,688],[917,644],[931,577],[970,532],[1056,492],[1178,469]] }
            ]
        }
    };
    let activeRoot = null;
    let onNavigate = null;
    let revealed = false;
    let disposeMotion = null;
    let petFeedback = null, petStatus = null, petTimer = null;
    const hintKey = "music-library-scene-hint-dismissed";

    function hintDismissed() {
        try { return localStorage.getItem(hintKey) === "true"; } catch (_) { return false; }
    }

    function setRevealed(value) {
        revealed = value;
        activeRoot?.classList.toggle("show-scene-entrances", value);
        document.getElementById("sceneHelpBtn")?.setAttribute("aria-expanded", String(value));
    }

    function clearPetFeedback() {
        if (petTimer !== null) clearTimeout(petTimer);
        petTimer = null;
        petFeedback?.remove();
        petStatus?.remove();
        petFeedback = petStatus = null;
    }

    function preparePetFeedback(scene) {
        const board = activeRoot.querySelector(".scene-artboard");
        petFeedback = document.createElement("div");
        petFeedback.className = "scene-pet-feedback";
        petFeedback.hidden = true;
        petFeedback.setAttribute("aria-hidden", "true");
        petFeedback.style.left = scene.petAnchor[0] / 1586 * 100 + "%";
        petFeedback.style.top = scene.petAnchor[1] / 992 * 100 + "%";
        petFeedback.innerHTML = '<svg viewBox="0 0 32 30" focusable="false"><path d="M16 26C12 22 3 16 3.5 9.5 4 2 13 2 16 8 19 1 29 3 28.5 10 28 16 21 23 16 26Z"/></svg>';
        petStatus = document.createElement("span");
        petStatus.className = "scene-pet-status";
        petStatus.setAttribute("role", "status");
        petStatus.setAttribute("aria-live", "polite");
        board.append(petFeedback, petStatus);
    }

    function petCat() {
        if (!activeRoot?.isConnected || !petFeedback || petTimer !== null) return;
        window.HomeSceneMotion?.pet();
        petFeedback.classList.toggle("is-animated", window.HomeSceneMotion?.canAnimate() ?? false);
        petFeedback.hidden = false;
        petStatus.textContent = "猫咪收到你的摸摸啦。";
        // One gentle response per touch; repeated clicks never queue gestures.
        petTimer = setTimeout(() => {
            petTimer = null;
            if (petFeedback) petFeedback.hidden = true;
            if (petStatus) petStatus.textContent = "";
        }, 2400);
    }

    function refresh(theme) {
        if (!activeRoot?.isConnected) return;
        clearPetFeedback();
        disposeMotion?.();
        disposeMotion = null;
        const sceneTheme = theme === "night" ? "night" : "cream";
        const scene = scenes[sceneTheme];
        const focused = activeRoot.querySelector(".scene-hotspot:focus")?.dataset.destination;
        const image = activeRoot.querySelector(".scene-artwork");
        image.src = scene.image;
        image.alt = scene.description;
        disposeMotion = window.HomeSceneMotion?.mount(activeRoot.querySelector(".scene-artboard"), image, sceneTheme);
        preparePetFeedback(scene);
        const targets = activeRoot.querySelector(".scene-targets");
        targets.replaceChildren();
        scene.targets.forEach(target => {
            const wrapper = document.createElement("div");
            wrapper.className = "scene-target";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "scene-hotspot scene-hotspot-" + target.id;
            button.dataset.destination = target.id;
            button.setAttribute("aria-label", target.id === "cat" ? "轻轻摸摸猫咪" : "打开" + target.label);
            const xs = target.points.map(point => point[0]);
            const ys = target.points.map(point => point[1]);
            const left = Math.min(...xs), top = Math.min(...ys);
            const width = Math.max(...xs) - left, height = Math.max(...ys) - top;
            button.style.left = left / 1586 * 100 + "%";
            button.style.top = top / 992 * 100 + "%";
            button.style.width = width / 1586 * 100 + "%";
            button.style.height = height / 992 * 100 + "%";
            button.style.clipPath = "polygon(" + target.points.map(point =>
                (point[0] - left) / width * 100 + "% " + (point[1] - top) / height * 100 + "%"
            ).join(",") + ")";
            // Feather a faint visual layer independently of the exact hit area.
            const glow = document.createElement("span");
            glow.className = "scene-hover-glow";
            glow.setAttribute("aria-hidden", "true");
            Object.assign(glow.style, {
                left: button.style.left, top: button.style.top,
                width: button.style.width, height: button.style.height
            });
            const glowShape = document.createElement("span");
            glowShape.className = "scene-hover-shape";
            glowShape.style.clipPath = button.style.clipPath;
            glow.append(glowShape);
            button.addEventListener("click", () => {
                if (target.id === "cat") petCat();
                else onNavigate?.(target.id);
            });
            wrapper.append(glow, button);
            if (target.id === "cat") {
                // A small keyboard-only marker keeps focus visible without
                // tinting the painting or bringing back a text bubble.
                const marker = document.createElement("span");
                marker.className = "scene-cat-focus";
                marker.setAttribute("aria-hidden", "true");
                marker.style.left = (scene.petAnchor[0] - 38) / 1586 * 100 + "%";
                marker.style.top = scene.petAnchor[1] / 992 * 100 + "%";
                wrapper.append(marker);
            } else {
                const label = document.createElement("span");
                label.className = "scene-label";
                label.setAttribute("aria-hidden", "true");
                label.textContent = target.label + " ↗";
                label.style.left = target.anchor[0] / 1586 * 100 + "%";
                label.style.top = target.anchor[1] / 992 * 100 + "%";
                wrapper.append(label);
            }
            targets.append(wrapper);
        });
        if (focused) targets.querySelector('[data-destination="' + focused + '"]')?.focus();
    }

    function mount(root, handlers) {
        unmount();
        activeRoot = root;
        onNavigate = handlers.navigate;
        revealed = false;
        const help = document.getElementById("sceneHelpBtn");
        help.onclick = () => setRevealed(!revealed);
        help.onkeydown = event => {
            if (event.key === "Escape") { setRevealed(false); event.stopPropagation(); }
        };
        help.setAttribute("aria-expanded", "false");
        const hint = root.querySelector(".scene-discovery");
        hint.hidden = hintDismissed();
        hint.querySelector(".scene-discover-btn").onclick = () => setRevealed(!revealed);
        hint.querySelector(".scene-dismiss-btn").onclick = () => {
            hint.hidden = true;
            setRevealed(false);
            try { localStorage.setItem(hintKey, "true"); } catch (_) { /* Current session only. */ }
            help.focus();
        };
        root.addEventListener("keydown", event => {
            if (event.key === "Escape") setRevealed(false);
            if (event.target.closest("button, input")) event.stopPropagation();
        });
        refresh(document.body.dataset.theme);
    }

    function unmount() {
        clearPetFeedback();
        disposeMotion?.();
        disposeMotion = null;
        activeRoot = null;
        onNavigate = null;
        const help = document.getElementById("sceneHelpBtn");
        if (help) { help.onclick = null; help.onkeydown = null; help.setAttribute("aria-expanded", "false"); }
    }

    window.HomeScene = { mount, refresh, unmount };
})();
