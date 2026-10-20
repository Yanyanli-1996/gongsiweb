const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = path.resolve(__dirname, '../app');
for (const file of fs.readdirSync(app).filter(f => f.endsWith('.js'))) {
  new vm.Script(fs.readFileSync(path.join(app, file), 'utf8'), { filename: file });
}
const html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
for (const [i, match] of [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].entries()) {
  new vm.Script(match[1], { filename: `index.html:inline-${i}` });
}
for (const match of html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/g, '$1</script>').matchAll(/\s(?:src|href)="([^"#]+)"/g)) {
  if (/^(?:https?:|data:|\/\/)/.test(match[1])) continue;
  if (!fs.existsSync(path.resolve(app, match[1].split('?')[0]))) throw new Error(`资源缺失：${match[1]}`);
}
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(app, 'materials-data.js'), 'utf8'), context);
const snapshot = JSON.parse(fs.readFileSync(path.join(app, '../data/material_notes-快照.json'), 'utf8'));
if (JSON.stringify(context.window.KB_SNAPSHOT_ROWS) !== JSON.stringify(snapshot)) throw new Error('快照已变化，请先运行 npm run snapshot');
console.log(`JavaScript 语法、静态资源路径与 ${snapshot.length} 张卡片快照检查通过`);
