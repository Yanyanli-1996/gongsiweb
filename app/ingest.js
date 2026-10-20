/**
 * AI 识别 —— 云服务接入 + 数据存取
 *
 * 识别逻辑：品类 → 材质 → 特性标签（8分类/66维度）
 * 标签只能从 KB_TAGS 里选，前端二次校验，防止污染体系。
 */
(function () {
  var cloud = null;
  var sdkReady = false;
  var waiters = [];

  /* 入库内容表名 */
  var TABLE = 'material_notes';

  /* ---------- 初始化：等 SDK 就绪 ---------- */
  /* SDK 由平台从 CDN 注入，网络波动时可能加载失败。
     这里做自动重试，避免用户对着「加载超时」发呆。 */
  var LOAD_RETRY = 3;

  function init() {
    if (cloud) return Promise.resolve();
    if (!sdkReady || !window.WorkBuddyCloud) {
      return new Promise(function (resolve, reject) {
        var finished = false;
        var tries = 0;
        var timer = null;

        function attempt(){
          if (finished) return;
          tries++;
          timer = setTimeout(function () {
            if (window.WorkBuddyCloud){
              // SDK 其实到了，直接放行
              finished = true;
              sdkReady = true;
              init().then(resolve, reject);
              return;
            }
            if (tries >= LOAD_RETRY){
              finished = true;
              reject(new Error(
                'AI 模块连不上服务（已重试 ' + LOAD_RETRY + ' 次）。\n' +
                '通常是网络波动，刷新页面再试即可。'
              ));
              return;
            }
            attempt();   // 再等一轮
          }, 20000);
        }
        attempt();

        waiters.push(function () {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          init().then(resolve, reject);
        });
      });
    }
    try {
      cloud = WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: window.CLOUD_CONFIG.endpoint,
        publishableKey: window.CLOUD_CONFIG.publishableKey
      });
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e);
    }
  }

  window.KB_ON_SDK_READY = function () {
    sdkReady = true;
    var list = waiters.slice();
    waiters.length = 0;
    list.forEach(function (fn) { fn(); });
  };


  /* ---------- 标签体系工具 ---------- */
  function tagTree() { return (window.KB_TAGS && window.KB_TAGS.tree) || {}; }

  function legalIndex() {
    var idx = {};
    Object.keys(tagTree()).forEach(function (cat) {
      var dims = tagTree()[cat];
      Object.keys(dims).forEach(function (dim) {
        var set = {};
        dims[dim].values.forEach(function (v) { set[v] = true; });
        idx[cat + '/' + dim] = set;
      });
    });
    return idx;
  }

  function dimOutline() {
    var out = [];
    Object.keys(tagTree()).forEach(function (cat) {
      var dims = tagTree()[cat];
      Object.keys(dims).forEach(function (dim) {
        out.push('  ' + cat + ' / ' + dim + '（' + dims[dim].values.length + '个可选）');
      });
    });
    return out.join('\n');
  }

  function valueOutline() {
    var out = [];
    Object.keys(tagTree()).forEach(function (cat) {
      out.push('## ' + cat);
      var dims = tagTree()[cat];
      Object.keys(dims).forEach(function (dim) {
        out.push('- ' + dim + '：' + dims[dim].values.join('、'));
      });
    });
    return out.join('\n');
  }

  function categories(){
    return (window.KB_TAGS && window.KB_TAGS.categories) || [];
  }

  /** 品类清单（含说明与该品类常见材质），供模型判断品类 */
  function libOutline() {
    var extra = {};
    (window.KB_MATERIALS_CARDS || []).forEach(function (c) {
      if (!extra[c.group]) extra[c.group] = [];
      if (extra[c.group].indexOf(c.material) < 0) extra[c.group].push(c.material);
    });
    return categories().map(function (c){
      var own = (c.materials || []).join('、');
      var got = extra[c.name] || [];
      var line = '- ' + c.name + (c.desc ? '（' + c.desc + '）' : '');
      line += '：' + (own || got.join('、') || '—');
      if(got.length) line += '；当前已入库 ' + got.join('、');
      return line;
    }).join('\n');
  }

  /** 材质词典：内置知识库 + 已入库出现过的材质 */
  function libMaterials() {
    var set = {};
    ((window.KB_TAGS && window.KB_TAGS.materialDict) || []).forEach(function (m) { set[m] = 1; });
    (window.KB_MATERIALS_CARDS || []).forEach(function (c) {
      var ms = c.materials && c.materials.length ? c.materials : (c.material ? [c.material] : []);
      ms.forEach(function (m) { set[m] = 1; });
    });
    return Object.keys(set).sort();
  }

  /* ---------- 材质词典 ----------
     名字不用 materials：局部变量 var materials 会遮蔽同名函数，导致调用失败 */
  function materialPool(){ return libMaterials(); }

  /* ---------- Prompt ---------- */
  /* 标签一次性给 979 个值会让模型偷懒只填少数字段，
     所以拆成两步：先让它判断适用哪些维度，再逐维度选值。 */
  var MATCH_PROMPT_HEAD =
    '你是家具行业的材质分析助手。用户给你一段文案或一张家具产品图片。\n' +
    '请按「先判断品类 → 再判断材质 → 最后打特性标签」三步分析。\n\n' +
    '第一步 品类（category）：判断这段素材属于哪个家具品类。\n' +
    '库中已有品类及包含的材质：\n' + libOutline() + '\n\n' +
    '第二步 材质（materials）：判断实际用到的材质，' +
    '只能从下面的材质词典中选，可多选，最多 4 个：\n' +
    materialPool().join('、') + '\n' +
    '如果素材没有明确材质信息，materials 返回空数组，不要猜。\n\n' +
    '第三步 特性标签：分两次输出，先选维度再选值，见后续说明。\n' +
    'spec：{ size 规格或尺寸, fit 适用, caution 注意 }，没有依据的字段留空字符串。\n' +
    '   size 填原文明确出现的尺寸/规格（如 1800mm*2000mm、35D、高箱），没有就留空\n' +
    'copy：从原文提取 2-4 条最有卖点的文案，保持原话不改写\n' +
    '如果内容不是家具（如风景照、人物），category 设为空字符串，其余都为空。\n\n' +
    '只输出 JSON，不要解释或 markdown 标记。';

  var MATCH_PROMPT =
    MATCH_PROMPT_HEAD +
    '\n\n本轮任务：完成全部分析，一次性输出。\n' +
    'tags 字段必须按「分类/维度」分组填写，格式示例：\n' +
    '{"tags":{"功能卖点/易洁耐造":["耐高温","易清洁"],"基础属性/主体材质":["岩板"]}}\n' +
    '只填能从素材中明确判断的，最多 10 个标签值，没有把握的维度直接不写。\n' +
    'keywords 从你选的标签值里挑 3-5 个最贴切的。\n\n' +
    '可选维度清单（tags 的键只能从这些里选）：\n' + dimOutline() + '\n\n' +
    '各维度可选值：\n' + valueOutline() + '\n\n' +
    '输出格式：{"category":"","materials":[],"tags":{"分类/维度":["值"]},"keywords":[],' +
    '"spec":{"size":"","fit":"","caution":""},"copy":[],"reason":""}';

  /* ---------- 调用 ---------- */
  function buildUserMessage(text, imageDataUrl) {
    var parts = [];
    if (text && text.trim()) {
      parts.push({ type: 'text', text: '以下是文案内容：\n' + text.trim() });
    }
    if (imageDataUrl) {
      parts.push({ type: 'image_url', image_url: { url: imageDataUrl } });
      parts.push({ type: 'text', text: '请分析这张家具产品图片。' });
    }
    if (!parts.length) throw new Error('没有可分析的内容');
    return parts;
  }

