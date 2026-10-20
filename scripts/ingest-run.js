/* 直接入库脚本：绕开浏览器，从本地 xlsx 读数据 → 云端 LLM 识别 → 写库
   用法：node ingest-run.js [行数上限]
   依赖：playwright-core 加载页面取得 SDK，再用页面内 evaluate 执行逻辑。 */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = 'C:/Users/11844/Desktop/全店在售品及卖点文案汇总（截止7月31日）.xlsx';
const LIMIT = parseInt(process.argv[2] || '300', 10);   // 本次处理行数
const FROM  = parseInt(process.argv[3] || '0', 10);     // 起始行（跳过已处理的）
const PER_BATCH = 8;                                     // 每批行数

/* ---------- 本地读 xlsx（流式，避免 902MB 撑爆内存） ---------- */
/* 只处理 xl/worksheets/sheet1.xml。走中央目录拿偏移，
   再分块读 + 流式 inflate + 边解压边切行，够到行数上限就停。 */
function readXlsx(file, maxRows){
  return new Promise(function(resolve, reject){
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;

    // 1) 从尾部找 End of Central Directory
    const tailLen = Math.min(size, 66000);
    const tailBuf = Buffer.alloc(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen);
    let eocd = -1;
    for(let i = tailLen - 22; i >= 0; i--){
      if(tailBuf.readUInt32LE(i) === 0x06054b50){ eocd = i; break; }
    }
    if(eocd < 0){ fs.closeSync(fd); return reject(new Error('不是有效的 xlsx')); }

    // 2) 读中央目录，定位 sheet1
    // 注意：eocd 是 tailBuf 内的相对位置，cdOff 是绝对偏移
    const eocdAbs = size - tailLen + eocd;
    const cdOff = tailBuf.readUInt32LE(eocd + 16);
    const cdLen = eocdAbs - cdOff;
    if(cdLen < 0 || cdLen > 50 * 1024 * 1024){ fs.closeSync(fd); return reject(new Error('中央目录异常')); }
    const cdBuf = Buffer.alloc(cdLen);
    fs.readSync(fd, cdBuf, 0, cdLen, cdOff);

    let p = 0, entry = null;
    const count = tailBuf.readUInt16LE(eocd + 10);
    for(let n = 0; n < count; n++){
      if(p + 46 > cdLen || cdBuf.readUInt32LE(p) !== 0x02014b50) break;
      const method = cdBuf.readUInt16LE(p + 10);
      const compSize = cdBuf.readUInt32LE(p + 20);
      const nameLen = cdBuf.readUInt16LE(p + 28);
      const extraLen = cdBuf.readUInt16LE(p + 30);
      const cmtLen = cdBuf.readUInt16LE(p + 32);
      const localOff = cdBuf.readUInt32LE(p + 42);
      const name = cdBuf.toString('utf8', p + 46, p + 46 + nameLen);
      if(/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) entry = { method, compSize, localOff };
      p += 46 + nameLen + extraLen + cmtLen;
      if(entry) break;
    }
    if(!entry){ fs.closeSync(fd); return reject(new Error('找不到工作表')); }

    // 3) 读本地头，算出数据起点
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, entry.localOff);
    const method = lh.readUInt16LE(8);
    const dataStart = entry.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

    // 4) 分块读 + 流式解压 + 切行
    const out = [];
    let carry = '';
    let seen = 0;
    let done = false;
    let pos = 0;
    let inf = null;
    let acc = '';

    function handleText(text){
      const s = carry + text;
      const parts = s.split(/(?=<row\b)/);
      carry = parts.pop();
      for(let i = 0; i < parts.length; i++){
        if(parts[i].indexOf('<row') !== 0) continue;
        seen++;
        const row = parseRow(parts[i]);
        if(row && row.some(function(c){ return String(c).trim() !== ''; })) out.push(row);
        if(out.length >= maxRows){ finish(); return; }
      }
    }

    function finish(){
      if(done) return;
      done = true;
      try{ if(inf) inf.destroy(); }catch(e){}
      try{ fs.closeSync(fd); }catch(e){}
      resolve(out);
    }

    if(method === 0){
      // 未压缩：直接顺序读
      const CH = 4 * 1024 * 1024;
      (function read(){
        if(done) return;
        const buf = Buffer.alloc(Math.min(CH, size - dataStart - pos));
        if(!buf.length) return finish();
        fs.readSync(fd, buf, 0, buf.length, dataStart + pos);
        pos += buf.length;
        handleText(buf.toString('utf8'));
        if(!done) read();
      })();
      return;
    }

    inf = zlib.createInflateRaw();
    inf.on('data', function(d){
      if(done) return;
      acc += d.toString('utf8');
      if(acc.length > 4 * 1024 * 1024){
        const t = acc; acc = '';
        handleText(t);
      }
    });
    inf.on('error', function(e){ if(!done){ done = true; try{fs.closeSync(fd);}catch(x){} reject(e); } });
    inf.on('end', function(){ if(!done){ acc += ''; handleText(acc); finish(); } });

    const CH = 4 * 1024 * 1024;
    (function read(){
      if(done) return;
      const buf = Buffer.alloc(Math.min(CH, size - dataStart - pos));
      if(!buf.length){ return inf.end(); }
      fs.readSync(fd, buf, 0, buf.length, dataStart + pos);
      pos += buf.length;
      if(inf.write(buf)) read();
      else inf.once('drain', read);
    })();
  });
}

