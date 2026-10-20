/* 静态完整性检查：找出「调用了但没定义」的函数。
   之前两次因大段替换误删函数（list / normMaterials 等），靠线上报错才发现。
   这个脚本能在提交前自查。 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const BUILTIN = new Set([
  'if','for','while','switch','catch','function','return','typeof','new','delete','do','else',
  'try','finally','void','await','yield','case','default','break','continue','instanceof','in','of',
  'Array','Object','String','Number','Boolean','JSON','Math','Date','Set','Map','RegExp','Error',
  'Promise','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent',
  'setTimeout','clearTimeout','setInterval','clearInterval','require','module','exports',
  'alert','confirm','prompt','fetch','console','Symbol','Proxy','Reflect','WeakMap','WeakSet',
  'Blob','File','FileReader','FormData','URL','TextDecoder','TextEncoder','Headers','Request','Response',
  'AbortController','DOMParser','XMLHttpRequest','Uint8Array','Int32Array','Float32Array','DataView',
  // String.prototype 常见方法（会被当成调用）
  'lastIndexOf','indexOf','includes','startsWith','endsWith','padStart','padEnd','repeat',
  'ArrayBuffer','CustomEvent','Event','EventTarget','History','Location','Navigator','Node',
  'Element','HTMLElement','Document','Window','Storage','ClipboardItem','FileList','FormData',
  // 浏览器全局
  'DecompressionStream','CompressionStream','ReadableStream','WritableStream','TransformStream',
  'Image','Audio','Video','Canvas','localStorage','sessionStorage','caches','crypto','performance',
  'navigator','location','screen','frames','self','top','parent','opener','frameset',
  'Notification','MutationObserver','IntersectionObserver','ResizeObserver','Worker','SharedWorker',
  'ServiceWorker','BroadcastChannel','MessageChannel','RTCPeerConnection','WebSocket','XMLHttpRequestUpload',
  // 关键字被当成调用（if( / for( / switch( 等）
  'var','let','const','function','class','extends','super','import','export','from','as',
  'async','await','yield','static','get','set','of','in','typeof','instanceof','new','delete','void','this'
]);

/* 收集函数参数名，避免把 fn / onProgress 这类参数当成未定义函数 */
function collectParams(src){
  const params = new Set();
  const re = /function\s*[a-zA-Z_$\w]*\s*\(([^)]*)\)/g;
  let m;
  while((m = re.exec(src))){
    m[1].split(',').forEach(p2 => {
      const n = p2.trim().replace(/^.*[\s:=]/, '').replace(/[{}]/g, '').trim();
      if(/^[a-zA-Z_$][\w$]*$/.test(n)) params.add(n);
    });
  }
  // 箭头函数单参
  const re2 = /\(([a-zA-Z_$][\w$]*)\)\s*=>/g;
  while((m = re2.exec(src))) params.add(m[1]);
  return params;
}

// 收集所有函数定义（含各种写法）
function collectDefs(src){
  const defs = new Set();
  const patterns = [
    /function\s+([a-zA-Z_$][\w$]*)\s*\(/g,
    /(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*function/g,
    /(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /window\.([a-zA-Z_$][\w$]*)\s*=\s*function/g,
    /(?:var|let|const)\s+([a-zA-Z_$][\w$]*)\s*=/g,   // 变量声明（赋值型）
  ];
  patterns.forEach(re=>{
    let m;
    while((m = re.exec(src))) defs.add(m[1]);
  });
  return defs;
}

/* 把正则字面量、字符串字面量替换成空白，避免里面的字符被当成调用 */
function stripLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // 字符串
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    // 正则字面量：上一个有效字符表明这里该按正则解析
    if (c === '/') {
      const prev = out.replace(/\s+$/, '').slice(-1);
      const isRegex = prev === '' || '(,=:[!&|?{};\n+-*%<>~^'.includes(prev);
      if (isRegex) {
        i++;
        let inClass = false;
        while (i < n) {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) { i++; break; }
          else if (src[i] === '\n') break;
          i++;
        }
        // 跳过 flags
        while (i < n && /[gimsuy]/.test(src[i])) i++;
        out += ' ';
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// 找出被调用的标识符
function collectCalls(src){
  // 先剔除正则字面量与字符串字面量，否则 /&#x(/ 里的 x 会被当成函数调用
  src = stripLiterals(src);
  const calls = new Set();
  const re = /(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g;
  let m;
  while((m = re.exec(src))) calls.add(m[1]);
  return calls;
}

// 属性访问不算调用（排除 .foo( ），这里用了负向断言
function collectMembers(src){
  const m = new Set();
  const re = /\.([a-zA-Z_$][\w$]*)\s*\(/g;
  let x;
  while((x = re.exec(src))) m.add(x[1]);
  return m;
}

let problems = 0;
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js') && f !== 'check.js');

files.forEach(f => {
  const p = path.join(DIR, f);
  const src = fs.readFileSync(p, 'utf8');
  const defs = collectDefs(src);
  const calls = collectCalls(src);
  const members = collectMembers(src);

  const params = collectParams(src);
  const missing = [...calls].filter(n =>
    !defs.has(n) && !BUILTIN.has(n) && !members.has(n) && !params.has(n)
  );

  // 重复定义检查
  const counts = {};
  const dupRe = /^  function ([a-zA-Z_$][\w$]*)\s*\(/gm;
  let m;
  while((m = dupRe.exec(src))) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const dups = Object.keys(counts).filter(k => counts[k] > 1);

  if(missing.length || dups.length){
    if(missing.length){
      console.log(`\n❌ ${f}`);
      console.log('   调用了但没定义:', missing.join(', '));
      problems++;
    }
    if(dups.length){
      console.log(`\n⚠️  ${f}`);
      console.log('   重复定义:', dups.map(k => `${k}×${counts[k]}`).join(', '));
      problems++;
    }
  }
});

// index.html 里的内联脚本也要查
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
if(inline){
  const defs = collectDefs(inline);
  const calls = collectCalls(inline);
  const members = collectMembers(inline);
  // 外部脚本提供的
  const external = new Set();
  files.forEach(f => {
    collectDefs(fs.readFileSync(path.join(DIR, f), 'utf8')).forEach(d => external.add(d));
  });
  const params = collectParams(inline);
  const missing = [...calls].filter(n =>
    !defs.has(n) && !external.has(n) && !BUILTIN.has(n) && !members.has(n) && !params.has(n)
  );
  if(missing.length){
    console.log('\n❌ index.html 内联脚本');
    console.log('   调用了但没定义:', missing.join(', '));
    problems++;
  }
}

if(problems === 0){
  console.log('✅ 检查通过：没有未定义函数，也没有重复定义');
  // 顺带确认几个关键常量仍在
  const ingestSrc = fs.readFileSync(path.join(DIR, 'ingest.js'), 'utf8');
  const must = ['var TABLE', 'function list', 'function save', 'function update',
                'function normMaterials', 'function normTags', 'function matchDocument'];
  const lost = must.filter(k => !ingestSrc.includes(k));
  if(lost.length){
    console.log('❌ ingest.js 缺少关键定义:', lost.join(', '));
    process.exitCode = 1;
  } else {
    console.log('   关键定义齐全：TABLE / list / save / update / normMaterials / normTags / matchDocument');
  }
} else {
  console.log(`\n发现 ${problems} 处问题`);
  process.exitCode = 1;
}
