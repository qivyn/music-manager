const { test: nodeTest } = require('node:test');
const test = (name, work) => nodeTest(name, { timeout: 5000 }, work);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const { createPreview } = require('../frontend/.preview/build-preview.cjs');

const source = require('./app-source.cjs').readAppSource();
const { createLibraryQuery } = require('../frontend/.preview/library-query.js');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

class Element {
    constructor(id = '') {
        this.id = id; this.dataset = {}; this.value = ''; this.textContent = ''; this.innerHTML = '';
        this.tagName = 'DIV'; this.parentElement = null; this.listeners = new Map(); this.disabled = false;
        this.paused = true; this.currentTime = 0; this.duration = 180; this.src = ''; this.plays = [];
        const classes = new Set();
        this.classList = { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
            contains: name => classes.has(name), toggle: (name, enabled = !classes.has(name)) => { enabled ? classes.add(name) : classes.delete(name); return enabled; } };
        this.style = { setProperty() {}, removeProperty() {} };
    }
    get innerHTML() { return this.html || ''; }
    set innerHTML(value) { this.html = value; this.onHTML?.(value); }
    insertAdjacentHTML(position, value) { this.innerHTML = position === 'afterbegin' ? value + this.innerHTML : this.innerHTML + value; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
    async fire(type, props = {}) {
        const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...props };
        await Promise.all((this.listeners.get(type) || []).map(fn => fn(event)));
        if (this['on' + type]) await this['on' + type](event);
    }
    matches(selector) {
        return selector.split(',').some(part => {
            part = part.trim();
            const data = part.match(/^\[data-([a-z-]+)\]$/);
            if (data) return data[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()) in this.dataset;
            return part === this.tagName.toLowerCase() || part === '#' + this.id || (part.startsWith('.') && this.classList.contains(part.slice(1)));
        });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelector(selector) {
        if (selector === '.nav-count-value') return this.countElement ||= new Element();
        return null;
    }
    querySelectorAll() { return []; }
    setAttribute() {} removeAttribute(name) { if (name === 'src') this.src = ''; }
    setSelectionRange() {} focus() {} select() {} contains(other) { return this === other; }
    getBoundingClientRect() { return { width: 100, height: 50, left: 0, top: 0 }; }
    load() {} pause() { this.paused = true; void this.fire('pause'); }
    async play() { this.paused = false; this.plays.push(this.src); await this.fire('play'); }
}

function app({ onInvoke = async () => undefined, confirmed = true, renderImports = false, realRender = false } = {}) {
    const elements = new Map();
    const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
    // Materialize controls from the real detail template so field-sync assertions
    // start with the values users actually see, and reopening replaces listeners.
    $('detailContent').onHTML = html => {
        const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#039;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
        for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
            const [, tag, attrs, id] = match;
            const node = new Element(id); node.tagName = tag.toUpperCase();
            node.value = decode(attrs.match(/\bvalue="([^"]*)"/)?.[1] || '');
            if (tag === 'select') {
                const options = html.slice(match.index + match[0].length).split('</select>')[0];
                node.value = options.match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/)?.[1]
                    || options.match(/<option[^>]*value="([^"]*)"/)?.[1] || '';
            }
            elements.set(id, node);
        }
        // Materialize clip rows from the real template and model DOM removal.
        // Keep controls separate so a full detail rebuild loses their identity.
        const list = $('detailClipList');
        let rows = [];
        const renderRows = markup => {
            rows = [...markup.matchAll(/class="clip-item"\s+data-clip-id="([^"]+)"/g)].map(match => {
                const row = new Element(); row.dataset.clipId = match[1]; row.parentElement = list;
                row.remove = () => { rows = rows.filter(item => item !== row); };
                return row;
            });
        };
        renderRows(html);
        list.querySelectorAll = selector => selector === '.clip-item' ? [...rows] : [];
        list.onHTML = renderRows;
    };
    for (const id of ['importModal', 'editModal', 'shortcutsModal', 'clipEditorPanel', 'updateModal', 'detailPanel', 'musicClipsPanel']) $(id).classList.add('hidden');
    const tracks = [1, 2, 3].map(n => ({ id: `m${n}`, name: `Track ${n}`, artist: 'Before', path: `/music/${n}.mp3`, album: 'A',
        albumSource: 'metadata', fileName: `${n}.mp3`, tags: [], tagIds: [], duration: 180, lastPlayedAt: null, playCount: 0, createdAt: n }));
    const clips = [{ id: 'c1', musicId: 'm1', name: 'Clip', start: 10, end: 20, tags: [], tagIds: [] }];
    const tags = [{ id: 1, name: 'A', categoryId: 1 }, { id: 2, name: 'B', categoryId: 1 }, { id: 3, name: 'C', categoryId: 1 }];
    const albumTags = new Map([['A', [1, 2, 3]]]);
    const queries = createLibraryQuery({ music: tracks, clips, tags });
    const calls = [], messages = [], rendered = [];
    let drop;
    const invoke = async (command, args = {}) => {
        calls.push({ command, args: clone(args) });
        const custom = await onInvoke(command, args);
        if (custom !== undefined) return custom;
        switch (command) {
            case 'query_library_page': {
                const q = args.query;
                if (q.kind === 'clips' && q.musicId) {
                    // Existing concurrency scenarios delay the same clip read;
                    // the transport now wraps only the requested SQL page.
                    const custom = await onInvoke('list_clips_for_music', { musicId: q.musicId });
                    if (custom !== undefined) {
                        const page = queries.page(q);
                        return { ...page, items: custom.map(clip => ({clip,music:tracks.find(m=>m.id===clip.musicId)})), total: custom.length };
                    }
                }
                return clone(queries.page(q));
            }
            case 'library_related_ids': return queries.related(args.musicIds, args.album);
            case 'query_music_neighbor': return clone(queries.neighbor(args.query,args.id,args.direction));
            case 'get_music': return clone(tracks.find(m => m.id === args.id) || null);
            case 'get_clip': return clone(clips.find(c => c.id === args.id) || null);
            case 'list_music': return clone(tracks);
            case 'list_clips': return clone(clips);
            case 'list_clips_for_music': return clone(clips.filter(c => c.musicId === args.musicId));
            case 'sync_library_locations': return { updatedPaths: 0, updatedAlbums: 0 };
            case 'file_exists': return true;
            case 'probe_file': return { exists: true, album: 'Metadata', folderAlbum: 'Folder' };
            case 'get_music_cover_arts': return [];
            case 'list_tags': return clone(tags);
            case 'list_tag_category_records': return [{ id: 1, name: 'Mood' }];
            case 'get_library_counts': return { music: tracks.length, clips: clips.length };
            case 'list_album_tags': return [...albumTags].map(([album, tagIds]) => ({ album, tagIds: [...tagIds] }));
            case 'set_album_tags': {
                if (args.tagIds.some(id => !tags.some(tag => tag.id === id))) throw new Error('missing tag');
                albumTags.set(args.album, [...args.tagIds]); return [...args.tagIds];
            }
            case 'delete_tag': {
                tags.splice(tags.findIndex(t => t.id === args.id), 1);
                for (const [album, ids] of albumTags) albumTags.set(album, ids.filter(id => id !== args.id));
                return null;
            }
            case 'update_music': {
                const index = tracks.findIndex(m => m.id === args.music.id);
                assert(index >= 0); tracks[index] = clone(args.music); return null;
            }
            case 'create_music': {
                if (tracks.some(m => m.path === args.music.path)) throw new Error('UNIQUE music.path');
                tracks.push(clone(args.music)); return null;
            }
            case 'create_clip': {
                assert(tracks.some(m => m.id === args.clip.musicId)); clips.push(clone(args.clip)); return null;
            }
            case 'update_clip': {
                const index = clips.findIndex(c => c.id === args.clip.id); assert(index >= 0);
                clips[index] = clone(args.clip); return null;
            }
            case 'mark_music_played': {
                const music = tracks.find(m => m.id === args.id); music.lastPlayedAt = Date.now(); music.playCount++; return null;
            }
            case 'delete_music_batch': case 'delete_clip_batch': {
                const ids = new Set(args.ids);
                if (command === 'delete_music_batch') {
                    for (let i = tracks.length - 1; i >= 0; i--) if (ids.has(tracks[i].id)) tracks.splice(i, 1);
                    for (let i = clips.length - 1; i >= 0; i--) if (ids.has(clips[i].musicId)) clips.splice(i, 1);
                } else for (let i = clips.length - 1; i >= 0; i--) if (ids.has(clips[i].id)) clips.splice(i, 1);
                return null;
            }
            default: return null;
        }
    };
    const radios = Object.fromEntries(['metadata', 'folder'].map(value => {
        const node = new Element(); node.value = value; return [value, node];
    }));
    const document = new Element('document');
    Object.assign(document, { body: new Element('body'), hidden: false, getElementById: $, activeElement: null,
        querySelector: selector => radios[selector.match(/input\[name="albumSource"\]\[value="([^"]+)"\]/)?.[1]] || null,
        querySelectorAll: selector => selector === 'input[name="albumSource"]' ? Object.values(radios) : [], createElement: () => new Element() });
    const window = { __TAURI__: { core: { invoke, convertFileSrc: value => value },
        dialog: { ask: async () => confirmed, message: async text => messages.push(text), open: async () => null },
        opener: { revealItemInDir: async () => {} }, window: { getCurrentWindow: () => ({ onDragDropEvent: async fn => { drop = fn; } }) } },
        addEventListener() {}, matchMedia: () => ({ matches: false }) };
    const context = { AbortController, console: { log() {}, error() {} }, window, document, localStorage: { getItem: () => null, setItem() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame() {}, CSS: { escape: s => s }, alert: text => { throw new Error(text); },
        recordRender: () => rendered.push(true), recordMessage: text => messages.push(text) };
    vm.createContext(context); vm.runInContext(source, context);
    vm.runInContext(`state.currentView = 'all';
        ${realRender ? '' : 'render = async () => recordRender();'} renderSidebarTags = async () => {};
        ${renderImports ? '' : 'renderSelectedFiles = async () => {};'} renderCandidatePanel = async () => {};
        renderFilterPanel = async () => {}; renderDetailTagSuggestions = async () => {};
        syncHomePlayback = () => {}; showToast = text => recordMessage(text);`, context);
    return { $, context, tracks, clips, tags, albumTags, calls, messages, rendered, radios,
        run: code => vm.runInContext(code, context), state: vm.runInContext('state', context),
        bind() { vm.runInContext('setupEvents()', context); }, drop: event => drop(event) };
}

const readMusic = (a, id) => a.run(`dbGet('music', '${id}')`);

test('detail selection is committed with its markup; late A cannot overwrite B', async () => {
    const waitA = deferred();
    const a = app({ onInvoke: (cmd, args) => cmd === 'list_clips_for_music' && args.musicId === 'm1' ? waitA.promise : undefined });
    const first = a.run("openDetail('m1')"); await tick();
    assert.equal(a.state.selectedMusic, null);
    await a.run("openDetail('m2')");
    waitA.resolve([]); await first;
    assert.equal(a.state.selectedMusic.id, 'm2');
    assert(a.$('detailContent').innerHTML.includes('Track 2'));
    assert(!a.$('detailContent').innerHTML.includes('Track 1'));
});

test('closing context panels invalidates an outstanding detail load', async () => {
    const wait = deferred(); const a = app({ onInvoke: cmd => cmd === 'list_clips_for_music' ? wait.promise : undefined });
    const pending = a.run("openDetail('m1')"); await tick(); a.run('closeMusicContextPanels()');
    wait.resolve([]); await pending;
    assert.equal(a.state.selectedMusic, null); assert(a.$('detailPanel').classList.contains('hidden'));
});

test('overlapping autosaves preserve both fields and the live input draft', async () => {
    const a = app(); await a.run("openDetail('m1')");
    a.$('detailEditGenre').value = 'unsaved draft';
    const results = await a.run("Promise.all([saveDetailEdit({name:'New name'}), saveDetailEdit({artist:'New artist'})])");
    assert.deepEqual(Array.from(results), [true, true]);
    assert.equal(a.tracks[0].name, 'New name'); assert.equal(a.tracks[0].artist, 'New artist');
    assert.equal(a.state.selectedMusic.name, 'New name'); assert.equal(a.$('detailEditGenre').value, 'unsaved draft');
});

test('rapidly reverting a field queues the revert instead of comparing a stale row', async () => {
    const wait = deferred(); let first = true;
    const a = app({ onInvoke: async cmd => { if (cmd === 'update_music' && first) { first = false; await wait.promise; } } });
    await a.run("openDetail('m1')");
    a.$('detailEditName').value = 'Temporary'; const firstChange = a.$('detailEditName').fire('change'); await tick();
    a.$('detailEditName').value = 'Track 1'; const revert = a.$('detailEditName').fire('change');
    wait.resolve(); await Promise.all([firstChange, revert]);
    assert.equal(a.tracks[0].name, 'Track 1');
});

test('a slow album-source probe saves its own track after selection changes', async () => {
    const probe = deferred(); const a = app({ onInvoke: cmd => cmd === 'probe_file' ? probe.promise : undefined });
    await a.run("openDetail('m1')"); a.$('detailEditAlbumSource').value = 'folder';
    const saving = a.$('detailEditAlbumSource').fire('change'); await tick(); await a.run("openDetail('m2')");
    probe.resolve({ exists: true, folderAlbum: 'New folder' }); await saving;
    assert.equal(a.tracks[0].album, 'New folder'); assert.equal(a.tracks[1].album, 'A');
    assert.equal(a.state.selectedMusic.id, 'm2');
});

test('autosave failures leave the queue usable and do not reopen a closed panel', async () => {
    let fail = true; const wait = deferred();
    const a = app({ onInvoke: async cmd => { if (cmd === 'update_music' && fail) { await wait.promise; throw new Error('disk offline'); } } });
    await a.run("openDetail('m1')"); const saving = a.run("saveDetailEdit({name:'Fail'})"); await tick();
    a.run('closeMusicContextPanels()'); wait.resolve(); assert.equal(await saving, false);
    assert(a.$('detailPanel').classList.contains('hidden'));
    fail = false; await a.run("openDetail('m1')"); assert.equal(await a.run("saveDetailEdit({name:'Retry'})"), true);
    assert.equal(a.tracks[0].name, 'Retry');
});

for (const button of ['closeClipEditor', 'cancelClipEditor']) {
    test(`${button} preserves dirty clips when the user cancels discard`, async () => {
        const a = app({ confirmed: false }); a.bind();
        a.run("state.clipMusic = {id:'m1'}; state.clipInitialState = getClipEditorSnapshot();");
        a.$('clipName').value = 'dirty'; a.$('clipEditorPanel').classList.remove('hidden');
        await a.$(button).fire('click');
        assert.equal(a.state.clipMusic.id, 'm1'); assert(!a.$('clipEditorPanel').classList.contains('hidden'));
        assert.equal(a.$('clipName').value, 'dirty');
    });
}

test('confirmed discard closes the editor; an Event object never forces discard', async () => {
    const a = app({ confirmed: true }); a.bind();
    a.run("state.clipMusic = {id:'m1'}; state.clipInitialState = getClipEditorSnapshot();");
    a.$('clipName').value = 'dirty'; await a.$('cancelClipEditor').fire('click');
    assert.equal(a.state.clipMusic, null); assert(a.$('clipEditorPanel').classList.contains('hidden'));
    const b = app({ confirmed: false }); b.run("state.clipMusic={id:'m1'}; state.clipInitialState=getClipEditorSnapshot();");
    b.$('clipName').value = 'dirty'; await b.run("closeClipEditor({type:'click'})"); assert.equal(b.state.clipMusic.id, 'm1');
});

test('view next/previous keep the view queue even when candidates differ', async () => {
    const a = app(); a.bind(); await a.run("(async()=>{visibleQueueMusic = (await requestLibraryPage({kind:'music'},'test')).items; state.player.candidates=[{id:'m3',kind:'music'}]; await playMusic('m1');})()");
    await a.run('nextTrack()'); await a.run('nextTrack()'); await a.run('prevTrack()');
    assert.equal(a.state.player.music.id, 'm2'); assert.equal(a.state.player.queueSource, 'view');
    assert.deepEqual(Array.from(a.state.player.queue, m => m.id), ['m1', 'm2', 'm3']);
});

test('mixed candidate queues still move between whole tracks and clips', async () => {
    const a = app(); a.bind(); a.run("state.player.candidates=[{id:'m1',kind:'music'},{id:'c1',kind:'clip'},{id:'m3',kind:'music'}]");
    await a.run("playMusic('m1',{source:'candidates'})"); await a.run('nextTrack()');
    assert.equal(a.state.player.segment.clipId, 'c1');
    await a.run('nextTrack()'); assert.equal(a.state.player.music.id, 'm3'); assert.equal(a.state.player.segment, null);
    await a.run('prevTrack()'); assert.equal(a.state.player.segment.clipId, 'c1'); assert.equal(a.state.player.queueSource, 'candidates');
});

for (const phase of ['get_music', 'file_exists', 'sync_library_locations']) {
    test(`workspace close during ${phase} cannot resurrect playback`, async () => {
        const waiting = deferred(), started = deferred(); let blocked = false;
        const a = app({ onInvoke: async cmd => { if (cmd === phase && !blocked) { blocked = true; started.resolve(); return await waiting.promise; } } });
        a.bind(); const loading = a.run("playMusic('m1')"); await started.promise;
        a.run('clearPlayer()'); waiting.resolve(undefined); await loading;
        assert.equal(a.state.player.music, null); assert.equal(a.$('barAudio').src, ''); assert.equal(a.$('barAudio').plays.length, 0);
    });
}

test('a newer workspace selection wins an older file check', async () => {
    const wait = deferred(), started = deferred();
    const a = app({ onInvoke: async (cmd, args) => { if (cmd === 'file_exists' && args.path === '/music/1.mp3') { started.resolve(); return wait.promise; } } });
    a.bind(); const old = a.run("playMusic('m1')"); await started.promise;
    await a.run("playMusic('m2')"); wait.resolve(true); await old;
    assert.equal(a.state.player.music.id, 'm2'); assert.deepEqual(a.$('barAudio').plays, ['/music/2.mp3']);
});

test('native Tauri drag payload imports files and responds to over/leave', async () => {
    const a = app({ onInvoke: cmd => cmd === 'scan_import_sources' ? {items:[{ exists: true, path: '/new.mp3', name: 'New' }],warnings:[],cancelled:false} : cmd === 'find_existing_music_paths' ? [] : undefined });
    a.bind(); a.$('importModal').classList.remove('hidden');
    await a.drop({ event: 'tauri://drag-over', payload: { type: 'over' } }); assert(a.$('dropZone').classList.contains('dragover'));
    await a.drop({ event: 'tauri://drag-leave', payload: { type: 'leave' } }); assert(!a.$('dropZone').classList.contains('dragover'));
    await a.drop({ event: 'tauri://drag-drop', payload: { type: 'drop', paths: ['/new.mp3'] } });
    assert.equal(a.state.importFiles.length, 1); assert.equal(a.state.importFiles[0].path, '/new.mp3');
    a.$('importModal').classList.add('hidden'); await a.drop({ payload: { type: 'drop', paths: ['/new.mp3'] } }); assert.equal(a.state.importFiles.length, 1);
});

test('partial import retries only the pending files and refreshes committed data', async () => {
    let fail = true;
    const a = app({ onInvoke: (cmd, args) => { if (cmd === 'create_music' && args.music.name === 'Y' && fail) throw new Error('disk offline'); } });
    a.run("getAudioDuration=async()=>180; state.importFiles=['X','Y','Z'].map(name=>({name,path:'/'+name+'.mp3',fileName:name+'.mp3',album:'A'}))");
    await a.run('importSelectedFiles()');
    assert.deepEqual(Array.from(a.state.importFiles, m => m.name), ['Y', 'Z']); assert(a.rendered.length > 0);
    fail = false; await a.run('importSelectedFiles()');
    assert.equal(a.state.importFiles.length, 0);
    assert.deepEqual(a.tracks.filter(m => ['X', 'Y', 'Z'].includes(m.name)).map(m => m.name), ['X', 'Y', 'Z']);
});

test('a second import click cannot duplicate an in-flight batch', async () => {
    const a = app(); const wait = deferred(); a.context.waitForDuration = () => wait.promise;
    a.run("getAudioDuration=()=>waitForDuration(); state.importFiles=[{name:'X',path:'/X.mp3',album:'A'}]");
    const importing = a.run('importSelectedFiles()'); await a.run('importSelectedFiles()'); wait.resolve(180); await importing;
    assert.equal(a.tracks.filter(m => m.path === '/X.mp3').length, 1);
});

test('files appended during an import remain pending and reopening does not reset the active batch', async () => {
    const a = app(); const wait = deferred(); a.context.waitForDuration = () => wait.promise;
    a.run("getAudioDuration=()=>waitForDuration(); state.importFiles=[{name:'X',path:'/X.mp3',album:'A'}]");
    a.$('importModal').classList.remove('hidden');
    const importing = a.run('importSelectedFiles()');
    a.run("openImportModal(); appendImportItems([{name:'Y',path:'/Y.mp3',album:'A'}])");
    assert.equal(a.state.importFiles.length, 2);
    wait.resolve(180); await importing;
    assert.deepEqual(Array.from(a.state.importFiles, m => m.name), ['Y']);
    assert(!a.$('importModal').classList.contains('hidden'));
});

test('manual import album overrides survive changing the global source and persist as manual', async () => {
    const a = app(); a.bind();
    a.run("getAudioDuration=async()=>180; state.importAlbumSource='folder'; state.importFiles=makeImportItems([{exists:true,name:'X',path:'/X.mp3',album:'Metadata',folderAlbum:'Folder'}])");
    const card = new Element(); card.dataset.fileIndex = '0';
    const input = new Element(); input.dataset.fileField = 'album'; input.value = 'My album'; input.parentElement = card;
    await a.$('selectedFiles').fire('input', { target: input });
    assert.equal(a.state.importFiles[0].albumSource, 'manual');
    // The global selector applies only to rows that still follow a source.
    await a.radios.metadata.fire('change');
    assert.equal(a.state.importFiles[0].album, 'My album');
    await a.run('importSelectedFiles()');
    const saved = a.tracks.find(m => m.path === '/X.mp3'); assert.equal(saved.album, 'My album'); assert.equal(saved.albumSource, 'manual');
});

for (const store of ['music', 'clips']) {
    test(`batch ${store} deletion clears the current player, related candidates and selections`, async () => {
        const a = app(); a.bind(); a.state.player.music = await readMusic(a, 'm1');
        a.state.player.segment = store === 'clips' ? { clipId: 'c1', musicId: 'm1' } : null;
        a.state.player.candidates = [{ id: 'm1', kind: 'music' }, { id: 'c1', kind: 'clip' }, { id: 'm3', kind: 'music' }];
        a.state.player.queue = [...a.state.player.candidates]; a.state.selectedMusic = await readMusic(a, 'm1');
        a.state.selectedMusicIds.add('m1'); a.state.selectedClipIds.add('c1'); a.state.selectionMode = true;
        a.state.currentView = store === 'clips' ? 'clips' : 'all';
        await a.$('bulkDeleteBtn').fire('click');
        assert.equal(a.state.player.music, null); assert.equal(a.$('barAudio').src, ''); assert.equal(a.state.selectionMode, false);
        assert.deepEqual(Array.from(a.state.player.candidates, c => c.id), store === 'music' ? ['m3'] : ['m1', 'm3']);
        assert.equal(a.state.selectedMusicIds.size, 0); assert.equal(a.state.selectedClipIds.size, 0);
        assert.equal(a.$('candidateNavCount').textContent, store === 'music' ? 1 : 2);
        if (store === 'music') assert.equal(a.state.selectedMusic, null);
    });
}

for (const batch of [false, true]) {
    test(`${batch ? 'batch' : 'single'} clip deletion updates detail rows and counts without replacing drafts`, async () => {
        const a = app();
        a.clips.push({ ...clone(a.clips[0]), id: 'c2', name: 'Another clip' });
        await a.run("openDetail('m1')");
        const name = a.$('detailEditName'), tags = a.$('detailEditTagInput');
        name.value = 'Uncommitted name'; tags.value = 'Uncommitted tag';
        const tab = a.$('detailClipsTab'), panel = a.$('detailTabClips');
        tab.classList.add('active'); panel.classList.remove('hidden');
        const rowIds = () => a.$('detailClipList').querySelectorAll('.clip-item').map(row => row.dataset.clipId);
        assert.deepEqual(rowIds(), ['c1', 'c2']);
        if (batch) await a.run("deleteLibraryEntries('clips', ['c1', 'c2'], { exitSelection: true })");
        else {
            await a.run("deleteClip('c1')");
            assert.deepEqual(rowIds(), ['c2']);
            assert.equal(tab.textContent, '音乐片段（1）');
            assert.equal(a.$('detailClipsHeading').textContent, '音乐片段（1）');
            await a.run("deleteClip('c2')");
        }
        assert.equal(a.clips.length, 0);
        assert.deepEqual(rowIds(), []);
        assert(a.$('detailClipList').innerHTML.includes('暂无片段'));
        assert.equal(tab.textContent, '音乐片段');
        assert.equal(a.$('detailClipsHeading').textContent, '音乐片段');
        assert.equal(a.$('detailEditName'), name); assert.equal(name.value, 'Uncommitted name');
        assert.equal(a.$('detailEditTagInput'), tags); assert.equal(tags.value, 'Uncommitted tag');
        assert.equal(a.$('detailClipsTab'), tab); assert(tab.classList.contains('active'));
        assert.equal(a.$('detailTabClips'), panel); assert(!panel.classList.contains('hidden'));
        assert(!a.$('detailPanel').classList.contains('hidden'));
    });
}

test('failed clip deletion leaves the detail rows intact', async () => {
    const a = app({ onInvoke: cmd => { if (cmd === 'delete_clip_batch') throw new Error('delete failed'); } });
    await a.run("openDetail('m1')");
    await assert.rejects(a.run("deleteClip('c1')"), /delete failed/);
    assert.equal(a.clips.length, 1);
    assert.deepEqual(a.$('detailClipList').querySelectorAll('.clip-item').map(row => row.dataset.clipId), ['c1']);
});

test('a slow deletion does not replace another track detail opened in the meantime', async () => {
    const wait = deferred(), started = deferred();
    const a = app({ onInvoke: async cmd => { if (cmd === 'delete_clip_batch') { started.resolve(); await wait.promise; } } });
    a.clips.push({ ...clone(a.clips[0]), id: 'c2', musicId: 'm2' });
    await a.run("openDetail('m1')");
    const deletion = a.run("deleteClip('c1')"); await started.promise;
    await a.run("openDetail('m2')");
    const name = a.$('detailEditName'); name.value = 'Other track draft';
    wait.resolve(); await deletion;
    assert.equal(a.state.selectedMusic.id, 'm2');
    assert.equal(a.$('detailEditName'), name); assert.equal(name.value, 'Other track draft');
    assert.deepEqual(a.$('detailClipList').querySelectorAll('.clip-item').map(row => row.dataset.clipId), ['c2']);
});

test('deleting another candidate preserves current audio and repairs the queue index', async () => {
    const a = app(); a.bind(); await a.run("playMusic('m1')");
    a.state.player.candidates = [{ id: 'm2', kind: 'music' }, { id: 'm1', kind: 'music' }];
    a.state.player.queue = [...a.state.player.candidates]; a.state.player.queueSource = 'candidates'; a.state.player.index = 1;
    await a.run("deleteLibraryEntries('music',['m2'])");
    assert.equal(a.state.player.music.id, 'm1'); assert.equal(a.$('barAudio').paused, false); assert.equal(a.state.player.index, 0);
});

test('sidebar tag deletion refreshes album IDs before the next album edit', async () => {
    const a = app(); a.bind(); await a.run('getAllTagRecords(); loadAlbumTags()');
    const deleted = new Element(); deleted.dataset.sidebarTagDelete = '1';
    await a.$('sidebarTags').fire('click', { target: deleted });
    assert.deepEqual(Array.from(a.run("albumTagsCache.get('A')")), [2, 3]);
    await a.run("removeAlbumTag('A',2)"); assert.deepEqual(a.albumTags.get('A'), [3]);
});

test('recent playback reads fresh history during the same session', async () => {
    const a = app(); a.bind();
    a.state.player.music = await readMusic(a, 'm1'); a.state.currentView = 'recent'; a.state.recentMode = 'used';
    a.run('markCurrentTrackUsed()'); await tick();
    const page = await a.run("requestLibraryPage({kind:'music',recent:'used'},'recent-test')");
    assert.equal(page.items[0].id, 'm1'); assert(page.items[0].lastPlayedAt);
});

test('an in-flight old page response is discarded after playback invalidates its revision', async () => {
    const wait = deferred(); let old = true; const a = app({ onInvoke: cmd => { if (cmd === 'query_library_page' && old) { old = false; return wait.promise; } } });
    const staleRows = clone(a.tracks); const loading = a.run("requestLibraryPage({kind:'music'},'test')"); await tick();
    a.state.player.music = await readMusic(a, 'm1'); a.run('markCurrentTrackUsed()'); await tick();
    wait.resolve({items:staleRows,total:3,page:1,pageSize:50,totalPages:1});
    const page = await loading; assert(page.items.find(m => m.id === 'm1').lastPlayedAt);
});

test('preview generator injects the mock before app.js without requiring Three.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
    const preview = createPreview(html);
    assert(preview.indexOf('.preview/mock-tauri.js') < preview.indexOf('src="app.js"'));
    assert.equal((createPreview(preview).match(/src="\.preview\/mock-tauri\.js"/g) || []).length, 1);
    assert(!preview.includes('src="vendor/three.min.js"'));
});