function decodeEnt(s){
  return String(s||'')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#x([0-9a-fA-F]+);/g, function(_,h){ return String.fromCharCode(parseInt(h,16)); })
    .replace(/&#(\d+);/g, function(_,n){ return String.fromCharCode(n); })
    .replace(/&amp;/g,'&');
}
function stripTags(s){
  return decodeEnt(String(s||'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
}
function colNum(ref){
  const m = /^([A-Za-z]+)/.exec(ref||'');
  if(!m) return 0;
  let n = 0; const s = m[1].toUpperCase();
  for(let i=0;i<s.length;i++) n = n*26 + (s.charCodeAt(i)-64);
  return n-1;
}
function parseRow(rowXml){
  const cells = {}; let maxCol = -1;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)(?:<\/c>|(?=<c\b)|(?=<row\b)|$))/g;
  let m;
  while((m = cellRe.exec(rowXml))){
    const attrs = m[1]||'', inner = m[2]||'';
    const refM = /\br="([A-Za-z]+\d+)"/.exec(attrs);
    const idx = refM ? colNum(refM[1]) : (maxCol+1);
    const typeM = /\bt="([^"]+)"/.exec(attrs);
    const type = typeM ? typeM[1] : 'n';
    let val = '';
    if(type === 'inlineStr'){
      const isM = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
      val = isM ? stripTags(isM[1]) : '';
    } else {
      const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      val = vm ? decodeEnt(vm[1]) : '';
    }
    cells[idx] = val;
    if(idx > maxCol) maxCol = idx;
  }
  const arr = [];
  for(let c=0;c<=maxCol;c++) arr.push(cells[c] != null ? cells[c] : '');
  return arr;
}

(async function(){
  console.log('读取文件:', path.basename(SRC));
  const rows = await readXlsx(SRC, FROM + LIMIT);
  const slice = rows.slice(FROM);
  console.log('读到', rows.length, '行');

  // 只保留有价值的列：类目(E) + SKU名(F) + 卖点(I)
  const header = rows[0] || [];
  console.log('表头:', header.slice(0,9).join(' | ').slice(0,80));

  const payload = slice.map(function(r){
    return { model: r[2]||'', sku: r[3]||'', cat: r[4]||'', name: r[5]||'', copy: String(r[8]||'').slice(0, 1500) };
  }).filter(function(o){ return o.name || o.copy; });

  // 批次
  const batches = [];
  for(let i = 0; i < payload.length; i += PER_BATCH) batches.push(payload.slice(i, i + PER_BATCH));
  console.log('分', batches.length, '批，每批', PER_BATCH, '行');

  // 起浏览器
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/', { waitUntil:'domcontentloaded' });
  await p.waitForSelector('.card, .empty', { timeout:60000 });
  // CDN 偶发断连，SDK 加载不出来时多等几轮
  let sdkOk = 0;
  for(let i = 0; i < 8 && !sdkOk; i++){
    sdkOk = await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined', { timeout:30000 })
      .then(()=>1).catch(()=>0);
    if(!sdkOk){
      process.stdout.write('SDK 未就绪，重试 ' + (i+1) + '/8 … ');
      await p.waitForTimeout(8000);
    }
  }
  if(!sdkOk){
    console.log('\nSDK 一直连不上（网络问题），请稍后重跑。已完成的批次不会丢。');
    await b.close(); process.exit(1);
  }
  console.log('SDK 就绪');

  // 取标签清单与材质词典，供提示词使用
  const guide = await p.evaluate(()=>({
    outline: window.KB_INGEST.dimOutline(),
    mats: window.KB_MATERIALS_CARDS ? [] : []
  }));
  console.log('标签维度数:', (guide.outline||'').length);

  const results = [];
  for(let bi = 0; bi < batches.length; bi++){
    const batch = batches[bi];
    const prompt = buildPrompt(batch, guide.outline);
    process.stdout.write('  批 ' + (bi+1) + '/' + batches.length + ' … ');
    let got = await p.evaluate(callLLMFn, { prompt: prompt });
    if(got && got.error){
      // 偶发截断，重试一次
      got = await p.evaluate(callLLMFn, { prompt: prompt });
    }
    if(got && got.error){
      console.log('失败(已重试): ' + got.error.slice(0,40));
      continue;
    }
    const items = (got && got.products) || [];
    results.push.apply(results, items);
    console.log('识别 ' + items.length + ' 个');
  }

  console.log('\n共识别', results.length, '个产品，开始入库…');

  // 入库
  const saved = await p.evaluate(saveFn, { items: results });
  console.log('入库结果:', JSON.stringify(saved));

  await b.close();
})();

