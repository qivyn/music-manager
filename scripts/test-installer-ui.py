"""Local macOS window regression; never configures or executes an installation."""
import pathlib
import subprocess
import tempfile

repo = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='music-manager-installer-ui-test-', dir='/private/tmp') as tmp:
    root = pathlib.Path(tmp)
    source = (repo/'scripts/macos-installer/main.swift').read_text()
    source = source.replace('        configureInstaller()\n', '        // Skip installation discovery in this window-only test.\n', 1)
    source = source[:source.rindex('let delegate = InstallerDelegate()')]
    source += '''
let app = NSApplication.shared
let delegate = InstallerDelegate()
delegate.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
let buttons = delegate.window.contentView!.subviews.compactMap { $0 as? NSButton }
let expected = ["安装 / 更新", "重新尝试启动", "恢复旧版", "导出诊断信息"]
guard buttons.filter({$0.frame.minY == 25}).map({$0.title}) == expected else {
    fputs("FAIL: bottom row must retain the original four actions\\n", stderr); exit(1)
}
guard buttons.count == 4 else {
    fputs("FAIL: default installer must expose only four actions\\n", stderr); exit(1)
}
guard app.mainMenu?.items.contains(where: {$0.title == "工具"}) == false else {exit(1)}
let labels = delegate.window.contentView!.subviews.compactMap { $0 as? NSTextField }
guard !labels.contains(where: {$0.stringValue.contains("安装位置")}) else {exit(1)}
delegate.window.close()
print("4 installer window checks passed")
'''
    (root/'main.swift').write_text(source)
    subprocess.run(['xcrun','swiftc','-swift-version','5','-module-cache-path',str(pathlib.Path('/private/tmp/music-manager-swift-cache')),str(repo/'scripts/macos-installer/InstallerCore.swift'),str(root/'main.swift'),'-o',str(root/'test')],check=True)
    subprocess.run([str(root/'test')],check=True)
