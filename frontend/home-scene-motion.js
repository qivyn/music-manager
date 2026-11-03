/* Locally deformed areas of the approved paintings, with a pose for each theme.
   Keeping the original pixels avoids changing the cat while extracting layers. */
(function () {
    "use strict";

    const WIDTH = 1586, HEIGHT = 992;
    // Slow, shallow breathing: roughly 2–3 CSS px at the back at normal size.
    const PERIOD = 8000, AMPLITUDE = 4;
    const TAIL_INTERVAL = 16000, TAIL_AMPLITUDE = 12;
    const PET_DURATION = 2400;
    const preferenceKey = "music-library-scene-motion";
    let enabled = true, reduced = null, control = null, current = null;

    function smoothstep(start, end, value) {
        const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
        return t * t * (3 - 2 * t);
    }

    function nightBodyWeight(x, y) {
        // The face, hanging foreleg, resting paws and tail stay outside this field.
        return smoothstep(1164, 1206, x) * (1 - smoothstep(1324, 1380, x))
            * smoothstep(536, 564, y) * (1 - smoothstep(638, 678, y));
    }

    function breathAt(milliseconds) {
        const phase = (milliseconds % PERIOD) / PERIOD;
        // A shorter inhale, slower exhale and a small resting pause.
        if (phase < 0.34) return AMPLITUDE * smoothstep(0, 0.34, phase);
        if (phase < 0.92) return AMPLITUDE * (1 - smoothstep(0.34, 0.92, phase));
        return 0;
    }

    function nightTailWeight(x, y) {
        // Follow the hanging tail's curved centre; the root stays on the seat.
        const centre = 1411 - 10 * smoothstep(758, 810, y) + 7 * smoothstep(822, 850, y);
        return smoothstep(728, 834, y) * (1 - smoothstep(862, 880, y))
            * (1 - smoothstep(26, 66, Math.abs(x - centre)));
    }

    function tailAt(milliseconds) {
        const cycle = Math.floor(milliseconds / TAIL_INTERVAL);
        // Vary the idle gap, speed and direction without wall-clock timers.
        // This timeline pauses with the scene and stays independent of breathing.
        const variation = ((cycle * 733 + 271) % 997) / 997;
        const start = cycle === 0 ? 2600 : 1800 + variation * 4800;
        const duration = 2800 + variation * 600;
        const phase = (milliseconds % TAIL_INTERVAL - start) / duration;
        if (phase <= 0 || phase >= 1) return { x: 0, y: 0 };
        const strength = cycle === 0 ? 1 : (0.72 + variation * 0.28) * (cycle % 3 === 1 ? -1 : 1);
        let sway;
        if (phase < 0.34) sway = smoothstep(0, 0.34, phase);
        else if (phase < 0.82) sway = 1 - 1.18 * smoothstep(0.34, 0.82, phase);
        else sway = -0.18 * (1 - smoothstep(0.82, 1, phase));
        return {
            x: TAIL_AMPLITUDE * strength * sway,
            y: -2.2 * Math.abs(strength) * smoothstep(0, 0.3, phase) * (1 - smoothstep(0.6, 1, phase))
        };
    }

    function nightHeadOffset(x, y) {
        const weight = smoothstep(994, 1030, x) * (1 - smoothstep(1160, 1200, x))
            * smoothstep(518, 540, y) * (1 - smoothstep(625, 670, y));
        // A tiny tilt about the neck and a soft lean into the armrest.
        return [(-4 + 0.018 * (y - 640)) * weight, (3 - 0.018 * (x - 1160)) * weight];
    }

    function creamBodyWeight(x, y) {
        const back = smoothstep(982, 1038, x) * (1 - smoothstep(1156, 1220, x))
            * smoothstep(448, 480, y) * (1 - smoothstep(548, 586, y));
        // The right-facing cat's forepaws lie just below its chest.
        const plantedPaws = smoothstep(1140, 1176, x) * smoothstep(530, 558, y);
        return back * (1 - plantedPaws);
    }

    function creamTailWeight(x, y) {
        // The shorter left-hand tail bends back toward the right at its tip.
        const centre = 953 + 30 * smoothstep(632, 694, y);
        return smoothstep(590, 684, y) * (1 - smoothstep(710, 736, y))
            * (1 - smoothstep(24, 58, Math.abs(x - centre)));
    }

    function creamHeadOffset(x, y) {
        const weight = smoothstep(1196, 1234, x) * (1 - smoothstep(1364, 1400, x))
            * smoothstep(384, 410, y) * (1 - smoothstep(510, 544, y));
        // Lean right/down into this painting's armrest, with a fixed paw line.
        return [(4 - 0.018 * (y - 536)) * weight, (2.5 + 0.018 * (x - 1220)) * weight];
    }

    const poses = {
        night: {
            patch: { x: 976, y: 500, width: 516, height: 400 }, tailDirection: 1,
            bodyWeight: nightBodyWeight, tailWeight: nightTailWeight, headOffset: nightHeadOffset
        },
        cream: {
            patch: { x: 864, y: 368, width: 576, height: 392 }, tailDirection: -1,
            bodyWeight: creamBodyWeight, tailWeight: creamTailWeight, headOffset: creamHeadOffset
        }
    };

    function petPoseAt(milliseconds) {
        const phase = milliseconds / PET_DURATION;
        if (phase <= 0 || phase >= 1) return { head: 0, blend: 0, x: 0, y: 0 };
        const sway = Math.sin(Math.PI * smoothstep(0.1, 0.9, phase));
        return {
            head: smoothstep(0, 0.3, phase) * (1 - smoothstep(0.45, 0.92, phase)),
            blend: smoothstep(0, 0.18, phase) * (1 - smoothstep(0.8, 1, phase)),
            x: 9 * sway, y: -1.5 * sway * sway
        };
    }

    function makeMesh(pose) {
        const patch = pose.patch;
        const columns = Math.ceil(patch.width / 8), rows = Math.ceil(patch.height / 8);
        const vertices = [], indices = [];
        for (let row = 0; row <= rows; row++) {
            for (let col = 0; col <= columns; col++) {
                const x = patch.x + patch.width * col / columns;
                const y = patch.y + patch.height * row / rows;
                vertices.push(x, y, pose.bodyWeight(x, y), pose.tailWeight(x, y), ...pose.headOffset(x, y));
            }
        }
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns; col++) {
                const a = row * (columns + 1) + col, b = a + columns + 1;
                indices.push(a, a + 1, b, a + 1, b + 1, b);
            }
        }
        return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
    }

    function createRenderer(artboard, image, pose, onFailure) {
        const patch = pose.patch;
        const canvas = document.createElement("canvas");
        canvas.className = "scene-motion-patch";
        canvas.setAttribute("aria-hidden", "true");
        Object.assign(canvas.style, {
            left: patch.x / WIDTH * 100 + "%", top: patch.y / HEIGHT * 100 + "%",
            width: patch.width / WIDTH * 100 + "%", height: patch.height / HEIGHT * 100 + "%"
        });
        const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, stencil: false });
        if (!gl) throw new Error("Scene motion unavailable");
        const shaders = [], buffers = [];
        let program, texture, observer, breathLocation, tailLocation, petLocation;
        let time = 0, petTime = -1, disposed = false;

        function dispose() {
            if (disposed) return;
            disposed = true;
            observer?.disconnect();
            window.removeEventListener("resize", resize);
            canvas.removeEventListener("webglcontextlost", lost);
            buffers.forEach(buffer => gl.deleteBuffer(buffer));
            shaders.forEach(shader => gl.deleteShader(shader));
            if (texture) gl.deleteTexture(texture);
            if (program) gl.deleteProgram(program);
            gl.getExtension("WEBGL_lose_context")?.loseContext();
            canvas.remove();
        }

        function compile(type, source) {
            const shader = gl.createShader(type);
            shaders.push(shader);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Scene shader unavailable");
            return shader;
        }

        function lost(event) {
            event.preventDefault();
            onFailure(); // Removing the overlay reveals the untouched original.
        }

        function draw(milliseconds, reactionTime = -1) {
            if (disposed) return;
            time = milliseconds;
            petTime = reactionTime;
            const tail = tailAt(milliseconds);
            const pet = petPoseAt(reactionTime);
            gl.uniform1f(breathLocation, breathAt(milliseconds));
            gl.uniform1f(petLocation, pet.head);
            gl.uniform2f(tailLocation, (tail.x * (1 - pet.blend) + pet.x * pet.blend) * pose.tailDirection,
                tail.y * (1 - pet.blend) + pet.y * pet.blend);
            gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
        }

        function resize() {
            if (disposed) return;
            const scale = artboard.getBoundingClientRect().width / WIDTH * Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.max(1, Math.round(patch.width * scale));
            canvas.height = Math.max(1, Math.round(patch.height * scale));
            gl.viewport(0, 0, canvas.width, canvas.height);
            draw(time, petTime);
        }

        const mesh = makeMesh(pose);
        try {
            program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, `
                attribute vec4 a_vertex;
                attribute vec2 a_nuzzle;
                uniform float u_breath;
                uniform float u_pet;
                uniform vec2 u_tail;
                uniform vec4 u_patch;
                uniform vec2 u_image;
                varying highp vec2 v_uv;
                void main() {
                    vec2 p = a_vertex.xy - vec2(0.0, u_breath * a_vertex.z) + u_tail * a_vertex.w;
                    p += a_nuzzle * u_pet;
                    vec2 clip = (p - u_patch.xy) / u_patch.zw * 2.0 - 1.0;
                    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
                    v_uv = a_vertex.xy / u_image;
                }
            `));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `
                precision mediump float;
                uniform sampler2D u_painting;
                varying highp vec2 v_uv;
                void main() { gl_FragColor = texture2D(u_painting, v_uv); }
            `));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("Scene shader unavailable");
            gl.useProgram(program);
            const vertexBuffer = gl.createBuffer(), indexBuffer = gl.createBuffer();
            buffers.push(vertexBuffer, indexBuffer);
            gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
            const attribute = gl.getAttribLocation(program, "a_vertex");
            gl.enableVertexAttribArray(attribute);
            gl.vertexAttribPointer(attribute, 4, gl.FLOAT, false, 24, 0);
            const nuzzleAttribute = gl.getAttribLocation(program, "a_nuzzle");
            gl.enableVertexAttribArray(nuzzleAttribute);
            gl.vertexAttribPointer(nuzzleAttribute, 2, gl.FLOAT, false, 24, 16);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
            texture = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            if (gl.getError() !== gl.NO_ERROR) throw new Error("Scene texture unavailable");
            gl.uniform1i(gl.getUniformLocation(program, "u_painting"), 0);
            gl.uniform2f(gl.getUniformLocation(program, "u_image"), WIDTH, HEIGHT);
            gl.uniform4f(gl.getUniformLocation(program, "u_patch"), patch.x, patch.y, patch.width, patch.height);
            breathLocation = gl.getUniformLocation(program, "u_breath");
            tailLocation = gl.getUniformLocation(program, "u_tail");
            petLocation = gl.getUniformLocation(program, "u_pet");
            resize();
            // Insert before the interactive targets; the decorative canvas never captures input.
            artboard.insertBefore(canvas, artboard.querySelector(".scene-targets"));
            canvas.addEventListener("webglcontextlost", lost);
            if (window.ResizeObserver) {
                observer = new window.ResizeObserver(resize);
                observer.observe(artboard);
            }
            window.addEventListener("resize", resize);
            return { draw, dispose };
        } catch (error) {
            dispose();
            throw error;
        }
    }

    function syncControl() {
        document.body?.classList?.toggle("scene-motion-enabled", enabled && !reduced.matches);
        if (!control) return;
        control.disabled = reduced.matches;
        control.setAttribute("aria-checked", String(enabled && !reduced.matches));
        control.querySelector("span").textContent = reduced.matches ? "系统已减弱" : enabled ? "开" : "关";
    }

    function setupControl(button) {
        if (!reduced) {
            try { enabled = localStorage.getItem(preferenceKey) !== "false"; } catch (_) { /* Session only. */ }
            reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
            const changed = () => { syncControl(); current?.update(); };
            if (reduced.addEventListener) reduced.addEventListener("change", changed);
            else reduced.addListener(changed);
        }
        if (button) {
            control = button;
            control.onclick = () => {
                enabled = !enabled;
                try { localStorage.setItem(preferenceKey, String(enabled)); } catch (_) { /* Session only. */ }
                syncControl();
                current?.update();
            };
        }
        syncControl();
    }

    function mount(artboard, image, theme = "night") {
        current?.destroy();
        const pose = poses[theme];
        if (!pose) return () => {};
        setupControl();
        const source = image.src;
        let disposed = false, failed = false, ready = false, renderer = null;
        let frame = 0, lastTime = null, elapsed = 0, petStart = null;

        function pet() {
            if (disposed || failed || !ready || !renderer || !enabled || reduced.matches
                || document.hidden || !artboard.isConnected || petStart !== null) return false;
            petStart = elapsed;
            return true;
        }

        function draw() {
            if (petStart !== null && elapsed - petStart >= PET_DURATION) petStart = null;
            renderer.draw(elapsed, petStart === null ? -1 : elapsed - petStart);
        }

        function stop() {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            lastTime = null;
        }

        function fail() {
            failed = true;
            stop();
            renderer?.dispose();
            renderer = null;
        }

        function update() {
            if (disposed || failed) return;
            if (!artboard.isConnected) { destroy(); return; }
            if (!enabled || reduced.matches || document.hidden) {
                stop();
                if (!enabled || reduced.matches) {
                    elapsed = 0;
                    petStart = null;
                    renderer?.dispose();
                    renderer = null;
                }
                return;
            }
            if (!ready) return;
            try {
                if (!renderer) renderer = createRenderer(artboard, image, pose, fail);
                if (!frame) {
                    draw();
                    frame = requestAnimationFrame(tick);
                }
            } catch (_) { fail(); }
        }

        function tick(time) {
            frame = 0;
            if (disposed || failed) return;
            if (!enabled || reduced.matches || document.hidden || !artboard.isConnected) { update(); return; }
            if (lastTime !== null) elapsed += Math.min(time - lastTime, 100);
            lastTime = time;
            try {
                draw();
                frame = requestAnimationFrame(tick);
            } catch (_) { fail(); }
        }

        function loaded() {
            // A theme switch may briefly leave the previous image's dimensions
            // on the element while its new request is pending.
            if (disposed || image.src !== source || image.currentSrc !== source) return;
            ready = image.naturalWidth === WIDTH && image.naturalHeight === HEIGHT;
            update();
        }

        function destroy() {
            if (disposed) return;
            disposed = true;
            stop();
            renderer?.dispose();
            renderer = null;
            image.removeEventListener("load", loaded);
            image.removeEventListener("error", fail);
            document.removeEventListener("visibilitychange", update);
            if (current === controller) current = null;
        }

        const controller = { update, destroy, pet };
        current = controller;
        image.addEventListener("load", loaded);
        image.addEventListener("error", fail);
        document.addEventListener("visibilitychange", update);
        if (image.complete) loaded();
        return destroy;
    }

    window.HomeSceneMotion = {
        setupControl, mount,
        pet: () => current?.pet() || false,
        canAnimate() { setupControl(); return enabled && !reduced.matches; }
    };
})();
