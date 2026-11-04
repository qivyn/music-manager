const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Run the real packaging phase after the already-signed installer is prepared.
// Stub only macOS's external hdiutil and delays; use real files and finalization.
const source = fs.readFileSync(path.join(__dirname, 'build-macos-installer.sh'), 'utf8');
const boundary = '/usr/bin/codesign --verify --deep --strict --verbose=2 "$installer"\n';
assert.equal(source.split(boundary).length, 2, 'locate signed-installer packaging phase');
const packaging = source.split(boundary)[1];

function run(mode, existing = false) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-dmg-test-'));
    try {
        const bin = path.join(tmp, 'bin');
        const work = path.join(tmp, 'work');
        const output = path.join(tmp, 'output.dmg');
        fs.mkdirSync(bin); fs.mkdirSync(work); fs.mkdirSync(path.join(work, 'image'));
        if (existing) fs.writeFileSync(output, 'existing package');
        fs.writeFileSync(path.join(bin, 'hdiutil'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2), log = process.env.DMG_TEST_LOG;
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log)) : [];
calls.push(args); fs.writeFileSync(log, JSON.stringify(calls));
if (args[0] === 'verify') process.exit(process.env.DMG_TEST_MODE === 'verify-failure' ? 3 : 0);
const attempt = calls.filter(c => c[0] === 'create').length;
const output = args.at(-1);
if (fs.existsSync(output)) { console.error('hdiutil: create failed - File exists'); process.exit(1); }
if (process.env.DMG_TEST_MODE === 'nonretryable') { console.error('hdiutil: create failed - No space left on device'); process.exit(28); }
const busy = process.env.DMG_TEST_MODE === 'always-busy' || (process.env.DMG_TEST_MODE === 'busy-twice' && attempt <= 2);
fs.writeFileSync(output, busy ? 'partial' : 'valid image');
if (busy) { console.error('hdiutil: create failed - Resource busy'); process.exit(1); }
`, { mode: 0o755 });
        fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\necho "$1" >> "$DMG_TEST_DELAYS"\n', { mode: 0o755 });
        fs.writeFileSync(path.join(tmp, 'update-artifacts.py'), "import os\nfrom pathlib import Path\nPath(os.environ['DMG_TEST_METADATA']).write_text('created')\n");
        const result = spawnSync('bash', ['-e', '-u', '-o', 'pipefail', '-c', packaging], {
            encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
                work, output_dmg: output, version: '0.2.8', source_app: path.join(tmp, 'fixture.app'), script_dir: tmp,
                DMG_TEST_MODE: mode, DMG_TEST_LOG: path.join(tmp, 'calls.json'),
                DMG_TEST_DELAYS: path.join(tmp, 'delays'), DMG_TEST_METADATA: path.join(tmp, 'metadata') }
        });
        const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        return { ...result, calls: JSON.parse(read(path.join(tmp, 'calls.json')) || '[]'),
            output: read(output), metadata: read(path.join(tmp, 'metadata')), delays: read(path.join(tmp, 'delays')) };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('DMG: first-attempt success is verified before metadata', () => {
    const r = run('success'); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls.map(c => c[0]), ['create', 'verify']);
    assert.equal(r.output, 'valid image'); assert.equal(r.metadata, 'created'); assert.equal(r.delays, null);
});
test('DMG: Resource busy retries with fresh candidates then verifies', () => {
    const r = run('busy-twice'); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls.map(c => c[0]), ['create', 'create', 'create', 'verify']);
    assert.equal(new Set(r.calls.filter(c => c[0] === 'create').map(c => c.at(-1))).size, 3);
    assert.equal(r.delays, '2\n4\n'); assert.equal(r.output, 'valid image'); assert.equal(r.metadata, 'created');
});
test('DMG: persistent Resource busy stops after three attempts without final output', () => {
    const r = run('always-busy'); assert.equal(r.status, 1);
    assert.deepEqual(r.calls.map(c => c[0]), ['create', 'create', 'create']);
    assert.equal(r.output, null); assert.equal(r.metadata, null); assert.equal(r.delays, '2\n4\n');
});
test('DMG: other create failures are not retried or hidden', () => {
    const r = run('nonretryable'); assert.equal(r.status, 28);
    assert.equal(r.calls.length, 1); assert.equal(r.delays, null); assert.equal(r.output, null); assert.equal(r.metadata, null);
});
test('DMG: verification failure cannot leave a final package or metadata', () => {
    const r = run('verify-failure'); assert.equal(r.status, 3);
    assert.equal(r.output, null); assert.equal(r.metadata, null); assert.equal(r.delays, null);
});
test('DMG: finalization never overwrites an existing destination', () => {
    const r = run('success', true); assert.notEqual(r.status, 0);
    assert.equal(r.output, 'existing package'); assert.equal(r.metadata, null);
});
