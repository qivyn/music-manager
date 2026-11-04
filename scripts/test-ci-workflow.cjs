const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
function job(name) {
    const body = workflow.split(`\n  ${name}:\n`)[1];
    assert.ok(body, `missing job ${name}`);
    return body.split(/\n  [\w-]+:\n/)[0];
}
function enabled(name, event, ref, newer) {
    const expression = job(name).match(/^    if: (.+)$/m)?.[1];
    assert.ok(expression, `missing condition for ${name}`);
    // The workflow uses only comparisons, &&, || and parentheses: these have
    // the same result in JS for the string contexts supplied here.
    return vm.runInNewContext(expression, {
        github: { event_name: event, ref },
        needs: { plan: { outputs: { newer: String(newer) } } }
    });
}

for (const [label, event, ref, newer, build, release] of [
    ['new-version PR', 'pull_request', 'refs/pull/2/merge', true, false, false],
    ['unchanged-version PR', 'pull_request', 'refs/pull/2/merge', false, false, false],
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
    const run = job(name).match(/- name: Set up Tauri CLI\n        run: \|\n((?:          .*\n|\n)+)/)?.[1];
    assert.ok(run, `${name} must use the cached CLI setup`);
    return run.replace(/^          /gm, '');
}

for (const name of ['build', 'release']) {
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