test('preview CLI preserves an existing output when the template is invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-preview-'));
    try {
        const input = path.join(dir, 'input with spaces.html'), output = path.join(dir, 'output with spaces.html');
        fs.writeFileSync(input, '<html></html>'); fs.writeFileSync(output, 'keep');
        const cli = path.join(__dirname, '../frontend/.preview/build-preview.cjs');
        assert.notEqual(spawnSync(process.execPath, [cli, input, output]).status, 0); assert.equal(fs.readFileSync(output, 'utf8'), 'keep');
        fs.writeFileSync(input, '<script src="app.js"></script>');
        assert.equal(spawnSync(process.execPath, [cli, input, output]).status, 0); assert(fs.readFileSync(output, 'utf8').includes('mock-tauri.js'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const first of ['detail', 'quick-tag']) {
    test(`detail and quick-tag writes preserve each other when ${first} starts first`, async () => {
        const wait = deferred(), started = deferred(); let block = true;
        const a = app({ onInvoke: async cmd => {
            if (cmd === 'update_music' && block) { block = false; started.resolve(); await wait.promise; }
        } });
        await a.run("openDetail('m1')"); await a.run("getAllTagRecords()");
        const detail = () => a.run("saveDetailEdit({name:'Renamed'})");
        const quick = () => a.run("saveQuickTag('m1','',1)");
        const one = first === 'detail' ? detail() : quick(); await started.promise;
        const two = first === 'detail' ? quick() : detail();
        await tick(); // Let an unqueued writer read the stale row before releasing the first write.
        wait.resolve(); await Promise.all([one, two]);
        assert.equal(a.tracks[0].name, 'Renamed'); assert.deepEqual(a.tracks[0].tagIds, [1]);
    });
}

test('concurrent quick tags and detail tag additions merge against the latest row', async () => {
    const a = app(); await a.run("openDetail('m1')"); await a.run("getAllTagRecords()");
    a.$('detailEditTagInput').value = 'New detail tag';
    await a.run("Promise.all([saveQuickTag('m1','',1), saveQuickTag('m1','',2), addDetailEditTag(), saveDetailEdit({artist:'New artist'})])");
    assert.deepEqual(a.tracks[0].tags, ['A', 'B', 'New detail tag']);
    assert.equal(a.tracks[0].artist, 'New artist');
    await a.run("Promise.all([saveQuickTag('m1','',1),saveQuickTag('m1','',1)])");
    assert.equal(a.tracks[0].tagIds.filter(id => id === 1).length, 1);
});

test('removing a detail tag preserves a concurrent quick tag absent from the detail snapshot', async () => {
    const a = app(); a.tracks[0].tags = ['A']; a.tracks[0].tagIds = [1];
    await a.run("openDetail('m1')"); await a.run("getAllTagRecords()");
    const button = new Element(); button.dataset.removeDetailTag = '0';
    await Promise.all([a.run("saveQuickTag('m1','',2)"), a.$('detailEditTags').fire('click', { target: button })]);
    assert.deepEqual(a.tracks[0].tagIds, [2]); assert.deepEqual(a.tracks[0].tags, ['B']);
});

for (const add of [true, false]) {
    test(`bulk tag ${add ? 'addition' : 'removal'} and detail saves preserve unrelated fields`, async () => {
        const a = app(); a.bind(); a.tracks[0].tags = ['A']; a.tracks[0].tagIds = [1];
        await a.run("openDetail('m1')"); a.state.selectedMusicIds.add('m1'); a.$('bulkTagInput').value = add ? 'B' : 'A';
        await Promise.all([a.run("saveDetailEdit({artist:'Changed'})"), a.$(add ? 'bulkAddTagBtn' : 'bulkRemoveTagBtn').fire('click')]);
        assert.equal(a.tracks[0].artist, 'Changed'); assert.deepEqual(a.tracks[0].tags, add ? ['A', 'B'] : []);
    });
}

test('rebinding a stale record preserves metadata saved while its new audio is loading', async () => {
    const duration = deferred(), started = deferred(); const a = app({ onInvoke: cmd => cmd === 'probe_file'
        ? {exists:true,path:'/new.mp3',fileName:'new.mp3',name:'New audio',fileSize:100,mimeType:'audio/mpeg'} : undefined });
    await a.run("openDetail('m1')");
    a.context.window.__TAURI__.dialog.open = async () => '/new.mp3';
    a.context.waitForDuration = () => { started.resolve(); return duration.promise; };
    a.run('getAudioDuration=()=>waitForDuration()');
    const binding = a.run('reauthorizeFile(state.selectedMusic)'); await started.promise;
    const saving = a.run("saveDetailEdit({artist:'Later artist'})"); duration.resolve(200); await Promise.all([binding, saving]);
    assert.equal(a.tracks[0].artist, 'Later artist'); assert.equal(a.tracks[0].duration, 200);
    assert.equal(a.tracks[0].path, '/new.mp3');
});

test('restart asks once with only confirm and cancel', async () => {
    const a = app(), prompts = [];
    a.context.window.__TAURI__.dialog.ask = async (message, options) => { prompts.push({ message, options }); return true; };
    const release = await a.run('prepareApplicationUpdate()');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].options.okLabel, '现在重启');
    assert.equal(prompts[0].options.cancelLabel, '稍后');
    assert.match(prompts[0].message, /未保存的输入不会保留/);
    assert.doesNotMatch(prompts[0].message, /管理员密码/);
    assert.equal(typeof release, 'function');
    assert.deepEqual(a.calls.map(c => c.command), ['prepare_update_exit']);
    release();
});

