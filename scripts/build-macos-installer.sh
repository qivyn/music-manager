#!/bin/bash
# Build-time only: users don't need Swift, Python, Node, or a terminal.
set -euo pipefail
[[ $# == 2 ]] || { echo '用法：build-macos-installer.sh /path/声场档案.app /path/output.dmg' >&2; exit 64; }
source_app="$1"
output_dmg="$2"
[[ -d "$source_app" && "$output_dmg" == /* && ! -e "$output_dmg" ]] || { echo '需要有效的 App、绝对输出路径且目标尚不存在' >&2; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/music-manager-package.XXXXXX")"
trap 'rm -rf "$work"' EXIT
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$source_app/Contents/Info.plist")"
/usr/bin/codesign --verify --deep --strict "$source_app"
python3 - "$source_app/Contents/Info.plist" "$script_dir/../src-tauri/src/db.rs" <<'PYMETA'
import plistlib,re,sys
with open(sys.argv[1],'rb') as f: info=plistlib.load(f)
with open(sys.argv[2]) as f: schema=int(re.search(r'const SCHEMA_VERSION: i64 = (\d+);',f.read()).group(1))
assert info.get('CFBundleIdentifier') == 'com.musicmanager.app', 'Not the production app'
assert info.get('MusicManagerStartupProtocol') == 1, 'Startup handshake missing'
assert info.get('MusicManagerDatabaseSchema') == schema, 'Database schema metadata mismatch'
PYMETA
archs="$(/usr/bin/lipo -archs "$source_app/Contents/MacOS/music-manager")"
case "$archs" in
  arm64) target='arm64-apple-macos11.0' ;;
  x86_64) target='x86_64-apple-macos10.15' ;;
  *) echo "请为每个架构分别构建安装包：$archs" >&2; exit 1 ;;
esac
installer="$work/image/安装与更新声场档案.app"
mkdir -p "$installer/Contents/MacOS" "$installer/Contents/Resources" "$work/modules"
xcrun swiftc -swift-version 5 -O -target "$target" -module-cache-path "$work/modules" \
  "$script_dir/macos-installer/InstallerCore.swift" "$script_dir/macos-installer/main.swift" \
  -o "$installer/Contents/MacOS/music-manager-installer"
/usr/bin/ditto "$source_app" "$installer/Contents/Resources/声场档案.app"
cp "$source_app/Contents/Resources/icon.icns" "$installer/Contents/Resources/icon.icns"
python3 - "$installer/Contents/Info.plist" "$version" <<'PY'
import plistlib,sys
with open(sys.argv[1],'wb') as f:
 plistlib.dump({'CFBundleIdentifier':'com.musicmanager.installer','CFBundleName':'安装与更新声场档案','CFBundleDisplayName':'安装与更新声场档案','CFBundleExecutable':'music-manager-installer','CFBundlePackageType':'APPL','CFBundleShortVersionString':sys.argv[2],'CFBundleVersion':sys.argv[2],'CFBundleIconFile':'icon.icns','LSMinimumSystemVersion':'10.15','NSHighResolutionCapable':True,'MusicManagerInAppUpdateProtocol':1,'MusicManagerInstallerProtocol':2},f)
PY
cat > "$work/image/请先阅读.txt" <<'EOF'
双击“安装与更新声场档案”，然后点击“安装 / 更新”。无需运行命令。
统一安装到系统“应用程序”；确认新版启动成功后清理已验证的旧位置副本。
遇到问题时，在安装窗口中选择“重新尝试启动”“恢复旧版”或“导出诊断信息”。
音乐库与音频独立保留。恢复旧版只恢复应用，会先检查数据库兼容性。
确认成功后清理旧版。尚未完成的更新可在安装窗口重试、恢复或导出诊断。
这是免费临时签名的安装包。若 macOS 首次阻止打开，请到“系统设置 → 隐私与安全性”允许打开。
EOF
/usr/bin/codesign --force --sign - "$installer"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$installer"
# Keep candidates beside the destination so a verified image can be published
# atomically without overwriting another build's output. Failed attempts never
# occupy the final filename, including hdiutil's partially written images.
dmg_work="$(mktemp -d "$(dirname "$output_dmg")/.music-manager-dmg.XXXXXX")"
trap 'rm -rf "$work" "$dmg_work"' EXIT
for attempt in 1 2 3; do
  candidate="$dmg_work/attempt-$attempt.dmg"
  if LC_ALL=C hdiutil create -volname "声场档案 $version" -srcfolder "$work/image" -fs HFS+ -format UDZO "$candidate" > "$dmg_work/create.log" 2>&1; then
    cat "$dmg_work/create.log"
    break
  else
    status=$?
    cat "$dmg_work/create.log" >&2
    if [[ "$attempt" == 3 ]] || ! grep -qF 'Resource busy' "$dmg_work/create.log"; then
      exit "$status"
    fi
    echo "DMG 创建遇到 Resource busy，等待 $((attempt * 2)) 秒后重试（最多 3 次）。" >&2
    sleep "$((attempt * 2))"
  fi
done
hdiutil verify "$candidate"
python3 - "$candidate" "$output_dmg" <<'PYFINAL'
import os,sys
os.link(sys.argv[1],sys.argv[2])  # Atomic, same filesystem, fails if destination exists.
PYFINAL
python3 "$script_dir/update-artifacts.py" --app "$source_app" --package "$output_dmg"
