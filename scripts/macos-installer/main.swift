import AppKit

// Every invocation, including reopening a cached installer, advertises its own lifetime.
private let installerLease:URL? = {
    let parent=Bundle.main.bundleURL.deletingLastPathComponent()
    guard parent.lastPathComponent.hasPrefix("helper-"),parent.deletingLastPathComponent().lastPathComponent.hasPrefix("update-") else{return nil}
    let path=parent.appendingPathComponent("active-installer-\(getpid()).json")
    do {try durableWrite(JSONSerialization.data(withJSONObject:["pid":getpid()]),to:path);return path}
    catch{return nil}
}()
atexit {if let lease=installerLease {try? FileManager.default.removeItem(at:lease)}}


if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--installer-worker-session" {
    do {try runInstallerWorkerSession(CommandLine.arguments[2]);exit(0)} catch {fputs(error.localizedDescription + "\n",stderr);exit(1)}
}
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--installer-worker" {
    do {try runInstallerWorker([CommandLine.arguments[2]]);exit(0)} catch {fputs(error.localizedDescription + "\n",stderr);exit(1)}
}


if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--installer-maintain" {
    do {
        let fm=FileManager.default
        let target=URL(fileURLWithPath:CommandLine.arguments[2])
        let shared=URL(fileURLWithPath:"/Applications/声场档案.app")
        let personal=fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/声场档案.app")
        guard [shared,personal].contains(target) else{throw InstallError("维护目标无效")}
        let state=target==shared ? URL(fileURLWithPath:"/Library/Application Support/com.musicmanager.installer/system") : fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/com.musicmanager.installer/user")
        let source=Bundle.main.resourceURL!.appendingPathComponent("声场档案.app")
        let logs=fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/com.musicmanager.installer")
        let engine=try Installer(source:source,destination:target,logRoot:logs,stateRoot:state)
        if let error=engine.recoveryError{throw InstallError(error)}
        try engine.cleanupCommitted();try engine.maintainEvidence()
        let job=Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        if job.lastPathComponent.hasPrefix("update-") {try durableWrite(JSONSerialization.data(withJSONObject:["committed":true,"cleanupPending":false,"jobId":job.lastPathComponent,"installerSession":engine.receipt?.session ?? "","targetPath":target.path]),to:job.appendingPathComponent("committed.json"))}
        closeInstallerWorker();exit(0)
    }catch{fputs(error.localizedDescription + "\n",stderr);closeInstallerWorker();exit(1)}
}

