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
