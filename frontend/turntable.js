/* =========================================================
   声场唱机 — Three.js 首页唱机 + 播放条 mini 唱片
   独立于 app.js 运行；通过 window.Turntable 对外提供：
     mount(container)  挂到首页容器（幂等）
     sleep()           离开首页时休眠渲染
     react(view)       菜单悬停联动："all" | "clips" | "albums" | "recent"
     setProgram({counts})           计数窗真实数据
     setTrack({coverArt, grooveUrl}) 当前曲目封面/波形
     setTheme("archive"|"sky")      整机换肤
     diveIn(cb)        镜头推进唱片后回调（进工作区过渡）
   无 THREE（vendor 缺失）时大唱机自动禁用，mini 唱片不受影响。
========================================================= */

(function () {
    "use strict";

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const audio = document.getElementById("barAudio");

    let playing = false;

    function isPlaying() {
        return playing || !!(audio && !audio.paused && !audio.ended && audio.currentSrc);
    }

    /* =========================================================
       Mini 唱片（播放条，2D Canvas）
    ========================================================== */

    const miniCanvas = document.querySelector(".player-vinyl");
    const mini = { angle: 0, speed: 0, raf: 0, cover: null, disc: null };

    function miniDrawDisc() {
        if (!miniCanvas) return;
        const S = 168, C = S / 2;
        const off = document.createElement("canvas");
        off.width = off.height = S;
        const x = off.getContext("2d");

        x.fillStyle = "#0b0a0d";
        x.beginPath(); x.arc(C, C, C - 2, 0, Math.PI * 2); x.fill();

        for (let r = C * 0.42; r < C - 6; r += 4) {
            x.strokeStyle = "rgba(255,255,255,.07)";
            x.lineWidth = 1;
            x.beginPath(); x.arc(C, C, r, 0, Math.PI * 2); x.stroke();
        }

        x.save();
        x.beginPath(); x.arc(C, C, C * 0.38, 0, Math.PI * 2); x.clip();
        if (mini.cover) {
            x.drawImage(mini.cover, C - C * 0.38, C - C * 0.38, C * 0.76, C * 0.76);
        } else {
            const g = x.createRadialGradient(C - 6, C - 6, 2, C, C, C * 0.38);
            g.addColorStop(0, "#e08a3c");
            g.addColorStop(1, "#a85f1c");
            x.fillStyle = g;
            x.fillRect(0, 0, S, S);
        }
        x.restore();

        x.strokeStyle = "rgba(255,244,224,.55)";
        x.lineWidth = 1.5;
        x.beginPath(); x.arc(C, C, C * 0.38 - 1, 0, Math.PI * 2); x.stroke();

        x.fillStyle = "#0a0a0c";
        x.beginPath(); x.arc(C, C, 3, 0, Math.PI * 2); x.fill();

        mini.disc = off;
    }

    function miniFrame() {
        mini.raf = 0;
        mini.speed += ((isPlaying() ? 2.3 : 0) - mini.speed) * 0.03;
        mini.angle += mini.speed / 60;

        const ctx = miniCanvas.getContext("2d");
        const S = miniCanvas.width, C = S / 2;
        ctx.clearRect(0, 0, S, S);
        if (mini.disc) {
            ctx.save();
            ctx.translate(C, C);
            ctx.rotate(mini.angle);
            ctx.drawImage(mini.disc, -C, -C);
            ctx.restore();
            ctx.save();
            ctx.beginPath(); ctx.arc(C, C, C - 2, 0, Math.PI * 2); ctx.clip();
            ctx.translate(C, C);
            ctx.rotate(mini.angle * 0.92);
            const g = ctx.createLinearGradient(0, -C, 0, C);
            g.addColorStop(0, "rgba(255,255,255,0)");
            g.addColorStop(.5, "rgba(255,255,255,.12)");
            g.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, C, -0.4, 0.4);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
        if (mini.speed > 0.004 || isPlaying()) {
            mini.raf = requestAnimationFrame(miniFrame);
        }
    }

    function miniKick() {
        if (!miniCanvas || reducedMotion.matches) { miniStatic(); return; }
        if (!mini.raf) mini.raf = requestAnimationFrame(miniFrame);
    }

    function miniStatic() {
        if (!miniCanvas) return;
        const ctx = miniCanvas.getContext("2d");
        ctx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
        if (mini.disc) ctx.drawImage(mini.disc, 0, 0);
    }

    function miniSetCover(dataUrl) {
        const revision = mini.coverRevision = (mini.coverRevision || 0) + 1;
        if (!dataUrl) { mini.cover = null; miniDrawDisc(); miniKick(); return; }
        const img = new Image();
        img.onload = () => { if (revision === mini.coverRevision) { mini.cover = img; miniDrawDisc(); miniKick(); } };
        img.src = dataUrl;
    }

    /* =========================================================
       大唱机（Three.js，首页）
       浅粉桌面唱机 / 奶油复古唱机，两套独立机身与控制面板；
       纯色页面上以近景展示唱盘、唱臂和细腻的烤漆表面。
    ========================================================== */

    const FAKE_PEAKS = new Float32Array(720);
    for (let i = 0; i < 720; i++) {
        const t = i / 720;
        FAKE_PEAKS[i] = Math.min(1, Math.abs(
            Math.sin(t * 43) * .5 + Math.sin(t * 17 + 2) * .3 + Math.sin(t * 91 + 5) * .2
        ));
    }

    let S = null;
    let hasIntro = false;
    let hasDived = false;
    let pendingStats = null;
    let playbackHandler = null;
    let emptyDropHandler = null;   // 空落针时由应用侧决定放哪张；返回 true 表示已接管
    let lastTrackInfo = { title: "", artist: "" };
    let trackRevision = 0;
    let coverRevision = 0;
    let pendingTrack = null;

    const LABEL_COLORS = { archive: ["#eee4cf", "#c5ab7f"], sky: ["#f2e9e5", "#cdb8bc"] };

    /* ---------------- 程序化贴图 ---------------- */

    // 柔光箱只用于机身与金属的环境反射，不渲染到页面背景。
    function makeEnvTexture(renderer, scene) {
        const canvas = document.createElement("canvas");
        canvas.width = 1024; canvas.height = 512;
        const ctx = canvas.getContext("2d");
        const gradient = ctx.createLinearGradient(0, 0, 0, 512);
        gradient.addColorStop(0, "#6c6a65");
        gradient.addColorStop(.55, "#343638");
        gradient.addColorStop(1, "#151719");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1024, 512);
        const softbox = ctx.createLinearGradient(50, 0, 310, 0);
        softbox.addColorStop(0, "rgba(255,249,236,0)");
        softbox.addColorStop(.2, "rgba(255,249,236,.9)");
        softbox.addColorStop(.8, "rgba(255,249,236,.9)");
        softbox.addColorStop(1, "rgba(255,249,236,0)");
        ctx.fillStyle = softbox;
        ctx.fillRect(50, 70, 260, 300);
        ctx.fillStyle = "rgba(216,233,244,.55)";
        ctx.fillRect(690, 120, 85, 260);
        const texture = new THREE.CanvasTexture(canvas);
        texture.encoding = THREE.sRGBEncoding;
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromEquirectangular(texture).texture;
        pmrem.dispose(); texture.dispose();
    }

    function makeBrushedTexture() {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#a8a8a8";
        ctx.fillRect(0, 0, 256, 256);
        for (let y = 0; y < 256; y++) {
            const value = 148 + Math.round(Math.sin(y * 73.13) * 18);
            ctx.fillStyle = `rgb(${value},${value},${value})`;
            ctx.fillRect(0, y, 256, 1);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        return texture;
    }

    function roundedBox(width, height, depth, radius = .12) {
        radius = Math.min(radius, width * .48, depth * .48);
        const bevel = Math.min(.03, height * .22, depth * .12);
        const shape = new THREE.Shape();
        const x = -width / 2, z = -depth / 2;
        shape.moveTo(x + radius, z);
        shape.lineTo(x + width - radius, z);
        shape.quadraticCurveTo(x + width, z, x + width, z + radius);
        shape.lineTo(x + width, z + depth - radius);
        shape.quadraticCurveTo(x + width, z + depth, x + width - radius, z + depth);
        shape.lineTo(x + radius, z + depth);
        shape.quadraticCurveTo(x, z + depth, x, z + depth - radius);
        shape.lineTo(x, z + radius);
        shape.quadraticCurveTo(x, z, x + radius, z);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: height - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, steps: 1, curveSegments: 8 });
        geometry.translate(0, 0, -(height - bevel * 2) / 2);
        geometry.rotateX(-Math.PI / 2);
        const positions = geometry.attributes.position, normals = geometry.attributes.normal, uv = geometry.attributes.uv;
        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
            if (Math.abs(normals.getY(i)) > .5) uv.setXY(i, x / width + .5, z / depth + .5);
            else if (Math.abs(normals.getZ(i)) > .5) uv.setXY(i, x / width + .5, y / height + .5);
            else uv.setXY(i, z / depth + .5, y / height + .5);
        }
        return geometry;
    }

    // 微小起伏只参与表面高光，机身颜色保持均匀。
    function makePaintTexture() {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, 128, 128);
        for (let y = 0; y < 128; y += 2) for (let x = 0; x < 128; x += 2) {
            const value = 120 + ((x * 17 + y * 37) % 16);
            ctx.fillStyle = `rgb(${value},${value},${value})`;
            ctx.fillRect(x, y, 1, 1);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(6, 6);
        return texture;
    }

    function makeSpeakerTexture() {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#998974";
        ctx.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 256; i += 6) {
            ctx.fillStyle = "#d0c1a5"; ctx.fillRect(i, 0, 2, 256);
            ctx.fillStyle = "#655d50"; ctx.fillRect(0, i, 256, 2);
            ctx.fillStyle = "#b6a68a"; ctx.fillRect(0, i + 2, 256, 1);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.encoding = THREE.sRGBEncoding;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(3, 1);
        texture.anisotropy = 8;
        return texture;
    }

    function makeKnob(state, parent, position, { front = false, radius = .22, interactive = true } = {}) {
        // 外层负责旋钮朝向，内层只绕自身轴旋转，前置旋钮也不会歪斜。
        const mount = new THREE.Group();
        mount.position.set(...position);
        if (front) mount.rotation.x = Math.PI / 2;
        parent.add(mount);
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(radius + .045, radius + .045, .025, 48), state.hardwareMat);
        mount.add(ring);
        const rotor = new THREE.Group();
        rotor.position.y = .09;
        mount.add(rotor);
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + .008, .15, 64), state.ivoryMat);
        knob.castShadow = true;
        rotor.add(knob);
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * .78, radius * .78, .008, 48), state.knobCapMat);
        cap.position.y = .079;
        rotor.add(cap);
        const pointer = new THREE.Mesh(new THREE.BoxGeometry(.017, .012, radius * .36), state.inkMat);
        pointer.position.set(0, .087, -radius * .52);
        rotor.add(pointer);
        for (let i = 0; i < 36; i++) {
            const angle = i / 36 * Math.PI * 2;
            const notch = new THREE.Mesh(new THREE.BoxGeometry(.009, .11, .009), state.knobRibMat);
            notch.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
            rotor.add(notch);
        }
        if (interactive) {
            rotor.traverse(part => { part.userData.part = "knob"; });
            rotor.userData.knobRoot = true;
            state.knobMeshes.push(rotor);
        }
        return rotor;
    }

    function drawRecord(state) {
        const c = state.recordCanvas;
        const x = c.getContext("2d");
        const S = c.width, C = S / 2;
        const R_OUT = C - 4, R_IN = 182, R_LABEL = 170;
        const peaks = state.peaks;
        const isSky = state.theme === "sky";

        const base = x.createRadialGradient(C, C, R_LABEL, C, C, R_OUT);
        if (isSky) {
            base.addColorStop(0, "#22272c");
            base.addColorStop(.78, "#13171c");
            base.addColorStop(1, "#0b0e12");
        } else {
            base.addColorStop(0, "#141317");
            base.addColorStop(.78, "#0b0a0d");
            base.addColorStop(1, "#070608");
        }
        x.fillStyle = base;
        x.fillRect(0, 0, S, S);

        for (let r = R_IN; r < R_OUT - 6; r += 3) {
            for (let s = 0; s < 360; s += 3) {
                const a0 = s / 360 * Math.PI * 2;
                const peak = peaks[Math.floor(s / 360 * peaks.length)];
                x.strokeStyle = `rgba(255,255,255,${.03 + peak * .08})`;
                x.lineWidth = 1.1;
                x.beginPath();
                x.arc(C, C, r, a0, a0 + 0.052);
                x.stroke();
            }
        }

        x.strokeStyle = "rgba(255,255,255,.15)";
        x.lineWidth = 2;
        x.beginPath(); x.arc(C, C, R_OUT - 4, 0, Math.PI * 2); x.stroke();

        const [la, lb] = LABEL_COLORS[state.theme] || LABEL_COLORS.archive;
        x.save();
        x.beginPath(); x.arc(C, C, R_LABEL, 0, Math.PI * 2); x.clip();
        if (state.coverImg) {
            const img = state.coverImg;
            const side = Math.min(img.width, img.height);
            x.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side,
                C - R_LABEL, C - R_LABEL, R_LABEL * 2, R_LABEL * 2);
        } else {
            const lg = x.createRadialGradient(C - 34, C - 34, 10, C, C, R_LABEL);
            lg.addColorStop(0, la); lg.addColorStop(1, lb);
            x.fillStyle = lg;
            x.fillRect(C - R_LABEL, C - R_LABEL, R_LABEL * 2, R_LABEL * 2);
            x.fillStyle = isSky ? "rgba(255,255,255,.94)" : "rgba(40,24,10,.85)";
            x.font = "600 44px 'Songti SC', serif";
            x.textAlign = "center"; x.textBaseline = "middle";
            x.fillText("声场档案", C, C - 30);
            x.font = "19px ui-monospace, monospace";
            x.fillStyle = isSky ? "rgba(255,255,255,.68)" : "rgba(40,24,10,.6)";
            x.fillText("CUT & CUE · 33⅓ RPM", C, C + 24);
        }
        x.restore();

        x.strokeStyle = isSky ? "rgba(255,255,255,.6)" : "rgba(255,244,224,.5)";
        x.lineWidth = 3;
        x.beginPath(); x.arc(C, C, R_LABEL - 9, 0, Math.PI * 2); x.stroke();

        x.fillStyle = "#0a0a0c";
        x.beginPath(); x.arc(C, C, 12, 0, Math.PI * 2); x.fill();

        state.recordTex.needsUpdate = true;
    }

    function drawCounter(state) {
        const ctx = state.counterCanvas.getContext("2d");
        ctx.clearRect(0, 0, 512, 128);
        ctx.fillStyle = state.theme === "archive" ? "#7a705c" : "#92777e";
        ctx.font = "500 46px ui-monospace, monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("33⅓ RPM", 256, 66);
        state.counterTex.needsUpdate = true;
    }

    function drawFrontPanel(state) {
        const canvas = document.createElement("canvas");
        canvas.width = 1024; canvas.height = 128;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, 1024, 128);
        ctx.fillStyle = state.theme === "archive" ? "#7a705c" : "#92777e";
        ctx.font = "500 40px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(state.theme === "archive" ? "SOUND FIELD   /   STEREO" : "S / F   ·   ANALOGUE", 512, 64);
        const texture = new THREE.CanvasTexture(canvas);
        texture.encoding = THREE.sRGBEncoding;
        texture.anisotropy = 8;
        return texture;
    }

    // 只用可见表面取景，透明点击热区不应把镜头推远。
    function framingPoints(root) {
        root.updateMatrixWorld(true);
        const points = [];
        const visit = object => {
            if (!object.visible) return;
            if (object.isMesh && object.geometry?.attributes.position) {
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                if (materials.some(material => material.visible && (!material.transparent || material.opacity > 0))) {
                    const positions = object.geometry.attributes.position;
                    for (let i = 0; i < positions.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld));
                }
            }
            object.children.forEach(visit);
        };
        visit(root);
        return points;
    }

    /* ---------------- 场景构建 ---------------- */

    function buildScene(container) {
        const state = {
            container, deck: null,
            renderer: null, scene: null, camera: null,
            cam: { radius: 10, theta: .14, phi: 1 },
            camBase: { radius: 10, theta: .14, phi: 1 },
            camOffset: { theta: 0, phi: 0, radius: 0 },
            camOffsetTgt: { theta: 0, phi: 0, radius: 0 },
            camTarget: null,
            needle: "parked",   // "parked"(回架) | "down"(落针)
            cur: {
                recordY: 0, speed: 0, armLift: 0, armAngle: -1.59, spin: 0, boost: 0, flash: 0,
                recordX: 0, scratchV: 0, scratchTime: 0, knobFlick: 0, leverFlick: 0
            },
            recordGroup: null, armLiftG: null, armSwingG: null,
            ledMat: null, sheen: null, plinthMat: null, groundMat: null, frontMat: null,
            recordCanvas: null, recordTex: null, recordMat: null,
            counterCanvas: null, counterTex: null, counterMat: null,
            plateMesh: null, counterMesh: null, frontPanelMesh: null,
            recordMesh: null, leverMesh: null, flickKnob: null,
            hitTargets: [], platterPos: null, platterX: 0, demo: false, scratching: false,
            scratchAudio: false, prevVolume: 1,
            peaks: FAKE_PEAKS, coverImg: null,
            theme: "archive",
            stats: [], statIdx: 0, statTimer: 0,
            awake: false, busy: false, raf: 0, motionTimers: new Set(),
            platterTop: .84, armPark: -1.59, armPlay: -2.10,
            trackTitle: "", trackArtist: ""
        };

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.outputEncoding = THREE.sRGBEncoding;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        state.renderer = renderer;

        const scene = new THREE.Scene();
        state.scene = scene;
        makeEnvTexture(renderer, scene);

        state.camera = new THREE.PerspectiveCamera(32, 2, 0.1, 100);
        state.camTarget = new THREE.Vector3(0, .5, .05);

        // 暖色电影光：左侧窗光为主光
        scene.add(new THREE.HemisphereLight(0xfff5e9, 0x303b43, 0.65));

        const key = new THREE.DirectionalLight(0xffd9a0, 1.35);
        key.position.set(-3.5, 6.5, 4);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.left = key.shadow.camera.bottom = -6;
        key.shadow.camera.right = key.shadow.camera.top = 6;
        key.shadow.radius = 5;
        scene.add(key);
        state.keyLight = key;

        const fill = new THREE.PointLight(0x9db8c8, 0.3, 30);
        fill.position.set(-4.5, 3, -2.5);
        scene.add(fill);

        const sheen = new THREE.PointLight(0xfff2dd, 0.55, 12);
        sheen.position.set(-0.6, 3.4, 0.4);
        scene.add(sheen);
        state.sheen = sheen;

        // 只接收阴影的透明地面：不要桌面，唱机直接落在页面背景上
        const groundMat = new THREE.ShadowMaterial({ opacity: 0.26 });
        state.groundMat = groundMat;
        const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), groundMat);
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -.31;
        ground.receiveShadow = true;
        scene.add(ground);
        state.groundMesh = ground;

        /* ---------- 两款机身：浅粉桌面式 / 奶油复古式 ---------- */
        const deck = new THREE.Group();
        scene.add(deck);
        state.deck = deck;
        state.brushedTexture = makeBrushedTexture();
        state.paintTexture = makePaintTexture();
        state.plinthMat = new THREE.MeshPhysicalMaterial({
            color: 0xf0d6de, roughness: .32, metalness: 0,
            clearcoat: .38, clearcoatRoughness: .3,
            bumpMap: state.paintTexture, bumpScale: .009
        });
        state.creamBodyMat = new THREE.MeshPhysicalMaterial({
            color: 0xe7dcc4, roughness: .36, metalness: 0,
            clearcoat: .32, clearcoatRoughness: .34,
            bumpMap: state.paintTexture, bumpScale: .012
        });
        state.topPlateMat = new THREE.MeshPhysicalMaterial({
            color: 0xf5e2e7, roughness: .35, metalness: 0,
            clearcoat: .3, clearcoatRoughness: .34,
            bumpMap: state.paintTexture, bumpScale: .006
        });
        state.hardwareMat = new THREE.MeshStandardMaterial({ color: 0xd9dcdb, metalness: .86, roughness: .24, roughnessMap: state.brushedTexture });
        state.ivoryMat = new THREE.MeshPhysicalMaterial({ color: 0xf4f0e7, roughness: .3, metalness: .04, clearcoat: .25 });
        state.knobCapMat = new THREE.MeshStandardMaterial({ color: 0xf9f6ef, roughness: .42, metalness: .12 });
        state.knobRibMat = new THREE.MeshStandardMaterial({ color: 0xc8c2b6, roughness: .55 });
        state.inkMat = new THREE.MeshStandardMaterial({ color: 0x746964, roughness: .7 });
        state.footMat = new THREE.MeshStandardMaterial({ color: 0xd6d0ca, roughness: .72 });
        state.knobMeshes = [];
        state.bodyVariants = { archive: new THREE.Group(), sky: new THREE.Group() };
        const pink = state.bodyVariants.sky, cream = state.bodyVariants.archive;
        pink.name = "sakura-desktop"; cream.name = "cream-retro";
        deck.add(pink, cream);

        function body(parent, geometry, material, position, name) {
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(...position);
            mesh.name = name;
            mesh.castShadow = mesh.receiveShadow = true;
            parent.add(mesh);
            return mesh;
        }
        // Lenco 的低矮方形轮廓：连续浅粉机身、细小接缝与奶白隔振脚。
        body(pink, roundedBox(6.8, .44, 4.6, .16), state.plinthMat, [0, .29, 0], "pink-plinth");
        body(pink, roundedBox(6.7, .045, 4.5, .14), state.ivoryMat, [0, .523, 0], "ivory-seam");
        body(pink, roundedBox(6.72, .065, 4.52, .15), state.topPlateMat, [0, .57, 0], "pink-top");
        for (const x of [-2.68, 2.68]) for (const z of [-1.64, 1.64]) {
            body(pink, new THREE.CylinderGeometry(.24, .27, .2, 48), state.ivoryMat, [x, -.04, z], "ivory-foot");
            for (let i = 0; i < 3; i++) body(pink, new THREE.CylinderGeometry(.251, .251, .014, 48), state.footMat, [x, -.085 + i * .045, z], "foot-rib");
            body(pink, new THREE.CylinderGeometry(.25, .25, .035, 48), state.footMat, [x, -.145, z], "rubber-pad");
        }
        makeKnob(state, pink, [2.72, .63, 1.65], { radius: .22 });

        // Brad 的圆润厚机身：前置双旋钮与电源拨键，侧面织物音箱。
        body(cream, roundedBox(6.55, .68, 4.92, .34), state.creamBodyMat, [0, .21, 0], "cream-shell");
        body(cream, roundedBox(6.4, .06, 4.76, .28), state.topPlateMat, [0, .58, 0], "cream-top");
        body(cream, roundedBox(6.26, .065, 4.64, .28), state.ivoryMat, [0, -.15, 0], "cream-base-trim");
        for (const x of [-2.57, 2.57]) for (const z of [-1.74, 1.74]) {
            body(cream, new THREE.CylinderGeometry(.19, .23, .12, 40), state.footMat, [x, -.24, z], "retro-foot");
        }
        makeKnob(state, cream, [-1.92, .23, 2.46], { front: true, radius: .235 });
        makeKnob(state, cream, [1.92, .23, 2.46], { front: true, radius: .235, interactive: false });
        const toggleMount = new THREE.Group();
        toggleMount.position.set(0, .23, 2.48);
        toggleMount.rotation.x = Math.PI / 2;
        cream.add(toggleMount);
        body(toggleMount, new THREE.CylinderGeometry(.105, .105, .025, 32), state.hardwareMat, [0, 0, 0], "power-collar");
        const toggle = body(toggleMount, new THREE.CylinderGeometry(.032, .045, .18, 24), state.ivoryMat, [0, .08, 0], "power-toggle");
        toggle.rotation.z = -.25;
        state.retroToggle = toggle;
        toggleMount.traverse(part => { part.userData.part = "lever"; });
        state.retroPower = toggleMount;
        const speakerTexture = makeSpeakerTexture();
        const cloth = new THREE.MeshStandardMaterial({ map: speakerTexture, bumpMap: speakerTexture, bumpScale: .025, roughness: 1 });
        for (const side of [-1, 1]) {
            const bezel = body(cream, roundedBox(2.75, .39, .055, .12), state.ivoryMat, [side * 3.286, .2, -.12], "speaker-bezel");
            bezel.rotation.y = side * Math.PI / 2;
            const grille = body(cream, roundedBox(2.59, .29, .06, .1), cloth, [side * 3.32, .2, -.12], "woven-speaker");
            grille.rotation.y = side * Math.PI / 2;
        }
        // 铰链与固定螺丝保留真实器物的结构细节，默认展示打开台面。
        for (const parent of [pink, cream]) for (const x of [-2.25, 2.1]) {
            body(parent, roundedBox(.38, .1, .14, .04), state.hardwareMat, [x, .63, -2.18], "lid-hinge");
            body(parent, new THREE.CylinderGeometry(.033, .033, .008, 16), state.inkMat, [x, .685, -2.18], "hinge-screw");
        }

        // 台面印字与真实转速标记，避免装饰性屏幕。
        state.frontMat = new THREE.MeshStandardMaterial({ transparent: true, roughness: .85, metalness: 0, depthWrite: false });
        state.frontPanelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.75, .22), state.frontMat);
        state.frontPanelMesh.rotation.x = -Math.PI / 2;
        state.frontPanelMesh.position.set(.35, .61, 2.02);
        deck.add(state.frontPanelMesh);
        state.counterCanvas = document.createElement("canvas");
        state.counterCanvas.width = 512; state.counterCanvas.height = 128;
        state.counterTex = new THREE.CanvasTexture(state.counterCanvas);
        state.counterTex.encoding = THREE.sRGBEncoding;
        state.counterMat = new THREE.MeshStandardMaterial({ map: state.counterTex, transparent: true, roughness: .85, depthWrite: false });
        state.counterMesh = new THREE.Mesh(new THREE.PlaneGeometry(.66, .165), state.counterMat);
        state.counterMesh.rotation.x = -Math.PI / 2;
        state.counterMesh.position.set(-2.05, .61, 2.02);
        deck.add(state.counterMesh);

        /* ---------- 厚转盘：银色频闪刻度、黑胶垫、大尺寸黑胶 ---------- */
        const PLATTER = { x: -.95, z: .05 };
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.12, .13, 160), state.hardwareMat);
        rim.position.set(PLATTER.x, .71, PLATTER.z);
        rim.castShadow = rim.receiveShadow = true;
        deck.add(rim);
        state.platterFeltMat = new THREE.MeshStandardMaterial({ color: 0x181a1d, roughness: .95 });
        const mat = new THREE.Mesh(new THREE.CylinderGeometry(2.06, 2.06, .028, 128), state.platterFeltMat);
        mat.position.set(PLATTER.x, .8, PLATTER.z);
        mat.receiveShadow = true;
        deck.add(mat);
        const recordGroup = new THREE.Group();
        recordGroup.position.set(PLATTER.x, .84, PLATTER.z);
        deck.add(recordGroup);
        state.recordGroup = recordGroup;
        state.recordCanvas = document.createElement("canvas");
        state.recordCanvas.width = state.recordCanvas.height = 1024;
        state.recordTex = new THREE.CanvasTexture(state.recordCanvas);
        state.recordTex.encoding = THREE.sRGBEncoding;
        state.recordTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        state.recordMat = new THREE.MeshStandardMaterial({ map: state.recordTex, roughness: .28, metalness: .18 });
        state.recordSideMat = new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: .4 });
        const record = new THREE.Mesh(new THREE.CylinderGeometry(1.98, 1.98, .036, 160), [state.recordSideMat, state.recordMat, state.recordSideMat]);
        record.castShadow = record.receiveShadow = true;
        recordGroup.add(record);
        const spindle = new THREE.Mesh(new THREE.CylinderGeometry(.034, .034, .13, 32), state.hardwareMat);
        spindle.position.y = .07;
        recordGroup.add(spindle);

        /* ---------- 独立直管唱臂与万向支架 ---------- */

        const metalMat = state.hardwareMat;
        const darkMat = new THREE.MeshStandardMaterial({ color: 0x2c2820, roughness: .5, metalness: .3 });
        // 唱臂组件独立材质，保留细腻的金属高光。
        const armMat = new THREE.MeshPhysicalMaterial({ color: 0xf4f0e7, metalness: .08, roughness: .3, clearcoat: .2 });
        state.armMat = armMat;

        const armBase = new THREE.Group();
        armBase.position.set(2, .68, -1.28);
        const mountingFoot = new THREE.Mesh(new THREE.CylinderGeometry(.27, .29, .14, 48), state.hardwareMat);
        mountingFoot.position.set(2, .62, -1.28);
        mountingFoot.castShadow = true;
        deck.add(mountingFoot);
        deck.add(armBase);

        const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(.22, .25, .08, 48), state.hardwareMat);
        baseDisc.position.y = 0.04;
        baseDisc.castShadow = true;
        armBase.add(baseDisc);

        const column = new THREE.Mesh(new THREE.CylinderGeometry(.08, .1, .42, 32), state.hardwareMat);
        column.position.y = 0.28;
        column.castShadow = true;
        armBase.add(column);

        // 万向节
        const gimbal = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.2, 16), darkMat);
        gimbal.rotation.z = Math.PI / 2;
        gimbal.position.y = 0.44;
        armBase.add(gimbal);

        const armLiftG = new THREE.Group();
        armLiftG.position.y = 0.42;
        armBase.add(armLiftG);
        state.armLiftG = armLiftG;

        const armSwingG = new THREE.Group();
        armSwingG.rotation.y = state.armPark;
        armLiftG.add(armSwingG);
        state.armSwingG = armSwingG;

        // 奶白唱臂搭配精密金属轴承与独立唱头。
        const wandCurve = new THREE.CatmullRomCurve3([
            new THREE.Vector3(-0.5, 0.02, 0),
            new THREE.Vector3(.1, 0, 0),
            new THREE.Vector3(.9, -.01, 0),
            new THREE.Vector3(1.7, -.04, 0),
            new THREE.Vector3(2.28, -0.1, 0.06)
        ]);
        const wand = new THREE.Mesh(new THREE.TubeGeometry(wandCurve, 40, .047, 16), armMat);
        wand.castShadow = true;
        armSwingG.add(wand);

        for (const offset of [-.045, .045]) {
            const bearing = new THREE.Mesh(new THREE.TorusGeometry(.115, .014, 8, 40), state.hardwareMat);
            bearing.rotation.y = Math.PI / 2;
            bearing.position.set(offset, .38, 0);
            armBase.add(bearing);
        }
        const cueLever = new THREE.Mesh(new THREE.CylinderGeometry(.016, .016, .25, 16), state.hardwareMat);
        cueLever.rotation.z = -.4;
        cueLever.position.set(2.36, .85, -1.02);
        deck.add(cueLever);
        for (const x of [2.3, 2.46]) {
            const screw = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, .012, 16), state.hardwareMat);
            screw.position.set(x, -.06, .06);
            armSwingG.add(screw);
        }

        /* 隐形加粗热区：臂杆本身太细难点，套一根看不见的粗管跟着臂走，
           指针判定和 hover 光标都吃它。 */
        const armHit = new THREE.Mesh(
            new THREE.TubeGeometry(wandCurve, 20, 0.2, 8),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
        );
        armSwingG.add(armHit);
        const headshellHit = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 0.45, 0.4),
            armHit.material
        );
        headshellHit.position.set(2.45, -0.12, 0.06);
        armSwingG.add(headshellHit);

        const counterweight = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, .3, 48), state.hardwareMat);
        counterweight.rotation.z = Math.PI / 2;
        counterweight.position.set(-0.62, 0.02, 0);
        counterweight.castShadow = true;
        armSwingG.add(counterweight);

        const counterStub = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.34, 12), armMat);
        counterStub.rotation.z = Math.PI / 2;
        counterStub.position.set(-0.35, 0.02, 0);
        armSwingG.add(counterStub);

        const headshell = new THREE.Mesh(roundedBox(.4, .085, .19, .04), armMat);
        headshell.position.set(2.4, -0.11, 0.06);
        headshell.rotation.y = -0.2;
        headshell.castShadow = true;
        armSwingG.add(headshell);

        // 指提（headshell 上翘起的小杆）
        const fingerLift = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), armMat);
        fingerLift.rotation.z = 0.5;
        fingerLift.position.set(2.52, -0.02, 0.1);
        armSwingG.add(fingerLift);

        const cartridge = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 0.11), darkMat);
        cartridge.position.set(2.42, -0.17, 0.06);
        armSwingG.add(cartridge);

        const needle = new THREE.Mesh(
            new THREE.CylinderGeometry(0.007, 0.003, 0.07, 8),
            new THREE.MeshStandardMaterial({ color: 0xd8d2c2 })
        );
        needle.position.set(2.5, -0.23, 0.06);
        armSwingG.add(needle);

        // 停靠架（带卡扣）
        const restPost = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.4, 16), metalMat);
        restPost.position.set(2, .85, 1.15);
        restPost.castShadow = true;
        deck.add(restPost);
        const restClip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.18), darkMat);
        restClip.position.set(2, 1.06, 1.15);
        deck.add(restClip);

        // 左下角启动键：大圆形点击面，与唱臂采用同一播放开关。
        const switchBase = new THREE.Mesh(new THREE.CylinderGeometry(.21, .23, .04, 48), state.hardwareMat);
        switchBase.position.set(-2.9, .615, 1.9);
        deck.add(switchBase);
        const switchLever = new THREE.Mesh(new THREE.CylinderGeometry(.155, .155, .045, 48), darkMat);
        switchLever.position.set(-2.9, .655, 1.9);
        switchLever.castShadow = true;
        deck.add(switchLever);

        /* ---------- LED 电源灯 ---------- */

        const ledMat = new THREE.MeshStandardMaterial({ color: 0x5a5142 });
        state.ledMat = ledMat;
        const led = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), ledMat);
        led.position.set(-2.55, .615, 1.9);
        deck.add(led);

        /* ---------- 可交互部件：唱片 / 唱臂 / 拨杆 / 旋钮 ---------- */

        record.userData.part = "record";
        armSwingG.traverse(o => { o.userData.part = "arm"; });
        switchLever.userData.part = "lever";
        switchBase.userData.part = "lever";


        state.recordMesh = record;
        state.leverMesh = switchLever;
        state.sharedHitTargets = [record, armSwingG];
        state.pinkSwitch = [switchLever, switchBase];
        pink.add(switchLever, switchBase, led);
        state.ledMesh = led;
        state.leverRestY = switchLever.position.y;
        state.platterPos = new THREE.Vector3(PLATTER.x, .84, PLATTER.z);
        state.platterX = PLATTER.x;


        /* ---------- 互动：相机环绕缩放 + 点唱机本体 ---------- */

        let dragging = false, lastX = 0, lastY = 0;
        let downX = 0, downY = 0, lastAngle = 0;
        const el = renderer.domElement;
        el.style.cursor = "grab";
        el.style.display = "block";
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.touchAction = "none";

        const raycaster = new THREE.Raycaster();

        function knobRoot(object) {
            while (object && !object.userData.knobRoot) object = object.parent;
            return object;
        }

        function pointerHit(e) {
            const rect = el.getBoundingClientRect();
            raycaster.setFromCamera(new THREE.Vector2(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1
            ), state.camera);
            return raycaster.intersectObjects(state.hitTargets, true)
                .find(h => h.object.userData.part);
        }

        // 指针相对盘心的转角（屏幕空间），搓碟用
        function platterAngle(e) {
            const rect = el.getBoundingClientRect();
            const v = state.platterPos.clone().project(state.camera);
            const cx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
            const cy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
            return Math.atan2(e.clientY - cy, e.clientX - cx);
        }

        el.addEventListener("pointerdown", e => {
            downX = e.clientX; downY = e.clientY;
            const hit = pointerHit(e);
            if (hit && hit.object.userData.part === "record") {
                // 抓住唱片：进入搓碟而不是环绕相机；播放中联动音频
                state.scratching = true;
                state.cur.scratchV = 0;
                state.cur.scratchTime = 0;
                lastAngle = platterAngle(e);
                if (isPlaying()) {
                    state.scratchAudio = true;
                    state.prevVolume = audio.volume;
                    audio.volume = 0.3;
                }
            } else {
                dragging = true;
                lastX = e.clientX; lastY = e.clientY;
            }
            el.setPointerCapture(e.pointerId);
            el.style.cursor = "grabbing";
        });

        el.addEventListener("pointermove", e => {
            if (state.scratching) {
                // 屏幕角增量（y 向下、顺时针为正）翻成盘面旋转方向
                const a = platterAngle(e);
                let d = lastAngle - a;
                if (d > Math.PI) d -= Math.PI * 2;
                if (d < -Math.PI) d += Math.PI * 2;
                state.cur.spin += d;
                state.cur.scratchV = state.cur.scratchV * 0.7 + d * 0.3;
                // 一圈 = 1.8s（33⅓ RPM），换算成音频时间交给渲染帧节流应用
                state.cur.scratchTime += d / (Math.PI * 2) * 1.8;
                lastAngle = a;
                if (reducedMotion.matches) frame(state);
                return;
            }
            if (!dragging) {
                // 悬停反馈：可点的部件上换成手型
                el.style.cursor = pointerHit(e) ? "pointer" : "grab";
                return;
            }
            state.camOffsetTgt.theta -= (e.clientX - lastX) * 0.006;
            state.camOffsetTgt.phi = Math.min(0.3, Math.max(-0.5,
                state.camOffsetTgt.phi - (e.clientY - lastY) * 0.004));
            lastX = e.clientX; lastY = e.clientY;
            if (reducedMotion.matches) frame(state);
        });

        ["pointerup", "pointercancel"].forEach(type =>
            el.addEventListener(type, e => {
                const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
                if (state.scratching) {
                    state.scratching = false;
                    if (state.scratchAudio) {
                        state.scratchAudio = false;
                        audio.volume = state.prevVolume;
                    }
                    if (moved < 6) {
                        // 点按唱片 = 播放/停止（和唱臂同一个两态开关）；
                        // 想定位段落就按住拖动搓碟
                        togglePlay(state);
                    } else {
                        // 松手带一点甩盘惯性
                        state.cur.boost = Math.max(-2.5, Math.min(2.5, state.cur.scratchV * 26));
                    }
                } else if (moved < 6) {
                    const hit = pointerHit(e);
                    const part = hit?.object.userData.part;
                    if (part === "arm" || part === "lever") {
                        togglePlay(state);
                    }
                    if (part === "lever") state.cur.leverFlick = 1;
                    if (part === "knob") {
                        state.flickKnob = knobRoot(hit.object);
                        state.cur.knobFlick = 1;
                    }
                }
                dragging = false;
                el.style.cursor = "grab";
            })
        );

        // 滚轮推拉镜头看细节；悬停在旋钮上时滚轮改为调音量
        el.addEventListener("wheel", e => {
            e.preventDefault();
            const hit = pointerHit(e);
            if (hit?.object.userData.part === "knob" && audio) {
                audio.volume = Math.min(1, Math.max(0, audio.volume - e.deltaY * 0.0012));
                state.flickKnob = knobRoot(hit.object);
                state.cur.knobFlick = Math.min(1, Math.abs(e.deltaY) * 0.01 + 0.3);
                if (reducedMotion.matches) frame(state);
                return;
            }
            state.camOffsetTgt.radius = Math.min(3.2, Math.max(-3.4,
                state.camOffsetTgt.radius + e.deltaY * 0.004));
            if (reducedMotion.matches) frame(state);
        }, { passive: false });
        el.addEventListener("dblclick", () => {
            state.camOffsetTgt.theta = 0;
            state.camOffsetTgt.phi = 0;
            state.camOffsetTgt.radius = 0;
            if (reducedMotion.matches) frame(state);
        });

        return state;
    }

    /* ---------------- 动作 ---------------- */

    /* 33⅓ RPM = 0.5556 圈/秒 ≈ 3.49 rad/s；待机时保持停转。 */
    const FULL_SPEED = 3.49;
    const IDLE_SPEED = 0;

    /* 声槽几何：外圈半径 1.9 → 臂角 -2.10，内圈半径 .75 → 臂角 -2.72。
       臂角随播放进度从外圈走向内圈，就是黑胶的「进度条」。 */
    const GROOVE_OUT = 1.9, GROOVE_IN = .75;
    const ARM_GROOVE_OUT = -2.10, ARM_GROOVE_IN = -2.72;

    function grooveAngle(p) {
        return ARM_GROOVE_OUT + (ARM_GROOVE_IN - ARM_GROOVE_OUT) * Math.min(1, Math.max(0, p));
    }

    function playProgress() {
        if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return 0;
        return Math.min(1, Math.max(0, audio.currentTime / audio.duration));
    }

    function ledOn(state) {
        state.ledMat.emissive.setHex(state.theme === "archive" ? 0xdbc68f : 0xe9b5c2);
        state.ledMat.emissiveIntensity = 1.2;
    }

    function ledOff(state) {
        state.ledMat.emissive.setHex(0x000000);
    }

    function motionAfter(state, callback, delay) {
        const timer = setTimeout(() => {
            state.motionTimers.delete(timer);
            callback();
        }, delay);
        state.motionTimers.add(timer);
        return timer;
    }

    function cancelMotion({ preservePose = false } = {}) {
        if (!S) return;
        for (const timer of S.motionTimers) clearTimeout(timer);
        S.motionTimers.clear();
        S.busy = false;
        S.demo = false;
        S.cur.recordX = S.cur.recordXT = 0;
        S.cur.recordY = S.cur.recordYT = 0;
        if (!preservePose) {
            S.cur.armLift = S.cur.armLiftT = 0;
            S.needle = isPlaying() ? "down" : "parked";
            S.cur.armAngle = S.cur.armAngleT = isPlaying() ? grooveAngle(playProgress()) : S.armPark;
        }
        S.cur.speedT = isPlaying() ? FULL_SPEED : 0;
        if (isPlaying()) ledOn(S); else ledOff(S);
        if (S.awake && reducedMotion.matches) frame(S);
    }

    /* 落针：回架 → 抬臂 → 对准当前进度的声槽 → 液压缓落 → 出声。 */
    function needleDropSequence(state, cb) {
        if (state.busy) return;
        if (reducedMotion.matches || !state.awake) {
            state.needle = "down";
            state.cur.armAngle = state.cur.armAngleT = grooveAngle(playProgress());
            state.cur.armLift = state.cur.armLiftT = 0;
            state.cur.speedT = FULL_SPEED;
            ledOn(state);
            if (state.awake) frame(state);
            cb?.();
            return;
        }
        state.busy = true;
        state.cur.armLiftT = 0.16;
        state.cur.speedT = FULL_SPEED;   // 转盘先转起来，再落针
        motionAfter(state, () => { state.cur.armAngleT = grooveAngle(playProgress()); }, 180);
        motionAfter(state, () => {
            state.cur.armLiftT = 0;
            state.needle = "down";
            ledOn(state);
        }, 550);
        motionAfter(state, () => { state.busy = false; cb?.(); }, 700);
    }

    /* 回架停转：抬臂 → 摆回臂架 → 落架 → 转盘缓停。 */
    function needleParkSequence(state, cb) {
        if (state.busy) return;
        if (reducedMotion.matches || !state.awake) {
            state.needle = "parked";
            state.cur.armAngle = state.cur.armAngleT = state.armPark;
            state.cur.armLift = state.cur.armLiftT = 0;
            state.cur.speedT = 0;
            ledOff(state);
            if (state.awake) frame(state);
            cb?.();
            return;
        }
        state.busy = true;
        state.cur.armLiftT = 0.16;
        motionAfter(state, () => { state.cur.armAngleT = state.armPark; }, 180);
        motionAfter(state, () => {
            state.cur.armLiftT = 0;
            state.needle = "parked";
            ledOff(state);
            state.cur.speedT = 0;
            state.busy = false;
            /* 回架途中新曲目已经开播（连播切歌）：
               落针编排被 busy 挡掉了，在这里补上。 */
            if (isPlaying()) {
                needleDropSequence(state, cb);
            } else {
                cb?.();
            }
        }, 600);
    }

    /* 没装片时点了播放：优先让应用侧决定放哪张（比如最近添加），
       应用侧没接管（曲库为空）就进演示态——唱臂落下、转盘空转。 */
    function handleNoTrack(state) {
        if (state.demo) {
            state.demo = false;
            needleParkSequence(state);
            return;
        }
        if (emptyDropHandler && emptyDropHandler() === true) return;
        state.demo = true;
        needleDropSequence(state);
    }

    /* 点唱臂 / 盘面 / 拨杆都是同一个两态开关：
       停 → 落针、LED 亮、转盘起转、出声；
       播 → 收针回架、LED 灭、转盘缓停、停声。 */
    function togglePlay(state) {
        if (playbackHandler && playbackHandler() === true) return;
        if (audio && audio.currentSrc) {
            if (audio.paused) {
                needleDropSequence(state, () => audio.play().catch(() => {}));
            } else {
                audio.pause();
            }
            return;
        }
        handleNoTrack(state);
    }

    function playIntro(state) {
        if (reducedMotion.matches) {
            state.cur.recordY = 0;
            state.cur.speed = IDLE_SPEED;
            return;
        }
        motionAfter(state, () => { state.cur.recordYT = 0; }, 200);
        motionAfter(state, () => { state.cur.speedT = IDLE_SPEED; }, 1300);
    }

    /* ---------------- 渲染循环 ---------------- */

    function placeCamera(state) {
        const { cam, camTarget, camera } = state;
        camera.position.set(
            camTarget.x + cam.radius * Math.sin(cam.phi) * Math.sin(cam.theta),
            camTarget.y + cam.radius * Math.cos(cam.phi),
            camTarget.z + cam.radius * Math.sin(cam.phi) * Math.cos(cam.theta)
        );
        camera.lookAt(camTarget);
    }

    function resize(state) {
        const w = state.container.clientWidth;
        const h = state.container.clientHeight;
        if (!w || !h) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = state.renderer.domElement;
        if (canvas.width === Math.round(w * dpr) && canvas.height === Math.round(h * dpr)) return;
        state.renderer.setSize(w, h, false);
        state.camera.aspect = w / h;
        state.camera.updateProjectionMatrix();

        // 按真实可见顶点取景，并校正透视投影的中心，消除一侧多余留白。
        const theta = state.camBase.theta, phi = state.camBase.phi;
        const tan = Math.tan(state.camera.fov * Math.PI / 360);
        const right = new THREE.Vector3(Math.cos(theta), 0, -Math.sin(theta));
        const up = new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.sin(phi), -Math.cos(phi) * Math.cos(theta));
        const outward = new THREE.Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
        const projected = state.framingPoints.map(point => ({ x: point.dot(right), y: point.dot(up), z: point.dot(outward) }));
        state.camTarget.set(0, .45, .05);
        for (let pass = 0; pass < 4; pass++) {
            const tx = state.camTarget.dot(right), ty = state.camTarget.dot(up), tz = state.camTarget.dot(outward);
            let distance = 0;
            for (const point of projected) {
                distance = Math.max(distance, point.z - tz + Math.abs(point.x - tx) / (tan * state.camera.aspect), point.z - tz + Math.abs(point.y - ty) / tan);
            }
            state.camBase.radius = distance * 1.035;
            if (pass === 3) break;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const point of projected) {
                const depth = state.camBase.radius - point.z + tz;
                const x = (point.x - tx) / (depth * tan * state.camera.aspect);
                const y = (point.y - ty) / (depth * tan);
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
            state.camTarget.addScaledVector(right, (minX + maxX) * .5 * state.camBase.radius * tan * state.camera.aspect);
            state.camTarget.addScaledVector(up, (minY + maxY) * .5 * state.camBase.radius * tan);
        }
    }

    function frame(state) {
        state.raf = 0;
        resize(state);
        const cur = state.cur;

        cur.recordY += ((cur.recordYT ?? 0) - cur.recordY) * 0.055;
        cur.recordX += ((cur.recordXT ?? 0) - cur.recordX) * 0.055;

        /* 电机逻辑：落针播放、演示态都是满速 33⅓；回架后用 speedT 缓停到 0。 */
        const motorOn = isPlaying() || state.demo || state.needle !== "parked";
        const speedTgt = (state.scratching ? 0 : (motorOn ? FULL_SPEED : (cur.speedT ?? 0))) + cur.boost;
        cur.speed += (speedTgt - cur.speed) * 0.02;
        cur.spin += cur.speed / 60;
        cur.boost *= 0.97;
        cur.flash *= 0.94;

        /* 搓碟联动音频：盘角增量换算成时间（一圈 = 1.8s），
           在渲染帧里节流地改写播放位置。 */
        if (state.scratching && state.scratchAudio && Math.abs(cur.scratchTime) > 0.015) {
            const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
            if (dur > 0) {
                audio.currentTime = Math.min(dur, Math.max(0, audio.currentTime + cur.scratchTime));
            }
            cur.scratchTime = 0;
        }

        /* 落针播放中：唱臂跟着进度从外圈走向内圈 */
        if (state.needle === "down" && isPlaying()) {
            cur.armAngleT = grooveAngle(playProgress());
        }

        cur.armLift += ((cur.armLiftT ?? 0) - cur.armLift) * 0.16;
        cur.armAngle += ((cur.armAngleT ?? state.armPark) - cur.armAngle) * 0.045;

        const cameraEase = reducedMotion.matches ? 1 : .09;
        state.camOffset.theta += (state.camOffsetTgt.theta - state.camOffset.theta) * cameraEase;
        state.camOffset.phi += (state.camOffsetTgt.phi - state.camOffset.phi) * cameraEase;
        state.camOffset.radius += (state.camOffsetTgt.radius - state.camOffset.radius) * cameraEase;

        state.recordGroup.position.x = state.platterX + cur.recordX;
        state.recordGroup.position.y = .84 + cur.recordY;
        state.recordGroup.rotation.y = cur.spin;
        state.armLiftG.position.y = 0.42 + cur.armLift;
        state.armSwingG.rotation.y = cur.armAngle;

        /* 待机呼吸：完全停机时 LED 缓慢起伏，暗示「可以点我」；
           落针播放 / 演示空转时由 ledOn 常亮接管。 */
        if (state.needle === "parked" && !state.demo && !isPlaying()) {
            const t = performance.now() / 1000;
            state.ledMat.emissive.setHex(state.theme === "archive" ? 0xdbc68f : 0xe9b5c2);
            state.ledMat.emissiveIntensity = 0.2 + 0.16 * (0.5 + 0.5 * Math.sin(t * 1.6));
        }

        /* 音量刻线跟随真实播放器；前置旋钮仍沿自身轴旋转。 */
        const volumeAngle = ((audio?.volume ?? .7) - .5) * Math.PI * 1.4;
        for (const knob of state.knobMeshes) knob.rotation.y = volumeAngle;
        if (state.flickKnob && cur.knobFlick > 0.02 && !reducedMotion.matches) {
            state.flickKnob.rotation.y += Math.sin(cur.knobFlick * 12) * cur.knobFlick * .12;
            cur.knobFlick *= 0.9;
        } else if (state.flickKnob) {
            state.flickKnob = null;
            cur.knobFlick = 0;
        }

        if (state.leverMesh && cur.leverFlick > 0.02) {
            state.leverMesh.position.y = state.leverRestY - Math.sin(cur.leverFlick * Math.PI) * .025;
            cur.leverFlick *= 0.88;
        } else if (state.leverMesh) {
            state.leverMesh.position.y = state.leverRestY;
            cur.leverFlick = 0;
        }
        state.retroToggle.rotation.z = state.needle === "parked" ? -.25 : .25;

        if (cur.flash > 0.02) {
            state.counterMat.emissiveIntensity = .8 + cur.flash * 1.6;
        } else if (state.counterMat.emissiveIntensity !== .8) {
            state.counterMat.emissiveIntensity = .8;
        }

        state.cam.theta = state.camBase.theta + state.camOffset.theta;
        state.cam.phi = state.camBase.phi + state.camOffset.phi;
        state.cam.radius = state.camBase.radius + state.camOffset.radius;
        placeCamera(state);

        state.renderer.render(state.scene, state.camera);

        if (state.awake && !document.hidden && !reducedMotion.matches) {
            state.raf = requestAnimationFrame(() => frame(state));
        }
    }

    function startLoop(state) {
        if (!state.raf && !reducedMotion.matches) {
            state.raf = requestAnimationFrame(() => frame(state));
        } else if (reducedMotion.matches) {
            frame(state);
        }
    }

    /* ---------------- 对外 API ---------------- */

    function mount(container) {
        if (!window.THREE) return false;
        if (!S) {
            try { S = buildScene(container); }
            catch (error) { console.warn("唱机预览不可用", error); return false; }
            S.theme = document.body.dataset.theme === "sky" ? "sky" : "archive";
            S.trackTitle = lastTrackInfo.title;
            S.trackArtist = lastTrackInfo.artist;
            applyTheme(S);
            drawRecord(S);
            drawCounter(S);
            container.appendChild(S.renderer.domElement);

            if (audio && !audio.paused && audio.currentSrc) {
                S.needle = "down";
                S.cur.armAngle = S.cur.armAngleT = grooveAngle(playProgress());
                S.cur.recordY = 0;
                ledOn(S);
            } else if (!hasIntro) {
                playIntro(S);
                hasIntro = true;
            }
        } else if (S.renderer.domElement.parentElement !== container) {
            S.container = container;
            container.appendChild(S.renderer.domElement);
        } else {
            S.container = container;
        }

        S.awake = true;
        if (!S.resizeObserver) S.resizeObserver = new ResizeObserver(() => {
            if (S.awake && reducedMotion.matches) frame(S);
        });
        S.resizeObserver.disconnect();
        S.resizeObserver.observe(container);
        if (pendingTrack) setTrack(pendingTrack);

        if (pendingStats && !S.stats.length) {
            S.stats = pendingStats;
            drawCounter(S);
        }

        // 每次回到首页都同步真实播放姿态（在曲库里点的播放也算数）
        if (!S.busy) {
            if (isPlaying()) {
                S.needle = "down";
                S.cur.armAngle = S.cur.armAngleT = grooveAngle(playProgress());
                S.cur.armLift = S.cur.armLiftT = 0;
                ledOn(S);
            } else {
                // 没在播：无论暂停还是收针停止，针都待在臂架上
                S.needle = "parked";
                S.cur.armAngle = S.cur.armAngleT = S.armPark;
                S.cur.armLift = S.cur.armLiftT = 0;
                ledOff(S);
            }
        }

        // 从工作区返回：镜头从推进位拉回
        if (hasDived) {
            hasDived = false;
            S.camOffsetTgt.theta = 0;
            S.camOffsetTgt.phi = 0;
            S.camOffsetTgt.radius = 0;
        }

        if (!S.statTimer && S.stats.length > 1) {
            S.statTimer = setInterval(() => {
                if (!S.awake) return;
                S.statIdx = (S.statIdx + 1) % S.stats.length;
                drawCounter(S);
            }, 4000);
        }

        startLoop(S);
        return true;
    }

    function sleep() {
        if (!S) return;
        S.awake = false;
        if (S.raf) cancelAnimationFrame(S.raf);
        S.raf = 0;
    }

    function react(view) {
        if (!S || !S.awake) return;
        if (view === "all") {
            S.cur.boost = 1.2;
        } else if (view === "clips" && !S.busy) {
            S.cur.armLiftT = 0.09;
            setTimeout(() => { S.cur.armLiftT = 0; }, 200);
            setTimeout(() => { S.cur.armLiftT = 0.09; }, 420);
            setTimeout(() => { S.cur.armLiftT = 0; }, 640);
        } else if (view === "albums") {
            const start = performance.now();
            const hue = () => {
                const p = (performance.now() - start) / 1500;
                if (p >= 1 || !S) { if (S) S.sheen.color.setHex(0xfff2dd); return; }
                S.sheen.color.setHSL(p, 0.65, 0.72);
                requestAnimationFrame(hue);
            };
            hue();
        } else if (view === "recent") {
            S.cur.flash = 1;
            if (S.stats.length > 1) {
                S.statIdx = (S.statIdx + 1) % S.stats.length;
                drawCounter(S);
            }
        }
    }

    function setProgram({ counts } = {}) {
        if (!counts) return;
        const stats = [
            { label: "TRACKS", value: counts.tracks ?? 0 },
            { label: "CLIPS", value: counts.clips ?? 0 },
            { label: "ALBUMS", value: counts.albums ?? 0 },
            { label: "TAGS", value: counts.tags ?? 0 }
        ];
        if (S) {
            S.stats = stats;
            drawCounter(S);
            if (!S.statTimer && S.awake) {
                S.statTimer = setInterval(() => {
                    if (!S.awake) return;
                    S.statIdx = (S.statIdx + 1) % S.stats.length;
                    drawCounter(S);
                }, 4000);
            }
        } else {
            pendingStats = stats;
        }
    }

    function setTrack(track = {}) {
        const newTrack = track.title !== undefined || track.artist !== undefined || track.grooveUrl !== undefined;
        if (newTrack) {
            trackRevision++;
            lastTrackInfo = { title: track.title || "", artist: track.artist || "" };
            pendingTrack = { ...track, coverArt: track.coverArt || "" };
            if (S) { S.trackTitle = lastTrackInfo.title; S.trackArtist = lastTrackInfo.artist; S.peaks = FAKE_PEAKS; }
        } else pendingTrack = { ...pendingTrack, ...track };
        const revision = trackRevision;
        if (newTrack || track.coverArt !== undefined) {
            const imageRevision = ++coverRevision;
            if (S) { S.coverImg = null; drawRecord(S); }
            miniSetCover(null);
            const cover = track.coverArt || "";
            if (cover) {
                const image = new Image();
                image.onload = () => {
                    if (revision !== trackRevision || imageRevision !== coverRevision) return;
                    miniSetCover(cover);
                    if (S) { S.coverImg = image; drawRecord(S); if (reducedMotion.matches) frame(S); }
                };
                image.src = cover;
            }
        }
        if (track.grooveUrl && window.Waveform) {
            window.Waveform.getPeaks(track.grooveUrl, 720).then(peaks => {
                if (S && revision === trackRevision) { S.peaks = peaks; drawRecord(S); if (reducedMotion.matches) frame(S); }
            }).catch(() => {});
        }
        if (S && reducedMotion.matches) frame(S);
    }

    function applyTheme(state) {
        const retro = state.theme === "archive";
        state.bodyVariants.archive.visible = retro;
        state.bodyVariants.sky.visible = !retro;
        state.design = retro ? "cream-retro" : "sakura-desktop";
        state.renderer.domElement.ariaLabel = `${retro ? "奶油复古" : "浅粉桌面"}唱机，点按唱臂播放，拖动空白处环绕，在音量旋钮上滚动调节音量`;
        state.plinthMat.color.setHex(0xf1d8e0);
        state.topPlateMat.color.setHex(retro ? 0xf0e7d3 : 0xf7e5eb);
        state.topPlateMat.roughness = retro ? .39 : .32;
        state.hardwareMat.color.setHex(retro ? 0xc5b796 : 0xe1e4e2);
        state.hardwareMat.metalness = .86;
        state.hardwareMat.roughness = retro ? .32 : .24;
        state.ivoryMat.color.setHex(retro ? 0xf3ebdb : 0xf7f4ed);
        state.knobCapMat.color.setHex(retro ? 0xf5efdf : 0xfbf9f3);
        state.armMat.color.setHex(retro ? 0xece3d0 : 0xf7f3e9);
        state.armMat.metalness = .08;
        state.armMat.roughness = .31;
        state.footMat.color.setHex(retro ? 0xa9a08e : 0xd9d1ce);
        state.inkMat.color.setHex(retro ? 0x716551 : 0x92777e);
        state.groundMat.opacity = .13;
        state.groundMesh.position.y = retro ? -.31 : -.17;
        state.recordMat.transparent = false;
        state.recordMat.opacity = 1;
        state.recordMat.roughness = .27;
        state.recordMat.metalness = .12;
        state.recordMat.emissive.setHex(0x000000);
        state.recordMat.emissiveIntensity = 0;
        state.recordSideMat.color.setHex(0x131418);
        state.platterFeltMat.color.setHex(retro ? 0x5f5c52 : 0x8b898a);
        state.sheen.intensity = .4;
        state.renderer.setClearColor(retro ? 0xf3efe7 : 0xeff4f4, 0);
        state.camBase.phi = retro ? .97 : .94;
        state.camBase.theta = retro ? .24 : .16;
        state.keyLight.color.setHex(0xfffaf3);
        state.keyLight.intensity = 1.7;
        // 正面品牌标识属于复古机身，浅粉款则保留台面上的小字。
        state.frontPanelMesh.rotation.x = retro ? 0 : -Math.PI / 2;
        state.frontPanelMesh.position.set(retro ? 0 : .35, retro ? .25 : .61, retro ? 2.492 : 2.02);
        state.frontPanelMesh.scale.setScalar(retro ? .64 : 1);
        state.counterMesh.visible = !retro;
        state.ledMesh.position.set(retro ? .24 : -2.55, retro ? .23 : .615, retro ? 2.495 : 1.9);
        state.deck.add(state.ledMesh);
        const activeKnobs = state.knobMeshes.filter(knob => {
            let parent = knob;
            while (parent && parent !== state.deck) {
                if (!parent.visible) return false;
                parent = parent.parent;
            }
            return true;
        });
        state.hitTargets = [...state.sharedHitTargets, ...activeKnobs, ...(retro ? [state.retroPower] : state.pinkSwitch)];
        const previous = state.frontMat.map;
        state.frontMat.map = drawFrontPanel(state);
        if (previous) previous.dispose();
        state.frontMat.needsUpdate = true;
        drawRecord(state);
        drawCounter(state);

        // 换主题时取静止姿态的边界，正在换片或落针也不会把镜头推远。
        state.frameVariants ||= {};
        if (!state.frameVariants[state.theme]) {
            const position = state.recordGroup.position.clone();
            const rotation = state.recordGroup.rotation.y;
            const angle = state.armSwingG.rotation.y, lift = state.armLiftG.position.y;
            state.recordGroup.position.set(state.platterX, state.platterTop, .05);
            state.recordGroup.rotation.y = 0;
            state.armSwingG.rotation.y = state.armPark;
            state.armLiftG.position.y = .42;
            state.frameVariants[state.theme] = framingPoints(state.deck);
            state.recordGroup.position.copy(position);
            state.recordGroup.rotation.y = rotation;
            state.armSwingG.rotation.y = angle;
            state.armLiftG.position.y = lift;
        }
        state.framingPoints = state.frameVariants[state.theme];
        state.renderer.domElement.width = 0;
        if (reducedMotion.matches) frame(state);
    }

    function setTheme(theme) {
        if (!S) return;
        S.theme = theme === "sky" ? "sky" : "archive";
        applyTheme(S);
    }

    function diveIn(cb) {
        if (!S || !S.awake || reducedMotion.matches) { cb(); return; }
        hasDived = true;
        S.camOffsetTgt.phi = -0.22;
        S.camOffsetTgt.radius = -4.4;
        setTimeout(cb, 850);
    }

    /* 换唱片：针回架 → 旧片升起滑出 → 换标签/波形 → 新片落下。
       cb 在新片落稳后触发（调用方决定何时落针出声）。
       keepRecord：调用方已经用 DOM 做了「飞片上机」，旧片原地换纹理，
       不再升起滑出——否则用户会看着刚飞到的唱片又自己飞走。 */
    function swapRecord(track = {}, cb, { keepRecord = false } = {}) {
        if (!S) { cb?.(); return; }
        if (reducedMotion.matches || !S.awake) {
            setTrack(track);
            S.needle = "parked";
            S.demo = false;
            ledOff(S);
            cb?.();
            return;
        }
        S.busy = true;
        S.demo = false;
        const needPark = S.needle !== "parked";
        const t0 = needPark ? 300 : 60;

        if (needPark) {
            S.cur.armLiftT = 0.16;
            S.cur.armAngleT = S.armPark;
        }

        if (keepRecord) {
            /* DOM 飞片约 0.7s 落到转盘，贴着落点换纹理、转不停 */
            motionAfter(S, () => {
                S.coverImg = null;
                if (track.coverArt) {
                    setTrack(track);
                } else {
                    setTrack({ grooveUrl: track.grooveUrl, title: track.title, artist: track.artist });
                    drawRecord(S);
                    miniSetCover(null);
                }
            }, t0 + 420);
            motionAfter(S, () => {
                S.needle = "parked";
                S.cur.armLiftT = 0;
                ledOff(S);
                S.busy = false;
                cb?.();
            }, t0 + 520);
            return;
        }

        // 旧片升起并向左滑出
        motionAfter(S, () => {
            S.cur.recordYT = 1.5;
            S.cur.recordXT = -4.5;
        }, t0);

        // 旧片飞出后换纹理，新片从上方落回转盘
        motionAfter(S, () => {
            // 无封面的曲目要回到默认标签，别让上一张的封面留着
            S.coverImg = null;
            if (track.coverArt) {
                setTrack(track);
            } else {
                setTrack({ grooveUrl: track.grooveUrl, title: track.title, artist: track.artist });
                drawRecord(S);
                miniSetCover(null);
            }
            S.cur.spin = 0;
            S.cur.recordXT = 0;
            S.cur.recordYT = 0;
        }, t0 + 300);

        motionAfter(S, () => {
            S.needle = "parked";
            S.cur.armLiftT = 0;
            ledOff(S);
            S.cur.speedT = 0;
            S.busy = false;
            cb?.();
        }, t0 + 580);
    }

    /* 落针（对外）：把针落到当前进度并回调（一般用来启动音频）。 */
    function dropNeedle(cb) {
        if (S) {
            needleDropSequence(S, cb);
        } else {
            cb?.();
        }
    }

    /* ---------------- 播放状态监听 ---------------- */

    if (audio) {
        audio.addEventListener("volumechange", () => {
            if (S && S.awake && reducedMotion.matches) frame(S);
        });
        audio.addEventListener("play", () => {
            playing = true;
            miniKick();
            // 应用侧直接起的播放：针若还没落，补一段落针编排
            if (S && S.awake && S.needle !== "down") {
                needleDropSequence(S);
            } else if (S) {
                ledOn(S);
            }
        });
        audio.addEventListener("pause", () => {
            playing = false;
            miniKick();
            // 停止 = 收针回架、转盘缓停（暂停也只有这一种姿态）
            if (S && S.awake && S.needle !== "parked") needleParkSequence(S);
        });
        audio.addEventListener("ended", () => {
            playing = false;
            miniKick();
            // 播完自动回臂、转盘缓停
            if (S && S.awake && S.needle === "down") needleParkSequence(S);
        });
        // 卸载曲目（关闭播放器）后收针回架。
        audio.addEventListener("emptied", () => {
            lastTrackInfo = { title: "", artist: "" };
            if (!S) return;
            S.trackTitle = "";
            S.trackArtist = "";
            if (S.awake && S.needle !== "parked") needleParkSequence(S);
        });
    }

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden && S && S.awake) startLoop(S);
    });

    reducedMotion.addEventListener("change", () => {
        miniStatic();
        if (S && S.awake) startLoop(S);
    });

    miniDrawDisc();
    miniStatic();

    /* 环绕机位（首页 360° 按钮）：delta 为弧度增量 */
    function orbit(delta) {
        if (!S) return;
        S.camOffsetTgt.theta += delta;
    }

    /* 转盘中心的屏幕坐标（clientX/Y）：选片后「飞片上机」的落点。 */
    function platterScreenPoint() {
        if (!S || !S.renderer) return null;
        const rect = S.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const v = S.platterPos.clone().project(S.camera);
        return {
            x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
            y: rect.top + (-v.y * 0.5 + 0.5) * rect.height
        };
    }

    /* 空落针（没装片就点唱臂/唱片）时由应用侧接管选片；
       处理器返回 true 表示已开始装片，false 则回落到演示空转。 */
    function setEmptyDropHandler(fn) {
        emptyDropHandler = typeof fn === "function" ? fn : null;
    }

    window.Turntable = {
        mount,
        sleep,
        react,
        setProgram,
        setTrack,
        setTheme,
        diveIn,
        swapRecord,
        dropNeedle,
        orbit,
        platterScreenPoint,
        setEmptyDropHandler,
        setPlaybackHandler: handler => { playbackHandler = typeof handler === "function" ? handler : null; },
        cancelMotion
    };
})();