/* 从模型输出里提取第一个完整的 JSON 对象。
     流式输出偶尔会被截断，直接 lastIndexOf('}') 会取到错误位置，
     所以这里逐字符扫描、按括号配对找到真正的结尾。 */
  function sliceJsonObj(s) {
    var start = s.indexOf('{');
    if (start === -1) return null;
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < s.length; i++) {
      var ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;  // 没闭合，被截断了
  }

  /* 输出被截断时，尽量补齐让它能解析：
     补完未闭合的字符串、数组、对象。 */
  function repairJson(s) {
    var out = s;
    var stack = [], inStr = false, esc = false;
    for (var i = 0; i < out.length; i++) {
      var ch = out[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) out += '"';                       // 补未闭合的字符串
    // 去掉可能残缺的尾巴（如 "abc" 后跟了个逗号）
    out = out.replace(/,\s*$/, '');
    while (stack.length) out += stack.pop();      // 补未闭合的括号
    return out;
  }

  function parseJson(s) {
    s = String(s || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '');

    var obj = sliceJsonObj(s);
    if (obj) {
      try { return JSON.parse(obj); }
      catch (e) { obj = null; }
    }
    // 走到这说明被截断了，尝试修补
    var repaired = repairJson(s);
    obj = sliceJsonObj(repaired);
    if (obj) {
      try { return JSON.parse(obj); } catch (e) { /* 继续兜底 */ }
    }
    throw new Error('返回内容不是有效 JSON（可能被截断），请重试');
  }

  function callLLM(systemPrompt, userContent) {
    function once() {
      var answer = '';
      return init().then(function () {
        return cloud.llm.chat.completions.create({
          model: window.KB_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ],
          stream: true,
          response_format: { type: 'json_object' },
          temperature: 1
        });
      }).then(function (chunks) {
        return (async function () {
          for await (var chunk of chunks) {
            var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (d && d.content) answer += d.content;
          }
        })();
      }).then(function () {
        if (!answer.trim()) throw new Error('模型没有返回内容，请重试');
        return parseJson(answer);
      });
    }

    // 流式输出偶尔被截断，重试一次
    return once().catch(function (e) {
      var msg = (e && e.message) || '';
      if (/截断|有效 JSON/.test(msg)) {
        console.warn('输出被截断，重试一次');
        return once();
      }
      throw e;
    });
  }

  /* ---------- 清洗 ---------- */
  function sanitize(raw) {
    var category = normCategory(raw.category);

    var matPool = {};
    materialPool().forEach(function (m) { matPool[m] = 1; });
    var materials = [];
    (Array.isArray(raw.materials) ? raw.materials : []).forEach(function (m) {
      m = String(m).trim();
      if (matPool[m] && materials.indexOf(m) === -1) materials.push(m);
    });
    materials = materials.slice(0, 4);

    var idx = legalIndex();
    var tags = {};
    var rawTags = raw.tags || {};
    Object.keys(rawTags).forEach(function (key) {
      var set = idx[key];
      if (!set) return;
      var keep = [];
      (Array.isArray(rawTags[key]) ? rawTags[key] : [rawTags[key]]).forEach(function (v) {
        v = String(v).trim();
        if (set[v] && keep.indexOf(v) === -1) keep.push(v);
      });
      if (keep.length) tags[key] = keep;
    });

    var kwAllowed = {};
    Object.keys(tags).forEach(function (k) {
      tags[k].forEach(function (v) { kwAllowed[v] = 1; });
    });
    var keywords = [];
    (Array.isArray(raw.keywords) ? raw.keywords : []).forEach(function (k) {
      k = String(k).trim();
      if (kwAllowed[k] && keywords.indexOf(k) === -1) keywords.push(k);
    });
    keywords = keywords.slice(0, 5);
    if (!keywords.length) {
      Object.keys(tags).forEach(function (k) {
        if (keywords.length >= 5) return;
        tags[k].forEach(function (v) {
          if (keywords.indexOf(v) < 0 && keywords.length < 5) keywords.push(v);
        });
      });
    }

    var spec = raw.spec || {};
    var copy = (Array.isArray(raw.copy) ? raw.copy : [])
      .map(function (c) { return String(c || '').trim(); })
      .filter(Boolean).slice(0, 4);

    return {
      category: category,
      materials: materials,
      tags: tags,
      keywords: keywords,
      spec: {
        size: String(spec.size || spec.density || '').trim().slice(0, 40),
        fit: String(spec.fit || '').trim().slice(0, 40),
        caution: String(spec.caution || '').trim().slice(0, 60)
      },
      copy: copy,
      reason: String(raw.reason || '').trim().slice(0, 60)
    };
  }

  function matchMaterial(opts) {
    var text = opts.text || '';
    var imageDataUrl = opts.imageDataUrl || null;
    if (!text.trim() && !imageDataUrl) return Promise.reject(new Error('没有可分析的内容'));
    return callLLM(MATCH_PROMPT, buildUserMessage(text, imageDataUrl))
      .then(function (raw) {
        return sanitize(raw);
      });
  }

  function tagsForDb(tags){
    var flat = [], dim = {};
    // 兼容两种入参：扁平的字符串数组，或 { '分类/维度': [值] }
    if(Array.isArray(tags)){
      tags.forEach(function(v){ if(v && flat.indexOf(v) === -1) flat.push(v); });
      return { flat: flat, dim: dim };
    }
    Object.keys(tags || {}).forEach(function(k){
      var arr = tags[k];
      if(!Array.isArray(arr)) arr = [arr];
      arr.forEach(function(v){
        if(!v) return;
        if(flat.indexOf(v) === -1) flat.push(v);
        (dim[k] = dim[k] || []);
        if(dim[k].indexOf(v) === -1) dim[k].push(v);
      });
    });
    return { flat: flat, dim: dim };
  }

  function save(note) {
    // 新建：自动记第一条「创建」记录
    var n = Object.assign({}, note);
    if(!Array.isArray(n._history) || !n._history.length){
      n._history = [{ t: Date.now(), a: 'create', by: n._actor || '', d: {} }];
    }
    return init().then(function () {
      return cloud.database.from(TABLE).insert(buildPayload(n)).select();
    }).then(function (r) {
      if (r && r.error) throw new Error(r.error.message || '保存失败');
      return (r && r.data && r.data[0]) || null;
    });
  }

  /* 解析 raw_text（存放扩展信息 + 修改记录） */
  function parseRaw(v){
    try{ var o = JSON.parse(v || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch(e){ return {}; }
  }

  /* 比较两版内容，得出变化了哪些字段 */
  function diffFields(before, after){
    var out = {};
    var keys = {
      material: '材质', category: '品类', keywords: '关键词', tags: '标签'
    };
    Object.keys(keys).forEach(function(k){
      var a = Array.isArray(before[k]) ? before[k].join('、') : String(before[k] || '');
      var b = Array.isArray(after[k])  ? after[k].join('、') : String(after[k]  || '');
      if(a !== b) out[k] = { from: a, to: b, label: keys[k] };
    });
    // 三行句子
    [['scene','使用场景'],['pain','痛点人群'],['sell','卖点优势']].forEach(function(p){
      var a = (before.lines && before.lines[p[0]]) || '';
      var b = (after.lines  && after.lines[p[0]])  || '';
      if(a !== b) out['line_' + p[0]] = { from: a, to: b, label: p[1] };
    });
    return out;
  }

  function buildPayload(note){
    var t = tagsForDb(note.tags);
    var spec = note.spec || {};
    return {
      category: note.category || '',
      material: (note.materials && note.materials[0]) || note.material || '',
      source_text: (note.sourceText || '').slice(0, 2000),
      feel: (note.keywords || []).slice(0, 5).join(','),
      tags: t.flat,
      copy_items: note.copy || [],
      fit: spec.fit || '',
      caution: spec.caution || '',
      raw_text: JSON.stringify(Object.assign({}, note._rawExtra || {}, {
        appliesTo: note.appliesTo || (note._rawExtra && note._rawExtra.appliesTo) || [note.category || '未分类'],
        materials: note.materials || [],
        keywords: note.keywords || [],
        tagDims: t.dim,
        size: spec.size || '',
        title: note.title || '',
        lines: note.lines || null,
        history: note._history || []
      })),
      confidence: note.confidence == null ? null : note.confidence
    };
  }

  /* 更新一条记录，同时把变更写进修改记录 */
  function update(id, note) {
    return init().then(function () {
      // 先读旧值，才能算出改了哪些字段
      return cloud.database.from(TABLE).select().eq('id', id);
    }).then(function (r) {
      var old = (r && r.data && r.data[0]) || null;
      if (!old) throw new Error('记录不存在，可能已被删除');
      var before = {
        material: old.material,
        category: old.category,
        keywords: String(old.feel || '').split(',').filter(Boolean),
        tags: Array.isArray(old.tags) ? old.tags : [],
        lines: parseRaw(old.raw_text).lines || null
      };
      var after = {
        material: (note.materials && note.materials[0]) || note.material || '',
        category: note.category || '',
        keywords: note.keywords || [],
        tags: note.tags || [],
        lines: note.lines || null
      };
      var changes = diffFields(before, after);
      var n = Object.assign({}, note);
      n._rawExtra = parseRaw(old.raw_text);
      if (n.confidence == null) n.confidence = old.confidence;
      if (n.sourceText == null) n.sourceText = old.source_text || '';
      if (!n.spec) n.spec = { size: n._rawExtra.size || '', fit: old.fit || '', caution: old.caution || '' };
      if (n.title == null) n.title = n._rawExtra.title || '';
      // 沿用旧的记录，再追加本次
      n._history = (parseRaw(old.raw_text).history || []).concat([
        { t: Date.now(), a: 'edit', by: note._actor || '', d: changes }
      ]);
      if (n._history.length > 50) n._history = n._history.slice(-50);
      return cloud.database.from(TABLE).update(buildPayload(n)).eq('id', id).select();
    }).then(function (r) {
      if (r && r.error) throw new Error(r.error.message || '更新失败');
      return (r && r.data && r.data[0]) || null;
    });
  }

  function remove(id) {
    return init().then(function () {
      return cloud.database.from(TABLE).delete().eq('id', id).select();
    }).then(function (r) {
      if (r && r.error) throw new Error(r.error.message || '删除失败');
      return (r && r.data) || [];
    });
  }

  /* 读取全部记录（全局共享，不区分设备与账号） */
  function list() {
    return init().then(function () {
      return cloud.database.from(TABLE).select();
    }).then(function (r) {
      if (r && r.error) throw new Error(r.error.message || '读取失败');
      return (r && r.data) || [];
    });
  }

  /* ---------- 批量：把文档拆成多个产品 ---------- */
  var BATCH_PROMPT =
    '你是家具行业的材质分析助手。用户给你一份文档片段，里面可能包含多个产品的说明。\n' +
    '请识别出其中有几个产品，每个产品的信息如下：\n\n' +
    '库中已有品类及包含的材质：\n' + libOutline() + '\n\n' +
    '可选材质词典（category 之外的 materials 只能从这里选）：\n' + materialPool().join('、') + '\n\n' +
    '每个产品包含：\n' +
    '- title：这个产品的名称或型号，没有就写空字符串\n' +
    '- desc：提取这个产品最有价值的卖点文案，保持原话，最多 3 条\n' +
    '- category：品类，只能从上面的品类列表里选\n' +
    '- materials：材质数组，从材质词典里选，没有就空数组\n' +
    '- tags：按「分类/维度」结构打标，标签值必须来自下面清单\n' +
    '- keywords：3-5 个关键词概括材质特性\n' +
    '- spec：{ size 规格尺寸, fit 适用, caution 注意 }，没依据就留空\n\n' +
    '标签清单：\n' + valueOutline() + '\n\n' +
    '要求：\n' +
    '0. 输入里每一行以「|」分隔各列。若首行是表头（如「型号 | 品类 | 材质」），' +
    '请按表头含义理解各列；**忽略 ID、链接、编码、日期这类无关列**\n' +
    '1. products 数组长度要与文档里的产品数一致，一款一款\n' +
    '2. 如果这段文字不是产品说明（比如目录、说明、页眉），返回空数组\n' +
    '3. 没有依据的字段宁可留空，也不要编造\n' +
    '4. **category 必须是上面品类列表里的原词**，不要自造（如不能写「儿童床」，应写「床」）\n' +
    '5. **materials 必须是数组**，不要写成「白蜡木、松木」这种字符串\n' +
    '6. **tags 的键必须是「分类/维度」格式**（如「功能卖点/易洁耐造」），' +
    '不要用「材质」「特点」「场景」这类自定义分组名\n' +
    '7. 不要返回空的占位对象，无法判断就跳过该产品\n\n' +
    '只输出 JSON。格式：\n' +
    '{"products":[{"title":"","desc":[],"category":"","materials":[],"tags":{},\n' +
    '"keywords":[],"spec":{"size":"","fit":"","caution":""}}]}';

  /**
   * 切块：按空行/表格行聚合成适合 LLM 处理的片段
   * blocks: [{type,text,cols}]
   */
  function chunkBlocks(blocks, maxChars){
    /* 表格类文档按「行数」分批：一次给模型一批产品，
       比逐行调用省几十倍时间与费用。 */
    var rows = blocks.filter(function(b){ return b.type === 'row' && (b.text || '').trim(); });
    if(rows.length > 1){
      var PER = 12;   // 每次 12 行
      var out = [];
      for(var i = 0; i < rows.length; i += PER){
        var slice = rows.slice(i, i + PER);
        var lines = slice.map(function(b){ return b.text; });
        // 把表头（第一行）重复带上，模型才知道每列的含义
        if(i > 0 && blocks[0] && blocks[0].text && blocks[0].text !== lines[0]){
          lines.unshift(blocks[0].text);
        }
        out.push(lines.join('\n'));
      }
      return out;
    }

    maxChars = maxChars || 2200;
    var chunks = [], cur = [], len = 0;
    function flush(){
      if(cur.length){
        chunks.push(cur.map(function(b){ return b.text; }).join('\n'));
        cur = []; len = 0;
      }
    }
    blocks.forEach(function(b){
      var t = b.text || '';
      if(!t.trim()) return;
      if(len + t.length > maxChars) flush();
      cur.push(b); len += t.length;
    });
    flush();
    return chunks;
  }

  /* 从模型输出里挑一个最像的合法品类 */
  /* 模型有时会把 tags 的键写成自定义分组名（材质/特点/场景），
     而不是要求的「分类/维度」路径。这里按标签值反查真实归属。 */
  var TAG_VAL_TO_KEYS = null;
  function tagValueKeys(){
    if(!TAG_VAL_TO_KEYS){
      TAG_VAL_TO_KEYS = {};
      var t = tagTree();
      Object.keys(t).forEach(function(cat){
        Object.keys(t[cat]).forEach(function(dim){
          t[cat][dim].values.forEach(function(v){
            (TAG_VAL_TO_KEYS[v] = TAG_VAL_TO_KEYS[v] || []).push(cat + '/' + dim);
          });
        });
      });
    }
    return TAG_VAL_TO_KEYS;
  }

  /* 把任意形态的标签归一成 { '分类/维度': [值] } */
  function normTags(raw){
    var idx = legalIndex();
    var out = {};
    var v2k = tagValueKeys();
    Object.keys(raw || {}).forEach(function(key){
      var vals = raw[key];
      if(!Array.isArray(vals)) vals = [vals];
      vals.forEach(function(v0){
        var v = String(v0 || '').trim();
        if(!v) return;
        // 情况 1：键就是合法的「分类/维度」
        if(idx[key] && idx[key][v]){
          (out[key] = out[key] || []).push(v);
          return;
        }
        // 情况 2：键不合法，按标签值反查真实归属
        var owners = v2k[v];
        if(!owners || !owners.length) return;
        // 优先落在键名能匹配的分类下
        var pick = owners[0];
        for(var i=0;i<owners.length;i++){
          if(key && owners[i].indexOf(key) > -1){ pick = owners[i]; break; }
        }
        var bucket = out[pick] = out[pick] || [];
        if(bucket.indexOf(v) === -1) bucket.push(v);
      });
    });
    Object.keys(out).forEach(function(k){
      out[k] = out[k].filter(function(v,i,a){ return a.indexOf(v)===i; });
    });
    return out;
  }

  /* materials 可能是数组、字符串（顿号分隔）或单值；
     且常带修饰词（「白蜡木实木框架」），需要匹配回词典里的材质名。 */
  function normMaterials(v){
    var pool = materialPool();
    var matPool = {};
    pool.forEach(function(m){ matPool[m] = 1; });
    var list = [];
    if(Array.isArray(v)) list = v.slice();
    else if(typeof v === 'string'){
      list = v.split(/[、,，;；\/\s]+/).filter(Boolean);
    } else if(v) list = [v];
    var out = [];
    list.forEach(function(m){
      var str = String(m).trim();
      if(!str) return;
      if(matPool[str]){
        if(out.indexOf(str) === -1) out.push(str);
        return;
      }
      // 去掉修饰词：取最长匹配，避免「实木」吃掉「多层实木」
      var hit = pool.filter(function(mm){
        return mm.length >= 2 && str.indexOf(mm) > -1;
      });
      hit.sort(function(a,b){ return b.length - a.length; });
      if(hit.length && out.indexOf(hit[0]) === -1) out.push(hit[0]);
    });
    return out.slice(0, 4);
  }

  function normCategory(v){
    var groups = {};
    categories().forEach(function(c){ groups[c.name] = 1; });
    // 已入库卡片里的品类也算合法
    (window.KB_MATERIALS_CARDS || []).forEach(function(c){ groups[c.group] = 1; });
    var alias = (window.KB_TAGS && window.KB_TAGS.categoryAlias) || {};
    var s = String(v || '').trim();
    if(!s) return '';
    if(groups[s]) return s;
    if(alias[s] && groups[alias[s]]) return alias[s];
    // 库名包含候选词（取最长，避免「软包床」被「床」吃掉）
    var hit = Object.keys(groups).filter(function(g){ return s.indexOf(g) > -1; });
    if(hit.length){
      hit.sort(function(a,b){ return b.length - a.length; });
      return hit[0];
    }
    // 反向：候选名包含输入
    var rev = Object.keys(groups).filter(function(g){ return g.indexOf(s) > -1; });
    if(rev.length){
      rev.sort(function(a,b){ return a.length - b.length; });
      return rev[0];
    }
    return '';
  }

  function sanitizeProduct(p){
    var mats = normMaterials(p.materials);
    var tags = normTags(p.tags);

    var allowed = {};
    Object.keys(tags).forEach(function(k){
      tags[k].forEach(function(v){ allowed[v] = 1; });
    });
    var kw = [];
    (Array.isArray(p.keywords) ? p.keywords : [p.keywords]).forEach(function(k){
      k = String(k || '').trim();
      if(allowed[k] && kw.indexOf(k) === -1) kw.push(k);
    });
    kw = kw.slice(0, 5);
    if(!kw.length){
      Object.keys(tags).forEach(function(k){
        if(kw.length >= 5) return;
        tags[k].forEach(function(v){
          if(kw.indexOf(v) === -1 && kw.length < 5) kw.push(v);
        });
      });
    }

    var spec = p.spec || {};
    var desc = (Array.isArray(p.desc) ? p.desc : [p.desc])
      .map(function(d){ return String(d || '').trim(); })
      .filter(Boolean).slice(0, 3);

    return {
      title: String(p.title || '').trim().slice(0, 60),
      desc: desc,
      category: normCategory(p.category),
      materials: mats,
      tags: tags,
      keywords: kw,
      spec: {
        size: String(spec.size || spec.density || '').trim().slice(0, 40),
        fit: String(spec.fit || '').trim().slice(0, 40),
        caution: String(spec.caution || '').trim().slice(0, 60)
      }
    };
  }

  /**
   * 批量识别文档
   * blocks:  [{type,text,cols}]  doc-parse.js 的输出
   * onProgress(done,total) 回调
   */
  /* opts: { start, limit, signal, onBatch }
     start  从第几批开始（续跑用）
     limit  本次最多处理几批，超出后把下一批号带回来等续跑
     onBatch(批内产品数组, 已完成批号)  每完成一批回调一次 */
  function matchDocument(blocks, onProgress, opts){
    opts = opts || {};
    var chunks = chunkBlocks(blocks);
    if(!chunks.length) return Promise.resolve([]);
    var start = opts.start || 0;
    var limit = opts.limit || 0;          // 0 = 不限制
    var total = chunks.length;
    var maxBatch = limit ? Math.min(total, start + limit) : total;
    var out = [];
    var errs = [];

    function step(i){
      if(i >= maxBatch) return Promise.resolve(out);
      if(opts.signal && opts.signal.aborted) return Promise.resolve(out);
      if(onProgress) onProgress(i - start, maxBatch - start, total, i);
      return callLLM(BATCH_PROMPT, [{ type:'text', text: chunks[i] }])
        .then(function(raw){
          var ps = Array.isArray(raw.products) ? raw.products : [];
          ps.forEach(function(p){
            var item = sanitizeProduct(p);
            // 必须至少识别出「标题/卖点 + 品类 + 材质」之一才算一条产品，
            // 否则过滤掉，避免模型返回空壳对象
            var hasContent = item.title || item.desc.length;
            var hasClassify = item.category && item.materials.length;
            if(hasContent && (item.category || item.materials.length || Object.keys(item.tags).length)){
              item._chunk = i;
              out.push(item);
            }
          });
        })
        .catch(function(e){
          // 单块失败不中断整体，但记下原因供提示
          errs.push((e && e.message) ? e.message : String(e));
          console.warn('第 ' + (i + 1) + ' 块识别失败：' + ((e && e.message) || e));
        })
        .then(function(){
          if(opts.onBatch && out.length) opts.onBatch(out, i);
          return step(i + 1);
        });
    }
    return step(start).then(function(){
      if(onProgress) onProgress(maxBatch - start, maxBatch - start, total, maxBatch);
      // 全失败时把原因带出去，便于界面给准确提示
      if (!out.length && errs.length) {
        var e = new Error(errs[0]);
        e._allFailed = true;
        e._reason = errs.join(' / ');
        throw e;
      }
      // 数组上挂进度，方便界面判断是否还有下一批
      out._progress = { done: maxBatch, total: total, next: maxBatch < total ? maxBatch : null };
      out._errors = errs;
      return out;
    });
  }

  window.KB_INGEST = {
    update: update,
    matchMaterial: matchMaterial,
    matchDocument: matchDocument,
    save: save,
    list: list,
    remove: remove,
    dimOutline: dimOutline
  };
})();