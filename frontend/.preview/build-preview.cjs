const fs = require("node:fs");

function createPreview(html) {
    const clean = html.replace(/\s*<script\s+src=["']\.preview\/(?:mock-tauri|library-query|movie-store)\.js["']\s*><\/script>/g, "");
    const anchor = /<script\s+src=["']app\.js["']\s*><\/script>/;
    if (!anchor.test(clean)) throw new Error("找不到 app.js 入口，未生成预览页");
    const first = /<script\s+src=["'](?:library-data|app)\.js["']\s*><\/script>/;
    return clean.replace(first, match => `<script src=".preview/library-query.js"></script>\n<script src=".preview/movie-store.js"></script>\n<script src=".preview/mock-tauri.js"></script>\n${match}`);
}

if (require.main === module) {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error("Usage: build-preview.cjs INPUT OUTPUT");
    const html = createPreview(fs.readFileSync(input, "utf8"));
    const temporary = `${output}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, html, { flag: "wx" });
        fs.renameSync(temporary, output);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}

module.exports = { createPreview };