test('restart warns about a password only when the install folder needs it, after confirming', async () => {
    const a = app(), prompts = [], order = [];
    a.context.window.__TAURI__.dialog.ask = async (message) => { prompts.push(message); order.push('ask'); return true; };
    a.context.onConfirmed = () => order.push('confirmed');
    const release = await a.run('prepareApplicationUpdate(true, onConfirmed)');
    assert.match(prompts[0], /管理员密码/);
    assert.deepEqual(order, ['ask', 'confirmed']);
    release();
});

for (const editor of ['detail', 'music', 'clip', 'tag']) {
    test(`restart ignores unsaved ${editor} input without saving or blocking`, async () => {
        const a = app(); a.tracks[0].name = 'Take  01';
        if (editor === 'detail') {
            await a.run("openDetail('m1')"); a.$('detailEditArtist').value = 'Unsaved artist';
        } else if (editor === 'music') {
            await a.run("openEditModalForMusic('m1')"); a.$('editName').value = '';
        } else if (editor === 'clip') {
            await a.run("openClipEditorForMusic('m1')"); a.$('clipName').value = 'Unsaved clip';
        } else {
            a.state.tagDraft = { type: 'create-tag', value: 'Unsaved tag', categoryId: 1 };
        }
        const before = clone({ tracks: a.tracks, clips: a.clips, tags: a.tags }); a.calls.length = 0;
        // The update flow must never ask a second save/discard question.
        a.context.window.__TAURI__.dialog.message = async () => { throw new Error('Unexpected draft dialog'); };
        const release = await a.run('prepareApplicationUpdate()');
        assert.equal(typeof release, 'function');
        assert.deepEqual(a.calls.map(c => c.command), ['prepare_update_exit']);
        assert.deepEqual(clone({ tracks: a.tracks, clips: a.clips, tags: a.tags }), before);
        release();
    });
}

test('cancelling restart keeps input and leaves the app usable without pausing writes', async () => {
    const a = app({ confirmed: false }); await a.run("openDetail('m1')");
    a.$('detailEditArtist').value = 'Keep this draft'; a.calls.length = 0;
    a.context.window.__TAURI__.dialog.message = async () => { throw new Error('Unexpected draft dialog'); };
    assert.equal(await a.run('prepareApplicationUpdate()'), null);
    assert.equal(a.$('detailEditArtist').value, 'Keep this draft');
    assert(!a.context.document.body.inert);
    assert.equal(a.calls.length, 0);
    assert.equal(await a.run("saveDetailEdit({artist:'Saved later'})"), true);
    assert.equal(a.tracks[0].artist, 'Saved later');
});

