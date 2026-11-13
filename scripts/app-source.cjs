// Use the same application modules and order as the browser, without booting.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../frontend');
const modules = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)]
    .map(match => match[1]).filter(name => ['library-data.js','assigned-tags.js','movie-usage.js','home-player.js','catalog-controls.js','library-browser.js','music-detail.js','player.js','candidates.js','library-import.js','clip-editor.js','app.js'].includes(name));
module.exports = { modules, readAppSource: () => modules.map(name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\ninit\(\);\s*$/, '')).join('\n') };
