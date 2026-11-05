import Foundation
import AppKit
import Darwin
import CryptoKit

enum InstallationLocation {
    static func byteSize(_ path: URL) -> Int64 {
        let iterator=FileManager.default.enumerator(at:path,includingPropertiesForKeys:[.fileSizeKey,.isRegularFileKey],options:[.skipsPackageDescendants])
        var total:Int64=0
        while let file=iterator?.nextObject() as? URL {if let values=try? file.resourceValues(forKeys:[.fileSizeKey,.isRegularFileKey]),values.isRegularFile==true {total += Int64(values.fileSize ?? 0)}}
        return total
    }
    static func rejectLinks(_ path: URL) throws {
        var item = path.standardizedFileURL
        while item.path != "/" {
            // macOS system aliases are fixed; reject application-controlled links below them.
            if ["/var", "/tmp"].contains(item.path) { item.deleteLastPathComponent(); continue }
            if let attrs = try? FileManager.default.attributesOfItem(atPath: item.path),
               attrs[.type] as? FileAttributeType == .typeSymbolicLink {
                throw InstallError("安装路径包含符号链接，已停止操作：\(item.path)")
            }
            item.deleteLastPathComponent()
        }
    }
}

func durableWrite(_ data: Data, to path: URL) throws {
    try InstallationLocation.rejectLinks(path)
    try data.write(to: path, options: .atomic)
    let fd = Darwin.open(path.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw InstallError("无法持久化安装记录") }
    defer { Darwin.close(fd) }
    guard fsync(fd) == 0 else { throw InstallError("安装记录落盘失败") }
    let parent = Darwin.open(path.deletingLastPathComponent().path, O_RDONLY)
    if parent >= 0 { _ = fsync(parent); Darwin.close(parent) }
}

struct InstallError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct InAppUpdateRequest {
    let destination: URL
    let parentPID: Int32
    let version: String
    let reply: URL
    let token: String
    var protocolVersion:Int=1

    static func parse(_ args: [String], allowedDestinations: [URL]) throws -> InAppUpdateRequest? {
        let keys = ["--update-protocol", "--update-destination", "--parent-pid", "--expected-version", "--handoff", "--token"]
        // Finder may add its own launch arguments; only our explicit flags request an update.
        if !args.contains(where: { keys.contains($0) }) { return nil }
        guard args.count == 10 || args.count == 12 else { throw InstallError("应用内更新参数不完整。") }
        var values: [String: String] = [:]
        for index in stride(from: 0, to: args.count, by: 2) {
            guard keys.contains(args[index]), values[args[index]] == nil else { throw InstallError("应用内更新参数无效。") }
            values[args[index]] = args[index + 1]
        }
        guard let path = values["--update-destination"], path.hasPrefix("/"),
              let pid = Int32(values["--parent-pid"] ?? ""), pid > 1, pid != ProcessInfo.processInfo.processIdentifier,
              let version = values["--expected-version"], version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil,
              let replyPath = values["--handoff"], replyPath.hasPrefix("/"),
              let token = values["--token"], token.range(of: #"^helper-[a-zA-Z0-9_-]+$"#, options: .regularExpression) != nil else {
            throw InstallError("无法确认本次更新的应用位置或来源参数。")
        }
        let reply = URL(fileURLWithPath: replyPath)
        if !allowedDestinations.contains(where: {$0.path == path}) {
            let origin = URL(fileURLWithPath: path)
            try InstallationLocation.rejectLinks(origin)
            guard NSRunningApplication(processIdentifier: pid)?.bundleURL?.resolvingSymlinksInPath() == origin.resolvingSymlinksInPath() else {
                throw InstallError("无法确认旧应用进程与迁移来源，已停止更新。")
            }
        }
        guard reply.lastPathComponent == "handoff.json", reply.deletingLastPathComponent().lastPathComponent == token else {
            throw InstallError("更新交接位置无效。")
        }
        let protocolVersion=Int(values["--update-protocol"] ?? "1") ?? 0
        guard [1,2].contains(protocolVersion) else{throw InstallError("更新交接协议不受支持")}
        return InAppUpdateRequest(destination: URL(fileURLWithPath: path), parentPID: pid, version: version, reply: reply, token: token, protocolVersion:protocolVersion)
    }
    func respond(error: String? = nil) throws {
        var data: [String: Any] = ["token": token, "version": version, "pid": ProcessInfo.processInfo.processIdentifier,"protocol":protocolVersion]
        if let error = error { data["error"] = error }
        try JSONSerialization.data(withJSONObject: data).write(to: reply, options: .atomic)
    }
    func respondToFailure(_ message: String, export: () throws -> URL,
                          reveal: (URL) -> Void = { NSWorkspace.shared.activateFileViewerSelecting([$0]) }) throws {
        var response = message
        // Released protocol-1 clients kill this process on an error reply and
        // have no export button. Finish exporting before they receive the error.
        if protocolVersion == 1 {
            do {
                let archive = try export()
                reveal(archive)
                response += "\n诊断 ZIP 已保存并在 Finder 中显示：\(archive.path)\n请将该文件发给管理员或开发者。"
            } catch {
                response += "\n诊断信息未能自动导出：\(error.localizedDescription)"
            }
        }
        try respond(error: response)
    }
    var cancelled:Bool {FileManager.default.fileExists(atPath:reply.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("cancel-request").path)}
    func waitForParentExit(timeout: TimeInterval = 30, isRunning: (Int32) -> Bool = { Darwin.kill($0, 0) == 0 || errno == EPERM }) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while isRunning(parentPID) && Date() < deadline {if cancelled{throw InstallError("更新准备已取消")}; Thread.sleep(forTimeInterval: 0.1) }
        if cancelled{throw InstallError("更新准备已取消")}
        guard !isRunning(parentPID) else {
            throw InstallError("声场档案尚未退出，更新未开始。请退出应用后再点击“安装 / 更新”。")
        }
    }
}

struct AppInfo {
    let version: String
    let schema: Int?
    let protocolVersion: Int?
    let minimumOS: String
    static func read(_ app: URL, identifier: String = "com.musicmanager.app") throws -> AppInfo {
        let file = app.appendingPathComponent("Contents/Info.plist")
        guard let dict = try PropertyListSerialization.propertyList(from: Data(contentsOf: file), format: nil) as? [String: Any],
              dict["CFBundleIdentifier"] as? String == identifier,
              dict["CFBundleExecutable"] as? String == "music-manager",
              let version = dict["CFBundleShortVersionString"] as? String,
              version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else {
            throw InstallError("安装包中的应用身份或版本无效，请重新下载官方安装包。")
        }
        return AppInfo(version: version, schema: dict["MusicManagerDatabaseSchema"] as? Int,
                       protocolVersion: dict["MusicManagerStartupProtocol"] as? Int,
                       minimumOS: dict["LSMinimumSystemVersion"] as? String ?? "10.15")
    }
    var rollbackSchema: Int? {
        // 0.2.5 is the first released version that refuses to create a replacement
        // library on a missing drive. Earlier bundles cannot safely be auto-restored.
        schema ?? (version == "0.2.5" ? 3 : nil)
    }
}

struct MigratedApplication: Codable {
    let path: String
    let version: String
    let digest: String
    let device: UInt64
    let inode: UInt64
}

struct InstallReceipt: Codable {
    let session: String
    let destination: String
    let backup: String
    let staging: String
    let version: String
    let previousVersion: String?
    let previousSchema: Int?
    var diagnosticsSession: String
    var phase: String
    var launched: Bool
    var formatVersion: Int? = 2
    var startupOutcome: String? = nil
    var cleanupPending: Bool? = false
    var createdAt: Date? = Date()
    var updatedAt: Date? = Date()
    var lastError: String? = nil
    var packageDigest: String? = nil
    var previousTransaction: String? = nil
    var previousDigest:String? = nil
    var transactionId:String? = nil
    var migrationSources: [MigratedApplication]? = nil
    var finished: Bool { ["completed", "restored", "failed_before_replace", "superseded"].contains(phase) }
}

struct StartupReport: Decodable {
    let `protocol`: Int
    let session: String
    let pid: Int32
    let version: String
    let state: String
    var applicationPath: String? = nil
}

enum StartupResult: Equatable {
    case ready, waitingLibrary, libraryUnavailable, cancelled
    var message: String {
        switch self {
        case .ready: return "更新完成，音乐库界面已就绪。"
        case .waitingLibrary: return "安装完成。请在声场档案窗口中选择已有音乐库或创建新库。"
        case .libraryUnavailable: return "应用已启动，但音乐库暂不可用。请到声场档案窗口连接硬盘或查看具体提示；无需重新安装。"
        case .cancelled: return "安装完成。你已退出音乐库选择，下次可直接打开声场档案。"
        }
    }
}