test('restart waits for complete queued saves and quick tags, while refusing new edits', async () => {
    const read = deferred(), started = deferred(); let block = false;
    const a = app({ onInvoke: async cmd => { if (block && cmd === 'get_music') { block = false; started.resolve(); await read.promise; } } });
    await a.run("openDetail('m1')"); await a.run("getAllTagRecords()"); block = true;
    const saving = a.run("Promise.all([saveDetailEdit({name:'Saved name'}), saveDetailEdit({artist:'Saved artist'}), saveQuickTag('m1','',1)])");
    await started.promise;
    let ready = false; const preparing = a.run('prepareApplicationUpdate()').then(release => { ready = true; return release; });
    await tick(); assert.equal(a.context.document.body.inert, true); assert.equal(ready, false);
    assert.equal(await a.run("saveDetailEdit({genre:'Rejected new edit'})"), false);
    read.resolve(); const release = await preparing; const results = await saving;
    assert.deepEqual(Array.from(results).slice(0, 2), [true, true]);
    assert.equal(a.tracks[0].name, 'Saved name'); assert.equal(a.tracks[0].artist, 'Saved artist'); assert.deepEqual(a.tracks[0].tagIds, [1]);
    assert(!a.tracks[0].genre); release(); assert.equal(a.context.document.body.inert, undefined);
});

test('a queued save failure aborts restart, restores interaction, and permits retry', async () => {
    const read = deferred(), started = deferred(); let block = false, fail = true;
    const a = app({ onInvoke: async cmd => {
        if (block && cmd === 'get_music') { block = false; started.resolve(); await read.promise; }
        if (cmd === 'update_music' && fail) throw new Error('disk full');
    } });
    await a.run("openDetail('m1')"); block = true;
    const saving = a.run("saveDetailEdit({name:'Retry me'})"); await started.promise;
    const preparing = a.run('prepareApplicationUpdate()'); await tick();
    read.resolve(); await assert.rejects(preparing, /操作未能完成/); assert.equal(await saving, false);
    assert(!a.context.document.body.inert); assert.equal(a.tracks[0].name, 'Track 1');
    fail = false; assert.equal(await a.run("saveDetailEdit({name:'Retry me'})"), true); assert.equal(a.tracks[0].name, 'Retry me');
});

test('restart waits for a source probe and the newer manual edit behind it', async () => {
    const probe = deferred(), started = deferred();
    const a = app({ onInvoke: cmd => { if (cmd === 'probe_file') { started.resolve(); return probe.promise; } } });
    await a.run("openDetail('m1')"); a.$('detailEditAlbumSource').value = 'folder';
    const sourceChange = a.$('detailEditAlbumSource').fire('change'); await started.promise;
    a.$('detailEditAlbum').value = 'Latest manual'; const manualChange = a.$('detailEditAlbum').fire('change');
    const preparing = a.run('prepareApplicationUpdate()'); await tick(); probe.resolve({ exists: true, folderAlbum: 'Folder' });
    const release = await preparing; await Promise.all([sourceChange, manualChange]);
    assert.equal(a.tracks[0].album, 'Latest manual'); assert.equal(a.tracks[0].albumSource, 'manual'); release();
});

test('source saves update the album field, and manual album saves update the source selector', async () => {
    const a = app(); await a.run("openDetail('m1')");
    assert.equal(a.$('detailEditAlbum').value, 'A'); assert.equal(a.$('detailEditAlbumSource').value, 'metadata');
    a.$('detailEditAlbumSource').value = 'folder'; await a.$('detailEditAlbumSource').fire('change');
    assert.equal(a.tracks[0].album, 'Folder'); assert.equal(a.$('detailEditAlbum').value, 'Folder');
    a.$('detailEditAlbum').value = '  My   album  '; await a.$('detailEditAlbum').fire('change');
    assert.equal(a.tracks[0].album, 'My album'); assert.equal(a.$('detailEditAlbum').value, 'My album');
    assert.equal(a.tracks[0].albumSource, 'manual'); assert.equal(a.$('detailEditAlbumSource').value, 'manual');
});

test('an earlier source probe never overwrites later manual saves or their visible values', async () => {
    const probe = deferred(), started = deferred();
    const a = app({ onInvoke: cmd => { if (cmd === 'probe_file') { started.resolve(); return probe.promise; } } });
    await a.run("openDetail('m1')"); a.$('detailEditAlbumSource').value = 'folder';
    const sourceChange = a.$('detailEditAlbumSource').fire('change'); await started.promise;
    a.$('detailEditAlbum').value = 'First manual'; const first = a.$('detailEditAlbum').fire('change');
    a.$('detailEditAlbum').value = 'Latest manual'; const latest = a.$('detailEditAlbum').fire('change');
    probe.resolve({ exists: true, folderAlbum: 'Stale folder' }); await Promise.all([sourceChange, first, latest]);
    assert.equal(a.tracks[0].album, 'Latest manual'); assert.equal(a.$('detailEditAlbum').value, 'Latest manual');
    assert.equal(a.$('detailEditAlbumSource').value, 'manual');
});

test('a source probe does not replace an uncommitted input draft or another field draft', async () => {
    const probe = deferred(), started = deferred();
    const a = app({ onInvoke: cmd => { if (cmd === 'probe_file') { started.resolve(); return probe.promise; } } });
    await a.run("openDetail('m1')"); a.$('detailEditAlbumSource').value = 'folder';
    const sourceChange = a.$('detailEditAlbumSource').fire('change'); await started.promise;
    a.$('detailEditAlbum').value = 'Typing, no blur yet'; a.$('detailEditArtist').value = 'Artist draft';
    probe.resolve({ exists: true, folderAlbum: 'Folder' }); await sourceChange;
    assert.equal(a.tracks[0].album, 'Folder'); assert.equal(a.$('detailEditAlbum').value, 'Typing, no blur yet');
    assert.equal(a.$('detailEditArtist').value, 'Artist draft');
    await a.$('detailEditAlbum').fire('change'); assert.equal(a.tracks[0].album, 'Typing, no blur yet');
});

test('multiple source selections keep event order, and manual selection works offline', async () => {
    const probe = deferred(), started = deferred(); let probes = 0;
    const a = app({ onInvoke: cmd => { if (cmd === 'probe_file' && ++probes === 1) { started.resolve(); return probe.promise; } } });
    await a.run("openDetail('m1')"); a.$('detailEditAlbumSource').value = 'folder';
    const first = a.$('detailEditAlbumSource').fire('change'); await started.promise;
    a.$('detailEditAlbumSource').value = 'metadata'; const second = a.$('detailEditAlbumSource').fire('change');
    probe.resolve({ exists: true, folderAlbum: 'Folder' }); await Promise.all([first, second]);
    assert.equal(a.tracks[0].album, 'Metadata'); assert.equal(a.$('detailEditAlbum').value, 'Metadata');
    a.$('detailEditAlbumSource').value = 'manual'; await a.$('detailEditAlbumSource').fire('change');
    assert.equal(probes, 2); assert.equal(a.tracks[0].albumSource, 'manual'); assert.equal(a.tracks[0].album, 'Metadata');
});

function importTarget(index, field, value) {
    const card = new Element(); card.dataset.fileIndex = String(index);
    const input = new Element(); input.dataset.fileField = field; input.value = value; input.parentElement = card;
    return input;
}

for (const fail of [false, true]) {
    test(`real import UI locks stale row edits/removals and unlocks after ${fail ? 'failure' : 'success'}`, async () => {
        const duration = deferred(), started = deferred();
        const a = app({ renderImports: true, onInvoke: (cmd, args) => {
            if (fail && cmd === 'create_music' && args.music.name === 'Y') throw new Error('disk offline');
        } }); a.bind();
        a.context.duration = path => { if (path === '/Y.mp3') { started.resolve(); return duration.promise; } return 180; };
        a.run("getAudioDuration=path=>duration(path); state.importFiles=['X','Y','Z'].map(name=>({name,path:'/'+name+'.mp3',fileName:name+'.mp3',album:'A',metadataAlbum:'A',folderAlbum:'Folder',albumSource:'metadata'}))");
        await a.run('renderSelectedFiles()'); assert(a.$('selectedFiles').innerHTML.includes('data-file-index="2"'));
        const importing = a.run('importSelectedFiles()'); await started.promise; await tick();
        assert.deepEqual(Array.from(a.state.importFiles, m => m.name), ['Y', 'Z']);
        assert.equal(a.$('selectedFiles').inert, true); assert(a.radios.metadata.disabled); assert(a.radios.folder.disabled);
        // Simulate queued/synthetic events as well as the native inert control lock.
        await a.$('selectedFiles').fire('input', { target: importTarget(1, 'name', 'Wrong Z rename') });
        const remove = new Element(); remove.dataset.removeImportFile = '1';
        await a.$('selectedFiles').fire('click', { target: remove }); await a.radios.folder.fire('change');
        assert.deepEqual(Array.from(a.state.importFiles, m => m.name), ['Y', 'Z']);
        assert.equal(a.state.importAlbumSource, 'metadata'); duration.resolve(180); await importing;
        assert.equal(a.$('selectedFiles').inert, false); assert(!a.radios.folder.disabled);
        if (fail) {
            assert(a.$('selectedFiles').innerHTML.includes('data-file-index="0"'));
            await a.$('selectedFiles').fire('input', { target: importTarget(0, 'name', 'Y retry') });
            assert.equal(a.state.importFiles[0].name, 'Y retry');
        } else {
            assert.equal(a.tracks.find(m => m.path === '/Y.mp3').name, 'Y');
            assert.equal(a.tracks.find(m => m.path === '/Z.mp3').name, 'Z');
        }
    });
}

test('restart waits through import metadata loading and commits the entire accepted batch', async () => {
    const duration = deferred(), started = deferred(); const a = app({ renderImports: true });
    a.context.duration = () => { started.resolve(); return duration.promise; };
    a.run("getAudioDuration=()=>duration(); state.importFiles=['X','Y'].map(name=>({name,path:'/'+name+'.mp3',album:'A'}))");
    const importing = a.run('importSelectedFiles()'); await started.promise;
    assert.equal(a.calls.filter(c => c.command === 'create_music').length, 0);
    let ready = false; const preparing = a.run('prepareApplicationUpdate()').then(release => { ready = true; return release; });
    await tick(); assert.equal(ready, false); duration.resolve(180);
    const release = await preparing; await importing;
    assert.equal(a.calls.filter(c => c.command === 'create_music').length, 2); assert.equal(a.state.importFiles.length, 0); release();
});

test('failed import during restart aborts update and restores a usable pending-file list', async () => {
    const duration = deferred(), started = deferred(); let fail = true;
    const a = app({ renderImports: true, onInvoke: (cmd, args) => {
        if (fail && cmd === 'create_music' && args.music.name === 'Y') throw new Error('disk full');
    } }); a.bind();
    a.context.duration = path => { if (path === '/Y.mp3') { started.resolve(); return duration.promise; } return 180; };
    a.run("getAudioDuration=path=>duration(path); state.importFiles=['X','Y'].map(name=>({name,path:'/'+name+'.mp3',album:'A'}))");
    const importing = a.run('importSelectedFiles()'); await started.promise;
    const preparing = a.run('prepareApplicationUpdate()'); await tick(); duration.resolve(180);
    await assert.rejects(preparing, /操作未能完成/); await importing; await tick();
    assert(!a.context.document.body.inert); assert.equal(a.$('selectedFiles').inert, false);
    assert.deepEqual(Array.from(a.state.importFiles, m => m.name), ['Y']);
    assert(a.$('selectedFiles').innerHTML.includes('data-file-index="0"'));
    fail = false; await a.run('importSelectedFiles()');
    assert.equal(a.tracks.filter(m => m.path === '/X.mp3').length, 1); assert.equal(a.tracks.filter(m => m.path === '/Y.mp3').length, 1);
});

test('restart drains a bulk tag operation across every selected record', async () => {
    const wait = deferred(), started = deferred(); let block = true;
    const a = app({ onInvoke: async cmd => { if (cmd === 'update_music' && block) { block = false; started.resolve(); await wait.promise; } } });
    a.bind(); a.state.selectedMusicIds.add('m1'); a.state.selectedMusicIds.add('m2'); a.$('bulkTagInput').value = 'Bulk';
    const tagging = a.$('bulkAddTagBtn').fire('click'); await started.promise;
    const preparing = a.run('prepareApplicationUpdate()'); await tick(); wait.resolve();
    const release = await preparing; await tagging;
    assert.deepEqual(a.tracks[0].tags, ['Bulk']); assert.deepEqual(a.tracks[1].tags, ['Bulk']); release();
});