function buildPrompt(batch, outline){
  const lines = batch.map(function(o, i){
    return ('【' + (i+1) + '】型号 ' + o.model + ' / ' + o.sku + '\n' +
            '类目: ' + o.cat + '\n' +
            '名称: ' + o.name + '\n' +
            '卖点: ' + String(o.copy).replace(/\s+/g,' ').slice(0,600));
  }).join('\n\n');

  return (
  '你是家具行业材质分析助手。下面是若干个产品的信息，请为每个产品提取材质特性标签。\n\n' +
  '可用的标签维度（键必须严格用「分类/维度」格式）：\n' + outline + '\n\n' +
  '产品信息：\n' + lines + '\n\n' +
  '严格只输出 JSON，格式：\n' +
  '{"products":[{"i":序号,"category":"品类","materials":["材质"],"tags":{"分类/维度":["标签值"]},"keywords":["关键词"],"copy":["卖点文案"]}]}\n\n' +
  '要求：\n' +
  '1. category 用家具品类名（如 床/沙发/茶几/餐桌/柜类）\n' +
  '2. materials 从卖点里提到的材质里挑（白蜡木/松木/岩板/科技布/真皮/海绵/排骨架等）\n' +
  '3. tags 的键必须是上面列出的「分类/维度」原文，标签值也必须来自对应维度的候选值\n' +
  '4. 每行 i 对应输入里的序号，不要遗漏、不要合并\n' +
  '5. 找不到依据的字段留空数组或空字符串\n' +
  '6. **重要**：如果几条只有尺寸/规格不同（如 1200mm / 1350mm / 1500mm），' +
  '那是同一个产品，只输出第一条，后面的直接跳过\n'
  );
}

function callLLMFn({ prompt }){
  const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: window.CLOUD_CONFIG.endpoint,
    publishableKey: window.CLOUD_CONFIG.publishableKey
  });
  const stream = cloud.llm.chat.completions.create({
    model: window.KB_MODEL,
    messages: [{ role:'user', content: prompt }],
    stream: true,
    response_format: { type:'json_object' },
    temperature: 1
  });
  return (async function(){
    let ans = '';
    for await (const c of stream){
      const d = c.choices && c.choices[0] && c.choices[0].delta;
      if(d && d.content) ans += d.content;
    }
    try{
      // 模型有时会包 ```json ... ```，需要剥掉
      var t = ans.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '');
      try{ return JSON.parse(t); }
      catch(e2){
        // 流式输出可能被截断，尝试补齐
        var a = t.indexOf('{');
        if(a === -1) throw e2;
        var cut = t.slice(a);
        var fix = cut.replace(/,\s*$/, '');
        var st = [];
        var inStr = false, esc = false;
        for(var i=0;i<fix.length;i++){
          var c = fix[i];
          if(esc){ esc=false; continue; }
          if(c==='\\'){ if(inStr) esc=true; continue; }
          if(c==='"'){ inStr=!inStr; continue; }
          if(inStr) continue;
          if(c==='{'||c==='[') st.push(c==='{'?'}':']');
          else if(c==='}'||c===']') st.pop();
        }
        if(inStr) fix += '"';
        while(st.length) fix += st.pop();
        return JSON.parse(fix);
      }
    }catch(e){
      return { error: 'JSON 解析失败: ' + ans.slice(0,100) };
    }
  })();
}

function saveFn({ items }){
  const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: window.CLOUD_CONFIG.endpoint,
    publishableKey: window.CLOUD_CONFIG.publishableKey
  });
  function tagDims(tags){
    const dim = {}, flat = [];
    Object.keys(tags||{}).forEach(function(k){
      const v = tags[k];
      if(Array.isArray(v) && v.length){ dim[k] = v; v.forEach(function(x){ flat.push(x); }); }
    });
    return { dim: dim, flat: flat };
  }
  return (async function(){
    let ok = 0, fail = 0;
    for(const it of items){
      const t = tagDims(it.tags);
      const row = {
        category: it.category || '',
        material: (it.materials || [])[0] || '',
        source_text: String(it.keywords ? it.keywords.join(',') : '').slice(0,2000),
        image_path: '',
        feel: (it.keywords || []).slice(0,5).join(','),
        tags: t.flat,
        copy_items: Array.isArray(it.copy) ? it.copy.slice(0,3) : [],
        fit: '', caution: '',
        raw_text: JSON.stringify({
          materials: it.materials || [],
          keywords: it.keywords || [],
          tagDims: t.dim,
          lines: null,
          history: [{ t: Date.now(), a:'create', by:'IMPORT', d:{} }]
        }),
        confidence: 0.5
      };
      try{
        const r = await cloud.database.from('material_notes').insert(row).select();
        if(r && r.error) throw new Error(r.error.message);
        ok++;
      }catch(e){ fail++; }
    }
    return { ok: ok, fail: fail, total: items.length };
  })();
}