func evaluateStartup(_ data: Data?, session: String, version: String, pid: Int32, running: Bool, applicationPath: String? = nil) throws -> StartupResult? {
    if let data = data, let report = try? JSONDecoder().decode(StartupReport.self, from: data),
       [1, 2].contains(report.protocol), report.session == session, report.version == version, report.pid == pid,
       (report.protocol == 1 || (report.applicationPath != nil && applicationPath != nil &&
        URL(fileURLWithPath:report.applicationPath!).resolvingSymlinksInPath() == URL(fileURLWithPath:applicationPath!).resolvingSymlinksInPath())) {
        if report.state == "cancelled" { return .cancelled }
        if report.state == "failed" { throw InstallError("新版启动时发生错误。可重新尝试、恢复旧版或导出诊断信息。") }
        if running {
            switch report.state {
            case "ready": return .ready
            case "waiting_library": return .waitingLibrary
            case "library_unavailable": return .libraryUnavailable
            default: break
            }
        }
    }
    if !running { throw InstallError("新版在启动完成前退出。旧版本备份已保留，可恢复旧版或导出诊断信息。") }
    return nil
}

protocol InstallerIO {
    func run(_ executable: String, _ arguments: [String], privileged: Bool) throws -> String
    func stopApplication(at destination: URL) throws
}

final class SystemIO: InstallerIO {
    let log: (String) -> Void
    let identifier: String
    init(log: @escaping (String) -> Void, identifier: String = "com.musicmanager.app") {
        self.log = log; self.identifier = identifier
    }
    static func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    func run(_ executable: String, _ arguments: [String], privileged: Bool = false) throws -> String {
        let task = Process()
        let pipe = Pipe()
        if privileged {
            try privilegedInstallerAction(["action":"file-operation","executable":executable,"arguments":arguments])
            return ""
        } else {
            task.executableURL = URL(fileURLWithPath: executable)
            task.arguments = arguments
        }
        task.standardOutput = pipe
        task.standardError = pipe
        log("执行：\(executable) \(arguments.joined(separator: " "))")
        try task.run()
        let timeout = DispatchWorkItem { if task.isRunning { task.terminate(); DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if task.isRunning { Darwin.kill(task.processIdentifier, SIGKILL) } } } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: timeout)
        defer { timeout.cancel() }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let output = String(decoding: data, as: UTF8.self)
        log(output)
        guard task.terminationStatus == 0 else {
            throw InstallError("操作未完成（\(URL(fileURLWithPath: executable).lastPathComponent)，\(task.terminationStatus)）。\n\(String(output.suffix(1500)))\n可以导出诊断信息发给开发者。")
        }
        return output
    }
    func stopApplication(at destination: URL) throws {
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
        let running=apps.filter{!$0.isTerminated}
        guard running.allSatisfy({$0.bundleURL?.resolvingSymlinksInPath()==destination.resolvingSymlinksInPath()}) else {
            throw InstallError("另一份声场档案正在运行，请保存并退出该副本后继续；安装器不会替你关闭它。")
        }
        for app in running {
            let plist=destination.appendingPathComponent("Contents/Info.plist")
            let info=(try? Data(contentsOf:plist)).flatMap{try? PropertyListSerialization.propertyList(from:$0,format:nil) as? [String:Any]}
            guard info?["MusicManagerExitProtocol"] as? Int == 2 else {throw InstallError("旧版不支持安全退出交接，请先保存编辑并自行退出，再继续安装。")}
            let id=identifier=="com.musicmanager.app" ? "com.musicmanager.installer" : identifier + ".installer"
            let runtime=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/"+id+"/runtime")
            try InstallationLocation.rejectLinks(runtime)
            let token=UUID().uuidString;let pid=app.processIdentifier
            let request=runtime.appendingPathComponent("\(pid)-request.json")
            let reply=runtime.appendingPathComponent("\(pid)-reply.json")
            try durableWrite(JSONSerialization.data(withJSONObject:["token":token,"pid":pid,"applicationPath":destination.path]),to:request)
            defer{try? FileManager.default.removeItem(at:request);try? FileManager.default.removeItem(at:reply)}
            let deadline=Date().addingTimeInterval(120)
            while !app.isTerminated && Date()<deadline {
                if let data=try? Data(contentsOf:reply),let response=try? JSONSerialization.jsonObject(with:data) as? [String:Any],response["token"] as? String==token,response["approved"] as? Bool==false {throw InstallError("用户取消更新，现有应用保持运行。")}
                Thread.sleep(forTimeInterval:0.1)
            }
            guard app.isTerminated else{throw InstallError("应用尚未退出，更新未开始。请处理编辑或任务后重试。")}
        }
    }
}

final class Installer {
    static let appName = "声场档案.app"
    let fm = FileManager.default
    let source: URL
    let destination: URL
    let logRoot: URL
    let stateRoot: URL
    let runDirectory: URL
    let io: InstallerIO
    let progress: (String) -> Void
    var receipt: InstallReceipt?
    private(set) var recoveryError: String?
    var launchedProcess: Process?
    var cancelRequested:()->Bool = {false}
    var migrationSources:[URL] = []
    var downloadTransaction:String?
    private var lockFD: Int32 = -1
    private var targetLockFD: Int32 = -1
    private var targetLocked=false
    private var appLog: FileHandle?
    private let systemChecks: Bool
    private let identifier: String

