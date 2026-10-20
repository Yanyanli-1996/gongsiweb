/* ==========================================================
   AI 识别 —— 面板界面
   两个入口：识别入库 / 识别材质特性
   ========================================================== */
(function () {
  var SDK = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@0.1.4-dev.ca27990.202610161713/lib/index.global.js';

  var st = {
    text: '', imageDataUrl: '', busy: false, result: null, mode: 'save',
    blocks: null,      // 文档解析后的块
    docName: '',       // 文档文件名
    cursor: 0,         // 已完成到第几批（续跑用）
    totalBatches: 0,   // 总批数
    auto: false,       // 是否自动连续识别
    stop: false,       // 用户要求暂停
    batch: null        // 批量识别结果
  };

  /* ---------- 注入 ---------- */
  function mount() {
    var panel = document.createElement('div');
    panel.className = 'ai-panel';
    panel.id = 'aiPanel';
    panel.innerHTML =
      '<div class="ai-head"><span class="t">AI 识别</span>' +
      '<button class="ai-close" id="aiClose" aria-label="关闭">&times;</button></div>' +
      '<div class="ai-body">' +

        '<div class="ai-step"><div class="ai-step-h"><span class="n">1</span>' +
          '<span id="aiStepHint">放入文案、图片或文档</span></div>' +
          '<div class="ai-drop" id="aiDrop" tabindex="0" aria-label="粘贴区，可直接粘贴图片或文字">' +
            '<div class="big">在此处 Ctrl+V 粘贴</div>' +
            '<div class="small">截图、图片、文字都可以粘</div>' +
            '<div class="ai-pickrow">' +
              '<button type="button" class="ai-pick" id="aiPick">选择图片</button>' +
              '<button type="button" class="ai-pick doc" id="aiDocBtn">选择文档</button>' +
            '</div>' +
            '<div class="ai-docnote">支持 Word / Excel / TXT / CSV，可含多个产品</div>' +
            '<div id="aiPrev"></div>' +
          '</div>' +
          '<input type="file" id="aiFile" accept="image/*" hidden>' +
          '<input type="file" id="aiDocFile" accept=".docx,.xlsx,.txt,.md,.csv,.tsv,.log" hidden>' +
          '<div style="margin-top:10px">' +
            '<textarea class="ai-text" id="aiText" placeholder="把文案粘贴到这里，例如：&#10;白蜡木实木床，加宽加厚无结松木排骨架，1800mm*2000mm"></textarea>' +
          '</div>' +
        '</div>' +

        '<div class="ai-actions">' +
          '<button class="btn-primary" id="aiRun">开始识别</button>' +
          '<button class="btn-ghost" id="aiClear">清空</button>' +
          '<span class="ai-msg busy" id="aiHint">文案和图片可以只传一个</span>' +
        '</div>' +

        '<div id="aiOut"></div>' +
      '</div>';

    var mask = document.createElement('div');
    mask.className = 'ai-mask';
    mask.id = 'aiMask';

    document.body.appendChild(mask);
    document.body.appendChild(panel);
    bind();
  }

  /* ---------- 事件 ---------- */
  function bind() {
    var drop = document.getElementById('aiDrop');
    var file = document.getElementById('aiFile');
    var text = document.getElementById('aiText');

    document.getElementById('aiTrigger').onclick = function () { open('save'); };
    document.getElementById('aiMatchTrigger').onclick = function () { open('match'); };
    document.getElementById('aiClose').onclick = close;
    document.getElementById('aiMask').onclick = close;
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.getElementById('aiPanel').classList.contains('on')) close();
    });

    drop.onclick = function (e) {
      if (e.target.closest('#aiPick')) return;
      drop.focus();
    };
    drop.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); }
    };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = function () { drop.classList.remove('over'); };
    // ondrop 绑定在下方（同时处理图片与文档）
    drop.onpaste = function (e) {
      if (handlePaste(e)) e.preventDefault();
    };
    file.onchange = function () { if (file.files[0]) handleFile(file.files[0]); };

    var pick = document.getElementById('aiPick');
    if (pick) pick.onclick = function (e) { e.stopPropagation(); file.click(); };

    // 文档上传
    var docInput = document.getElementById('aiDocFile');
    var docBtn = document.getElementById('aiDocBtn');
    if (docBtn) docBtn.onclick = function (e) { e.stopPropagation(); docInput.click(); };
    if (docInput) docInput.onchange = function () {
      if (docInput.files[0]) handleDocFile(docInput.files[0]);
    };

    // 拖入文档
    drop.ondrop = function (e) {
      e.preventDefault(); drop.classList.remove('over');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (/^image\//.test(f.type)) handleFile(f);
      else handleDocFile(f);
    };

    text.oninput = function () { st.text = text.value; };

    document.getElementById('aiRun').onclick = run;
    document.getElementById('aiClear').onclick = function () {
      st.text = ''; st.imageDataUrl = ''; st.result = null; st.blocks = null; st.docName = '';
      text.value = '';
      document.getElementById('aiPrev').innerHTML = '';
      document.getElementById('aiOut').innerHTML = '';
      setHint('已清空');
    };
  }

  /* 文档：解析 → 显示预览 → 交给批量识别 */
  function handleDocFile(f){
    setHint('正在解析文档…');
    KB_DOC.parse(f).then(function(blocks){
      st.blocks = blocks;
      st.docName = f.name;
      st.cursor = 0; st.totalBatches = 0; st.stop = false;
      st.batch = null; st.found = null;
      var rows = blocks.filter(function(b){ return b.type === 'row'; }).length;
      var paras = blocks.length - rows;
      var preview = blocks.slice(0, 6).map(function(b){
        return '<div class="ai-blk"><span class="bt">' +
          (b.type === 'row' ? '表格行' : '段落') + '</span>' +
          escapeHtml(b.text.slice(0, 100)) + '</div>';
      }).join('');
      document.getElementById('aiPrev').innerHTML =
        '<div class="ai-docok">' +
          '<div class="ai-docname">' + escapeHtml(f.name) + '</div>' +
          '<div class="ai-docmeta">' + (f.size / 1024).toFixed(0) + ' KB · ' +
            blocks.length + ' 个段落/行（文本 ' + paras + ' · 表格行 ' + rows + '）</div>' +
          '<div class="ai-blks">' + preview +
            (blocks.length > 6 ? '<div class="ai-blk more">… 还有 ' + (blocks.length - 6) + ' 段</div>' : '') +
          '</div>' +
        '</div>';
      setHint('文档已解析，共 ' + blocks.length + ' 段，点「开始识别」自动拆分产品');
    }).catch(function(e){
      setHint('解析失败：' + ((e && e.message) ? e.message : e), 'err');
    });
  }

  function open(mode) {
    st.mode = mode || 'save';
    document.getElementById('aiOut').innerHTML = '';
    document.querySelector('.ai-head .t').textContent =
      st.mode === 'match' ? 'AI 识别材质特性' : 'AI 识别入库';
    document.getElementById('aiStepHint').textContent =
      st.mode === 'match' ? '放入文案或图片，自动匹配品类与标签' : '放入文案或图片，识别后入库';
    document.getElementById('aiRun').textContent =
      st.mode === 'match' ? '开始匹配' : '开始识别';
    document.getElementById('aiMask').classList.add('on');
    document.getElementById('aiPanel').classList.add('on');
  }
  function close() {
    document.getElementById('aiMask').classList.remove('on');
    document.getElementById('aiPanel').classList.remove('on');
  }

  /* ---------- 粘贴 ---------- */
  function handlePaste(e) {
    var dt = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
    if (!dt) return false;
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          var f = it.getAsFile();
          if (f) { handleFile(f); return true; }
        }
      }
    }
    var t = dt.getData('text/plain');
    if (t && t.trim()) {
      var ta = document.getElementById('aiText');
      ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n') : '') + t;
      st.text = ta.value;
      setHint('已粘贴文案 ' + t.trim().length + ' 字');
      return true;
    }
    return false;
  }

  /* ---------- 图片 ---------- */
  function handleFile(f) {
    if (!/^image\//.test(f.type)) { setHint('请选择图片文件', 'err'); return; }
    if (f.size > 4 * 1024 * 1024) { setHint('图片太大，请压缩到 4MB 以内', 'err'); return; }
    var r = new FileReader();
    r.onload = function (e) {
      st.imageDataUrl = e.target.result;
      document.getElementById('aiPrev').innerHTML =
        '<img class="ai-preview" src="' + st.imageDataUrl + '" alt="预览">' +
        '<div class="ai-file-row"><span>' + escapeHtml(f.name) + '</span>' +
        '<span style="color:var(--text-3)">' + (f.size / 1024).toFixed(0) + ' KB</span></div>';
      setHint('图片已就绪');
    };
    r.onerror = function () { setHint('图片读取失败', 'err'); };
    r.readAsDataURL(f);
  }

  function setHint(txt, kind) {
    var el = document.getElementById('aiHint');
    el.className = 'ai-msg ' + (kind || 'busy');
    el.textContent = txt;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 执行 ---------- */
  /* 文档批量识别：自动连续处理下一批，直到全部完成或用户暂停 */
  function runDocument(){
    var btn = document.getElementById('aiRun');
    /* 累积结果存在 st.found 里：暂停后点「继续识别」要接着之前的，
       不能每次从零开始（否则前面的批次白识别了）。 */
    var collected = st.found || (st.found = []);
    st.stop = false;
    btn.textContent = '暂停';

    function oneBatch(){
      return KB_INGEST.matchDocument(st.blocks, function(done, batchTotal, total, cursor){
        var pct = total ? Math.round(cursor / total * 100) : 0;
        setHint('识别中 第 ' + cursor + ' / ' + total + ' 批（' + pct + '%）' +
                (collected.length ? '，已识别 ' + collected.length + ' 个产品' : ''), '');
      }, {
        start: st.cursor,
        limit: 1
      }).then(function(list){
        Array.prototype.push.apply(collected, list);
        var pg = list._progress || {};
        st.cursor = pg.done || 0;
        st.totalBatches = pg.total || 0;
        return pg;
      });
    }

    function loop(){
      if (st.stop) return Promise.resolve({ stopped:true });
      return oneBatch().then(function(pg){
        if (!pg || pg.done >= pg.total){
          return { done:true, total: pg ? pg.total : 0 };
        }
        return loop();   // 还有下一批，继续
      });
    }

    loop().then(function(info){
      if (info && info.stopped){
        st.batch = collected;
        renderBatch(collected);
        setHint('已暂停在第 ' + st.cursor + ' / ' + st.totalBatches + ' 批，' +
                '已识别 ' + collected.length + ' 个产品', '');
        return;
      }
      if (!collected.length){
        setHint('文档里没识别出产品。若是产品清单表格，请确认含「型号 + 卖点」等描述列。', 'err');
        return;
      }
      st.batch = collected;
      renderBatch(collected);
      setHint('全部识别完成：共 ' + st.totalBatches + ' 批，识别出 ' +
              collected.length + ' 个产品，勾选后入库', 'ok');
    })
    .catch(function(e){
      if (e && e._allFailed){
        setHint('识别失败：' + (e._reason || e.message) + '\n可点「重新识别」再试一次', 'err');
      } else {
        setHint('识别失败：' + ((e && e.message) ? e.message : e), 'err');
      }
    })
    .finally(function(){
      st.busy = false;
      st.stop = false;
      btn.disabled = false;
      // 还有剩余批次就显示「继续识别」，否则回到「重新识别」
      if (st.cursor && st.cursor < st.totalBatches){
        btn.textContent = '继续识别';
      } else {
        btn.textContent = st.cursor ? '重新识别' : '开始识别';
      }
    });
  }

  function run() {
    /* 识别中点按钮 = 暂停 */
    if (st.busy && st.blocks && st.blocks.length){
      st.stop = true;
      var b = document.getElementById('aiRun');
      b.textContent = '正在暂停…';
      return;
    }
    if (st.busy) return;
    if (!st.text.trim() && !st.imageDataUrl && !st.blocks) { setHint('请先放入文案、图片或文档', 'err'); return; }
    // 从头识别（不是续跑）时清空累积结果
    if(!st.cursor) st.found = null;
    st.busy = true;
    var btn = document.getElementById('aiRun');
    // 文档识别时不禁用按钮 —— 它是「暂停」开关，必须可点
    btn.disabled = !st.blocks;
    document.getElementById('aiOut').innerHTML = '';

    // 文档 → 批量识别（可自动连续处理多批）
    if (st.blocks && st.blocks.length) {
      st.auto = true;
      runDocument();
      return;
    }

    setHint('识别中，约需 10–25 秒…');
    KB_INGEST.matchMaterial({ text: st.text, imageDataUrl: st.imageDataUrl })
      .then(function (r) {
        st.result = r;
        renderResult(r);
        setHint(r.category ? '识别完成' : '未能判断出品类，可手动补全', 'ok');
      })
      .catch(function (e) {
        setHint('识别失败：' + ((e && e.message) ? e.message : e), 'err');
      })
      .finally(function () {
        st.busy = false;
        btn.disabled = false;
      });
  }

  /* ---------- 批量结果 ---------- */
  function renderBatch(list){
    var out = document.getElementById('aiOut');
    out.innerHTML =
      '<div class="ai-result">' +
        '<div class="ai-step-h" style="margin-bottom:8px"><span class="n">2</span>' +
          '识别出 ' + list.length + ' 个产品（来源：' + escapeHtml(st.docName || '文档') + '）</div>' +
        '<div class="ai-batchbar">' +
          '<button class="btn-ghost" id="btAll">全选</button>' +
          '<button class="btn-ghost" id="btNone">全不选</button>' +
          '<span class="ai-msg busy" id="btHint">勾选要入库的产品</span>' +
        '</div>' +
        list.map(function(p, i){
          var tagCount = 0;
          Object.keys(p.tags || {}).forEach(function(k){ tagCount += p.tags[k].length; });
          return '<label class="ai-item">' +
            '<input type="checkbox" data-bi="' + i + '" checked>' +
            '<div class="ai-itemmain">' +
              '<div class="ai-pickhead">' +
                '<span class="ai-picktitle">' + escapeHtml(p.title || ('产品 ' + (i+1))) + '</span>' +
                (p.category ? '<span class="ai-pickcat">' + escapeHtml(p.category) + '</span>'
                            : '<span class="ai-pickcat warn">品类未识别</span>') +
              '</div>' +
              (p.materials.length
                ? '<div class="ai-pickmats">' + p.materials.map(escapeHtml).join('、') + '</div>'
                : '<div class="ai-pickmats warn">材质未识别</div>') +
              (p.keywords.length
                ? '<div class="ai-pickkw">' + p.keywords.map(escapeHtml).join('、') + '</div>' : '') +
              (p.desc.length
                ? '<div class="ai-pickdesc">' + p.desc.map(function(d){
                    return '<div>' + escapeHtml(d) + '</div>';
                  }).join('') + '</div>' : '') +
              '<div class="ai-picktags">已打 ' + tagCount + ' 个标签' +
                (Object.keys(p.tags).length
                  ? ' · ' + Object.keys(p.tags).map(function(k){
                      return escapeHtml(k.split('/')[0]);
                    }).filter(function(v, i, a){ return a.indexOf(v) === i; }).join(' / ')
                  : '') +
              '</div>' +
            '</div>' +
          '</label>';
        }).join('') +
        '<div class="ai-actions" style="margin-top:14px">' +
          '<button class="btn-primary" id="btSave">入库选中项</button>' +
          '<button class="btn-ghost" id="aiRe">重新识别</button>' +
        '</div>' +
        '<div class="ai-msg" id="saveMsg"></div>' +
      '</div>';

    out.querySelector('#btAll').onclick = function () {
      out.querySelectorAll('[data-bi]').forEach(function(c){ c.checked = true; });
    };
    out.querySelector('#btNone').onclick = function () {
      out.querySelectorAll('[data-bi]').forEach(function(c){ c.checked = false; });
    };
    out.querySelector('#btSave').onclick = saveBatch;
    out.querySelector('#aiRe').onclick = run;
  }

  function saveBatch(){
    var out = document.getElementById('aiOut');
    var msg = out.querySelector('#saveMsg');
    var idxs = [];
    out.querySelectorAll('[data-bi]').forEach(function(c){
      if (c.checked) idxs.push(Number(c.dataset.bi));
    });
    if (!idxs.length) {
      msg.className = 'ai-msg err';
      msg.textContent = '请至少勾选一个产品';
      return;
    }
    var btn = out.querySelector('#btSave');
    btn.disabled = true;
    msg.className = 'ai-msg busy';
    msg.textContent = '入库中 0 / ' + idxs.length + '…';

    var i = 0, ok = 0, failed = [];
    function next(){
      if (i >= idxs.length) {
        msg.className = 'ai-msg ' + (failed.length ? 'err' : 'ok');
        msg.textContent = failed.length
          ? ('已入库 ' + ok + ' 条，失败 ' + failed.length + ' 条：' + failed.join('、'))
          : ('已入库 ' + ok + ' 条');
        window.KB_RELOAD_USER_NOTES();
        st.blocks = null; st.docName = ''; st.batch = null;
        setHint('入库完成');
        if (!failed.length) setTimeout(function () {
          document.getElementById('aiPrev').innerHTML = '';
          document.getElementById('aiOut').innerHTML = '';
        }, 1200);
        return;
      }
      var p = st.batch[idxs[i]];
      KB_INGEST.save({
        category: p.category,
        materials: p.materials,
        keywords: p.keywords,
        tags: p.tags,
        title: p.title || '',
        copy: (p.desc || []).map(function (d, k) { return { type: '文案' + (k + 1), text: d }; }),
        lines: null,
        spec: p.spec,
        sourceText: (p.title || '') + ' ' + (p.desc || []).join(' '),
        _actor: (window.KB_ACTOR ? window.KB_ACTOR() : '')
      }).then(function () { ok++; })
        .catch(function (err) { failed.push((p.title || ('产品'+(i+1))) + '（' + ((err&&err.message)||err) + '）'); })
        .then(function () {
          i++;
          msg.textContent = '入库中 ' + i + ' / ' + idxs.length + '…';
          next();
        });
    }
    next();
  }

  /* ---------- 结果 ---------- */
  function categories(){
    return (window.KB_TAGS && window.KB_TAGS.categories) || [];
  }
  /* 材质词典：内置知识库 + 已入库出现过的材质 */
  function libMaterials() {
    var out = {};
    ((window.KB_TAGS && window.KB_TAGS.materialDict) || []).forEach(function (m) { out[m] = 1; });
    (window.KB_MATERIALS_CARDS || []).forEach(function (c) {
      var ms = c.materials && c.materials.length ? c.materials : (c.material ? [c.material] : []);
      ms.forEach(function (m) { out[m] = 1; });
    });
    return Object.keys(out).sort();
  }

  function renderResult(r) {
    var out = document.getElementById('aiOut');

    var groups = {};
    categories().forEach(function (c) { groups[c.name] = 1; });
    (window.KB_MATERIALS_CARDS || []).forEach(function (e) { groups[e.group] = 1; });
    var catOpts = '<option value="">— 未识别 —</option>' +
      Object.keys(groups).sort().map(function (g) {
        return '<option value="' + escapeHtml(g) + '"' + (r.category === g ? ' selected' : '') + '>' + escapeHtml(g) + '</option>';
      }).join('');

    var mats = libMaterials();
    var matHtml = '<option value="">— 请选择材质 —</option>' +
      mats.map(function (m) {
        var on = (r.materials || []).indexOf(m) > -1;
        return '<option value="' + escapeHtml(m) + '"' + (on ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
      }).join('');

    /* 标签：按分类/维度分组，全部列出可点选 */
    var tagHtml = '';
    var TREE = (window.KB_TAGS && window.KB_TAGS.tree) || {};
    Object.keys(TREE).forEach(function (cat) {
      var dims = TREE[cat];
      var rows = '';
      Object.keys(dims).forEach(function (dim) {
        var key = cat + '/' + dim;
        var sel = (r.tags && r.tags[key]) || [];
        rows += '<div class="ai-dim"><div class="ai-dim-h">' + escapeHtml(dim) + '</div><div class="ai-tags">';
        dims[dim].values.forEach(function (v) {
          rows += '<span class="ai-tg' + (sel.indexOf(v) > -1 ? ' on' : '') +
                  '" data-rkey="' + escapeHtml(key) + '" data-rval="' + escapeHtml(v) + '">' + escapeHtml(v) + '</span>';
        });
        rows += '</div></div>';
      });
      if (rows) tagHtml += '<div class="ai-tcat">' + escapeHtml(cat) + '</div>' + rows;
    });

    var copyHtml = (r.copy || []).map(function (c, i) {
      return '<div class="ai-copyline"><textarea data-copy="' + i + '">' + escapeHtml(c) + '</textarea>' +
             '<button class="ai-del" data-delcopy="' + i + '" title="删除">&times;</button></div>';
    }).join('');

    out.innerHTML =
      '<div class="ai-result">' +
        '<div class="ai-step-h" style="margin-bottom:10px"><span class="n">2</span>识别结果（可修改后入库）</div>' +

        (r.reason ? '<div class="m-reason">判断依据：' + escapeHtml(r.reason) + '</div>' : '') +

        '<div class="ai-row">' +
          '<div class="ai-field"><label>品类</label><select id="rCat">' + catOpts + '</select></div>' +
          '<div class="ai-field"><label>材质（可多选）</label><select id="rMat" multiple size="4">' + matHtml + '</select></div>' +
        '</div>' +

        '<div class="ai-row">' +
          '<div class="ai-field"><label>规格 / 尺寸</label><input id="rSize" value="' + escapeHtml(r.spec.size) + '" placeholder="如 1800mm*2000mm / 35D"></div>' +
          '<div class="ai-field"><label>适用</label><input id="rFit" value="' + escapeHtml(r.spec.fit) + '" placeholder="如 侧睡、久坐"></div>' +
        '</div>' +
        '<div class="ai-field"><label>注意</label><input id="rCaution" value="' + escapeHtml(r.spec.caution) + '" placeholder="如 易老化"></div>' +

        '<div class="ai-field"><label>特性标签 · 点选</label>' +
          '<div class="ai-field-hint">只能使用标签库中的值，按分类与维度组织</div>' +
          '<div id="rTags" class="ai-tagbox">' + tagHtml + '</div></div>' +

        '<div class="ai-field"><label>提取到的卖点</label><div id="rCopies">' + copyHtml + '</div>' +
          '<button class="btn-ghost" id="addCopy" style="margin-top:6px">+ 加一行</button></div>' +

        '<div class="ai-actions" style="margin-top:14px">' +
          '<button class="btn-primary" id="aiSave">确认入库</button>' +
          '<button class="btn-ghost" id="aiView">只看筛选结果</button>' +
          '<button class="btn-ghost" id="aiRe">重新识别</button>' +
        '</div>' +
        '<div class="ai-msg" id="saveMsg"></div>' +
      '</div>';

    out.querySelectorAll('[data-rval]').forEach(function (el) {
      el.onclick = function () { el.classList.toggle('on'); };
    });
    out.querySelectorAll('[data-delcopy]').forEach(function (b) {
      b.onclick = function () {
        var ta = out.querySelector('[data-copy="' + b.dataset.delcopy + '"]');
        if (ta) ta.closest('.ai-copyline').remove();
      };
    });
    document.getElementById('addCopy').onclick = function () {
      var box = document.getElementById('rCopies');
      var d = document.createElement('div');
      d.className = 'ai-copyline';
      d.innerHTML = '<textarea></textarea><button class="ai-del" title="删除">&times;</button>';
      box.appendChild(d);
      d.querySelector('textarea').focus();
      d.querySelector('.ai-del').onclick = function () { d.remove(); };
    };
    document.getElementById('aiRe').onclick = run;
    document.getElementById('aiSave').onclick = save;
    document.getElementById('aiView').onclick = view;
  }

  function collectTags() {
    var out = {};
    document.querySelectorAll('#rTags .ai-tg.on').forEach(function (el) {
      var k = el.dataset.rkey, v = el.dataset.rval;
      if (!out[k]) out[k] = [];
      out[k].push(v);
    });
    return out;
  }
  function collectCopies() {
    return Array.prototype.slice
      .call(document.querySelectorAll('#rCopies textarea'))
      .map(function (t) { return t.value.trim(); })
      .filter(Boolean);
  }
  function collectMats() {
    var sel = document.getElementById('rMat');
    return Array.prototype.slice.call(sel.selectedOptions).map(function (o) { return o.value; });
  }

  function buildNote() {
    return {
      category: document.getElementById('rCat').value,
      materials: collectMats(),
      tags: collectTags(),
      copy: collectCopies(),
      sourceText: st.text,
      spec: {
        size: document.getElementById('rSize').value.trim(),
        fit: document.getElementById('rFit').value.trim(),
        caution: document.getElementById('rCaution').value.trim()
      },
      keywords: (st.result && st.result.keywords) || [],
      confidence: st.result ? (st.result.reason || '').length / 100 : null
    };
  }

  function view() {
    var note = buildNote();
    if (!note.category) { alert('请先选择品类'); return; }
    if (!note.materials.length) { alert('请至少选择一个材质'); return; }
    var flat = [];
    Object.keys(note.tags).forEach(function (k) {
      note.tags[k].forEach(function (v) { flat.push({ cat: k.split('/')[0], dim: k.split('/')[1], value: v }); });
    });
    window.KB_APPLY_FILTER({ group: note.category, material: note.materials[0], tags: flat });
    close();
  }

  function save() {
    var msg = document.getElementById('saveMsg');
    var note = buildNote();
    if (!note.category) { msg.className = 'ai-msg err'; msg.textContent = '请填写品类'; return; }
    if (!note.materials.length) { msg.className = 'ai-msg err'; msg.textContent = '请至少选择一个材质'; return; }
    if (!Object.keys(note.tags).length) { msg.className = 'ai-msg err'; msg.textContent = '请至少选择一组标签'; return; }

    var btn = document.getElementById('aiSave');
    btn.disabled = true;
    msg.className = 'ai-msg busy';
    msg.textContent = '保存中…';

    KB_INGEST.save(note)
      .then(function () {
        msg.className = 'ai-msg ok';
        msg.textContent = '已入库';
        window.KB_RELOAD_USER_NOTES();
        setTimeout(function () {
          st.text = ''; st.imageDataUrl = ''; st.result = null;
          document.getElementById('aiText').value = '';
          document.getElementById('aiPrev').innerHTML = '';
          document.getElementById('aiOut').innerHTML = '';
          setHint('已入库，可继续添加');
        }, 900);
      })
      .catch(function (e) {
        msg.className = 'ai-msg err';
        msg.textContent = '保存失败：' + ((e && e.message) ? e.message : e);
        btn.disabled = false;
      });
  }

  /* ---------- 启动 ---------- */
  var tries = 0, MAX = 4;

  function loadSdk(runBtn) {
    var s = document.createElement('script');
    s.src = SDK;
    s.onload = function () {
      if (!window.WorkBuddyCloud) return retry(runBtn, 'SDK 加载异常');
      runBtn.disabled = false;
      if (window.KB_ON_SDK_READY) window.KB_ON_SDK_READY();
    };
    s.onerror = function () { retry(runBtn, 'AI 模块加载失败'); };
    document.head.appendChild(s);
  }
  function retry(runBtn, msg) {
    tries++;
    if (tries >= MAX) { setHint(msg + '，请刷新页面重试', 'err'); runBtn.disabled = true; return; }
    setHint(msg + '，正在重试（' + tries + '/' + MAX + '）', 'err');
    runBtn.disabled = true;
    setTimeout(function () { loadSdk(runBtn); }, 1200 * tries);
  }

  function boot() {
    mount();
    var runBtn = document.getElementById('aiRun');
    if (window.WorkBuddyCloud) {
      if (window.KB_ON_SDK_READY) window.KB_ON_SDK_READY();
      runBtn.disabled = false;
      return;
    }
    runBtn.disabled = true;
    loadSdk(runBtn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();