const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { buildPolicy, checkResults } = require('./ci-policy.cjs');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
function job(name) {
    const body = workflow.split(`\n  ${name}:\n`)[1];
    assert.ok(body, `missing job ${name}`);
    return body.split(/\n  [\w-]+:\n/)[0];
}
function enabled(name, event, ref, newer, files = ['frontend/app.js']) {
    const expression = job(name).match(/^    if: (.+)$/m)?.[1];
    assert.ok(expression, `missing condition for ${name}`);
    // The workflow uses only comparisons, &&, || and parentheses: these have
    // the same result in JS for the string contexts supplied here.
    let required = false;
    try { required = buildPolicy({ event, ref, newer, files }).build; } catch { /* unsupported event fails the plan job */ }
    return vm.runInNewContext(expression, {
        github: { event_name: event, ref },
        needs: { plan: { outputs: { newer: String(newer), build_required: String(required) } } }
    });
}

for (const [label, event, ref, newer, build, release] of [
    ['new-version PR', 'pull_request', 'refs/pull/2/merge', true, true, false],
    ['unchanged-version code PR', 'pull_request', 'refs/pull/2/merge', false, true, false],
    ['new main version', 'push', 'refs/heads/main', true, true, true],
    ['unchanged main version', 'push', 'refs/heads/main', false, false, false],
    ['manual build on main', 'workflow_dispatch', 'refs/heads/main', true, true, false],
    ['manual build of existing version on branch', 'workflow_dispatch', 'refs/heads/fix', false, true, false],
    ['tag push', 'push', 'refs/tags/v0.2.8', true, false, false],
    ['other branch push', 'push', 'refs/heads/fix', true, false, false]
]) {
    test(`CI build/release policy: ${label}`, () => {
        assert.equal(enabled('build', event, ref, newer), build, 'build');
        assert.equal(enabled('release', event, ref, newer), release, 'release');
    });
}

function setupScript(name) {
    assert.match(job(name), /uses: \.\/\.github\/actions\/setup-tauri-cli/);
    const action = fs.readFileSync(path.join(__dirname, '../.github/actions/setup-tauri-cli/action.yml'), 'utf8');
    const run = action.match(/- name: Set up Tauri CLI\n      shell: bash\n      run: \|\n((?:        .*\n|\n)+)/)?.[1];
    assert.ok(run, `${name} must use the cached CLI setup`);
    assert.ok(action.indexOf('- name: Save verified Tauri CLI') > action.indexOf('- name: Set up Tauri CLI'));
    assert.match(action, /uses: actions\/cache\/save@[0-9a-f]{40}/);
    return run.replace(/^        /gm, '');
}

for (const name of ['build', 'preview', 'release']) {
    for (const cached of ['2.11.4', '2.10.0', null]) {
        test(`${name}: ${cached === '2.11.4' ? 'reuse matching' : 'install missing or stale'} Tauri CLI (${cached})`, () => {
            const script = setupScript(name);
            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ci-cli-'));
            try {
                const bin = path.join(tmp, 'fake-bin');
                const cliBin = path.join(tmp, 'music-manager-tauri-cli/bin');
                fs.mkdirSync(bin);
                fs.mkdirSync(cliBin, { recursive: true });
                if (cached) fs.writeFileSync(path.join(cliBin, 'cargo-tauri'), `#!/bin/sh\necho 'tauri-cli ${cached}'\n`, { mode: 0o755 });
                // A fake cargo checks the real workflow's installation arguments;
                // no Rust compilation, network request or user Cargo directory.
                fs.writeFileSync(path.join(bin, 'cargo'), `#!/bin/bash
set -eu
[[ "$*" == "install tauri-cli --version =2.11.4 --locked --root $RUNNER_TEMP/music-manager-tauri-cli --force" ]]
echo install >> "$RUNNER_TEMP/calls"
printf '#!/bin/sh\\necho "tauri-cli 2.11.4"\\n' > "$RUNNER_TEMP/music-manager-tauri-cli/bin/cargo-tauri"
chmod +x "$RUNNER_TEMP/music-manager-tauri-cli/bin/cargo-tauri"
`, { mode: 0o755 });
                const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
                    encoding: 'utf8',
                    env: { ...process.env, RUNNER_TEMP: tmp, GITHUB_PATH: path.join(tmp, 'path'),
                        TAURI_CLI_VERSION: '2.11.4', PATH: `${bin}:${process.env.PATH}` }
                });
                assert.equal(result.status, 0, result.stderr);
                assert.equal(fs.existsSync(path.join(tmp, 'calls')), cached !== '2.11.4');
                assert.equal(fs.readFileSync(path.join(tmp, 'path'), 'utf8'), `${cliBin}\n`);
            } finally {
                fs.rmSync(tmp, { recursive: true, force: true });
            }
        });
    }
}

