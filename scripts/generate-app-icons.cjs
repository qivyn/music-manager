// Export the illustration with native icon corners, without painting a frame.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const artwork = path.join(root, "src-tauri/app-icon-artwork.png");
const source = path.join(root, "src-tauri/app-icon.png");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "music-manager-icon-"));

try {
    const svg = path.join(temp, "icon.svg");
    const image = fs.readFileSync(artwork).toString("base64");
    fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><clipPath id="tile"><rect x="64" y="64" width="896" height="896" rx="196"/></clipPath></defs>
  <image x="64" y="64" width="896" height="896" clip-path="url(#tile)" xlink:href="data:image/png;base64,${image}"/>
</svg>`);
    execFileSync("cargo", ["tauri", "icon", svg, "--output", temp, "--png", "1024"], {
        cwd: root, stdio: "inherit"
    });
    fs.copyFileSync(path.join(temp, "1024x1024.png"), source);
    execFileSync("cargo", ["tauri", "icon", source, "--output", path.join(root, "src-tauri/icons"), "--ios-color", "#faf3e9"], {
        cwd: root, stdio: "inherit"
    });
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