final class InstallerDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var status: NSTextField!
    var spinner: NSProgressIndicator!
    var installButton: NSButton!
    var retryButton: NSButton!
    var restoreButton: NSButton!
    var exportButton: NSButton!
    var installer: Installer?
    var busy = false
    var updateRequest: InAppUpdateRequest?
    var packageVersion:NSTextField!
    var diagnosticsRoot: URL?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出安装与更新", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 340),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "声场档案 · 安装与更新"
        window.delegate = self
        window.isReleasedWhenClosed = false
        let content = window.contentView!
        let heading = NSTextField(labelWithString: "安装与更新声场档案")
        heading.font = .systemFont(ofSize: 23, weight: .semibold)
        heading.frame = NSRect(x: 28, y: 274, width: 560, height: 36)
        content.addSubview(heading)
        let subtitle = NSTextField(wrappingLabelWithString: "安装成功后会清理旧版。失败时保留恢复材料；音乐库和原始音频独立保留。")
        subtitle.frame = NSRect(x: 28, y: 218, width: 560, height: 48)
        content.addSubview(subtitle)
        packageVersion = NSTextField(labelWithString: "安装包版本：…")
        packageVersion.frame = NSRect(x: 28, y: 190, width: 560, height: 22)
        content.addSubview(packageVersion)
        status = NSTextField(wrappingLabelWithString: "正在读取安装信息…")
        status.isSelectable = true
        status.frame = NSRect(x: 28, y: 90, width: 560, height: 86)
        content.addSubview(status)
        spinner = NSProgressIndicator(frame: NSRect(x: 28, y: 70, width: 560, height: 12))
        spinner.style = .bar; spinner.isIndeterminate = true; spinner.isDisplayedWhenStopped = false
        content.addSubview(spinner)
        installButton = button("安装 / 更新", action: #selector(install), x: 28, width: 125)
        retryButton = button("重新尝试启动", action: #selector(retry), x: 160, width: 130)
        restoreButton = button("恢复旧版", action: #selector(restore), x: 296, width: 110)
        exportButton = button("导出诊断信息", action: #selector(exportLogs), x: 414, width: 175)
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        configureInstaller()
    }
    func configureInstaller() {
        do {
            let fm = FileManager.default
            let shared = URL(fileURLWithPath: "/Applications/声场档案.app")
            let personal = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/声场档案.app")
            var logRoot = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/com.musicmanager.installer")
            var identifier = "com.musicmanager.app"
            // All new installations and upgrades converge on the system Applications folder.
            var destination = shared
            #if INSTALLER_UI_TESTS
            // Compiled only into the native UI test fixture, never the distributed installer.
            let testRoot = URL(fileURLWithPath: "/private/tmp/music-manager-installer-ui")
            destination = testRoot.appendingPathComponent("Applications/声场档案.app")
            logRoot = testRoot.appendingPathComponent("logs")
            identifier = "com.musicmanager.installertest"
            #endif
            diagnosticsRoot = logRoot
            #if INSTALLER_UI_TESTS
            let allowedDestinations = [destination]
            #else
            let allowedDestinations = [shared, personal]
            #endif
            updateRequest = try InAppUpdateRequest.parse(Array(CommandLine.arguments.dropFirst()), allowedDestinations: allowedDestinations)
            var selectedState=fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/com.musicmanager.installer/user")
            if destination==shared{selectedState=URL(fileURLWithPath:"/Library/Application Support/com.musicmanager.installer/system")}
            #if INSTALLER_UI_TESTS
            selectedState=logRoot.appendingPathComponent("state")
            #endif
            let currentReceipt=selectedState.appendingPathComponent("latest.json")
            let receiptFile=fm.fileExists(atPath:currentReceipt.path) ? currentReceipt : logRoot.appendingPathComponent("latest.json")
            if let data = try? Data(contentsOf: receiptFile),
               let previous = try? JSONDecoder().decode(InstallReceipt.self, from: data) {
                #if !INSTALLER_UI_TESTS
                guard [shared.path, personal.path].contains(previous.destination) else {
                    throw InstallError("上次更新记录的安装位置异常，已停止安装。请联系开发者。")
                }
                if !previous.finished && previous.destination != destination.path {
                    throw InstallError("旧位置有未完成的安装事务，请先完成恢复，再安装到应用程序。")
                }
                #endif
            }
            let source = Bundle.main.resourceURL!.appendingPathComponent("声场档案.app")
            let info = try AppInfo.read(source, identifier: identifier)
            var stateRoot = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/com.musicmanager.installer/user")
            if destination == shared {stateRoot=URL(fileURLWithPath:"/Library/Application Support/com.musicmanager.installer/system")}
            #if INSTALLER_UI_TESTS
            stateRoot=logRoot.appendingPathComponent("state")
            #endif
            installer = try Installer(source: source, destination: destination, logRoot: logRoot, identifier: identifier, stateRoot: stateRoot, progress: { [weak self] message in
                DispatchQueue.main.async { self?.status.stringValue = message }
            })
            var origins:[URL] = []
            if let request = updateRequest, request.destination != destination {origins.append(request.destination)}
            #if !INSTALLER_UI_TESTS
            if fm.fileExists(atPath:personal.path) {origins.append(personal)}
            origins += NSRunningApplication.runningApplications(withBundleIdentifier:identifier).compactMap { $0.bundleURL }
            #else
            // Fixture migration discovery remains entirely inside the isolated root.
            let legacy=testRoot.appendingPathComponent("Legacy/声场档案.app")
            if fm.fileExists(atPath:legacy.path) {origins.append(legacy)}
            #endif
            installer?.migrationSources=Array(Set(origins)).filter {$0 != destination}.sorted {$0.path < $1.path}
            packageVersion.stringValue = "安装包版本：\(info.version)"
            status.stringValue = "点击“安装 / 更新”开始。失败后可以在这里恢复旧版或导出诊断信息。"
            if let error = installer?.recoveryError { status.stringValue = error }
            if let receipt = installer?.receipt, !["completed", "restored", "failed_before_replace"].contains(receipt.phase) {
                status.stringValue = "检测到上次未完成的更新。\n可以重新尝试启动，或点击“恢复旧版”。旧应用备份和音乐库已保留。"
            }
            if let request = updateRequest, let installer = installer {
                installer.cancelRequested={request.cancelled}
                installer.downloadTransaction=request.reply.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent
                status.stringValue = "正在准备目标安装，当前应用保持运行…"
                perform(completion: { NSApp.terminate(nil) }) {
                    do {try installer.validateInAppUpdate(version: request.version);try installer.prepare();try request.respond()}
                    catch {self.respondToUpdateFailure(error);throw error}
                    try request.waitForParentExit()
                    try installer.install()
                    _ = try installer.launch()
                    if installer.receipt?.startupOutcome != nil {
                        let job=request.reply.deletingLastPathComponent().deletingLastPathComponent()
                        if job.lastPathComponent.hasPrefix("update-") {try durableWrite(JSONSerialization.data(withJSONObject:["committed":true,"cleanupPending":installer.receipt?.cleanupPending == true,"jobId":job.lastPathComponent,"installerSession":installer.receipt?.session ?? "","targetPath":installer.destination.path]),to:job.appendingPathComponent("committed.json"))}
                    }
                }
            }
        } catch {
            respondToUpdateFailure(error)
            show(error)
        }
        refreshButtons()
    }
    func button(_ title: String, action: Selector, x: CGFloat, width: CGFloat) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded; b.frame = NSRect(x: x, y: 25, width: width, height: 32)
        window.contentView!.addSubview(b); return b
    }
    func refreshButtons() {
        installButton.isEnabled = !busy && installer != nil && installer?.recoveryError == nil
        exportButton.isEnabled = !busy && installer != nil
        retryButton.isEnabled = !busy && installer?.canRetry == true
        restoreButton.isEnabled = !busy && installer?.canRestore == true
    }
    func perform(completion: (() -> Void)? = nil, _ work: @escaping () throws -> Void) {
        busy = true; refreshButtons(); spinner.startAnimation(nil)
        DispatchQueue.global(qos: .userInitiated).async {
            var failure: Error?
            do { try work() } catch { failure = error }
            DispatchQueue.main.async {
                self.busy = false; self.spinner.stopAnimation(nil); self.refreshButtons()
                if let failure = failure { if self.updateRequest?.cancelled==true {NSApp.terminate(nil)} else {self.show(failure)} }
                else { completion?() }
            }
        }
    }
    func show(_ error: Error) {
        status.stringValue = error.localizedDescription
        if let dir = installer?.runDirectory {
            try? error.localizedDescription.write(to: dir.appendingPathComponent("error.txt"), atomically: true, encoding: .utf8)
        }
    }
    func respondToUpdateFailure(_ error: Error) {
        guard let request = updateRequest, let root = diagnosticsRoot else { return }
        try? request.respondToFailure(error.localizedDescription, export: {
            try exportUpdateFailure(error.localizedDescription, installer: self.installer, logRoot: root)
        }, reveal: { url in
            let reveal = { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            if Thread.isMainThread { reveal() } else { DispatchQueue.main.sync(execute: reveal) }
        })
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if busy { NSSound.beep() }
        return !busy
    }
    func applicationWillTerminate(_ notification:Notification) {closeInstallerWorker()}
    @objc func install() {
        guard let installer = installer else { return }
        perform { try installer.install(); _ = try installer.launch(); try? installer.maintainEvidence() }
    }
    @objc func retry() {
        guard let installer = installer else { return }
        perform { _ = try installer.launch() }
    }
    @objc func restore() {
        guard let installer = installer else { return }
        let alert = NSAlert()
        alert.messageText = "恢复旧版本？"
        alert.informativeText = "会先退出声场档案，并检查旧版能否读取当前音乐库。只恢复应用，不回滚或覆盖音乐库。"
        alert.addButton(withTitle: "恢复旧版"); alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { perform { try installer.restore() } }
    }
    @objc func exportLogs() {
        guard let installer = installer else { return }
        let panel = NSSavePanel()
        panel.title = "导出诊断信息（不含音乐库或音频）"
        panel.message = "包含安装日志、启动日志和最近的应用崩溃报告，可能包含本机文件路径。"
        panel.nameFieldStringValue = "声场档案诊断-\(Int(Date().timeIntervalSince1970)).zip"
        panel.allowedFileTypes = ["zip"]
        if panel.runModal() == .OK, let url = panel.url {
            perform {
                try installer.exportDiagnostics(to: url)
                DispatchQueue.main.async { self.status.stringValue = "诊断信息已导出：\(url.path)\n请把这个文件发给开发者排查。" }
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !busy }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if busy {
            let alert = NSAlert(); alert.messageText = "安装操作正在进行"
            alert.informativeText = "请等待当前操作结束，再关闭安装窗口。"; alert.runModal()
            return .terminateCancel
        }
        return .terminateNow
    }
}

let delegate = InstallerDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.run()