test('restart waits for rebinding metadata, and a late rebind does not reopen a changed selection', async () => {
    const duration = deferred(), started = deferred();
    const a = app({ onInvoke: cmd => cmd === 'probe_file'
        ? {exists:true,path:'/new.mp3',fileName:'new.mp3',name:'Rebound',fileSize:100,mimeType:'audio/mpeg'} : undefined });
    await a.run("openDetail('m1')"); a.context.window.__TAURI__.dialog.open = async () => '/new.mp3';
    a.context.duration = () => { started.resolve(); return duration.promise; }; a.run('getAudioDuration=()=>duration()');
    const binding = a.run('reauthorizeFile(state.selectedMusic)'); await started.promise;
    await a.run("openDetail('m2')");
    let ready = false; const preparing = a.run('prepareApplicationUpdate()').then(release => { ready = true; return release; });
    await tick(); assert.equal(ready, false); duration.resolve(240);
    const release = await preparing; await binding;
    assert.equal(a.tracks[0].path, '/new.mp3'); assert.equal(a.tracks[0].duration, 240);
    assert.equal(a.state.selectedMusic.id, 'm2'); release();
});

test('a failed source probe does not poison the newer manual save or leave its selector stale', async () => {
    const probe = deferred(), started = deferred();
    const a = app({ onInvoke: async cmd => { if (cmd === 'probe_file') { started.resolve(); await probe.promise; throw new Error('offline'); } } });
    await a.run("openDetail('m1')"); a.$('detailEditAlbumSource').value = 'folder';
    const sourceChange = a.$('detailEditAlbumSource').fire('change'); await started.promise;
    a.$('detailEditAlbum').value = 'Manual survives'; const manual = a.$('detailEditAlbum').fire('change');
    probe.resolve(); await Promise.all([sourceChange, manual]);
    assert.equal(a.tracks[0].album, 'Manual survives'); assert.equal(a.$('detailEditAlbumSource').value, 'manual');
    assert(a.messages.some(text => text.includes('offline')));
});

test('a source change behind rebinding probes the current file rather than a captured stale path', async () => {
    const duration = deferred(), started = deferred(); const paths = [];
    const a = app({ onInvoke: (cmd, args) => {
        if (cmd === 'probe_file') { paths.push(args.path); return {exists:true,path:args.path,fileName:'new.mp3',name:'New',folderAlbum:args.path === '/new.mp3' ? 'New folder' : 'Old folder'}; }
    } });
    await a.run("openDetail('m1')"); a.context.window.__TAURI__.dialog.open = async () => '/new.mp3';
    a.context.duration = () => { started.resolve(); return duration.promise; }; a.run('getAudioDuration=()=>duration()');
    const binding = a.run('reauthorizeFile(state.selectedMusic)'); await started.promise;
    a.$('detailEditAlbumSource').value = 'folder'; const sourceChange = a.$('detailEditAlbumSource').fire('change');
    duration.resolve(200); await Promise.all([binding, sourceChange]);
    assert.deepEqual(paths, ['/new.mp3', '/new.mp3']); assert.equal(a.tracks[0].album, 'New folder');
    assert.equal(a.$('detailEditAlbum').value, 'New folder');
});

test('reopening details during autosave waits for the saved row instead of rendering stale values', async () => {
    const wait = deferred(), started = deferred();
    const a = app({ onInvoke: async cmd => { if (cmd === 'update_music') { started.resolve(); await wait.promise; } } });
    await a.run("openDetail('m1')"); const saving = a.run("saveDetailEdit({album:'Saved album'})"); await started.promise;
    a.run('closeMusicContextPanels()'); const reopening = a.run("openDetail('m1')");
    await tick(); assert(a.$('detailPanel').classList.contains('hidden'));
    wait.resolve(); await Promise.all([saving, reopening]);
    assert.equal(a.$('detailEditAlbum').value, 'Saved album'); assert.equal(a.$('detailEditAlbumSource').value, 'manual');
});

test('restart beginning during post-save UI refresh does not turn a committed save into failure', async () => {
    const count = deferred(), started = deferred(); let block = false;
    const a = app({ onInvoke: async cmd => { if (block && cmd === 'get_library_counts') { block = false; started.resolve(); await count.promise; } } });
    await a.run("openDetail('m1')"); block = true;
    const saving = a.run("saveDetailEdit({name:'Already committed'})"); await started.promise;
    const preparing = a.run('prepareApplicationUpdate()'); await tick(); count.resolve();
    const release = await preparing; assert.equal(await saving, true);
    assert.equal(a.tracks[0].name, 'Already committed'); assert(!a.messages.some(text => text.startsWith('保存失败'))); release();
});

test('modal name edits preserve an unchanged folder source and a concurrent quick tag', async () => {
    const a = app(); a.tracks[0].albumSource = 'folder'; await a.run('getAllTagRecords()');
    a.run('openEditModal('+JSON.stringify(a.tracks[0])+')'); a.$('editName').value = 'Modal name';
    await a.run("saveQuickTag('m1','',1)"); await a.run('saveEdit()');
    assert.equal(a.tracks[0].name, 'Modal name'); assert.equal(a.tracks[0].albumSource, 'folder');
    assert.deepEqual(a.tracks[0].tagIds, [1]);
});

test('modal tag changes merge with concurrent quick tags and preserve newer unchanged metadata', async () => {
    const a = app(); a.tracks[0].tags = ['A']; a.tracks[0].tagIds = [1]; await a.run('getAllTagRecords()');
    a.run('openEditModal('+JSON.stringify(a.tracks[0])+')');
    a.run("editModalDraft.tags=[]; editModalDraft.tagIds=[]"); a.$('editTagInput').value = 'Modal tag'; a.run('addEditTag()');
    await a.run("saveQuickTag('m1','',2)"); await a.run("saveDetailEdit({album:'Later album'},'m1')");
    await a.run('saveEdit()');
    assert.equal(a.tracks[0].album, 'Later album'); assert.deepEqual(a.tracks[0].tags, ['B', 'Modal tag']);
});

test('modal tag drafts are independent from a pending detail tag save', async () => {
    const wait = deferred(), started = deferred(); let block = true;
    const a = app({ onInvoke: async cmd => { if (cmd === 'update_music' && block) { block = false; started.resolve(); await wait.promise; } } });
    await a.run("openDetail('m1')"); a.$('detailEditTagInput').value = 'Detail tag'; const detail = a.run('addDetailEditTag()'); await started.promise;
    a.run('openEditModal('+JSON.stringify(a.tracks[0])+')'); a.$('editTagInput').value = 'Modal draft'; a.run('addEditTag()');
    wait.resolve(); await detail;
    assert.deepEqual(Array.from(a.run('editModalDraft.tags')), ['Modal draft']);
    await a.run('saveEdit()'); assert.deepEqual(a.tracks[0].tags, ['Detail tag', 'Modal draft']);
});

for (const phase of ['get_music', 'list_clips_for_music']) {
    test(`clip panel commits one current track and body when A is delayed at ${phase}`, async () => {
        const wait = deferred(), started = deferred(); let blocked = false;
        const a = app({ onInvoke: (cmd, args) => {
            const id = cmd === 'get_music' ? args.id : args.musicId;
            if (cmd === phase && id === 'm1' && !blocked) { blocked = true; started.resolve(); return wait.promise; }
        } }); a.bind(); a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
        const first = a.run("openMusicClipsPanel('m1')"); await started.promise;
        await a.run("openMusicClipsPanel('m2')"); wait.resolve(phase === 'get_music' ? clone(a.tracks[0]) : []); await first;
        assert.equal(a.state.clipsPanelMusic.id, 'm2');
        assert(a.$('musicClipsBody').innerHTML.includes('<strong>Track 2</strong>'));
        assert(!a.$('musicClipsBody').innerHTML.includes('<strong>Track 1</strong>'));
        const create = new Element(); create.dataset.clipsPanelAction = 'create';
        await a.$('musicClipsBody').fire('click', { target: create });
        assert.equal(a.state.clipMusic.id, 'm2');
    });
    test(`closing the clip panel during ${phase} prevents its late load from reopening it`, async () => {
        const wait = deferred(), started = deferred();
        const a = app({ onInvoke: cmd => { if (cmd === phase) { started.resolve(); return wait.promise; } } }); a.bind();
        const opening = a.run("openMusicClipsPanel('m1')"); await started.promise;
        await a.$('closeMusicClips').fire('click'); wait.resolve(phase === 'get_music' ? clone(a.tracks[0]) : []); await opening;
        assert.equal(a.state.clipsPanelMusic, null); assert(a.$('musicClipsPanel').classList.contains('hidden'));
    });
}

test('a late clip panel cannot hide newer details', async () => {
    const wait = deferred(), started = deferred();
    const a = app({ onInvoke: (cmd, args) => { if (cmd === 'list_clips_for_music' && args.musicId === 'm1') { started.resolve(); return wait.promise; } } });
    const opening = a.run("openMusicClipsPanel('m1')"); await started.promise;
    await a.run("openDetail('m2')"); wait.resolve([]); await opening;
    assert.equal(a.state.selectedMusic.id, 'm2'); assert.equal(a.state.clipsPanelMusic, null);
    assert(!a.$('detailPanel').classList.contains('hidden')); assert(a.$('musicClipsPanel').classList.contains('hidden'));
});

for (const phase of ['get_music', 'list_clips_for_music']) {
    test(`details reread saves accepted after the initial read at ${phase}`, async () => {
        const wait = deferred(), started = deferred(); let block = false;
        const a = app({ onInvoke: (cmd, args) => {
            if (block && cmd === phase) { block = false; started.resolve(); return wait.promise; }
        } });
        await a.run("openDetail('m1')"); const old = clone(a.tracks[0]); block = true;
        const reopening = a.run("openDetail('m1')"); await started.promise;
        a.$('detailEditName').value = 'Latest saved name'; await a.$('detailEditName').fire('change');
        a.$('detailEditGenre').value = 'Uncommitted genre'; a.$('detailEditTagInput').value = 'Uncommitted tag';
        wait.resolve(phase === 'get_music' ? old : []); await reopening;
        assert.equal(a.tracks[0].name, 'Latest saved name'); assert.equal(a.state.selectedMusic.name, 'Latest saved name');
        assert.equal(a.$('detailEditName').value, 'Latest saved name');
        assert.equal(a.$('detailEditGenre').value, 'Uncommitted genre'); assert.equal(a.$('detailEditTagInput').value, 'Uncommitted tag');
    });
}

for (const action of ['close', 'switch', 'draft']) {
    test(`Finder refresh preserves the current context when the user chooses ${action}`, async () => {
        const wait = deferred(), started = deferred(); let block = false;
        const a = app({ onInvoke: async cmd => {
            if (cmd === 'sync_library_locations') return { updatedPaths: 1, updatedAlbums: 1 };
            if (block && cmd === 'get_library_counts') { block = false; started.resolve(); await wait.promise; }
        } });
        await a.run("openDetail('m1')"); block = true;
        a.tracks[0].path = '/moved/1.mp3'; a.tracks[0].album = 'Moved folder';
        const refreshing = a.run('refreshLocationsAfterFinderChanges()'); await started.promise;
        const genre = a.$('detailEditGenre'), tag = a.$('detailEditTagInput');
        if (action === 'close') a.run('closeMusicContextPanels()');
        if (action === 'switch') await a.run("openDetail('m2')");
        if (action === 'draft') { genre.value = 'Genre draft'; tag.value = 'Tag draft'; }
        wait.resolve(); await refreshing;
        if (action === 'close') { assert.equal(a.state.selectedMusic, null); assert(a.$('detailPanel').classList.contains('hidden')); }
        if (action === 'switch') assert.equal(a.state.selectedMusic.id, 'm2');
        if (action === 'draft') {
            assert.equal(a.$('detailEditGenre'), genre); assert.equal(genre.value, 'Genre draft');
            assert.equal(a.$('detailEditTagInput'), tag); assert.equal(tag.value, 'Tag draft');
            assert.equal(a.state.selectedMusic.path, '/moved/1.mp3'); assert.equal(a.$('detailEditAlbum').value, 'Moved folder');
        }
    });
}

for (const phase of ['get_music', 'file_exists']) {
    test(`deleting an unrelated track preserves pending playback during ${phase}`, async () => {
        const wait = deferred(), started = deferred(); let block = true;
        const a = app({ onInvoke: (cmd, args) => {
            if (cmd === phase && (args.id === 'm1' || args.path === '/music/1.mp3') && block) { block = false; started.resolve(); return wait.promise; }
        } }); a.bind();
        const playing = a.run("playMusic('m1')"); await started.promise;
        await a.run("deleteLibraryEntries('music',['m3'])"); wait.resolve(phase === 'get_music' ? clone(a.tracks[0]) : true); await playing;
        assert.equal(a.state.player.music?.id, 'm1'); assert.deepEqual(a.$('barAudio').plays, ['/music/1.mp3']);
    });
}

test('unrelated deletion preserves the delayed clip metadata seek', async () => {
    const a = app(); a.bind(); await a.run("playClip({id:'c1'})");
    await a.run("deleteLibraryEntries('music',['m3'])"); await a.$('barAudio').fire('loadedmetadata');
    assert.equal(a.state.player.segment.clipId, 'c1'); assert.equal(a.$('barAudio').currentTime, 10);
});