test('only a nonempty documentation-only PR on an already-published version skips packaging', () => {
    assert.equal(enabled('build', 'pull_request', 'refs/pull/2/merge', false, ['README.md', 'docs/guide.md']), false);
    assert.equal(enabled('build', 'pull_request', 'refs/pull/2/merge', true, ['docs/release-notes.md']), true);
    for (const files of [[], undefined, ['README.md', 'frontend/icon.png'], ['src-tauri/src/lib.rs'],
        ['scripts/test-dmg-packaging.cjs'], ['.github/workflows/ci.yml'], ['new-directory/file'],
        ['docs/old.md', 'frontend/new.js']]) {
        assert.equal(buildPolicy({ event: 'pull_request', newer: false, files }).build, true, JSON.stringify(files));
    }
    assert.throws(() => buildPolicy({ event: 'pull_request', newer: undefined, files: ['README.md'] }));
    assert.throws(() => buildPolicy({ event: 'push', ref: 'refs/tags/v0.2.8', newer: true }));
});

function successfulNeeds(required = true) {
    return { frontend: { result: 'success' }, backend: { result: 'success' },
        plan: { result: 'success', outputs: { build_required: String(required) } },
        build: { result: required ? 'success' : 'skipped' }, preview: { result: required ? 'success' : 'skipped' } };
}
test('CI Ready permits complete results and explicit legitimate skips', () => {
    checkResults(successfulNeeds()); checkResults(successfulNeeds(false));
    assert.match(job('ready'), /name: CI Ready\n/);
    assert.match(job('ready'), /if: always\(\)/);
    assert.match(job('ready'), /needs: \[frontend, backend, plan, build, preview\]/);
    assert.match(job('ready'), /run: node scripts\/ci-policy.cjs --check/);
    assert.match(job('release'), /needs: \[plan, build, ready\]/);
});
for (const name of ['frontend', 'backend', 'plan', 'build', 'preview']) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        test(`CI Ready blocks ${name} ${result}`, () => {
            const needs = successfulNeeds(); needs[name].result = result;
            assert.throws(() => checkResults(needs));
        });
    }
}
test('CI Ready cannot interpret a missing decision as permission to skip', () => {
    for (const required of ['', undefined, 'unknown']) {
        const needs = successfulNeeds(false); needs.plan.outputs.build_required = required;
        assert.throws(() => checkResults(needs));
    }
});
test('both native architectures are present and rehearsal uses no production key', () => {
    assert.match(job('build'), /target: aarch64-apple-darwin/);
    assert.match(job('build'), /target: x86_64-apple-darwin/);
    assert.match(job('preview'), /signer generate --ci/);
    assert.doesNotMatch(job('preview'), /secrets\./);
    assert.match(job('release'), /Preserve signed candidate before publishing[\s\S]+Publish GitHub Release/);
});

test('PR decision compares the complete diff and catches code renamed into documentation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ci-diff-'));
    const git = (...args) => {
        const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
    };
    const commit = () => { git('add', '-A'); git('-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', 'fixture'); };
    try {
        git('init', '-q'); fs.writeFileSync(path.join(tmp, 'app.js'), 'source'); commit();
        const base = git('rev-parse', 'HEAD'); fs.mkdirSync(path.join(tmp, 'docs'));
        fs.renameSync(path.join(tmp, 'app.js'), path.join(tmp, 'docs', 'renamed file.md')); commit();
        fs.writeFileSync(path.join(tmp, 'README.md'), 'later docs change'); commit();
        const output = path.join(tmp, 'ci-output');
        const r = spawnSync(process.execPath, [path.join(__dirname, 'ci-policy.cjs')], {
            cwd: tmp, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request',
                GITHUB_REF: 'refs/pull/2/merge', CI_NEWER: 'false', PR_BASE_SHA: base, GITHUB_OUTPUT: output }
        });
        assert.equal(r.status, 0, r.stderr);
        assert.match(fs.readFileSync(output, 'utf8'), /build_required=true/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
