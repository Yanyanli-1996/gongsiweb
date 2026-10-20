const fs = require('node:fs');
const path = require('node:path');
require('./build-snapshot');
require('./validate');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '_site');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of fs.readdirSync(path.join(root, 'app'))) {
  if (file === 'check.js') continue;
  fs.copyFileSync(path.join(root, 'app', file), path.join(output, file));
}
fs.writeFileSync(path.join(output, '.nojekyll'), '');
console.log('静态站已输出到 _site/');