    init(source: URL, destination: URL, logRoot: URL, io: InstallerIO? = nil,
         systemChecks: Bool = true, identifier: String = "com.musicmanager.app",
         stateRoot: URL? = nil, progress: @escaping (String) -> Void = { _ in }) throws {
        self.source = source
        self.destination = destination
        self.logRoot = logRoot
        self.stateRoot = stateRoot ?? logRoot
        self.progress = progress
        self.systemChecks = systemChecks
        self.identifier = identifier
        runDirectory = logRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try InstallationLocation.rejectLinks(logRoot)
        try fm.createDirectory(at: runDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try durableWrite(JSONSerialization.data(withJSONObject:["identifier":identifier,"run":runDirectory.lastPathComponent,"logRoot":logRoot.path]),to:runDirectory.appendingPathComponent("run-owner.json"))
        let logFile = runDirectory.appendingPathComponent("installer.log")
        let logLock = NSLock()
        let append: (String) -> Void = { message in
            logLock.lock(); defer { logLock.unlock() }
            let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
            if !FileManager.default.fileExists(atPath: logFile.path) { FileManager.default.createFile(atPath: logFile.path, contents: nil) }
            if let file = try? FileHandle(forWritingTo: logFile) {
                file.seekToEndOfFile(); file.write(Data(line.utf8)); file.closeFile()
            }
        }
        self.io = io ?? SystemIO(log: append, identifier: identifier)
        try InstallationLocation.rejectLinks(destination)
        try InstallationLocation.rejectLinks(self.stateRoot)
        try acquireTargetLock()
        try fm.createDirectory(at: self.stateRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        append("系统：\(ProcessInfo.processInfo.operatingSystemVersionString)；目标：\(destination.path)")
        lockFD = Darwin.open(logRoot.appendingPathComponent("installer.lock").path, O_CREAT | O_RDWR, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            if lockFD >= 0 { Darwin.close(lockFD); lockFD = -1 }
            throw InstallError("另一个安装窗口正在工作，请返回那个窗口完成操作。")
        }
        let legacy = logRoot.appendingPathComponent("latest.json")
        let current = self.stateRoot.appendingPathComponent("latest.json")
        let record = fm.fileExists(atPath: current.path) ? current : legacy
        if let data = try? Data(contentsOf: record) {
            do {
                receipt = try JSONDecoder().decode(InstallReceipt.self, from: data)
                if let r = receipt, r.destination != destination.path, r.finished {
                    // Only the old shared Logs record may describe another target.
                    // Dedicated system state must always belong to this destination.
                    guard record == legacy else { throw InstallError("更新记录与安装位置不一致，已停止操作。请导出诊断信息。") }
                    try validateReceipt(at: URL(fileURLWithPath: r.destination))
                    // Preserve v0.2.6/0.2.7 evidence in its original user scope.
                    // The privileged state writer correctly rejects personal paths.
                    let archive = logRoot.appendingPathComponent("transactions/\(r.session).json")
                    try InstallationLocation.rejectLinks(legacy)
                    try InstallationLocation.rejectLinks(archive)
                    try fm.createDirectory(at: archive.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    try durableWrite(data, to: archive)
                    try fm.removeItem(at: legacy)
                    receipt = nil
                } else {
                    try validateReceipt()
                }
            } catch {
                receipt = nil
                recoveryError = "更新记录无法安全读取，已停止安装和恢复。请导出诊断信息发给开发者。"
                append("更新记录错误：\(error.localizedDescription)")
            }
        }
    }
    deinit {
        appLog?.closeFile()
        if lockFD >= 0 { flock(lockFD, LOCK_UN); Darwin.close(lockFD) }
        try? releaseTargetLock()
    }
    func acquireTargetLock() throws {
        if targetLocked{return}
        if destination.path=="/Applications/声场档案.app" && systemChecks {
            try privilegedInstallerAction(["action":"prepare-system"])
        } else {
            let path=destination.deletingLastPathComponent().appendingPathComponent(".music-manager-installer.lock")
            try InstallationLocation.rejectLinks(path)
            try fm.createDirectory(at:destination.deletingLastPathComponent(),withIntermediateDirectories:true)
            targetLockFD=Darwin.open(path.path,O_RDONLY|O_NOFOLLOW)
            if targetLockFD<0{targetLockFD=Darwin.open(path.path,O_CREAT|O_RDWR|O_NOFOLLOW,0o644)}
            guard targetLockFD>=0,flock(targetLockFD,LOCK_EX|LOCK_NB)==0 else {
                if targetLockFD>=0{Darwin.close(targetLockFD);targetLockFD = -1}
                throw InstallError("目标应用已有安装事务或目录不可写，请返回原安装窗口或检查应用程序目录权限。")
            }
        }
        targetLocked=true
    }
    func releaseTargetLock() throws {
        if !targetLocked{return}
        if destination.path=="/Applications/声场档案.app" && systemChecks {try privilegedInstallerAction(["action":"release-target"])}
        else if targetLockFD>=0{flock(targetLockFD,LOCK_UN);Darwin.close(targetLockFD);targetLockFD = -1}
        targetLocked=false
    }
    func validateReceipt(at location: URL? = nil) throws {
        guard let r = receipt else { return }
        let location = location ?? destination
        try InstallationLocation.rejectLinks(location)
        let parent = location.deletingLastPathComponent()
        let expectedBackup = parent.appendingPathComponent(".music-manager-backups/\(r.session)/\(Self.appName)").path
        let expectedStaging = parent.appendingPathComponent(".music-manager-stage-\(r.session).app").path
        guard UUID(uuidString: r.session) != nil, r.destination.hasPrefix("/"), r.destination == location.path,
              r.backup == expectedBackup, r.staging == expectedStaging else {
            throw InstallError("更新记录与安装位置不一致，已停止操作。请导出诊断信息。")
        }
    }
    func save() throws {
        receipt?.updatedAt = Date()
        let data = try JSONEncoder().encode(receipt)
        let current = stateRoot.appendingPathComponent("latest.json")
        if let old = try? Data(contentsOf: current), (try? JSONDecoder().decode(InstallReceipt.self, from: old)) != nil {
            try persistState(old, name:"previous.json")
        }
        try persistState(data, name:"latest.json")
        try data.write(to: runDirectory.appendingPathComponent("transaction.json"), options: .atomic)
    }
    func persistState(_ data: Data, name: String) throws {
        if stateRoot.path == "/Library/Application Support/com.musicmanager.installer/system" {
            try privilegedInstallerAction(["action":"write-state","name":name,"data":data.base64EncodedString()])
        } else { try durableWrite(data, to:stateRoot.appendingPathComponent(name)) }
    }
    func archiveReceipt() throws {
        guard let r = receipt else { return }
        let directory = stateRoot.appendingPathComponent("transactions")
        if !stateRoot.path.hasPrefix("/Library/") { try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        try persistState(JSONEncoder().encode(r), name:"transactions/" + r.session + ".json")
    }
    func operation(_ executable: String, _ args: [String], writingTo directories: [URL]) throws {
        let privileged = directories.contains { directory in
            // mkdir/ditto may create several missing directories. Check the nearest
            // existing ancestor, including backup directories owned by another user.
            var existing = directory.standardizedFileURL
            while !fm.fileExists(atPath: existing.path) {
                let parent = existing.deletingLastPathComponent()
                if parent == existing { return true }
                existing = parent
            }
            return !fm.isWritableFile(atPath: existing.path) || !fm.isExecutableFile(atPath: existing.path)
        }
        if privileged && systemChecks && destination.path != "/Applications/声场档案.app" {throw InstallError("当前用户安装目录不可写，请修复目录权限或明确选择系统安装。")}
        _ = try io.run(executable, args, privileged: privileged)
    }
    var canRetry: Bool {
        guard let r = receipt else { return false }
        if hasPublishedReplacement(r) {
            // Button eligibility only; launch rechecks the full signature before proceeding.
            guard let info = try? AppInfo.read(destination, identifier: identifier) else { return false }
            return info.version == r.version && info.protocolVersion == 1
        }
        return ["installed", "starting", "completed"].contains(r.phase) && fm.fileExists(atPath: r.destination)
    }
    private func hasPublishedReplacement(_ r: InstallReceipt) -> Bool {
        r.phase == "replacing" && fm.fileExists(atPath: r.destination) && !fm.fileExists(atPath: r.staging)
    }
    private func canSupersede(_ r: InstallReceipt, with new: AppInfo) -> Bool {
        guard ["installed", "starting"].contains(r.phase) || hasPublishedReplacement(r),
              new.version.compare(r.version, options: .numeric) == .orderedDescending,
              let current = try? AppInfo.read(destination, identifier: identifier) else { return false }
        return current.version == r.version
    }
    @discardableResult
    private func resumePublishedReplacement() throws -> Bool {
        guard let r = receipt, hasPublishedReplacement(r) else { return false }
        try validateReceipt()
        let info = try verify(destination, expected: r.version)
        guard info.protocolVersion == 1 else { throw InstallError("已就位的应用不支持启动检测，已停止继续更新。") }
        // Recover the rename-before-journal window without making a new backup or
        // marking startup successful. The original backup and transaction stay intact.
        receipt!.phase = "installed"
        try save()
        return true
    }
    var canRestore: Bool {
        guard let r = receipt else { return false }
        if r.phase == "completed", r.formatVersion == 2, r.startupOutcome != nil { return false }
        return fm.fileExists(atPath: r.backup) || isRestoring(r)
    }
    private func isRestoring(_ r: InstallReceipt) -> Bool {
        ["restoring", "restoring_unpublished"].contains(r.phase)
    }
    func displacedApplication(_ r: InstallReceipt) -> URL {
        // Deterministic within the validated transaction; recoverable after either rename.
        URL(fileURLWithPath: r.backup).deletingLastPathComponent().appendingPathComponent("未启用的新版.app")
    }
    func attemptsDirectory(_ r: InstallReceipt) -> URL {
        logRoot.appendingPathComponent(r.session).appendingPathComponent("attempts")
    }
    func validateForRemoval(_ app:URL,version:String) throws {
        try InstallationLocation.rejectLinks(app)
        guard try AppInfo.read(app,identifier:identifier).version==version else{throw InstallError("清理材料身份发生变化")}
        if systemChecks {_ = try io.run("/usr/bin/codesign",["--verify","--deep","--strict",app.path],privileged:false)}
    }
    func executableDigest(_ app:URL) throws -> String {
        try InstallationLocation.rejectLinks(app)
        return SHA256.hash(data:try Data(contentsOf:app.appendingPathComponent("Contents/MacOS/music-manager"))).map{String(format:"%02x",$0)}.joined()
    }
    func verify(_ app: URL, expected: String? = nil, allowTranslatedBackup: Bool = false) throws -> AppInfo {
        try InstallationLocation.rejectLinks(app)
        let info = try AppInfo.read(app, identifier: identifier)
        if let expected = expected, info.version != expected { throw InstallError("复制后的应用版本不一致，已停止更新。") }
        if systemChecks {
            _ = try io.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path], privileged: false)
            let binary = app.appendingPathComponent("Contents/MacOS/music-manager")
            let arch = (try? io.run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], privileged: false))?.trimmingCharacters(in: .whitespacesAndNewlines) == "1" ? "arm64" : "x86_64"
            // lipo belongs to developer tools on some systems; /usr/bin/file is built in.
            let description = try io.run("/usr/bin/file", ["-b", binary.path], privileged: false)
            if !description.contains(arch) {
                guard allowTranslatedBackup, arch == "arm64", description.contains("x86_64") else {
                    throw InstallError("安装包不适合这台 Mac，请下载\(arch == "arm64" ? "Apple Silicon" : "Intel")版本。")
                }
                // Probe translation with a system binary, not the old app: executing
                // an old app before the schema check could open/migrate the library.
                do {
                    _ = try io.run("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], privileged: false)
                } catch {
                    throw InstallError("旧版是 Intel 应用，但当前无法通过 Rosetta 运行，已停止恢复。新版、旧版备份与音乐库均已保留。")
                }
            }
            let os = ProcessInfo.processInfo.operatingSystemVersion
            let current = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
            guard current.compare(info.minimumOS, options: .numeric) != .orderedAscending else {
                throw InstallError("此版本需要 macOS \(info.minimumOS) 或更新系统；当前系统为 \(current)。")
            }
        }
        return info
    }
    func validateInAppUpdate(version: String) throws {
        if let error = recoveryError { throw InstallError(error) }
        let new = try verify(source, expected: version)
        if let r = receipt, isRestoring(r) ||
            (["preparing", "replacing", "installed", "starting"].contains(r.phase) && fm.fileExists(atPath: r.backup) && !canSupersede(r, with: new)) {
            throw InstallError("上次更新尚未完成，请先在更新窗口恢复或处理旧版备份。当前应用继续运行。")
        }
        let old = try AppInfo.read(migrationSources.first ?? destination, identifier: identifier)
        guard new.protocolVersion == 1, new.version.compare(old.version, options: .numeric) == .orderedDescending else {
            throw InstallError("更新包必须支持启动检测，且版本高于当前已安装版本。")
        }
    }
    func prepare() throws {
        try acquireTargetLock()
        if cancelRequested(){throw InstallError("更新准备已取消")}
        if let error = recoveryError { throw InstallError(error) }
        try InstallationLocation.rejectLinks(destination)
        if let r = receipt, r.phase == "prepared" {
            _ = try verify(URL(fileURLWithPath: r.staging), expected: r.version)
            if let id=downloadTransaction,receipt!.transactionId != id {receipt!.transactionId=id;try save()}
            guard try AppInfo.read(source, identifier: identifier).version == r.version else { throw InstallError("已有其他版本的待安装事务，请先处理。") }
            return
        }
        if receipt?.phase == "completed", receipt?.cleanupPending == true {try cleanupCommitted()}
        if let r=receipt,r.phase=="failed_before_replace",r.cleanupPending==true {
            let stage=URL(fileURLWithPath:r.staging);try InstallationLocation.rejectLinks(stage)
            if fm.fileExists(atPath:stage.path){try operation("/bin/rm",["-rf",stage.path],writingTo:[stage.deletingLastPathComponent()])}
            receipt!.cleanupPending=false;try save()
        }
        let new = try verify(source)
        guard new.protocolVersion == 1 else { throw InstallError("这个安装包不支持启动检测，请下载带有“安装与更新”入口的新安装包。") }
        if let r = receipt, !canSupersede(r, with: new), try resumePublishedReplacement() { return }
        // An interrupted rename can leave no app at the destination. Recover before a new transaction.
        if let r = receipt, isRestoring(r) || (fm.fileExists(atPath: r.backup) && !fm.fileExists(atPath: r.destination)) {
            try restore()
        }
        if let r = receipt, ["preparing", "replacing", "installed", "starting"].contains(r.phase), fm.fileExists(atPath: r.backup), !canSupersede(r, with: new) {
            throw InstallError("上次更新尚未确认完成。请先点击“重新尝试启动”或“恢复旧版”，不要重复替换。")
        }
        if systemChecks {
            let enumerator=fm.enumerator(at:source,includingPropertiesForKeys:[.fileSizeKey,.isRegularFileKey])
            var expanded:Int64=0
            while let entry=enumerator?.nextObject() as? URL {let value=try entry.resourceValues(forKeys:[.fileSizeKey,.isRegularFileKey]);if value.isRegularFile==true {expanded += Int64(value.fileSize ?? 0)}}
            let attributes=try fm.attributesOfFileSystem(forPath:destination.deletingLastPathComponent().path)
            let available=(attributes[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
            guard available >= expanded + max(expanded/5,100*1024*1024) else{throw InstallError("目标磁盘空间不足，请释放空间后重试；当前应用未被替换。")}
        }
        progress("正在检查安装包、芯片架构和版本…")
        var old: AppInfo?
        if fm.fileExists(atPath: destination.path) {
            old = try AppInfo.read(destination, identifier: identifier)
            if new.version.compare(old!.version, options: .numeric) == .orderedAscending {
                throw InstallError("已安装 \(old!.version)，安装包为 \(new.version)。普通更新不支持降级，请使用“恢复旧版”。")
            }
        }
        var migrations = receipt?.migrationSources ?? []
        for origin in migrationSources where origin != destination && !migrations.contains(where: {$0.path == origin.path}) {
            migrations.append(try migrationIdentity(origin, maximumVersion: new.version))
        }
        for record in migrations where fm.fileExists(atPath: record.path) { try validateMigration(record) }
        let session = UUID().uuidString
        let parent = destination.deletingLastPathComponent()
        let previousTransaction=receipt?.session
        try archiveReceipt()
        receipt = InstallReceipt(session: session, destination: destination.path,
            backup: parent.appendingPathComponent(".music-manager-backups/\(session)/\(Self.appName)").path,
            staging: parent.appendingPathComponent(".music-manager-stage-\(session).app").path,
            version: new.version, previousVersion: old?.version, previousSchema: old?.rollbackSchema,
            diagnosticsSession: runDirectory.lastPathComponent,
            phase: "preparing", launched: false)
        receipt!.transactionId=downloadTransaction ?? session
        receipt!.migrationSources=migrations
        receipt!.previousTransaction=previousTransaction
        if old != nil {receipt!.previousDigest=try executableDigest(destination)}
        if let bytes=try? Data(contentsOf:source.appendingPathComponent("Contents/MacOS/music-manager")) {receipt!.packageDigest=SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined()}
        try save()
        progress("正在准备新版 \(new.version)，旧版将保留为备份…")
        do {
            let staging = URL(fileURLWithPath: receipt!.staging)
            try operation("/usr/bin/ditto", [source.path, staging.path], writingTo: [staging])
            _ = try verify(staging, expected: new.version)
            // Removing quarantine is restricted to this verified, newly staged application.
            try operation("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staging.path], writingTo: [staging])
            receipt!.phase = "prepared"; try save()
            if cancelRequested(){throw InstallError("更新准备已取消")}
        } catch {
            let original = error
            if let r = receipt, fm.fileExists(atPath: r.backup) {
                do { try restore() } catch {
                    throw InstallError("更新未完成，自动恢复也未完成。旧版备份仍在：\(r.backup)\n\(error.localizedDescription)\n请点击恢复旧版或导出诊断信息。")
                }
            } else {
                receipt!.phase = "failed_before_replace";receipt!.lastError=original.localizedDescription
                let stage=URL(fileURLWithPath:receipt!.staging)
                if fm.fileExists(atPath:stage.path) {
                    do {try InstallationLocation.rejectLinks(stage);try operation("/bin/rm",["-rf",stage.path],writingTo:[stage.deletingLastPathComponent()])}
                    catch{receipt!.cleanupPending=true}
                }
                try? save()
            }
            throw original
        }
    }
    func install() throws {
        try prepare()
        if cancelRequested(){throw InstallError("更新准备已取消")}
        guard let r = receipt else { throw InstallError("尚未准备安装") }
        if r.phase == "installed" { return }
        guard r.phase == "prepared" else { throw InstallError("安装事务尚未准备完成") }
        try InstallationLocation.rejectLinks(destination)
        if let previous = r.previousVersion {
            let actualDigest=try executableDigest(destination)
            guard try AppInfo.read(destination, identifier: identifier).version == previous, r.previousDigest == nil || actualDigest == r.previousDigest else { throw InstallError("安装目标在准备期间发生变化，已停止替换。") }
        } else if fm.fileExists(atPath: destination.path) { throw InstallError("目标位置出现了其他应用，已停止替换。") }
        _ = try verify(URL(fileURLWithPath: r.staging), expected: r.version)
        if let expected=r.packageDigest,try executableDigest(URL(fileURLWithPath:r.staging)) != expected {throw InstallError("暂存应用在准备后发生变化")}
        let parent = destination.deletingLastPathComponent()
        let staging = URL(fileURLWithPath: r.staging)
        let backupParent = URL(fileURLWithPath: r.backup).deletingLastPathComponent()
        do {
            progress("正在退出旧应用并安全替换…")
            for origin in r.migrationSources ?? [] {
                try validateMigration(origin)
                try io.stopApplication(at: URL(fileURLWithPath: origin.path))
            }
            try io.stopApplication(at: destination)
            receipt!.phase = "replacing"; try save()
            if r.previousVersion != nil {
                try operation("/bin/mkdir", ["-p", backupParent.path], writingTo: [backupParent])
                try operation("/bin/mv", [destination.path, receipt!.backup], writingTo: [parent, backupParent])
            }
            try operation("/bin/mv", [staging.path, destination.path], writingTo: [staging.deletingLastPathComponent(), parent])
            _ = try verify(destination, expected: r.version)
            receipt!.phase = "installed"; try save()
        } catch {
            let original = error
            if fm.fileExists(atPath: r.backup) { try restore() }
            throw original
        }
    }
    func cleanupCommitted() throws {
        try acquireTargetLock()
        guard let r = receipt, r.phase == "completed", r.startupOutcome != nil else { return }
        try validateReceipt()
        do {
            for path in [r.backup, r.staging, displacedApplication(r).path] where fm.fileExists(atPath: path) {
                let url = URL(fileURLWithPath: path)
                try InstallationLocation.rejectLinks(url)
                let expected=path==r.backup ? r.previousVersion : Optional(r.version)
                guard let expected=expected else{throw InstallError("清理材料缺少版本身份")}
                try validateForRemoval(url,version:expected)
                try operation("/bin/rm", ["-rf", path], writingTo: [url.deletingLastPathComponent()])
            }
            let parent = URL(fileURLWithPath: r.backup).deletingLastPathComponent()
            if fm.fileExists(atPath: parent.path), (try fm.contentsOfDirectory(atPath: parent.path)).isEmpty {
                try operation("/bin/rm", ["-rf",parent.path], writingTo:[parent.deletingLastPathComponent()])
            }
            try cleanupSuperseded(r.previousTransaction)
            for origin in r.migrationSources ?? [] where fm.fileExists(atPath: origin.path) {
                try validateMigration(origin)
                if systemChecks && NSRunningApplication.runningApplications(withBundleIdentifier: identifier).contains(where: {
                    !$0.isTerminated && $0.bundleURL?.resolvingSymlinksInPath() == URL(fileURLWithPath: origin.path).resolvingSymlinksInPath()
                }) { throw InstallError("旧应用仍在运行，安装已成功，稍后重试清理。") }
                // Never pass an arbitrary legacy path to the privileged worker.
                _ = try io.run("/bin/rm", ["-rf", origin.path], privileged: false)
            }
            receipt!.cleanupPending = false; receipt!.lastError = nil; try save()
        } catch {
            receipt!.cleanupPending = true; receipt!.lastError = error.localizedDescription; try? save()
            throw error
        }
    }
    private func migrationIdentity(_ origin: URL, maximumVersion: String) throws -> MigratedApplication {
        try InstallationLocation.rejectLinks(origin)
        // Foundation rewrites /private/tmp to /tmp; that system alias is not an unsafe source.
        guard origin.path.hasPrefix("/"), !origin.pathComponents.contains(".."), origin.lastPathComponent == Self.appName,
              origin != destination, origin != source,
              !origin.path.hasPrefix("/Volumes/"), !origin.pathComponents.contains("target"),
              !origin.pathComponents.dropLast().contains(where: {$0.hasSuffix(".app")}),
              !origin.path.hasPrefix(destination.path + "/"), !destination.path.hasPrefix(origin.path + "/") else {
            throw InstallError("旧应用迁移来源无效，已停止操作。")
        }
        let info = try AppInfo.read(origin, identifier: identifier)
        guard info.version.compare(maximumVersion, options: .numeric) != .orderedDescending else {throw InstallError("旧位置存在更高版本，已停止降级。")}
        try validateForRemoval(origin, version: info.version)
        let attrs = try fm.attributesOfItem(atPath: origin.path)
        guard attrs[.type] as? FileAttributeType == .typeDirectory,
              let device = attrs[.systemNumber] as? NSNumber, let inode = attrs[.systemFileNumber] as? NSNumber else {throw InstallError("无法确认旧应用文件身份。")}
        return MigratedApplication(path: origin.path, version: info.version, digest: try executableDigest(origin), device: device.uint64Value, inode: inode.uint64Value)
    }
    private func validateMigration(_ record: MigratedApplication) throws {
        let current = try migrationIdentity(URL(fileURLWithPath:record.path), maximumVersion:record.version)
        guard current.version == record.version, current.digest == record.digest, current.device == record.device, current.inode == record.inode else {
            throw InstallError("旧应用在更新期间发生变化，已保留该副本，请检查后重试。")
        }
    }
    private func cleanupSuperseded(_ first:String?) throws {
        var next=first;var seen=Set<String>()
        while let session=next,UUID(uuidString:session) != nil,seen.insert(session).inserted {
            let path=stateRoot.appendingPathComponent("transactions/"+session+".json")
            try InstallationLocation.rejectLinks(path)
            guard let data=try? Data(contentsOf:path),var old=try? JSONDecoder().decode(InstallReceipt.self,from:data),
                  old.destination==destination.path,old.session==session else{return}
            let parent=destination.deletingLastPathComponent()
            guard old.backup==parent.appendingPathComponent(".music-manager-backups/\(session)/声场档案.app").path,
                  old.staging==parent.appendingPathComponent(".music-manager-stage-\(session).app").path,
                  !["restoring","restoring_unpublished"].contains(old.phase) else{throw InstallError("先前恢复事务仍需人工处理")}
            for (value,version) in [(old.backup,old.previousVersion),(old.staging,Optional(old.version)),(displacedApplication(old).path,Optional(old.version))] {
                let file=URL(fileURLWithPath:value)
                if fm.fileExists(atPath:value) {
                    guard let version=version else{throw InstallError("先前事务材料身份不明")}
                    try validateForRemoval(file,version:version)
                    try operation("/bin/rm",["-rf",value],writingTo:[file.deletingLastPathComponent()])
                }
            }
            old.phase="superseded";old.cleanupPending=false
            try persistState(JSONEncoder().encode(old),name:"transactions/"+session+".json")
            next=old.previousTransaction
        }
    }
    func launch(timeout: TimeInterval = 45) throws -> StartupResult {
        try acquireTargetLock()
        try resumePublishedReplacement()
        guard let r = receipt, canRetry else { throw InstallError("请先完成安装或恢复旧版。") }
        _ = try verify(destination, expected: r.version)
        try io.stopApplication(at: destination)
        // A new token and expected PID prevent a previous successful launch masking a crash.
        let token = UUID().uuidString
        let attempt = attemptsDirectory(r).appendingPathComponent(token)
        try fm.createDirectory(at: attempt, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let status = attempt.appendingPathComponent("startup.json")
        let metadata = ["session": token, "version": r.version, "startedAt": ISO8601DateFormatter().string(from: Date())]
        try JSONEncoder().encode(metadata).write(to: attempt.appendingPathComponent("attempt.json"), options: .atomic)
        let task = Process()
        task.executableURL = destination.appendingPathComponent("Contents/MacOS/music-manager")
        task.currentDirectoryURL = destination.deletingLastPathComponent()
        var environment = ProcessInfo.processInfo.environment
        environment["MUSIC_MANAGER_STARTUP_REPORT"] = status.path
        environment["MUSIC_MANAGER_STARTUP_PATH_CHECK"] = "1"
        environment["MUSIC_MANAGER_STARTUP_SESSION"] = token
        task.environment = environment
        let output = attempt.appendingPathComponent("application.log")
        appLog?.closeFile()
        fm.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
        appLog = try FileHandle(forWritingTo: output)
        task.standardOutput = appLog; task.standardError = appLog
        receipt!.phase = "starting"; receipt!.launched = true
        receipt!.diagnosticsSession = runDirectory.lastPathComponent
        try save()
        progress("正在启动新版，等待应用回报状态…")
        do {
            try task.run()
            launchedProcess = task
            let deadline = Date().addingTimeInterval(timeout)
            var firstResult: (StartupResult, Date)?
            while Date() < deadline {
                let result = try evaluateStartup(try? Data(contentsOf: status), session: token,
                                                 version: r.version, pid: task.processIdentifier, running: task.isRunning, applicationPath: destination.path)
                if let result = result {
                    if result == .cancelled || (firstResult?.0 == result && Date().timeIntervalSince(firstResult!.1) >= 2) {
                        receipt!.phase = "completed"; receipt!.startupOutcome = String(describing: result)
                        receipt!.cleanupPending = true; try save()
                        do { try cleanupCommitted(); progress(result.message) }
                        catch { progress(result.message + "\n安装成功；清理尚未完成，可稍后重试。") }
                        try releaseTargetLock()
                        return result
                    }
                    if firstResult?.0 != result { firstResult = (result, Date()) }
                } else { firstResult = nil }
                Thread.sleep(forTimeInterval: 0.2)
            }
            throw InstallError("应用仍在运行，但尚未确认启动完成。可先查看应用窗口，再重新尝试启动或导出诊断信息；不会强制结束进程或自动降级。")
        } catch {
            try? error.localizedDescription.write(to: attempt.appendingPathComponent("error.txt"), atomically: true, encoding: .utf8)
            throw error
        }
    }
    func restore() throws {
        try acquireTargetLock()
        if receipt?.phase == "completed", receipt?.formatVersion == 2, receipt?.startupOutcome != nil {throw InstallError("安装已确认成功，旧版不再用于恢复。请使用修复安装。 ")}
        guard let r = receipt else { throw InstallError("没有可恢复的旧版备份。") }
        try validateReceipt()
        let backup = URL(fileURLWithPath: r.backup)
        let displaced = displacedApplication(r)
        if !fm.fileExists(atPath: r.backup) {
            // The old app was already moved back, but the completion record wasn't saved.
            guard isRestoring(r), let previous = r.previousVersion else {
                throw InstallError("没有可恢复的旧版备份。")
            }
            let info = try AppInfo.read(destination, identifier: identifier)
            guard info.version == previous else {
                throw InstallError("恢复后的应用与更新记录不一致，已停止操作。")
            }
            if r.phase == "restoring" { _ = try verify(destination, expected: previous, allowTranslatedBackup: true) }
            receipt!.phase = "restored"; try save()
            progress("已确认旧版 \(previous) 恢复完成。音乐库未被替换。")
            try releaseTargetLock()
            return
        }
        let backupInfo = try AppInfo.read(backup, identifier: identifier)
        guard backupInfo.version == r.previousVersion else { throw InstallError("旧版备份与更新记录不一致，已停止恢复。") }
        progress("正在检查旧版和音乐库兼容性…")
        try io.stopApplication(at: destination)
        if let task = launchedProcess, task.isRunning {
            throw InstallError("新版进程还没有退出，请先退出声场档案，再恢复旧版。")
        }
        // Only a staged app that has not been moved into place proves it wasn't published.
        // `launched == false` alone says nothing about launches from Finder.
        let unpublished = r.phase == "restoring_unpublished" ||
            (r.phase == "replacing" && !r.launched &&
             fm.fileExists(atPath: r.staging) && !fm.fileExists(atPath: r.destination))
        if !unpublished {
            _ = try verify(backup, expected: r.previousVersion, allowTranslatedBackup: true)
            guard let supported = backupInfo.rollbackSchema else {
                throw InstallError("旧版缺少可确认的数据库兼容性和启动保护，不能自动恢复。旧版备份与音乐库均已保留，请导出诊断信息。")
            }
            // A damaged installed binary must not prevent checking the untouched DB.
            // Fall back only to an independently verified payload; never skip the check.
            var checker: URL?
            var candidates = [destination]
            if isRestoring(r) { candidates.append(displaced) }
            candidates.append(source)
            for candidate in candidates {
                guard let info = try? verify(candidate), info.protocolVersion == 1,
                      info.version == r.version || (candidate == source && info.version.compare(r.version, options: .numeric) == .orderedDescending) else { continue }
                checker = candidate
                break
            }
            guard let checker = checker else { throw InstallError("没有可安全执行数据库兼容性检查的应用，请重新下载本版或更新版本的安装包。音乐库和旧版备份已保留。") }
            _ = try io.run(checker.appendingPathComponent("Contents/MacOS/music-manager").path,
                           ["--installer-check-rollback", String(supported)], privileged: false)
        }
        let hadNew = fm.fileExists(atPath: destination.path)
        if hadNew && fm.fileExists(atPath: displaced.path) {
            throw InstallError("恢复暂存位置已有应用，已停止操作以保留所有副本。请导出诊断信息。")
        }
        // Journal BEFORE either rename. Both paths are recoverable without a completion write.
        receipt!.phase = unpublished ? "restoring_unpublished" : "restoring"
        try save()
        let parent = destination.deletingLastPathComponent()
        if hadNew { try operation("/bin/mv", [destination.path, displaced.path], writingTo: [parent, displaced.deletingLastPathComponent()]) }
        try operation("/bin/mv", [r.backup, destination.path], writingTo: [backup.deletingLastPathComponent(), parent])
        receipt!.phase = "restored"; try save()
        progress("已恢复旧版 \(backupInfo.version)。音乐库未被替换。请从应用程序中打开声场档案。")
        try releaseTargetLock()
    }
    func historicalResidue() -> [URL] {
        var records:[InstallReceipt]=[]
        let roots=Array(Set([logRoot,stateRoot]))
        for root in roots {
            let entries=((try? fm.contentsOfDirectory(at:root.appendingPathComponent("transactions"),includingPropertiesForKeys:nil)) ?? []) + [root.appendingPathComponent("latest.json")]
            for entry in entries {
                guard (try? InstallationLocation.rejectLinks(entry)) != nil,
                      let data=try? Data(contentsOf:entry),let r=try? JSONDecoder().decode(InstallReceipt.self,from:data),
                      r.destination==destination.path,UUID(uuidString:r.session) != nil,["completed","restored"].contains(r.phase),
                      r.backup==destination.deletingLastPathComponent().appendingPathComponent(".music-manager-backups/\(r.session)/声场档案.app").path,
                      r.staging==destination.deletingLastPathComponent().appendingPathComponent(".music-manager-stage-\(r.session).app").path else {continue}
                records.append(r)
            }
        }
        var result=Set<URL>()
        for r in records {
            for (path,version) in [(r.backup,r.previousVersion),(r.staging,Optional(r.version)),(displacedApplication(r).path,Optional(r.version))] {
                let url=URL(fileURLWithPath:path)
                if let version=version,(try? validateForRemoval(url,version:version)) != nil {result.insert(url)}
            }
        }
        return result.sorted{$0.path<$1.path}
    }
    func cleanHistoricalResidue(_ approved:[URL]) throws {
        let verified=Set(historicalResidue())
        for path in approved {
            guard verified.contains(path) else{throw InstallError("历史清理清单发生变化，请重新检查。")}
            try InstallationLocation.rejectLinks(path)
            try operation("/bin/rm",["-rf",path.path],writingTo:[path.deletingLastPathComponent()])
        }
    }
    func maintainEvidence(now:Date=Date()) throws {
        var protected=Set([runDirectory.lastPathComponent,receipt?.diagnosticsSession ?? "",receipt?.session ?? ""])
        for entry in (try? fm.contentsOfDirectory(at:stateRoot.appendingPathComponent("transactions"),includingPropertiesForKeys:nil)) ?? [] {
            guard (try? InstallationLocation.rejectLinks(entry)) != nil,let data=try? Data(contentsOf:entry),let old=try? JSONDecoder().decode(InstallReceipt.self,from:data) else{continue}
            if !old.finished || old.cleanupPending==true {protected.insert(old.session);protected.insert(old.diagnosticsSession)}
        }
        let logs=(try fm.contentsOfDirectory(at:logRoot,includingPropertiesForKeys:[.contentModificationDateKey])).filter{path in
            guard UUID(uuidString:path.lastPathComponent) != nil,!protected.contains(path.lastPathComponent),(try? InstallationLocation.rejectLinks(path)) != nil,
                  let bytes=try? Data(contentsOf:path.appendingPathComponent("run-owner.json")),let owner=try? JSONSerialization.jsonObject(with:bytes) as? [String:Any] else{return false}
            return owner["identifier"] as? String==identifier && owner["run"] as? String==path.lastPathComponent && owner["logRoot"] as? String==logRoot.path
        }
            .sorted{((try? $0.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast)}
        var bytes=logs.reduce(Int64(0)){$0+InstallationLocation.byteSize($1)}
        for log in logs {
            try InstallationLocation.rejectLinks(log)
            let date=(try? log.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? now
            if now.timeIntervalSince(date)>30*86400 || bytes>100*1024*1024 {
                let size=InstallationLocation.byteSize(log);try fm.removeItem(at:log);bytes -= size
            }
        }
        let directory=stateRoot.appendingPathComponent("transactions")
        let entries=(try? fm.contentsOfDirectory(at:directory,includingPropertiesForKeys:[.contentModificationDateKey])) ?? []
        let terminal=entries.filter{entry in
            guard UUID(uuidString:entry.deletingPathExtension().lastPathComponent) != nil,entry.pathExtension=="json",
                  let data=try? Data(contentsOf:entry),let record=try? JSONDecoder().decode(InstallReceipt.self,from:data),record.session==entry.deletingPathExtension().lastPathComponent,
                  record.destination==destination.path else{return false}
            return record.finished && record.cleanupPending != true && record.session != receipt?.session
        }.sorted{((try? $0.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast)}
        if stateRoot.path.hasPrefix("/Library/") {try privilegedInstallerAction(["action":"prune-state"])}
        // System records are pruned only by the bounded elevated worker.
        for entry in terminal.dropLast(20) where !stateRoot.path.hasPrefix("/Library/") {try InstallationLocation.rejectLinks(entry);try fm.removeItem(at:entry)}
    }
    func exportDiagnostics(to output: URL) throws {
        // Export only this installer session plus the most recent transaction.
        // Do not include settings.json, database, audio, or the entire user log directory.
        let bundle = runDirectory.appendingPathComponent("diagnostics-\(UUID().uuidString)")
        try fm.createDirectory(at: bundle, withIntermediateDirectories: false)
        defer { try? fm.removeItem(at: bundle) }
        for name in ["installer.log", "application.log", "startup.json", "transaction.json", "error.txt"] {
            if let data = try? Data(contentsOf: runDirectory.appendingPathComponent(name)) {
                try Data(data.suffix(2_000_000)).write(to: bundle.appendingPathComponent(name))
            }
        }
        if let data = try? Data(contentsOf: logRoot.appendingPathComponent("latest.json")) {
            try data.write(to: bundle.appendingPathComponent("latest-transaction.json"))
        }
        for name in ["latest.json", "previous.json"] {
            let path = stateRoot.appendingPathComponent(name)
            if (try? InstallationLocation.rejectLinks(path)) != nil, let data = try? Data(contentsOf: path) {
                try Data(data.suffix(2_000_000)).write(to: bundle.appendingPathComponent("state-" + name))
            }
        }
        if let previous = receipt?.diagnosticsSession, UUID(uuidString: previous) != nil,
           previous != runDirectory.lastPathComponent {
            for name in ["installer.log", "application.log", "startup.json", "transaction.json", "error.txt"] {
                if let data = try? Data(contentsOf: logRoot.appendingPathComponent(previous).appendingPathComponent(name)) {
                    try Data(data.suffix(2_000_000)).write(to: bundle.appendingPathComponent("上次-" + name))
                }
            }
        }
        if let r = receipt {
            let attempts = attemptsDirectory(r)
            let entries = (try? fm.contentsOfDirectory(at: attempts, includingPropertiesForKeys: nil)) ?? []
            for entry in entries where UUID(uuidString: entry.lastPathComponent) != nil {
                let target = bundle.appendingPathComponent("启动记录").appendingPathComponent(entry.lastPathComponent)
                try fm.createDirectory(at: target, withIntermediateDirectories: true)
                for name in ["application.log", "startup.json", "attempt.json", "error.txt"] {
                    if let data = try? Data(contentsOf: entry.appendingPathComponent(name)) {
                        try Data(data.suffix(2_000_000)).write(to: target.appendingPathComponent(name))
                    }
                }
            }
        }
        let reportDirectory = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/DiagnosticReports")
        let reports = (try? fm.contentsOfDirectory(at: reportDirectory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let matching = reports.filter { $0.lastPathComponent.hasPrefix("music-manager") && ["ips", "crash"].contains($0.pathExtension) }
            .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        if let newest = matching.first, let data = try? Data(contentsOf: newest), data.count < 5_000_000 {
            try data.write(to: bundle.appendingPathComponent(newest.lastPathComponent))
        }
        try "系统：\(ProcessInfo.processInfo.operatingSystemVersionString)\n诊断文件可能包含本机路径和系统崩溃报告，请仅发给你信任的开发者。\n".write(to: bundle.appendingPathComponent("说明.txt"), atomically: true, encoding: .utf8)
        _ = try io.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle.path, output.path], privileged: false)
    }
}

func exportUpdateFailure(_ message: String, installer: Installer?, logRoot: URL) throws -> URL {
    let directory = installer?.runDirectory ?? logRoot.appendingPathComponent(UUID().uuidString)
    try InstallationLocation.rejectLinks(directory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try durableWrite(Data(message.utf8), to: directory.appendingPathComponent("error.txt"))
    let output = directory.appendingPathComponent("声场档案更新诊断.zip")
    if let installer = installer {
        try installer.exportDiagnostics(to: output)
    } else {
        // Initialization may fail before an Installer exists (e.g. authorization).
        // Still produce a usable report without acquiring an installation lock.
        let bundle = directory.appendingPathComponent("failure-report")
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: bundle) }
        try durableWrite(Data(message.utf8), to: bundle.appendingPathComponent("error.txt"))
        try durableWrite(Data("系统：\(ProcessInfo.processInfo.operatingSystemVersionString)\n安装器初始化失败；未收集音乐库或音频。".utf8), to: bundle.appendingPathComponent("说明.txt"))
        _ = try SystemIO(log: {_ in}).run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle.path, output.path])
    }
    return output
}

// The elevated process accepts a closed set of installer actions, never arbitrary shell text.
// It does not launch the application or open its music library.
private var workerOwnedLock:Int32 = -1
func runInstallerWorker(_ arguments: [String]) throws {
    guard geteuid() == 0, arguments.count == 1,
          let data = Data(base64Encoded: arguments[0]),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let action = request["action"] as? String else { throw InstallError("提权请求无效") }
    let fm = FileManager.default
    let target = URL(fileURLWithPath: "/Applications/声场档案.app")
    let state = URL(fileURLWithPath: "/Library/Application Support/com.musicmanager.installer/system")
    try InstallationLocation.rejectLinks(target); try InstallationLocation.rejectLinks(state)
    if action == "prepare-system" {
        try fm.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions:0o755])
        for directory in [state.deletingLastPathComponent(),state] {
            let attrs=try fm.attributesOfItem(atPath:directory.path)
            guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value==0,((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o022 == 0 else{throw InstallError("系统安装状态目录权限异常")}
        }
        let lock = state.appendingPathComponent("target.lock")
        try InstallationLocation.rejectLinks(lock)
        let fd = Darwin.open(lock.path, O_CREAT | O_RDONLY | O_NOFOLLOW, 0o644)
        guard fd >= 0 else { throw InstallError("无法创建系统安装锁") }; Darwin.close(fd)
        let attrs=try fm.attributesOfItem(atPath:lock.path)
        guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value==0,((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o022 == 0 else{throw InstallError("系统安装锁权限异常")}
        if workerOwnedLock<0 {
            let fd=Darwin.open(lock.path,O_RDONLY|O_NOFOLLOW)
            guard fd>=0,flock(fd,LOCK_EX|LOCK_NB)==0 else{if fd>=0{Darwin.close(fd)};throw InstallError("另一账户或安装窗口正在更新目标应用")}
            workerOwnedLock=fd
        }
        return
    }
    if action=="release-target" {
        if workerOwnedLock>=0{flock(workerOwnedLock,LOCK_UN);Darwin.close(workerOwnedLock);workerOwnedLock = -1}
        return
    }
    guard workerOwnedLock>=0 else{throw InstallError("系统安装操作尚未持有目标锁")}
    if action == "prune-state" {
        let directory=state.appendingPathComponent("transactions")
        try InstallationLocation.rejectLinks(directory)
        let current=(try? Data(contentsOf:state.appendingPathComponent("latest.json"))).flatMap{try? JSONDecoder().decode(InstallReceipt.self,from:$0)}
        let files=(try? fm.contentsOfDirectory(at:directory,includingPropertiesForKeys:[.contentModificationDateKey])) ?? []
        let terminal=files.filter{path in
            guard UUID(uuidString:path.deletingPathExtension().lastPathComponent) != nil,path.pathExtension=="json",(try? InstallationLocation.rejectLinks(path)) != nil,
                  let data=try? Data(contentsOf:path),let r=try? JSONDecoder().decode(InstallReceipt.self,from:data),r.destination==target.path,
                  r.session==path.deletingPathExtension().lastPathComponent,r.session != current?.session else{return false}
            return (r.finished || r.phase=="superseded") && r.cleanupPending != true
        }.sorted{((try? $0.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate) ?? .distantPast)}
        for path in terminal.dropLast(20){try fm.removeItem(at:path)}
        return
    }
    if action == "write-state" {
        guard let name = request["name"] as? String,
              name == "latest.json" || name == "previous.json" || (name.hasPrefix("transactions/") && UUID(uuidString: String(name.dropFirst(13).dropLast(5))) != nil && name.hasSuffix(".json")),
              let encoded = request["data"] as? String, let bytes = Data(base64Encoded: encoded),
              let receipt = try? JSONDecoder().decode(InstallReceipt.self, from: bytes),
              receipt.destination == target.path, UUID(uuidString: receipt.session) != nil,
              receipt.backup == "/Applications/.music-manager-backups/\(receipt.session)/声场档案.app",
              receipt.staging == "/Applications/.music-manager-stage-\(receipt.session).app" else { throw InstallError("系统事务记录无效") }
        let path = state.appendingPathComponent(name)
        try InstallationLocation.rejectLinks(path)
        try fm.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true, attributes:[.posixPermissions:0o755])
        try durableWrite(bytes, to:path); return
    }
    guard action == "file-operation", let executable = request["executable"] as? String,
          let args = request["arguments"] as? [String] else { throw InstallError("未知提权操作") }
    func managed(_ path: String, includeTarget: Bool = false) -> Bool {
        if includeTarget && path == target.path { return true }
        let url = URL(fileURLWithPath:path).standardizedFileURL
        if url.path != path { return false }
        let parts = url.pathComponents
        if parts.count == 3 && parts[1] == "Applications", parts[2].hasPrefix(".music-manager-stage-"), parts[2].hasSuffix(".app") {
            return UUID(uuidString:String(parts[2].dropFirst(21).dropLast(4))) != nil
        }
        if parts.count >= 4 && parts.count <= 5 && parts[1] == "Applications" && parts[2] == ".music-manager-backups" && UUID(uuidString:parts[3]) != nil {
            return parts.count == 4 || ["声场档案.app","未启用的新版.app"].contains(parts[4])
        }
        return false
    }
    switch executable {
    case "/usr/bin/ditto":
        guard args.count == 2, managed(args[1]), URL(fileURLWithPath:args[1]).lastPathComponent.hasPrefix(".music-manager-stage-") else { throw InstallError("暂存请求无效") }
        let source = URL(fileURLWithPath:args[0]); try InstallationLocation.rejectLinks(source)
        _ = try AppInfo.read(source)
        _ = try SystemIO(log:{_ in}).run("/usr/bin/codesign",["--verify","--deep","--strict",source.path])
    case "/bin/mv":
        guard args.count == 2, args.allSatisfy({managed($0,includeTarget:true)}) else { throw InstallError("替换请求无效") }
        _ = try AppInfo.read(URL(fileURLWithPath:args[0]))
    case "/bin/mkdir":
        guard args.count == 2, args[0] == "-p", managed(args[1]) else { throw InstallError("目录请求无效") }
    case "/bin/rm":
        guard args.count == 2, args[0] == "-rf", managed(args[1]) else { throw InstallError("清理请求无效") }
    case "/usr/bin/xattr":
        guard args.count == 3, args[0] == "-dr", args[1] == "com.apple.quarantine", managed(args[2]) else { throw InstallError("隔离属性请求无效") }
    default: throw InstallError("不允许的提权操作")
    }
    for path in args where path.hasPrefix("/") { try InstallationLocation.rejectLinks(URL(fileURLWithPath:path)) }
    _ = try SystemIO(log:{_ in}).run(executable,args)
}

// One authorization per installer process; the short-lived worker exits with its parent.
final class InstallerWorkerSession {
    let root: URL
    let task = Process()
    var sequence = 0
    var poisoned=false
    let lock = NSLock()
    init() throws {
        root = URL(fileURLWithPath:"/private/tmp").appendingPathComponent("music-manager-worker-" + UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let request:[String:Any] = ["root":root.path,"uid":getuid(),"pid":getpid()]
        let encoded = try JSONSerialization.data(withJSONObject:request).base64EncodedString()
        guard let executable = Bundle.main.executableURL?.path else {throw InstallError("无法定位安装执行器")}
        let command = [executable,"--installer-worker-session",encoded].map(SystemIO.shellQuote).joined(separator:" ")
        task.executableURL = URL(fileURLWithPath:"/usr/bin/osascript")
        task.arguments = ["-e","on run argv\n do shell script (item 1 of argv) with administrator privileges\nend run",command]
        task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
        try task.run()
    }
    func perform(_ request:[String:Any]) throws {
        lock.lock();defer{lock.unlock()}
        guard !poisoned else{throw InstallError("执行器状态未确认，请关闭安装窗口后重试。 ")}
        sequence += 1
        let input=root.appendingPathComponent("request-\(sequence).json")
        let output=root.appendingPathComponent("reply-\(sequence).json")
        try durableWrite(JSONSerialization.data(withJSONObject:request),to:input)
        let deadline=Date().addingTimeInterval(120)
        while Date()<deadline {
            if let data=try? Data(contentsOf:output),let reply=try? JSONSerialization.jsonObject(with:data) as? [String:Any] {
                try? FileManager.default.removeItem(at:input);try? FileManager.default.removeItem(at:output)
                if let error=reply["error"] as? String {throw InstallError(error)}
                return
            }
            if !task.isRunning {throw InstallError("管理员授权已取消或安装执行器退出，请重新打开安装器后重试。")}
            Thread.sleep(forTimeInterval:0.05)
        }
        poisoned=true
        // Do not continue with a worker that may still be changing files.
        throw InstallError("安装执行器超时，请等待执行器退出后重新打开安装窗口。")
    }
    deinit {
        try? Data().write(to:root.appendingPathComponent("stop"))
        // The worker removes its own request directory only after all work stops.
        if !task.isRunning {try? FileManager.default.removeItem(at:root)}
    }
}
private var workerSession: InstallerWorkerSession?
private let workerSessionLock = NSLock()
func privilegedInstallerAction(_ request: [String:Any]) throws {
    workerSessionLock.lock();defer{workerSessionLock.unlock()}
    if workerSession == nil {workerSession = try InstallerWorkerSession()}
    try workerSession!.perform(request)
}
func runInstallerWorkerSession(_ encoded:String) throws {
    guard geteuid()==0,let bytes=Data(base64Encoded:encoded),let info=try JSONSerialization.jsonObject(with:bytes) as? [String:Any],
          let path=info["root"] as? String,let uid=info["uid"] as? UInt32,let pid=info["pid"] as? Int32,
          pid>1,URL(fileURLWithPath:path).deletingLastPathComponent().path=="/private/tmp",
          UUID(uuidString:String(URL(fileURLWithPath:path).lastPathComponent.dropFirst(21))) != nil else {throw InstallError("安装会话无效")}
    let root=URL(fileURLWithPath:path);try InstallationLocation.rejectLinks(root)
    let attrs=try FileManager.default.attributesOfItem(atPath:path)
    guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value==uid,(attrs[.posixPermissions] as? NSNumber)?.intValue==0o700 else {throw InstallError("安装会话权限异常")}
    defer{try? FileManager.default.removeItem(at:root)}
    var sequence=1
    let expires=Date().addingTimeInterval(900)
    while Date()<expires && FileManager.default.fileExists(atPath:root.path) && Darwin.kill(pid,0)==0 && !FileManager.default.fileExists(atPath:root.appendingPathComponent("stop").path) {
        let input=root.appendingPathComponent("request-\(sequence).json")
        if FileManager.default.fileExists(atPath:input.path) {
            var reply:[String:Any]=["ok":true]
            do {try InstallationLocation.rejectLinks(input);let data=try Data(contentsOf:input);try runInstallerWorker([data.base64EncodedString()])}
            catch{reply=["error":error.localizedDescription]}
            try durableWrite(JSONSerialization.data(withJSONObject:reply),to:root.appendingPathComponent("reply-\(sequence).json"));sequence += 1
        } else {Thread.sleep(forTimeInterval:0.05)}
    }
}

func closeInstallerWorker() { workerSession = nil }
