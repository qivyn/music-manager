const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('audio metadata timeout releases its media resource and rejects instead of hanging the import', async () => {
    const source = require('./app-source.cjs').readAppSource();
    const start = source.indexOf('function getAudioDuration(');
    const code = source.slice(start, source.indexOf('\n\n/* ===', start));
    let timeout, loads = 0;
    const audio = { pause() {}, load() { loads++; }, removeAttribute(name) { delete this[name]; } };
    const context = { document: { createElement: () => audio }, convertFileSrc: s => s,
        setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {} };
    vm.runInNewContext(code, context);
    const pending = context.getAudioDuration('/offline.mp3');
    assert.equal(typeof timeout, 'function', 'metadata loading must have a deadline');
    const rejected = assert.rejects(pending, /超时/);
    timeout();
    await rejected;
    assert.equal(audio.src, undefined);
    assert.equal(audio.onloadedmetadata, null);
    assert(loads > 0);
});

test('row and player waveforms share one audio decode at different resolutions', async () => {
    let decodes = 0;
    const window = { addEventListener() {}, OfflineAudioContext: class {
        async decodeAudioData() { decodes++; return { numberOfChannels: 1, length: 4096,
            getChannelData: () => new Float32Array(4096).fill(0.5) }; }
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/waveform.js'), 'utf8'), {
        window, console, AbortController,
        document: { body: {}, getElementById: () => null, querySelectorAll: () => [] },
        MutationObserver: class { observe() {} },
        fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
    });
    const [row, player] = await Promise.all([window.Waveform.getPeaks('song', 140), window.Waveform.getPeaks('song', 320)]);
    assert.equal(row.length, 140);
    assert.equal(player.length, 320);
    assert.equal(decodes, 1);
});

test('cancelled queued waveforms never fetch and playback takes priority over remaining rows', async () => {
    const fetched = [], gates = new Map();
    const window = { addEventListener() {}, OfflineAudioContext: class {
        async decodeAudioData() { return {numberOfChannels:1,length:4,getChannelData:()=>new Float32Array([0,1,0,1])}; }
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/waveform.js'),'utf8'), {
        window, console, AbortController,
        document:{body:{},getElementById:()=>null,querySelectorAll:()=>[]},MutationObserver:class{observe(){}},
        fetch:async url=>{fetched.push(url);return {ok:true,arrayBuffer:()=>new Promise(resolve=>gates.set(url,resolve))};}
    });
    const first=window.Waveform.getPeaks('active1',140), second=window.Waveform.getPeaks('active2',140);
    await new Promise(setImmediate);
    const controller=new AbortController();
    const obsolete=window.Waveform.getPeaks('obsolete',140,{signal:controller.signal});
    const rejection=assert.rejects(obsolete,{name:'AbortError'});
    const row=window.Waveform.getPeaks('row',140),player=window.Waveform.getPeaks('player',320,{priority:10});
    controller.abort();await rejection;
    gates.get('active1')(new ArrayBuffer(8));await first;await new Promise(setImmediate);
    assert.deepEqual(fetched,['active1','active2','player']);
    gates.get('active2')(new ArrayBuffer(8));await second;await new Promise(setImmediate);
    assert.deepEqual(fetched,['active1','active2','player','row']);
    gates.get('row')(new ArrayBuffer(8));gates.get('player')(new ArrayBuffer(8));await Promise.all([row,player]);
});
