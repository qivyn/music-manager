const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function buildPolicy({ event, ref, newer, files }) {
    if (typeof newer !== 'boolean') throw new Error('Missing version comparison');
    if (event === 'workflow_dispatch') return { build: true, reason: 'Manual validation' };
    if (event === 'push' && ref === 'refs/heads/main') return { build: newer, reason: newer ? 'New main version' : 'Version already published' };
    if (event !== 'pull_request') throw new Error(`Unsupported CI event: ${event}/${ref}`);
    if (newer) return { build: true, reason: 'Unpublished version' };
    // Only an explicit, nonempty documentation-only diff can skip packaging.
    // Renames are supplied as delete + add, and unknown/new paths build by default.
    const documentationOnly = Array.isArray(files) && files.length > 0 && files.every(file =>
        file === 'README.md' || file === 'AGENTS.md' || /^docs\/[^\0]+$/.test(file));
    return { build: !documentationOnly, reason: documentationOnly ? 'Documentation only' : 'Code, resources, tooling, or unknown diff' };
}

function checkResults(needs) {
    for (const name of ['frontend', 'backend', 'plan']) {
        if (needs[name]?.result !== 'success') throw new Error(`${name} did not succeed`);
    }
    const required = needs.plan.outputs?.build_required;
    if (!['true', 'false'].includes(required)) throw new Error('Missing build decision');
    for (const name of ['build', 'preview']) {
        const expected = required === 'true' ? 'success' : 'skipped';
        if (needs[name]?.result !== expected) throw new Error(`${name}: expected ${expected}, got ${needs[name]?.result}`);
    }
}

if (require.main === module) {
    if (process.argv[2] === '--check') {
        checkResults(JSON.parse(process.env.CI_NEEDS));
        console.log('CI Ready: every required test, build and release rehearsal succeeded.');
    } else {
        const newer = process.env.CI_NEWER;
        if (!['true', 'false'].includes(newer)) throw new Error('Invalid version comparison');
        let files;
        if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
            const base = process.env.PR_BASE_SHA;
            if (!/^[0-9a-f]{40}$/.test(base || '')) throw new Error('Missing PR base commit');
            // Compare the actual checkout (GitHub's test merge) against the PR base.
            files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean);
        }
        const policy = buildPolicy({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, newer: newer === 'true', files });
        console.log(policy.reason);
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `build_required=${policy.build}\nbuild_reason=${policy.reason}\n`);
    }
}
module.exports = { buildPolicy, checkResults };