for (const panel of ['detail', 'clips']) {
    test(`deleting the old track preserves a newer pending ${panel} panel for a surviving track`, async () => {
        const wait = deferred(), started = deferred();
        const a = app({ onInvoke: (cmd, args) => { if (cmd === 'list_clips_for_music' && args.musicId === 'm2') { started.resolve(); return wait.promise; } } });
        await a.run(panel === 'detail' ? "openDetail('m1')" : "openMusicClipsPanel('m1')");
        const next = a.run(panel === 'detail' ? "openDetail('m2')" : "openMusicClipsPanel('m2')"); await started.promise;
        await a.run("deleteLibraryEntries('music',['m1'])"); wait.resolve([]); await next;
        assert.equal((panel === 'detail' ? a.state.selectedMusic : a.state.clipsPanelMusic)?.id, 'm2');
    });
}

test('a detail read in flight during clip deletion cannot resurrect the deleted row', async () => {
    const wait = deferred(), started = deferred(); let block = false;
    const a = app({ onInvoke: cmd => { if (block && cmd === 'list_clips_for_music') { block = false; started.resolve(); return wait.promise; } } });
    await a.run("openDetail('m1')"); const oldClips = clone(a.clips); block = true;
    const reading = a.run("openDetail('m1')"); await started.promise;
    await a.run("deleteLibraryEntries('clips',['c1'])"); wait.resolve(oldClips); await reading;
    assert.equal(a.$('detailClipList').querySelectorAll('.clip-item').length, 0);
    assert(!a.$('detailContent').innerHTML.includes('data-clip-id="c1"'));
});

test('deleting the requested track still cancels its delayed playback response', async () => {
    const wait = deferred(), started = deferred(); let block = true;
    const a = app({ onInvoke: (cmd, args) => { if (cmd === 'get_music' && args.id === 'm1' && block) { block = false; started.resolve(); return wait.promise; } } }); a.bind();
    const old = clone(a.tracks[0]); const playing = a.run("playMusic('m1')"); await started.promise;
    await a.run("deleteLibraryEntries('music',['m1'])"); wait.resolve(old); await playing;
    assert.equal(a.state.player.music, null); assert.equal(a.$('barAudio').plays.length, 0);
});

test('deleting a clip parent cancels a clip request before its parent has been read', async () => {
    const wait = deferred(), started = deferred();
    const a = app({ onInvoke: cmd => { if (cmd === 'get_clip') { started.resolve(); return wait.promise; } } }); a.bind();
    const clip = clone(a.clips[0]); const playing = a.run("playClip({id:'c1'})"); await started.promise;
    await a.run("deleteLibraryEntries('music',['m1'])"); wait.resolve(clip); await playing;
    assert.equal(a.state.player.music, null); assert.equal(a.$('barAudio').plays.length, 0);
});

for (const source of ['workspace', 'home']) {
    test(`deleting the loaded track preserves a newer ${source} request for a surviving track`, async () => {
        const wait = deferred(), started = deferred(); let block = false;
        const a = app({ onInvoke: (cmd, args) => { if (block && cmd === 'file_exists' && args.path === '/music/2.mp3') { block = false; started.resolve(); return wait.promise; } } }); a.bind();
        await a.run("(async()=>{visibleQueueMusic=(await requestLibraryPage({kind:'music'},'test')).items; await playMusic('m1');})()");
        // Await the first play explicitly before delaying the replacement.
        await tick(); assert.equal(a.state.player.music?.id, 'm1'); block = true;
        if (source === 'home') a.run("state.currentView='home'; homeTracks=visibleQueueMusic.slice()");
        const replacing = a.run(source === 'home' ? "swapToMusic(visibleQueueMusic[1])" : "playMusic('m2')"); await started.promise;
        await a.run("deleteLibraryEntries('music',['m1'])"); wait.resolve(true); await replacing; await tick();
        assert.equal(a.state.player.music?.id, 'm2'); assert.equal(a.$('barAudio').src, '/music/2.mp3'); assert.equal(a.$('barAudio').paused, false);
        assert.equal(a.state.player.queueSource, source === 'home' ? 'home' : 'view');
        if (source === 'workspace') assert.equal(a.state.player.index, 0);
    });
}

test('deletion of an unrelated track preserves a pending home audition', async () => {
    const wait = deferred(), started = deferred();
    const a = app({ onInvoke: (cmd, args) => { if (cmd === 'file_exists' && args.path === '/music/1.mp3') { started.resolve(); return wait.promise; } } }); a.bind();
    a.run("state.currentView='home'"); const playing = a.run("swapToMusic({id:'m1',path:'/music/1.mp3',name:'Track 1'})"); await started.promise;
    await a.run("deleteLibraryEntries('music',['m3'])"); wait.resolve(true); await playing; await tick();
    assert.equal(a.state.player.music?.id, 'm1'); assert.equal(a.$('barAudio').paused, false);
});

test('a clip request for the same parent survives deletion of the previously loaded clip', async () => {
    const wait = deferred(), started = deferred(); let block = false;
    const a = app({ onInvoke: (cmd, args) => { if (block && cmd === 'file_exists') { block = false; started.resolve(); return wait.promise; } } }); a.bind();
    a.clips.push({ ...clone(a.clips[0]), id: 'c2', start: 30, end: 40 });
    await a.run("playClip({id:'c1'})"); block = true;
    const replacing = a.run("playClip({id:'c2'})"); await started.promise;
    await a.run("deleteLibraryEntries('clips',['c1'])"); wait.resolve(true); await replacing;
    await a.$('barAudio').fire('loadedmetadata');
    assert.equal(a.state.player.segment?.clipId, 'c2'); assert.equal(a.$('barAudio').currentTime, 30);
});

for (const action of ['close', 'switch']) {
    test(`a delayed clip editor cannot overwrite the user choice to ${action}`, async () => {
        const wait = deferred(), started = deferred();
        const a = app({ onInvoke: (cmd, args) => { if (cmd === 'file_exists' && args.path === '/music/1.mp3') { started.resolve(); return wait.promise; } } });
        a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
        const opening = a.run('openClipEditor('+JSON.stringify(a.tracks[0])+')'); await started.promise;
        if (action === 'close') await a.run('closeClipEditor(true)');
        else await a.run('openClipEditor('+JSON.stringify(a.tracks[1])+')');
        wait.resolve(true); await opening;
        if (action === 'close') { assert.equal(a.state.clipMusic, null); assert(a.$('clipEditorPanel').classList.contains('hidden')); assert.equal(a.$('clipAudio').src, ''); }
        else { assert.equal(a.state.clipMusic.id, 'm2'); assert.equal(a.$('clipAudio').src, '/music/2.mp3'); }
    });
}

test('stale clip metadata cannot change the range or dirty baseline of a newer editor', async () => {
    const a = app(); a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
    await a.run('openClipEditor('+JSON.stringify(a.tracks[0])+')'); const oldMetadata = a.$('clipAudio').onloadedmetadata;
    await a.run('openClipEditor('+JSON.stringify(a.tracks[1])+')'); a.state.clipStart = 50; a.state.clipEnd = 60;
    const baseline = a.state.clipInitialState; oldMetadata(); assert.equal(a.state.clipStart, 50); assert.equal(a.state.clipEnd, 60); assert.equal(a.state.clipInitialState, baseline);
});

test('switching a dirty clip editor requires accepting discard and preserves it when cancelled', async () => {
    const a = app({ confirmed: false }); a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
    await a.run('openClipEditor('+JSON.stringify(a.tracks[0])+')'); a.run('state.clipInitialState=getClipEditorSnapshot()');
    a.$('clipName').value = 'Keep my draft';
    await a.run('openClipEditor('+JSON.stringify(a.tracks[1])+')');
    assert.equal(a.state.clipMusic.id, 'm1'); assert.equal(a.$('clipName').value, 'Keep my draft');
});

test('finishing an earlier clip save does not close a newer editor or its draft', async () => {
    const wait = deferred(), started = deferred();
    const a = app({ onInvoke: async cmd => { if (cmd === 'create_clip') { started.resolve(); await wait.promise; } } });
    a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
    await a.run('openClipEditor('+JSON.stringify(a.tracks[0])+')'); a.$('clipName').value = 'Save on A';
    const saving = a.run('saveClip()'); await started.promise;
    await a.run('openClipEditor('+JSON.stringify(a.tracks[1])+')'); a.$('clipName').value = 'Draft on B';
    wait.resolve(); await saving;
    assert.equal(a.clips.find(c => c.name === 'Save on A').musicId, 'm1');
    assert.equal(a.state.clipMusic.id, 'm2'); assert.equal(a.$('clipName').value, 'Draft on B'); assert(!a.$('clipEditorPanel').classList.contains('hidden'));
});

test('unrelated deletion keeps the replacement queue index rather than the still-playing old track index', async () => {
    const wait = deferred(), started = deferred(); let block = false;
    const a = app({ onInvoke: (cmd, args) => { if (block && cmd === 'file_exists' && args.path === '/music/2.mp3') { block = false; started.resolve(); return wait.promise; } } }); a.bind();
    await a.run("(async()=>{visibleQueueMusic=(await requestLibraryPage({kind:'music'},'test')).items; await playMusic('m1');})()"); block = true;
    const replacing = a.run("playMusic('m2')"); await started.promise;
    await a.run("deleteLibraryEntries('music',['m3'])"); wait.resolve(true); await replacing;
    assert.equal(a.state.player.music.id, 'm2'); assert.equal(a.state.player.queue[a.state.player.index].id, 'm2');
});

test('location repair during playback invalidates an in-flight detail snapshot', async () => {
    const wait = deferred(), started = deferred(); let block = false, repair = false;
    const a = app({ onInvoke: (cmd, args) => {
        if (block && cmd === 'list_clips_for_music') { block = false; started.resolve(); return wait.promise; }
        if (repair && cmd === 'sync_library_locations') { repair = false; a.tracks[0].path = '/moved/1.mp3'; a.tracks[0].album = 'Moved'; return {updatedPaths:1,updatedAlbums:1}; }
    } }); a.bind(); await a.run("openDetail('m1')"); block = true;
    const opening = a.run("openDetail('m1')"); await started.promise; repair = true;
    await a.run("playMusic('m1')"); wait.resolve([]); await opening;
    assert.equal(a.state.selectedMusic.path, '/moved/1.mp3'); assert.equal(a.$('detailEditAlbum').value, 'Moved');
});

for (const action of ['candidate', 'modal-save']) {
    test(`finishing an earlier ${action} cannot replace a newer pending detail request`, async () => {
        const operation = deferred(), opStarted = deferred(), read = deferred(), readStarted = deferred();
        const a = app({ onInvoke: async (cmd, args) => {
            if ((action === 'candidate' && cmd === 'create_candidate') || (action === 'modal-save' && cmd === 'update_music')) { opStarted.resolve(); await operation.promise; }
            if (cmd === 'list_clips_for_music' && args.musicId === 'm2') { readStarted.resolve(); return read.promise; }
        } }); await a.run("openDetail('m1')");
        if (action === 'modal-save') { a.run('openEditModal('+JSON.stringify(a.tracks[0])+')'); a.$('editName').value = 'Saved on A'; }
        const pending = a.run(action === 'candidate' ? "toggleClipCandidate('c1')" : 'saveEdit()'); await opStarted.promise;
        const next = a.run("openDetail('m2')"); await readStarted.promise;
        operation.resolve(); await pending; read.resolve([]); await next;
        assert.equal(a.state.selectedMusic?.id, 'm2'); assert.equal(a.$('detailEditName').value, 'Track 2');
    });
}

function clipButton(surface, id, action) {
    const button = new Element();
    if (surface === 'musicClipsBody') { button.dataset.panelClipAction = action; button.dataset.panelClipId = id; }
    else { button.dataset.clipAction = action; button.dataset.clipId = id; }
    return button;
}

for (const surface of ['contentArea', 'detailContent', 'musicClipsBody']) {
    for (const action of ['play', 'edit']) {
        test(`${surface} ${action} buttons register intent before reading the first clip`, async () => {
            const wait = deferred(), started = deferred(); let block = true;
            const a = app({ onInvoke: (cmd, args) => { if (block && cmd === 'get_clip' && args.id === 'c1') { block = false; started.resolve(); return wait.promise; } } }); a.bind();
            a.clips.push({ ...clone(a.clips[0]), id: 'c2', musicId: 'm2' });
            a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
            const old = a.$(surface).fire('click', { target: clipButton(surface, 'c1', action) }); await started.promise;
            await a.$(surface).fire('click', { target: clipButton(surface, 'c2', action) });
            wait.resolve(clone(a.clips[0])); await old;
            if (action === 'play') assert.equal(a.state.player.segment?.clipId, 'c2');
            else { assert.equal(a.state.clipMusic?.id, 'm2'); assert.equal(a.$('clipAudio').src, '/music/2.mp3'); }
        });
    }
}

