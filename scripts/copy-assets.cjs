// Copies static renderer assets (html/css) into dist/ next to the compiled app.js.
const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'dist', 'renderer');
mkdirSync(outDir, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  copyFileSync(join(root, 'src', 'renderer', file), join(outDir, file));
}
console.log('copied renderer static assets -> dist/renderer');
