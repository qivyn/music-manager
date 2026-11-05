const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createUpdaterController, updatePresentation } = require("../frontend/updater.js");
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};
function setup(options = {}) {
    const calls = [];
    let progress;
    let releases = 0;
    const controller = createUpdaterController({
        invoke: async (command, args) => {
            calls.push(command);
            if (options.invoke) return options.invoke(command, args);
            if (command === "check_app_update") return { currentVersion: "0.2.5", version: "0.2.6", notes: "updates" };
        },
        listen: async (_event, handler) => { progress = handler; return () => {}; },
        onChange() {},
        chooseDiagnosticsPath: options.chooseDiagnosticsPath || (async () => "/tmp/update-diagnostics.zip"),
        revealDiagnostics: options.revealDiagnostics || (async () => {}),
        prepareRestart: options.prepareRestart || (async () => () => { releases++; })
    });
    return { controller, calls, progress: value => progress({ payload: value }), releases: () => releases };
}
test("checking never downloads or quits; download never installs automatically", async () => {
    const { controller: c, calls } = setup();
    await c.check();
    assert.equal(c.state.phase, "available");
    assert.deepEqual(calls, ["check_app_update"]);
    await c.download();
    assert.equal(c.state.phase, "ready");
    assert.deepEqual(calls, ["check_app_update", "download_app_update"]);
});
test("failed restart can export diagnostics without retrying or losing the failure message", async () => {
    let exported;
    const {controller:c,calls}=setup({invoke:async(cmd,args)=>{
        if(cmd==='check_app_update') return {currentVersion:'0.2.7',version:'0.2.8'};
        if(cmd==='restart_for_app_update') throw new Error('更新记录无法安全读取');
        if(cmd==='export_update_diagnostics') exported=args;
    }});
    await c.check();await c.download();await c.restart();
    const failure=c.state.message;
    await c.exportDiagnostics();
    assert.equal(exported.destination,'/tmp/update-diagnostics.zip');
    assert.equal(exported.context.message,failure);
    assert.equal(exported.context.currentVersion,'0.2.7');
    assert.equal(exported.context.targetVersion,'0.2.8');
    assert.equal(c.state.message,failure);
    assert.match(c.state.diagnosticsMessage,/Finder/);
    assert.equal(c.state.diagnosticsPath, exported.destination);
    assert.equal(calls.filter(c=>c==='restart_for_app_update').length,1);
});
test("cancelling diagnostics save does not write or change the updater error", async () => {
    const {controller:c,calls}=setup({chooseDiagnosticsPath:async()=>null});
    c.state.message='原更新错误';
    await c.exportDiagnostics();
    assert.equal(c.state.message,'原更新错误');
    assert.equal(c.state.busy,false);
    assert.ok(!calls.includes('export_update_diagnostics'));
});
test("diagnostics failure is separate and duplicate exports cannot race", async () => {
    const save=deferred();
    const {controller:c,calls}=setup({invoke:()=>save.promise});
    c.state.message='原更新错误';
    const first=c.exportDiagnostics();
    await c.exportDiagnostics();await c.check();
    save.reject(new Error('目标不可写'));await first;
    assert.deepEqual(calls,['export_update_diagnostics']);
    assert.equal(c.state.message,'原更新错误');
    assert.match(c.state.diagnosticsError,/目标不可写/);
    assert.equal(c.state.busy,false);
});
test("successful diagnostic export reveals the saved ZIP and allows revealing it again", async () => {
    const actions=[];
    const {controller:c}=setup({
        invoke:async(cmd,args)=>{actions.push(['export',args.destination]);},
        revealDiagnostics:async path=>{actions.push(['reveal',path]);}
    });
    c.state.message='原更新错误';
    await c.exportDiagnostics();
    assert.deepEqual(actions,[['export','/tmp/update-diagnostics.zip'],['reveal','/tmp/update-diagnostics.zip']]);
    assert.equal(c.state.diagnosticsPath,'/tmp/update-diagnostics.zip');
    assert.equal(c.state.message,'原更新错误');
    assert.ok(!c.state.diagnosticsMessage.includes('/tmp/'));
    await c.showDiagnostics();
    assert.deepEqual(actions.at(-1),['reveal','/tmp/update-diagnostics.zip']);
    assert.equal(actions.filter(([action])=>action==='export').length,1);
});
test("Finder failure keeps the successfully exported file and provides a retry", async () => {
    let fail=true,reveals=0,exports=0;
    const {controller:c}=setup({invoke:async()=>{exports++;},revealDiagnostics:async()=>{
        reveals++;if(fail)throw new Error('Finder unavailable');
    }});
    c.state.message='原更新错误';await c.exportDiagnostics();
    assert.equal(c.state.diagnosticsPath,'/tmp/update-diagnostics.zip');
    assert.match(c.state.diagnosticsMessage,/已保存/);
    assert.match(c.state.diagnosticsMessage,/Finder/);
    assert.equal(c.state.message,'原更新错误');
    fail=false;await c.showDiagnostics();
    assert.equal(exports,1);assert.equal(reveals,2);
    assert.equal(c.state.diagnosticsRevealError,'');
});
test("cancelled or failed export never opens Finder", async () => {
    let reveals=0;
    const cancelled=setup({chooseDiagnosticsPath:async()=>null,revealDiagnostics:async()=>{reveals++;}}).controller;
    await cancelled.exportDiagnostics();
    const failed=setup({invoke:async()=>{throw new Error('disk full');},revealDiagnostics:async()=>{reveals++;}}).controller;
    await failed.exportDiagnostics();
    assert.equal(reveals,0);
    assert.equal(failed.state.diagnosticsPath,'');
    assert.match(failed.state.diagnosticsError,/disk full/);
});
test("cancelling a second export retains the first file and its Finder action", async () => {
    let choice='/tmp/first.zip';const reveals=[];
    const {controller:c}=setup({chooseDiagnosticsPath:async()=>choice,revealDiagnostics:async path=>reveals.push(path)});
    await c.exportDiagnostics();choice=null;const message=c.state.diagnosticsMessage;
    await c.exportDiagnostics();
    assert.equal(c.state.diagnosticsPath,'/tmp/first.zip');
    assert.equal(c.state.diagnosticsMessage,message);
    assert.deepEqual(reveals,['/tmp/first.zip']);
    await c.showDiagnostics();assert.deepEqual(reveals,['/tmp/first.zip','/tmp/first.zip']);
});
test("duplicate clicks cannot start concurrent checks or downloads", async () => {
    const work = deferred();
    const { controller: c, calls } = setup({ invoke: () => work.promise });
    const check = c.check();
    await c.check(); await c.download();
    assert.equal(calls.length, 1);
    work.resolve({ currentVersion: "0.2.5", version: null, notes: "" }); await check;
    assert.equal(c.state.phase, "latest");
});
test("download failure cannot enable restart and can be retried", async () => {
    let fail = true;
    const { controller: c, calls } = setup({ invoke: async cmd => {
        if (cmd === "check_app_update") return { currentVersion: "0.2.5", version: "0.2.6", notes: "" };
        if (fail) throw new Error("signature invalid");
    } });
    await c.check(); await c.download(); await c.restart();
    assert.equal(c.state.phase, "available");
    assert.match(c.state.message, /signature invalid/);
    assert.ok(!calls.includes("restart_for_app_update"));
    fail = false; await c.download();
    assert.equal(c.state.phase, "ready");
});
test("progress is displayed without marking an unverified download ready", async () => {
    const work = deferred();
    const { controller: c, progress } = setup({ invoke: cmd => cmd === "check_app_update"
        ? { currentVersion: "0.2.5", version: "0.2.6", notes: "" } : work.promise });
    await c.check();
    const downloading = c.download();
    progress({ phase: "downloading", downloaded: 50, total: 100 });
    assert.equal(c.state.downloaded, 50);
    progress({ phase: "verifying", downloaded: 0, total: null });
    progress({ phase: "ready", downloaded: 100, total: 100 });
    assert.equal(c.state.phase, "verifying");
    assert.equal(c.state.busy, true);
    work.resolve(); await downloading;
    assert.equal(c.state.phase, "ready");
});
test("cancelling restart retains download and never invokes the installer", async () => {
    const { controller: c, calls } = setup({ prepareRestart: async () => null });
    await c.check(); await c.download(); await c.restart();
    assert.equal(c.state.phase, "ready");
    assert.ok(!calls.includes("restart_for_app_update"));
});
test("handoff failure unlocks the library and allows retry", async () => {
    const app = setup({ invoke: async cmd => {
        if (cmd === "check_app_update") return { currentVersion: "0.2.5", version: "0.2.6", notes: "" };
        if (cmd === "restart_for_app_update") throw new Error("helper failed");
    } });
    await app.controller.check(); await app.controller.download(); await app.controller.restart();
    assert.equal(app.controller.state.phase, "ready");
    assert.match(app.controller.state.message, /helper failed/);
    assert.equal(app.releases(), 1);
});
test("restart waits for in-flight library work before calling backend", async () => {
    const drained = deferred();
    const { controller: c, calls } = setup({ prepareRestart: () => drained.promise });
    await c.check(); await c.download();
    const restarting = c.restart();
    assert.ok(!calls.includes("restart_for_app_update"));
    drained.resolve(() => {}); await restarting;
    assert.ok(calls.includes("restart_for_app_update"));
});
test("restart reports waiting only after the confirmation is accepted", async () => {
    const drained = deferred(); let confirm;
    const { controller: c } = setup({ prepareRestart: onConfirmed => { confirm = onConfirmed; return drained.promise; } });
    await c.check(); await c.download();
    const ready = c.state.message;
    const restarting = c.restart();
    assert.equal(c.state.message, ready, "panel claimed work had started while the dialog was open");
    confirm();
    assert.match(c.state.message, /等待当前操作完成/);
    drained.resolve(() => {}); await restarting;
});
test("offline check shows an error rather than claiming the app is current", async () => {
    const { controller: c } = setup({ invoke: () => { throw new Error("offline"); } });
    await c.check();
    assert.equal(c.state.phase, "idle");
    assert.match(c.state.message, /offline/);
    assert.equal(c.state.busy, false);
});
test("restoring a downloaded update after app restart does not recheck or redownload", async () => {
    const {controller:c,calls}=setup({invoke:cmd=>cmd==='get_update_status'
        ? {phase:'ready',transactionId:'update-saved',targetVersion:'0.2.8',currentVersion:'0.2.7',notes:'saved'} : undefined});
    await c.restore();
    assert.equal(c.state.phase,'ready');assert.equal(c.state.version,'0.2.8');
    assert.deepEqual(calls,['get_update_status']);
});
test("rechecking preserves a verified ready package", async () => {
    const {controller:c}=setup({invoke:()=>({version:'0.2.8',currentVersion:'0.2.7',downloaded:true})});
    await c.check();assert.equal(c.state.phase,'ready');
});
test("progress from another transaction is ignored", async () => {
    const work=deferred();
    const {controller:c,progress}=setup({invoke:cmd=>cmd==='check_app_update'?{version:'0.2.8'}:work.promise});
    await c.check();const request=c.download();c.state.transactionId='update-current';
    progress({transactionId:'update-other',phase:'downloading',downloaded:999,total:1000});
    assert.equal(c.state.downloaded,0);work.resolve();await request;
});
test("real update panel keeps an enabled export button after a failed restart", async () => {
    const fs=require('node:fs'),vm=require('node:vm');
    const html=fs.readFileSync(require.resolve('../frontend/index.html'),'utf8');
    const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,{
        hidden:false,disabled:false,textContent:'',handlers:{},dataset:{},open:false,
        classList:{add(){},remove(){},contains(){return false;}},removeAttribute(){},
        addEventListener(name,fn){this.handlers[name]=fn;}
    }]));
    let exported,saveCalls=0;const revealed=[];
    const api={event:{listen:async()=>()=>{}},opener:{revealItemInDir:async path=>revealed.push(path)},dialog:{save:async()=>{saveCalls++;return '/tmp/diagnostics.zip';}},core:{invoke:async(cmd,args)=>{
        if(cmd==='get_installation_status')return {canUpdate:true,installationPath:'/Applications/声场档案.app',arch:'aarch64'};
        if(cmd==='get_update_status')return {phase:'ready',currentVersion:'0.2.8',targetVersion:'0.2.9'};
        if(cmd==='restart_for_app_update')throw new Error('交接失败');
        if(cmd==='export_update_diagnostics')exported=args;
    }}};
    const document={getElementById:id=>nodes.get(id),addEventListener(){}};
    const context={document,window:{document,__TAURI__:api},prepareApplicationUpdate:async()=>()=>{},console};
    vm.runInNewContext(fs.readFileSync(require.resolve('../frontend/updater.js'),'utf8'),context);
    await nodes.get('checkUpdateBtn').handlers.click();
    await nodes.get('updateActionBtn').handlers.click();
    assert.equal(nodes.get('updateStatus').textContent,'交接失败');
    const button=nodes.get('updateDiagnosticsBtn');
    assert.ok(button);assert.equal(button.disabled,false);assert.equal(button.hidden,false);
    await button.handlers.click();
    assert.equal(saveCalls,1);assert.equal(exported.context.message,'交接失败');
    assert.equal(nodes.get('updateStatus').textContent,'交接失败');
    assert.match(nodes.get('updateDiagnosticsTitle').textContent,/已导出/);
    assert.match(nodes.get('updateDiagnosticsStatus').textContent,/Finder/);
    assert.deepEqual(revealed,['/tmp/diagnostics.zip']);
    const show=nodes.get('updateDiagnosticsRevealBtn');
    assert.equal(show.hidden,false);assert.equal(show.disabled,false);
    await show.handlers.click();assert.deepEqual(revealed,['/tmp/diagnostics.zip','/tmp/diagnostics.zip']);
    assert.equal(nodes.get('updateInstallationDetails').open,false);
    assert.equal(nodes.get('updateDiagnosticsDetails').open,false);
    assert.equal(nodes.get('updateErrorDetails').open,false);
    assert.equal(nodes.get('updateStatusTitle').textContent,'更新未完成');
    assert.equal(nodes.get('updateDiagnosticsFile').textContent,'diagnostics.zip');
    assert.ok(!nodes.get('updateDiagnosticsStatus').textContent.includes('/tmp/'));
});
test("update presentation separates short guidance from detailed errors", () => {
    const state={phase:'idle',errorAction:'check',message:'network error at /private/tmp/very/long/path'};
    const view=updatePresentation(state);
    assert.equal(view.title,'暂时无法检查更新');assert.equal(view.tone,'warning');
    assert.ok(!view.message.includes('/private/tmp'));
    assert.equal(state.message,'network error at /private/tmp/very/long/path');
    assert.equal(updatePresentation({phase:'available',errorAction:'download',message:'The signature verification failed'}).title,'更新包未通过验证');
    assert.equal(updatePresentation({phase:'latest',message:'当前已是最新版本。'}).tone,'success');
});
const { updateActions, compareVersions } = require("../frontend/updater.js");
test("the primary button offers the next useful step for each failure", () => {
    const label = state => updateActions(state).primary.label;
    assert.equal(label({ phase: "available", version: "0.2.11" }), "更新到 0.2.11");
    assert.equal(label({ phase: "ready" }), "重启并安装");
    assert.equal(label({ phase: "idle", errorAction: "check" }), "重试检查");
    assert.equal(label({ phase: "available", errorAction: "download", message: "更新包签名校验失败" }), "重新下载");
    assert.equal(label({ phase: "available", errorAction: "download", message: "network" }), "重试下载");
    assert.equal(label({ phase: "ready", errorAction: "install", errorCode: "CONFLICT", message: "另一个窗口" }), "已关闭，重试");
    const unknown = updateActions({ phase: "ready", errorAction: "install", message: "交接失败" });
    assert.deepEqual([unknown.primary.intent, unknown.secondary.label], ["export", "重试更新"]);
    assert.equal(updateActions({ phase: "available", version: "0.2.11" }).secondary.intent, "none", "recheck shown without a failure");
    assert.equal(compareVersions("0.2.9", "0.2.10"), -1);
    assert.equal(compareVersions("0.2.10", "0.2.10"), 0);
});
test("a silent background check never shows an error", async () => {
    const { controller: c } = setup({ invoke: () => { throw new Error("offline"); } });
    await c.check({ silent: true });
    assert.equal(c.state.errorAction, "");
    assert.doesNotMatch(c.state.message, /offline/);
});
test("installed notes survive restoring the saved status when the panel opens", async () => {
    const { controller: c } = setup({ invoke: cmd => cmd === "get_update_status" ? { phase: "idle", currentVersion: "0.2.11" } : undefined });
    c.showInstalled({ version: "0.2.11", notes: "更新不再需要密码" });
    await c.restore();
    assert.equal(c.state.phase, "installed");
    assert.equal(c.state.notes, "更新不再需要密码");
    assert.match(c.state.message, /已更新到 0.2.11/);
});
function panel({ invoke, storage = {} }) {
    const fs = require("node:fs"), vm = require("node:vm");
    const html = fs.readFileSync(require.resolve("../frontend/index.html"), "utf8");
    const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
        hidden: false, disabled: false, textContent: "", handlers: {}, dataset: {}, open: false,
        classList: { add() {}, remove() {}, contains() { return true; } }, removeAttribute() {},
        addEventListener(name, fn) { this.handlers[name] = fn; }
    }]));
    const calls = [], timers = [];
    const api = { event: { listen: async () => () => {} }, opener: { revealItemInDir: async () => {} }, dialog: { save: async () => null },
        core: { invoke: async (cmd, args) => { calls.push(cmd); return invoke(cmd, args); } } };
    const localStorage = { getItem: key => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; }, removeItem: key => { delete storage[key]; } };
    const document = { getElementById: id => nodes.get(id), addEventListener() {} };
    const confirmations = [];
    const context = { document, localStorage, window: { document, __TAURI__: api }, console, Date,
        setTimeout: fn => { timers.push(fn); return timers.length; },
        prepareApplicationUpdate: async () => { confirmations.push(true); return () => {}; } };
    vm.runInNewContext(fs.readFileSync(require.resolve("../frontend/updater.js"), "utf8"), context);
    const flush = () => new Promise(resolve => setImmediate(resolve));
    return { nodes, calls, storage, timers, confirmations, flush };
}
test("after an update the app says so once and shows this version's notes", async () => {
    const p = panel({ storage: { "musicManager.update.lastRunVersion": "0.2.10", "musicManager.update.checkedAt": String(Date.now()) },
        invoke: cmd => cmd === "get_update_welcome" ? { version: "0.2.11", notes: "更新不再需要密码", launchedByInstaller: true }
            : cmd === "get_installation_status" ? { canUpdate: true } : cmd === "get_update_status" ? { phase: "idle" } : undefined });
    await p.flush(); await p.flush();
    const notice = p.nodes.get("updateNoticeBtn");
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /已更新到 0.2.11/);
    assert.equal(p.storage["musicManager.update.lastRunVersion"], "0.2.11");
    await notice.handlers.click();
    assert.equal(notice.hidden, true);
    assert.equal(p.nodes.get("updateNotes").textContent, "更新不再需要密码");
    assert.equal(p.nodes.get("updateStatusTitle").textContent, "更新完成");
    assert.ok(!p.calls.includes("check_app_update"), "opening the notes rechecked within a day");
});
test("background discovery checks at most daily, badges the entry and updates in one click", async () => {
    const p = panel({ storage: { "musicManager.update.lastRunVersion": "0.2.10" },
        invoke: cmd => cmd === "get_update_welcome" ? { version: "0.2.10", notes: "", launchedByInstaller: false }
            : cmd === "check_app_update" ? { currentVersion: "0.2.10", version: "0.2.11", notes: "新版" }
            : cmd === "get_installation_status" ? { canUpdate: true } : cmd === "get_update_status" ? { phase: "idle" } : undefined });
    await p.flush(); await p.flush();
    assert.equal(p.nodes.get("updateNoticeBtn").textContent, "", "welcome shown without a version change");
    assert.equal(p.timers.length, 1);
    await p.timers[0](); await p.flush();
    assert.match(p.nodes.get("updateNoticeBtn").textContent, /有新版本 0.2.11/);
    assert.equal(p.nodes.get("settingsToggleBtn").dataset.updateAvailable, "true");
    assert.match(p.nodes.get("checkUpdateBadge").textContent, /0.2.11/);
    assert.ok(Number(p.storage["musicManager.update.checkedAt"]) > 0);
    assert.equal(p.nodes.get("updateActionBtn").textContent, "更新到 0.2.11");
    await p.nodes.get("updateActionBtn").handlers.click();
    assert.deepEqual(p.calls.filter(c => ["download_app_update", "restart_for_app_update"].includes(c)), ["download_app_update", "restart_for_app_update"]);
    assert.equal(p.confirmations.length, 1, "restart was not confirmed exactly once");
});
test("an update from a client that never recorded its version still says updated", async () => {
    const p = panel({ storage: { "musicManager.update.checkedAt": String(Date.now()) },
        invoke: cmd => cmd === "get_update_welcome" ? { version: "0.2.11", notes: "n", launchedByInstaller: true, previousVersion: "0.2.10" } : undefined });
    await p.flush(); await p.flush();
    assert.match(p.nodes.get("updateNoticeBtn").textContent, /已更新到 0.2.11/);
});