test('closing the editor cancels an edit button request still fetching its clip', async () => {
    const wait = deferred(), started = deferred(); const a = app({ onInvoke: cmd => { if (cmd === 'get_clip') { started.resolve(); return wait.promise; } } }); a.bind();
    const opening = a.$('detailContent').fire('click', { target: clipButton('detailContent', 'c1', 'edit') }); await started.promise;
    await a.run('closeClipEditor(true)'); wait.resolve(clone(a.clips[0])); await opening;
    assert.equal(a.state.clipMusic, null); assert(a.$('clipEditorPanel').classList.contains('hidden'));
});

for (const action of ['play', 'clip', 'edit']) {
    test(`music ${action} buttons preserve the last click while the first music lookup is delayed`, async () => {
        const wait = deferred(), started = deferred(); let block = true;
        const a = app({ onInvoke: (cmd, args) => { if (block && cmd === 'get_music' && args.id === 'm1') { block = false; started.resolve(); return wait.promise; } } }); a.bind();
        a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
        const button = id => { const node = new Element(); node.dataset.action = action; node.dataset.id = id; return node; };
        const old = a.$('contentArea').fire('click', { target: button('m1') }); await started.promise;
        await a.$('contentArea').fire('click', { target: button('m2') }); wait.resolve(clone(a.tracks[0])); await old;
        if (action === 'play') assert.equal(a.state.player.music?.id, 'm2');
        if (action === 'clip') assert.equal(a.state.clipMusic?.id, 'm2');
        if (action === 'edit') assert.equal(a.$('editMusicId').value, 'm2');
    });
}

test('a closed metadata modal cannot reopen from an earlier lookup', async () => {
    const wait = deferred(), started = deferred(); const a = app({ onInvoke: cmd => { if (cmd === 'get_music') { started.resolve(); return wait.promise; } } });
    const opening = a.run("openEditModalForMusic('m1')"); await started.promise;
    a.run('closeEditModal()'); wait.resolve(clone(a.tracks[0])); await opening;
    assert(a.$('editModal').classList.contains('hidden'));
});

test('finishing an old metadata save preserves a newer modal and draft', async () => {
    const wait = deferred(), started = deferred(); const a = app({ onInvoke: async cmd => { if (cmd === 'update_music') { started.resolve(); await wait.promise; } } });
    a.run('openEditModal('+JSON.stringify(a.tracks[0])+')'); a.$('editName').value = 'Saved A';
    const saving = a.run('saveEdit()'); await started.promise;
    a.run('openEditModal('+JSON.stringify(a.tracks[1])+')'); a.$('editName').value = 'Draft B';
    wait.resolve(); await saving;
    assert.equal(a.tracks[0].name, 'Saved A'); assert.equal(a.$('editMusicId').value, 'm2'); assert.equal(a.$('editName').value, 'Draft B');
    assert(!a.$('editModal').classList.contains('hidden'));
});

for (const method of ['previewClipSelection', 'playFullTrack']) {
    test(`a late ${method} rejection cannot reset playback state in a newer editor`, async () => {
        const done = deferred(); const a = app(); a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
        await a.run('openClipEditor('+JSON.stringify(a.tracks[0])+')');
        a.$('clipAudio').play = () => done.promise.then(() => { throw new Error('old audio aborted'); });
        const playing = a.run(method+'()');
        await a.run('openClipEditor('+JSON.stringify(a.tracks[1])+')');
        a.state.clipPreviewing = true; a.state.clipFullPreviewing = true;
        done.resolve(); await playing;
        assert.equal(a.state.clipPreviewing, true); assert.equal(a.state.clipFullPreviewing, true);
    });
}

test('deleting an edited clip closes only its obsolete editor', async () => {
    const a = app(); a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
    await a.run('openClipEditor('+JSON.stringify(a.tracks[0])+','+JSON.stringify(a.clips[0])+')');
    await a.run("deleteLibraryEntries('clips',['c1'])");
    assert.equal(a.state.clipMusic, null); assert(a.$('clipEditorPanel').classList.contains('hidden'));
});

for (const kind of ['clip', 'modal']) {
    test(`deleting the old parent preserves a pending ${kind} editor for a surviving parent`, async () => {
        const wait = deferred(), started = deferred(); let block = false;
        const a = app({ onInvoke: (cmd, args) => { if (block && cmd === 'get_music' && args.id === 'm2') { block = false; started.resolve(); return wait.promise; } } });
        a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}');
        if (kind === 'clip') await a.run('openClipEditor('+JSON.stringify(a.tracks[0])+')');
        else a.run('openEditModal('+JSON.stringify(a.tracks[0])+')'); block = true;
        const opening = a.run(kind === 'clip' ? "openClipEditorForMusic('m2')" : "openEditModalForMusic('m2')"); await started.promise;
        const surviving = clone(a.tracks[1]); await a.run("deleteLibraryEntries('music',['m1'])"); wait.resolve(surviving); await opening;
        if (kind === 'clip') { assert.equal(a.state.clipMusic?.id, 'm2'); assert(!a.$('clipEditorPanel').classList.contains('hidden')); }
        else { assert.equal(a.$('editMusicId').value, 'm2'); assert(!a.$('editModal').classList.contains('hidden')); }
    });
    test(`a delayed ${kind} lookup cannot open an editor after its parent is deleted`, async () => {
        const wait = deferred(), started = deferred(); let block = true;
        const a = app({ onInvoke: (cmd, args) => { if (block && cmd === 'get_music' && args.id === 'm1') { block = false; started.resolve(); return wait.promise; } } });
        a.run('updateTimeline=()=>{}; renderClipTagSuggestions=async()=>{}'); const old = clone(a.tracks[0]);
        const opening = a.run(kind === 'clip' ? "openClipEditorForMusic('m1')" : "openEditModalForMusic('m1')"); await started.promise;
        await a.run("deleteLibraryEntries('music',['m1'])"); wait.resolve(old); await opening;
        if (kind === 'clip') assert.equal(a.state.clipMusic, null);
        else assert(a.$('editModal').classList.contains('hidden'));
    });
}

test('audio metadata arriving after typing keeps the clip draft dirty and retains its manual range', async () => {
    const a = app({confirmed:false}); a.bind(); a.run('renderClipTagSuggestions=async()=>{}');
    await a.run('openClipEditor('+JSON.stringify(a.tracks[0])+')');
    a.$('clipName').value = 'Typed before audio loaded'; await a.$('clipName').fire('input'); a.state.clipStart = 20; a.state.clipEnd = 45;
    a.$('clipAudio').onloadedmetadata();
    assert.equal(a.state.clipStart, 20); assert.equal(a.state.clipEnd, 45); assert.equal(a.run('isClipEditorDirty()'), true);
    assert.equal(await a.run('closeClipEditor()'), false); assert.equal(a.$('clipName').value, 'Typed before audio loaded');
});


test('empty searches explain the filter and keep both recent mode controls', async () => {
    const a = app({ realRender: true }); a.bind();
    a.state.currentView = 'recent'; a.state.recentMode = 'used';
    await a.run('render()');
    assert.match(a.$('contentArea').innerHTML, /暂无播放记录/);
    assert.match(a.$('contentArea').innerHTML, /data-recent-mode="added"/);
    assert.match(a.$('contentArea').innerHTML, /data-recent-mode="used"/);
    a.state.currentView = 'all'; a.state.search = 'no such track';
    await a.run('render()');
    assert.match(a.$('contentArea').innerHTML, /没有匹配结果/);
    assert.match(a.$('contentArea').innerHTML, /data-clear-library-filters/);
    assert.doesNotMatch(a.$('contentArea').innerHTML, /还没有音乐/);
    assert(!a.calls.some(c => ['list_music','list_clips'].includes(c.command)));
});

test('library rendering consumes one SQL page and ignores an older view response', async () => {
    const delayed = deferred(); let first = true;
    const a = app({ realRender:true, onInvoke: (cmd,args) => {
        if(cmd === 'query_library_page' && args.query.kind === 'music' && first) { first=false; return delayed.promise; }
    }});
    const old = a.run('render()'); await tick();
    a.state.currentView = 'clips'; await a.run('render()');
    const current = a.$('contentArea').innerHTML;
    delayed.resolve({items:a.tracks,total:3,page:1,pageSize:50,totalPages:1}); await old;
    assert.equal(a.$('contentArea').innerHTML,current);
    assert.match(current,/clip-library-row/);
});

test('SQL page request coalesces overlapping identical reads without keeping full-library snapshots', async () => {
    const wait=deferred(); let calls=0;
    const a=app({onInvoke:cmd=>{if(cmd==='query_library_page'){calls++;return wait.promise;}}});
    const first=a.run("requestLibraryPage({kind:'music'},'test')"),second=a.run("requestLibraryPage({kind:'music'},'test')");
    wait.resolve({items:[],total:0,page:1,pageSize:50,totalPages:1});await Promise.all([first,second]);
    assert.equal(calls,1);
});

test('cancelling while one import write commits retains that item and leaves the rest pending', async () => {
    const started=deferred(),commit=deferred();
    const a=app({onInvoke:(cmd,args)=>{if(cmd==='create_music' && args.music.name==='X'){started.resolve();return commit.promise;}}});
    a.run("getAudioDuration=async()=>180; state.importFiles=['X','Y','Z'].map(name=>({name,path:'/'+name+'.mp3',album:'A'}))");
    const importing=a.run('importSelectedFiles()');await started.promise;
    a.run('cancelImportTask()');commit.resolve();await importing;
    assert.deepEqual(Array.from(a.state.importFiles,m=>m.name),['Y','Z']);
    assert.equal(a.calls.filter(c=>c.command==='create_music').length,1);
    assert.match(a.$('importProgressText').textContent,/导入 1 \/ 3/);
    assert.equal(a.$('selectedFiles').inert,false);
    await a.run('importSelectedFiles()');
    assert.equal(a.tracks.filter(m=>m.name==='X').length,1);
    assert.equal(a.state.importFiles.length,0);
});

test('import metadata prefetch never exceeds three pending files and cancellation releases them', async () => {
    const a=app();let active=0,peak=0;
    a.context.measure=(_path,{signal})=>new Promise((resolve,reject)=>{
        active++;peak=Math.max(peak,active);
        signal.addEventListener('abort',()=>{active--;reject(Object.assign(new Error('cancel'),{name:'AbortError'}));},{once:true});
    });
    a.run("getAudioDuration=measure; state.importFiles=Array.from({length:10},(_,i)=>({name:String(i),path:'/'+i+'.mp3'}))");
    const importing=a.run('importSelectedFiles()');await tick();
    assert.equal(peak,3);a.run('cancelImportTask()');await importing;
    assert.equal(active,0);assert.equal(a.state.importFiles.length,10);
    assert.equal(a.calls.filter(c=>c.command==='create_music').length,0);
});

test('deleting the last clip on a later detail page clamps the SQL page and preserves metadata drafts', async () => {
    const a=app();
    for(let i=2;i<=31;i++) a.clips.push({id:`c${i}`,musicId:'m1',name:`Part ${i}`,start:i*10,end:i*10+5,tags:[],tagIds:[]});
    a.state.pages['music-clips:m1']=2;
    await a.run("openDetail('m1')");
    const input=a.$('detailEditName');input.value='unsaved draft';
    await a.run("deleteLibraryEntries('clips',['c31'])");
    assert.equal(a.state.pages['music-clips:m1'],1);
    assert.equal(a.$('detailClipList').querySelectorAll('.clip-item').length,30);
    assert.equal(a.$('detailEditName'),input);assert.equal(input.value,'unsaved draft');
});

test('an early scan cancellation is resent after registration and releases its event listener', async () => {
    const pending=deferred();let listener,unlistened=0;
    const a=app({onInvoke:cmd=>cmd==='scan_import_sources'?pending.promise:undefined});
    a.context.window.__TAURI__.event={listen:async(_name,fn)=>{listener=fn;return()=>unlistened++;}};
    const scan=a.run("getNewImportItems(['/test/folder'])");await tick();
    const request=a.calls.find(c=>c.command==='scan_import_sources').args.requestId;
    a.run('cancelImportTask()');
    listener({payload:{requestId:request,completed:0,total:0,started:true}});
    pending.resolve({items:[],warnings:[],cancelled:true});
    assert.equal((await scan).length,0);assert.equal(unlistened,1);
    assert.equal(a.calls.filter(c=>c.command==='cancel_import_scan').length,2);
    assert.match(a.$('importProgressText').textContent,/已停止扫描/);
});

