const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const rows = JSON.parse(fs.readFileSync(path.join(root, 'data/material_notes-快照.json'), 'utf8'));
if (!Array.isArray(rows)) throw new Error('数据快照必须是数组');
fs.writeFileSync(path.join(root, 'app/materials-data.js'), '// 由 scripts/build-snapshot.js 从仓库数据快照生成。\nwindow.KB_MATERIALS_CARDS = [];\nwindow.KB_SNAPSHOT_ROWS = ' + JSON.stringify(rows, null, 2) + ';\n');
console.log(`已生成 ${rows.length} 张材质卡片的浏览快照`);
