/* 合并同类项（修正版）
   关键改进：
   1. 标签用【完整并集】，不用「出现≥2次」的交集 —— 上一版取交集时
      因分词边界被切开，产生了「儿童学GB28007」这类截断标签
   2. 过滤明显是规格/型号的噪音关键词
   3. 合并后按标准材质 + 品类重写三行文案 */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

(async function(){
  const b = await chromium.launch();const ctx = await b.newContext();const p = await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.card, .empty',{timeout:60000});
  let ok=0;
  for(let i=0;i<8&&!ok;i++){
    ok=await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined',{timeout:30000}).then(()=>1).catch(()=>0);
    if(!ok){ process.stdout.write('SDK '+(i+1)+' … '); await p.waitForTimeout(6000); }
  }
  if(!ok){ console.log('SDK 不可用'); await b.close(); return; }
  console.log('SDK 就绪');

  const r = await p.evaluate(async function(){
    const M = window.KB_MAT_PROFILE;
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint, publishableKey: window.CLOUD_CONFIG.publishableKey });

    /* 规格/型号/促销这类不是特性，不能进关键词 */
    var NOISE = /^[\d.]+\s*(米|m|mm|cm|公分|寸|英寸|人位)$|^[\d.]+m?$/i;
    var NOISE_WORDS = /^(非沙发床|现货|预售|包邮|新品|清仓)$/;
    var NOISE_LONG = /^\d{6,}$/;
    function isNoise(k){
      return NOISE.test(k) || NOISE_WORDS.test(k) || NOISE_LONG.test(k);
    }

    /* 截断标签特征：含半截英文数字混排且长度异常短 */
    function isBrokenTag(t){
      if(!t) return true;
      if(t.length < 2) return true;
      // 「儿童学GB28007」这类：中文字符数 < 英文数字串长度 → 判定为截断
      var cn = (t.match(/[\u4e00-\u9fa5]/g)||[]).length;
      var alnum = (t.match(/[A-Za-z0-9]/g)||[]).length;
      if(alnum >= 3 && cn === 0) return false;      // 纯英文数字标签正常
      if(cn >= 2) return false;                      // 中文标签正常
      return alnum >= 3;                             // 中文不足但英文数字多 → 截断
    }

    // 取全量：id 不从 1 开始，必须先探边界，再按 id 递进
    var probe = await cloud.database.from('material_notes').select();
    var ids = (probe.data||[]).map(function(x){ return x.id; });
    var minId = Math.min.apply(null, ids.concat([0]));
    var all = [];
    for(var lo = minId; lo <= Math.max.apply(null, ids.concat([0])) + 200; lo += 200){
      var pg = await cloud.database.from('material_notes').select().gte('id', lo).lt('id', lo + 200);
      if(pg.data && pg.data.length) all = all.concat(pg.data);
    }
    console.log('  读到 ' + all.length + ' 条（id ' + minId + ' 起）');

    // 分组
    var groups = {};
    all.forEach(function(row){
      var norm = M.normalize(row.material);
      var key = norm + '||' + (row.category || '未分类');
      (groups[key] = groups[key] || []).push(row);
    });
    var keys = Object.keys(groups);
    console.log('  归并为 ' + keys.length + ' 组');

    var created = 0, deleted = 0, fail = 0;

    for(var gi = 0; gi < keys.length; gi++){
      var key = keys[gi];
      var rows = groups[key];
      var norm = key.split('||')[0];
      var cat = key.split('||')[1];
      var profile = M.get(norm);

      /* 标签：完整并集（不取交集），过滤截断项 */
      var tagSeen = {}, kwSeen = {}, copies = [], ids = [];
      rows.forEach(function(row){
        ids.push(row.id);
        (row.tags || []).forEach(function(t){
          if(t && !isBrokenTag(t)) tagSeen[t] = 1;
        });
        String(row.feel || '').split(/[,、，]/).map(function(s){ return s.trim(); })
          .filter(Boolean).forEach(function(k){
            if(!isNoise(k)) kwSeen[k] = (kwSeen[k]||0) + 1;
          });
        (row.copy_items || []).forEach(function(c){
          var txt = typeof c === 'string' ? c : (c && c.text) || '';
          if(txt && copies.indexOf(txt) === -1) copies.push(txt);
        });
      });

      var tags = Object.keys(tagSeen);
      // 补材质固有特点
      profile.facets.forEach(function(f){ if(tags.indexOf(f) === -1) tags.push(f); });

      // 关键词：高频的优先（去掉规格噪音）
      var kws = Object.keys(kwSeen).filter(function(k){ return !isNoise(k); });
      kws.sort(function(a, b){ return kwSeen[b] - kwSeen[a]; });
      kws = kws.slice(0, 5);

      var raw = {};
      try{ raw = JSON.parse(rows[0].raw_text || '{}'); }catch(e){}
      raw.materials = [norm];
      raw.matFeature = profile.feat;
      raw.mergedFrom = ids.length;
      raw.lines = { scene: profile.scene, pain: profile.pain, sell: profile.sell };

      var payload = {
        category: cat === '未分类' ? '' : cat,
        material: norm,
        source_text: rows.length + ' 个 SKU 合并',
        image_path: '',
        feel: kws.join(','),
        tags: tags,
        copy_items: copies.slice(0, 3),
        fit: '', caution: '',
        raw_text: JSON.stringify(raw),
        confidence: 0.6
      };

      // 单条就地更新即可
      if(rows.length === 1){
        await cloud.database.from('material_notes').update(payload).eq('id', ids[0]).select();
        created++;
        continue;
      }

      for(var si = 0; si < ids.length; si++){
        await cloud.database.from('material_notes').delete().eq('id', ids[si]).select();
        deleted++;
      }
      var ins = await cloud.database.from('material_notes').insert(payload).select();
      if(ins && !ins.error) created++; else fail++;
      if((gi + 1) % 15 === 0) console.log('  ' + (gi+1) + '/' + keys.length + ' 组…');
    }
    return { 原始: all.length, 合并后: keys.length, 新建: created, 删除: deleted, 失败: fail };
  });

  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();