test('mixed folder imports skip thousands of duplicates without a dialog and keep new files confirmable', async () => {
    const duplicates = Array.from({ length: 2000 }, (_, i) => `/mock/existing/${i}.mp3`);
    const fresh = ['/mock/new/A.mp3', '/mock/new/B.mp3', '/mock/new/C.mp3'];
    const items = [...duplicates, ...fresh].map(path => ({ path, exists: true, name: path.split('/').pop(), duration: 180 }));
    const a = app({ renderImports: true, onInvoke: cmd => cmd === 'scan_import_sources'
        ? { items, warnings: [], cancelled: false }
        : cmd === 'find_existing_music_paths' ? duplicates : undefined });
    a.context.window.__TAURI__.dialog.open = async () => ['/mock/existing', '/mock/new'];
    const dialogs = [];
    a.context.window.__TAURI__.dialog.message = async text => dialogs.push(text);
    await a.run('chooseFolders()'); await tick();
    assert.equal(dialogs.length, 0, 'duplicate detection must not require dismissing a native alert');
    assert.deepEqual(Array.from(a.state.importFiles, item => item.path), fresh);
    assert.equal(a.$('confirmImportBtn').disabled, false);
    assert.equal(a.$('confirmImportBtn').textContent, '确认导入 3 首');
    assert.equal(a.$('importProgressText').textContent, '已跳过 2000 首重复音乐，新增 3 首待导入');
    assert.equal(a.calls.filter(call => call.command === 'create_music').length, 0, 'selection still needs explicit import confirmation');
    a.run('getAudioDuration = async () => 180');
    await a.run('importSelectedFiles()');
    assert.deepEqual(a.calls.filter(call => call.command === 'create_music').map(call => call.args.music.path), fresh);
});

test('an all-duplicate selection leaves existing import drafts intact and reports no new music', async () => {
    const a = app({ renderImports: true, onInvoke: cmd => cmd === 'scan_import_sources'
        ? { items: [{ path: '/music/1.mp3', exists: true, name: 'Existing' }], warnings: [], cancelled: false }
        : cmd === 'find_existing_music_paths' ? ['/music/1.mp3'] : undefined });
    a.context.window.__TAURI__.dialog.open = async () => ['/music'];
    await a.run('chooseFolders()'); await tick();
    assert.equal(a.messages.length, 0);
    assert.equal(a.state.importFiles.length, 0);
    assert.equal(a.$('confirmImportBtn').disabled, true);
    assert.equal(a.$('importProgressText').textContent, '已跳过 1 首重复音乐，本次没有新增音乐');
    a.run("state.importFiles = [{path:'/pending.mp3',name:'Pending',album:'Draft'}]");
    await a.run('chooseFolders()'); await tick();
    assert.equal(a.messages.length, 0);
    assert.deepEqual(Array.from(a.state.importFiles, item => item.path), ['/pending.mp3']);
    assert.equal(a.$('confirmImportBtn').textContent, '确认导入 1 首');
    assert.equal(a.$('confirmImportBtn').disabled, false);
});

test('duplicate summaries count both saved and pending files while keeping pending edits', async () => {
    const items = ['/music/1.mp3', '/pending.mp3', '/new.mp3'].map(path => ({ path, name: path, exists: true }));
    const a = app({ renderImports: true, onInvoke: cmd => cmd === 'scan_import_sources'
        ? { items, warnings: [], cancelled: false }
        : cmd === 'find_existing_music_paths' ? ['/music/1.mp3'] : undefined });
    a.context.window.__TAURI__.dialog.open = async () => ['/music'];
    a.run("state.importFiles = [{path:'/pending.mp3',name:'Keep my draft',album:'My album'}]");
    await a.run('chooseFolders()'); await tick();
    assert.equal(a.messages.length, 0);
    assert.equal(a.state.importFiles.length, 2);
    assert.equal(a.state.importFiles[0].name, 'Keep my draft');
    assert.equal(a.$('importProgressText').textContent, '已跳过 2 首重复音乐，新增 1 首待导入');
    assert.equal(a.$('confirmImportBtn').textContent, '确认导入 2 首');
});

function assignedTagButton(kind, id, tagId, parent = null) {
    const button = new Element(); button.tagName = 'BUTTON';
    button.dataset.removeAssignedTag = String(tagId);
    button.dataset.tagOwnerKind = kind; button.dataset.tagOwnerId = id;
    button.parentElement = parent;
    return button;
}

test('music tags expose a named inline removal control for the exact tag ID', () => {
    const a = app();
    const html = a.run("renderInlineMusicTags({id:'m1',tags:['Same','Same'],tagIds:[1,2]})");
    assert.match(html, /data-remove-assigned-tag="1"/);
    assert.match(html, /data-remove-assigned-tag="2"/);
    assert.match(html, /aria-label="从音乐移除 Tag Same"/);
});

test('removing a music tag from its row preserves same-name tags and never starts playback', async () => {
    const a = app(); a.bind();
    a.tracks[0].tags = ['Same', 'Same']; a.tracks[0].tagIds = [1, 2];
    const row = new Element(); row.dataset.musicId = 'm1';
    await a.$('contentArea').fire('click', { target: assignedTagButton('music','m1',1,row) });
    assert.deepEqual(a.tracks[0].tagIds, [2]);
    assert.deepEqual(a.tracks[0].tags, ['Same']);
    assert.equal(a.tags.length, 3, 'the shared tag library is retained');
    assert.equal(a.state.player.music, null);
    assert(!a.calls.some(c => c.command === 'delete_tag'));
});

for (const container of ['contentArea','musicClipsBody','detailContent','candidatePanelBody']) {
    test(`clip tags can be removed in ${container} without changing parent tags or clip timing`, async () => {
        const a = app(); a.bind();
        a.clips[0].tags=['A','B']; a.clips[0].tagIds=[1,2];
        a.tracks[0].tags=['A']; a.tracks[0].tagIds=[1];
        const row=new Element(); row.classList.add('clip-item'); row.dataset.clipId='c1'; row.dataset.panelClipId='c1';
        await a.$(container).fire('click',{target:assignedTagButton('clip','c1',1,row)});
        assert.deepEqual(a.clips[0].tagIds,[2]);
        assert.equal(a.clips[0].start,10);assert.equal(a.clips[0].end,20);
        assert.deepEqual(a.tracks[0].tagIds,[1]);
        assert.equal(a.state.player.music,null);
        assert.equal(a.tags.length,3);
    });
}

test('failed inline tag removal preserves the tag and allows a later retry', async () => {
    let fail=true;
    const a=app({onInvoke:cmd=>{if(cmd==='update_music' && fail)throw new Error('disk offline');}});a.bind();
    a.tracks[0].tags=['A'];a.tracks[0].tagIds=[1];
    const button=assignedTagButton('music','m1',1);
    await a.$('contentArea').fire('click',{target:button});
    assert.deepEqual(a.tracks[0].tagIds,[1]);assert(a.messages.some(m=>m.includes('移除 Tag 失败')));
    fail=false;
    await a.$('contentArea').fire('click',{target:button});
    assert.deepEqual(a.tracks[0].tagIds,[]);
});

test('rapid removals of two clip tags merge instead of restoring the first tag', async () => {
    const a=app();a.bind();a.clips[0].tags=['A','B','C'];a.clips[0].tagIds=[1,2,3];
    await Promise.all([1,2].map(id=>a.$('contentArea').fire('click',{target:assignedTagButton('clip','c1',id)})));
    assert.deepEqual(a.clips[0].tagIds,[3]);
});

test('saving an already-open clip editor preserves an inline removal and its own draft', async () => {
    const a=app();a.clips[0].tags=['A','B'];a.clips[0].tagIds=[1,2];
    await a.run("openClipEditorForClip('c1')");
    a.$('clipName').value='Edited name';
    await a.run("removeAssignedTag('clip','c1',1)");
    await a.run('saveClip()');
    assert.equal(a.clips[0].name,'Edited name');
    assert.deepEqual(a.clips[0].tagIds,[2]);
});

test('inline tag removal preserves concurrent music edits and live detail input', async () => {
    const gate=deferred(),started=deferred();let block=true;
    const a=app({onInvoke:cmd=>{if(cmd==='update_music' && block){block=false;started.resolve();return gate.promise;}}});
    a.tracks[0].tags=['A'];a.tracks[0].tagIds=[1];
    await a.run("openDetail('m1')");a.$('detailEditName').value='Uncommitted name';
    const removal=a.run("removeAssignedTag('music','m1',1)");await started.promise;
    const edit=a.run("mutateMusic('m1',()=>({artist:'New artist'}))");
    gate.resolve();await Promise.all([removal,edit]);
    assert.equal(a.tracks[0].artist,'New artist');assert.deepEqual(a.tracks[0].tagIds,[]);
    assert.equal(a.$('detailEditName').value,'Uncommitted name');
});

test('removing the filter tag updates the SQL result without removing the shared tag', async () => {
    const a=app({realRender:true});a.bind();
    a.tracks[0].tags=['A'];a.tracks[0].tagIds=[1];a.state.activeTagIds=[1];
    await a.run('render()');
    assert.match(a.$('contentArea').innerHTML,/data-remove-assigned-tag="1"/);
    await a.$('contentArea').fire('click',{target:assignedTagButton('music','m1',1)});
    assert.match(a.$('contentArea').innerHTML,/没有匹配结果/);
    assert(a.tags.some(tag=>tag.id===1));
});

test('inline removal leaves an already playing track and its position uninterrupted', async () => {
    const a=app();a.bind();a.tracks[0].tags=['A'];a.tracks[0].tagIds=[1];
    await a.run("playMusic('m1')");a.$('barAudio').currentTime=42;
    const plays=a.$('barAudio').plays.length;
    const row=new Element();row.dataset.musicId='m1';
    await a.$('contentArea').fire('click',{target:assignedTagButton('music','m1',1,row)});
    assert.equal(a.state.player.music.id,'m1');assert.equal(a.$('barAudio').currentTime,42);
    assert.equal(a.$('barAudio').paused,false);assert.equal(a.$('barAudio').plays.length,plays);
    assert.deepEqual(a.tracks[0].tagIds,[]);
});

for (const kind of ['music','clip']) {
    test(`cancelling ${kind} tag confirmation preserves the association without writing`, async () => {
        const a=app({confirmed:false});a.bind();
        const record=kind==='music'?a.tracks[0]:a.clips[0];record.tags=['A'];record.tagIds=[1];
        const button=assignedTagButton(kind,record.id,1);
        await a.$('contentArea').fire('click',{target:button});
        assert.deepEqual(record.tagIds,[1]);
        assert(!a.calls.some(c=>['update_music','update_clip','delete_tag'].includes(c.command)));
        assert.equal(button.disabled,false);
    });
}

test('tag removal waits for explicit confirmation and rapid repeated clicks show one prompt', async () => {
    const a=app();a.bind();a.tracks[0].tags=['A'];a.tracks[0].tagIds=[1];
    const answer=deferred(),prompts=[];
    a.context.window.__TAURI__.dialog.ask=async(message,options)=>{prompts.push({message,options});return answer.promise;};
    const button=assignedTagButton('music','m1',1);
    const removing=a.$('contentArea').fire('click',{target:button});await tick();
    await a.$('contentArea').fire('click',{target:button});
    assert.equal(prompts.length,1);assert.equal(button.disabled,true);
    assert(!a.calls.some(c=>c.command==='update_music'));
    assert.match(prompts[0].message,/Track 1/);assert.match(prompts[0].message,/A/);
    assert.equal(prompts[0].options.okLabel,'移除');assert.equal(prompts[0].options.cancelLabel,'取消');
    answer.resolve(true);await removing;
    assert.deepEqual(a.tracks[0].tagIds,[]);
    assert.equal(a.calls.filter(c=>c.command==='update_music').length,1);
});

test('cancelling an album tag confirmation preserves its cached and persisted associations', async () => {
    const a=app({confirmed:false});await a.run('loadAlbumTags()');
    await a.run("removeAlbumTag('A',1)");
    assert.deepEqual(a.albumTags.get('A'),[1,2,3]);
    assert.deepEqual(Array.from(a.run("albumTagsCache.get('A')")),[1,2,3]);
    assert(!a.calls.some(c=>c.command==='set_album_tags'));
});

test('cancelling a detail tag confirmation keeps its tag and live input draft', async () => {
    const a=app({confirmed:false});a.tracks[0].tags=['A'];a.tracks[0].tagIds=[1];
    await a.run("openDetail('m1')");a.$('detailEditName').value='Unsaved name';
    const button=new Element();button.dataset.removeDetailTag='0';
    await a.$('detailEditTags').fire('click',{target:button});
    assert.deepEqual(a.tracks[0].tagIds,[1]);assert.deepEqual(Array.from(a.state.editTagIds),[1]);
    assert.equal(a.$('detailEditName').value,'Unsaved name');
    assert(!a.calls.some(c=>c.command==='update_music'));
});
