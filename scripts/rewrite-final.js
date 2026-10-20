/* 按材质重新生成卖点包装（AI 优化）
   每张卡 = 一个材质，需要：
     - 3 条卖点文案，讲这个材质本身好在哪（覆盖其适用品类）
     - 适用品类列表
   输入：材质特性 + 适用品类 + 原始文案
   输出：干净、克制、不含规格促销的文案 */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

(async function(){
  const b=await chromium.launch();const ctx=await b.newContext();const p=await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.card, .empty',{timeout:60000});
  let ok=0;
  for(let i=0;i<12&&!ok;i++){
    ok=await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined',{timeout:30000}).then(()=>1).catch(()=>0);
    if(!ok){ process.stdout.write('SDK '+(i+1)+' '); await p.waitForTimeout(7000); }
  }
  if(!ok){ console.log('SDK 不可用'); await b.close(); return; }
  console.log('SDK 就绪');

  const r = await p.evaluate(async function(){
    const M = window.KB_MAT_PROFILE;
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint, publishableKey: window.CLOUD_CONFIG.publishableKey });

    var probe = await cloud.database.from('material_notes').select();
    var pids = (probe.data||[]).map(function(x){ return x.id; });
    var minId = Math.min.apply(null, pids.concat([0]));
    var maxId = Math.max.apply(null, pids.concat([0]));
    var all = [];
    for(var lo = minId; lo <= maxId + 200; lo += 200){
      var pg = await cloud.database.from('material_notes').select().gte('id', lo).lt('id', lo + 200);
      if(pg.data && pg.data.length) all = all.concat(pg.data);
    }
    console.log('  共 ' + all.length + ' 张卡待改写');

    function buildPrompt(mat, cats, feat, facets, old){
      return '你是家具文案编辑，为一种材质写通用卖点文案（该材质会用于多种家具）。\n\n' +
        '【材质】' + mat + '\n' +
        '【适用品类】' + cats.join('、') + '\n' +
        '【材质特性】' + feat + '\n' +
        '【细分特点】' + facets.join('、') + '\n' +
        '【原始文案参考】\n' + old + '\n\n' +
        '严格只输出 JSON：{"copy":["文案1","文案2","文案3"],"keywords":["关键词1","关键词2","关键词3","关键词4"]}\n\n' +
        '要求：\n' +
        '1. 每条文案 16-32 字，讲清「这个材质用在家具有什么实际好处」\n' +
        '2. 三条各有侧重：可分别落在「材质本身特性」「日常使用体验」「长期耐用表现」\n' +
        '3. 文案要能通用，不要只贴合某一个品类（比如写材质本身，而不是「这张沙发」）\n' +
        '4. 严禁出现：尺寸数字、型号、促销词（清仓/折扣/质保）、认证背书\n' +
        '5. 严禁吹牛，不要「顶级」「极致」「奢华」「无敌」\n' +
        '6. 全中文，不要任何英文单词\n' +
        '7. keywords 给 3-4 个材质特性关键词（不要品类词）\n';
    }

    async function askLLM(prompt){
      const stream = cloud.llm.chat.completions.create({
        model: window.KB_MODEL,
        messages: [{ role:'user', content: prompt }],
        stream: true,
        response_format: { type:'json_object' },
        temperature: 0.8
      });
      let ans = '';
      for await (const c of stream){
        const d = c.choices && c.choices[0] && c.choices[0].delta;
        if(d && d.content) ans += d.content;
      }
      let t = ans.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
      try{ return JSON.parse(t); }
      catch(e){
        const a = t.indexOf('{');
        if(a === -1) return null;
        let fix = t.slice(a).replace(/,\s*$/,'');
        const st = []; let inStr=false, esc=false;
        for(let i=0;i<fix.length;i++){
          const c = fix[i];
          if(esc){ esc=false; continue; }
          if(c==='\\'){ if(inStr) esc=true; continue; }
          if(c==='"'){ inStr=!inStr; continue; }
          if(inStr) continue;
          if(c==='{'||c==='[') st.push(c==='{'?'}':']');
          else if(c==='}'||c===']') st.pop();
        }
        if(inStr) fix += '"';
        while(st.length) fix += st.pop();
        try{ return JSON.parse(fix); } catch(e2){ return null; }
      }
    }

    function bad(c){
      if(!c || typeof c !== 'string') return true;
      c = c.trim();
      if(c.length < 8 || c.length > 40) return true;
      if(/[0-9]+\s*(mm|cm|米|m|寸)/i.test(c)) return true;
      if(/清仓|折扣|折|质保|保修|销量|第一|质检|认证|型号|冠军/.test(c)) return true;
      var letters = (c.match(/[A-Za-z]{2,}/g)||[]).filter(function(w){
        return ['ENF','E0','GB','PRO','AI','PU','PVC','PET','PP','TPE'].indexOf(w.toUpperCase()) === -1;
      });
      if(letters.length) return true;
      return false;
    }

    var okN = 0, fail = 0, samples = [];
    for(var i = 0; i < all.length; i++){
      var row = all[i];
      var prof = M.get(row.material) || M.get('其他');
      var raw = {};
      try{ raw = JSON.parse(row.raw_text || '{}'); }catch(e){}
      var cats = Array.isArray(raw.appliesTo) && raw.appliesTo.length
        ? raw.appliesTo : [row.category];
      var old = (row.copy_items||[]).join(' / ').slice(0, 800);

      var res = await askLLM(buildPrompt(
        row.material, cats, prof.feat, prof.facets||[], old || '（无）'
      ));

      var copy = res && res.copy;
      var kws = res && res.keywords;

      if(!Array.isArray(copy)){ copy = []; }
      var clean = copy.filter(function(c){ return !bad(c); })
        .map(function(c){ return String(c).replace(/^\d+[\.、]\s*/,'').trim(); })
        .slice(0, 3);
      if(clean.length < 3) clean = clean.concat([prof.sell, prof.scene, prof.pain]).slice(0, 3);
      if(clean.length < 3) fail++;

      var cleanKw = Array.isArray(kws)
        ? kws.filter(function(k){ return !bad(k); }).slice(0, 4)
        : [];
      if(cleanKw.length < 2) cleanKw = (prof.facets||[]).slice(0, 4);

      await cloud.database.from('material_notes').update({
        copy_items: clean,
        feel: cleanKw.join(',')
      }).eq('id', row.id).select();
      okN++;

      if(i < 4) samples.push({ 材质: row.material, 品类数: cats.length, 文案: clean });
      if((i+1) % 10 === 0) console.log('  已改写 ' + (i+1) + '…');
    }
    return { 成功: okN, 需补: fail, 样本: samples };
  });

  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();