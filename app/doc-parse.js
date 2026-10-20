/* ==========================================================
   文档解析 —— 浏览器端，零外部依赖
   支持：txt / md / csv / docx / xlsx
   docx 与 xlsx 本质是 zip，用浏览器原生 DecompressionStream 解压
   ========================================================== */
(function(){
  /* 大文件多是因为里面塞满图片，而我们只需要文字。
     所以这个限制针对「解压后的文本量」，文件本身可以放很大。 */
  var MAX_BYTES = 400 * 1024 * 1024;  // 原始文件上限 400MB
  var MAX_TEXT  = 12 * 1024 * 1024;   // 提取出的文字上限 12MB（约 600 万字，足够）
  /* 单次最多处理的行数。超大表（如近 2 万行、每行数 KB）
     一次性解压进内存会直接把浏览器撑爆，所以读到上限就停。 */
  var MAX_ROWS  = 1500;

  /* ---------- zip 读取 ---------- */
  /* only: 只提取匹配的条目名（正则）；跳过其余（图片等），避免占用内存 */
  function readZip(buf, only){
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var files = {};
    var skipped = 0;

    // 从尾部找 End of Central Directory
    var eocd = -1;
    var min = Math.max(0, buf.byteLength - 66000);
    for(var i = buf.byteLength - 22; i >= min; i--){
      if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
    }
    if(eocd < 0) throw new Error('不是有效的压缩包（docx/xlsx）');

    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var p = cdOff;

    for(var n = 0; n < count; n++){
      if(dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder('utf-8').decode(u8.slice(p + 46, p + 46 + nameLen));
      // 只要文本相关的条目，图片/字体/嵌入对象直接跳过（它们才是文件大的元凶）
      if(only && !only.test(name)){ skipped++; p += 46 + nameLen + extraLen + commentLen; continue; }
      // 本地头的 extra 长度可能与中央目录不同，必须重新读
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      files[name] = { method: method, data: u8.slice(dataStart, dataStart + compSize) };
      p += 46 + nameLen + extraLen + commentLen;
    }
    files._skipped = skipped;
    return files;
  }

  function inflateRaw(bytes){
    // 用浏览器原生 DecompressionStream 解 deflate-raw
    if(typeof DecompressionStream === 'undefined'){
      return Promise.reject(new Error('当前浏览器不支持文档解析，请改用 Chrome/Edge'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function(ab){
      return new Uint8Array(ab);
    });
  }

  function readEntry(f){
    if(f.method === 0) return Promise.resolve(f.data);
    if(f.method === 8) return inflateRaw(f.data);
    return Promise.reject(new Error('不支持的压缩方式（' + f.method + '）'));
  }

  /* ---------- 流式解压 ----------
     超大 sheet 解压后可能有几百 MB，一次性读进内存会崩。
     这里逐块解压，交给 onChunk 处理；onChunk 返回 false 即提前结束，
     剩余的数据不再解压，内存占用可控。 */
  function streamEntry(f, onChunk){
    if(f.method === 0){
      onChunk(new TextDecoder('utf-8').decode(f.data));
      return Promise.resolve(false);
    }
    if(f.method !== 8){
      return Promise.reject(new Error('不支持的压缩方式（' + f.method + '）'));
    }
    if(typeof DecompressionStream === 'undefined'){
      return Promise.reject(new Error('当前浏览器不支持文档解析，请改用 Chrome/Edge'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var reader = new Blob([f.data]).stream().pipeThrough(ds).getReader();
    var dec = new TextDecoder('utf-8', { fatal:false });
    var buf = '';
    var stopped = false;

    function step(){
      if(stopped) return Promise.resolve(false);
      return reader.read().then(function(r){
        if(stopped) return false;
        if(r.done){ buf += dec.decode(); onChunk(buf); return false; }
        buf += dec.decode(r.value, { stream:true });
        // 缓冲区过大就切分处理，避免单串过大
        if(buf.length > 4 * 1024 * 1024){
          var keep = 40000;      // 可能被切断的行，保留尾巴下次接上
          var head = buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          if(onChunk(head) === false){ stopped = true; return false; }
        }
        return step();
      });
    }
    return step();
  }

  /* ---------- docx ---------- */
  function parseDocx(buf){
    // 只要正文，跳过 media/（图片）、embeddings/、theme/ 等占地方的条目
    var files = readZip(buf, /^word\/document\.xml$/);
    var docFile = files['word/document.xml'];
    if(!docFile) throw new Error('docx 里找不到正文（word/document.xml）');

    return readEntry(docFile).then(function(bytes){
      var xml = new TextDecoder('utf-8').decode(bytes);

      /* 先用正则抽文字段落与表格行。
         不用 DOMParser：真实 docx 里偶尔有未声明的命名空间前缀
         （如某些第三方工具生成的 <a:blip>），会让整份 XML 解析失败，
         导致明明有文字却读不出来。正则对命名空间前缀天然免疫。 */
      var blocks = [];
      var re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      var m;
      while((m = re.exec(xml))){
        var inner = m[1] != null ? m[1] : m[2];
        if(m[2] != null){
          // 表格行：按单元格拆列
          var cells = [];
          var cre = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
          var cm;
          while((cm = cre.exec(inner))){
            cells.push(stripXml(cm[1]));
          }
          cells = cells.filter(function(c){ return c !== ''; });
          if(cells.length) blocks.push({ type:'row', text: cells.join(' | '), cols: cells });
        } else {
          var t = stripXml(inner);
          if(t) blocks.push({ type:'p', text: t });
        }
      }
      return blocks;
    });
  }

  /* 去掉 XML 标签、实体，只留纯文字 */
  function stripXml(s){
    return String(s || '')
      .replace(/<[^>]*>/g, ' ')           // 去掉所有标签
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function(_, n){ return String.fromCharCode(n); })
      .replace(/&amp;/g, '&')
      .replace(/&#x([0-9a-fA-F]+);/g, function(_, h){ return String.fromCharCode(parseInt(h, 16)); })
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* 单元格引用转列号：A→0, B→1, AA→26 */
  function colToNum(ref){
    var m = /^([A-Za-z]+)/.exec(String(ref || ''));
    if(!m) return 0;
    var s = m[1].toUpperCase(), n = 0;
    for(var i = 0; i < s.length; i++){
      n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n - 1;
  }

  /* xlsx 共享字符串表：<si> 内可能是多段 <t> 或富文本 <r> */
  function readSharedStrings(xml){
    var out = [];
    var re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    var m;
    while((m = re.exec(xml))) out.push(stripXml(m[1]));
    return out;
  }

  function decodeXml(s){
    return String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, function(_, h){ return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function(_, n){ return String.fromCharCode(n); })
      .replace(/&amp;/g, '&');
  }

  /* 读一张工作表的所有行；按 r="A1" 定位列，保持列对齐 */
  function readSheetRows(xml, shared){
    var rows = [];
    var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    var rm;
    while((rm = rowRe.exec(xml))){
      var cells = {}, maxCol = -1;
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      var cm;
      while((cm = cellRe.exec(rm[1]))){
        var attrs = cm[1] || '', inner = cm[2] || '';
        var refM = /\br="([A-Za-z]+\d+)"/.exec(attrs);
        var idx = refM ? colToNum(refM[1]) : (maxCol + 1);
        var typeM = /\bt="([^"]+)"/.exec(attrs);
        var type = typeM ? typeM[1] : 'n';
        var val = '';
        if(type === 'inlineStr'){
          val = stripXml(inner);
        } else {
          var vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          var raw = vm ? decodeXml(vm[1]) : '';
          if(type === 's'){
            var si = parseInt(raw, 10);
            val = (shared[si] != null) ? shared[si] : '';
          } else {
            val = raw;
          }
        }
        cells[idx] = val;
        if(idx > maxCol) maxCol = idx;
      }
      var arr = [];
      for(var c = 0; c <= maxCol; c++) arr.push(cells[c] != null ? cells[c] : '');
      rows.push(arr);
    }
    return rows;
  }

  /* 从 XML 文本里按 <row 开标签切分，跨块也能接上 */
  function makeRowAccumulator(){
    var carry = '';
    var rows = [];
    return {
      push: function(text){
        var s = carry + text;
        /* 按开标签切分，不依赖 </row>。
           超大文件里闭合标签可能在很后面，靠 </row> 匹配会一路吞掉几十 MB。 */
        var parts = s.split(/(?=<row\b)/);
        carry = parts.pop();
        for(var i = 0; i < parts.length; i++){
          if(parts[i].indexOf('<row') === 0) rows.push(parts[i]);
        }
      },
      flush: function(){
        if(carry.indexOf('<row') === 0) rows.push(carry);
        carry = '';
      },
      rows: function(){ return rows; }
    };
  }

  /* 解析一行 → 列数组（按 r="A1" 的列字母定位，缺失列补空） */
  function parseRowCells(rowXml, shared){
    var cells = {}, maxCol = -1;
    var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)(?:<\/c>|(?=<c\b)|(?=<row\b)|$))/g;
    var cm;
    while((cm = cellRe.exec(rowXml))){
      var attrs = cm[1] || '', inner = cm[2] || '';
      var refM = /\br="([A-Za-z]+\d+)"/.exec(attrs);
      var idx = refM ? colToNum(refM[1]) : (maxCol + 1);
      var typeM = /\bt="([^"]+)"/.exec(attrs);
      var type = typeM ? typeM[1] : 'n';
      var val = '';
      if(type === 'inlineStr'){
        var isM = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
        val = isM ? stripXml(isM[1]) : '';
      } else {
        var vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        var raw = vm ? decodeXml(vm[1]) : '';
        if(type === 's'){
          var si = parseInt(raw, 10);
          val = (shared[si] != null) ? shared[si] : '';
        } else {
          val = raw;
        }
      }
      cells[idx] = val;
      if(idx > maxCol) maxCol = idx;
    }
    var arr = [];
    for(var c = 0; c <= maxCol; c++) arr.push(cells[c] != null ? cells[c] : '');
    return arr;
  }

  /* ---------- xlsx ----------
     走流式解压：超大表读到 MAX_ROWS 行就停，不把几百 MB 全塞进内存。
     也不用 DOMParser，对命名空间不完整的片段免疫。 */
  function parseXlsx(buf){
    var files = readZip(buf, /^(xl\/worksheets\/sheet\d+\.xml|xl\/sharedStrings\.xml)$/);

    var sheetKeys = Object.keys(files).filter(function(k){
      return /^xl\/worksheets\/sheet\d+\.xml$/.test(k);
    }).sort(function(a, b){
      return parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10);
    });
    if(!sheetKeys.length) throw new Error('xlsx 里找不到工作表');

    var ssP = files['xl/sharedStrings.xml']
      ? readEntry(files['xl/sharedStrings.xml']).then(function(b){
          return readSharedStrings(new TextDecoder('utf-8').decode(b));
        })
      : Promise.resolve([]);

    return ssP.then(function(shared){
      var acc = makeRowAccumulator();
      var rows = [];          // 解析好的行
      var seen = 0;           // 原始行数（含被跳过的空行）

      function harvest(){
        var pending = acc.rows();
        while(pending.length > 0){
          if(seen >= MAX_ROWS) return true;   // 够了，让外层中止
          var raw = pending.shift();
          seen++;
          var t = parseRowCells(raw, shared).map(function(c){
            return String(c == null ? '' : c).trim();
          });
          if(!t.some(function(c){ return c !== ''; })) continue;
          while(t.length && t[t.length-1] === '') t.pop();
          if(t.length) rows.push(t);
        }
        return false;
      }

      return streamEntry(files[sheetKeys[0]], function(text){
        acc.push(text);
        return !harvest();     // true = 中止
      }).then(function(){
        acc.flush();
        harvest();
        return { rows: rows, seen: seen };
      });
    }).then(function(out){
      if(!out.rows.length) throw new Error('Excel 里没有读到任何内容（可能是空表）');
      var blocks = out.rows.map(function(t){
        return { type:'row', text: t.join(' | '), cols: t };
      });
      if(out.seen >= MAX_ROWS){
        blocks.push({
          type:'note', cols: null,
          text:'（表格共约 ' + out.seen + ' 行，本次已读取前 ' + MAX_ROWS + ' 行。' +
               '其余部分可拆分后再上传。）'
        });
      }
      return blocks;
    });
  }

  /* ---------- 纯文本 ---------- */
  function parseText(file){
    return file.text().then(function(t){
      var name = (file.name || '').toLowerCase();
      if(/\.csv$/.test(name)) return csvToRows(t);
      if(/\.tsv$/.test(name)) return tsvToRows(t);
      // 按空行分段
      var paras = t.split(/\r?\n\s*\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
      if(paras.length <= 1){
        // 没有空行，按换行分段
        paras = t.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
      }
      return paras.map(function(s){ return { type:'p', text:s }; });
    });
  }

  function splitCsvLine(line, sep){
    var out = [], cur = '', q = false;
    for(var i = 0; i < line.length; i++){
      var ch = line[i];
      if(q){
        if(ch === '"'){
          if(line[i+1] === '"'){ cur += '"'; i++; }
          else q = false;
        } else cur += ch;
      } else {
        if(ch === '"') q = true;
        else if(ch === sep){ out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function csvToRows(t){
    return t.split(/\r?\n/).filter(function(l){ return l.trim(); })
      .map(function(l){ var v=splitCsvLine(l, ','); return { type:'row', text: v.join(' | '), cols: v }; });
  }
  function tsvToRows(t){
    return t.split(/\r?\n/).filter(function(l){ return l.trim(); })
      .map(function(l){ var v=splitCsvLine(l, '\t'); return { type:'row', text: v.join(' | '), cols: v }; });
  }

  /* ---------- 对外 ---------- */
  /* 返回 [{type, text}]，xlsx 已转成行文本 */
  function parse(file){
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var mb = (file.size / 1024 / 1024).toFixed(1);
    if(file.size > MAX_BYTES){
      return Promise.reject(new Error(
        '文件 ' + mb + 'MB，超过 ' + (MAX_BYTES / 1024 / 1024) + 'MB 上限。\n' +
        '可以试试：删掉文档里的图片，或用 Word 另存为「不带图片」的副本'
      ));
    }
    if(/^(txt|md|markdown|csv|tsv|log)$/.test(ext)) return parseText(file);
    if(ext === 'docx') return file.arrayBuffer().then(parseDocx);
    if(ext === 'xlsx' || ext === 'xls') return file.arrayBuffer().then(parseXlsx);
    if(ext === 'doc') return Promise.reject(new Error('旧版 .doc 无法直接解析，请另存为 .docx'));
    if(ext === 'pdf') return Promise.reject(new Error('PDF 暂不支持，请复制文字或另存为 .docx/.txt'));
    if(/^image\//.test(file.type)){
      return Promise.reject(new Error('这是图片，请用「粘贴区」上传图片'));
    }
    return Promise.reject(new Error('不支持的文件格式：.' + ext));
  }

  /* 文字太多时截断，避免一次塞爆模型上下文 */
  function capBlocks(blocks){
    var total = 0, kept = [];
    for(var i = 0; i < blocks.length; i++){
      var len = blocks[i].text.length;
      if(total + len > MAX_TEXT) break;
      total += len;
      kept.push(blocks[i]);
    }
    if(kept.length < blocks.length){
      kept.push({
        type: 'note',
        text: '（文档内容较长，已读取前 ' + kept.length + ' 段，共 ' + blocks.length + '段）',
        cols: null
      });
    }
    return kept;
  }

  window.KB_DOC = {
    /* 对外只暴露这个：内部解析完会按文字量截断 */
    parse: function(file){
      return parse(file).then(capBlocks);
    },
    support: ['txt', 'md', 'csv', 'tsv', 'docx', 'xlsx'],
    maxBytes: MAX_BYTES
  };
})();