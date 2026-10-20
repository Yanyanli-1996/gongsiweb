/* 批量补全三行文案（使用场景 / 痛点人群 / 卖点优势）
   已有记录 raw_text.lines 为 null，这里按材质+品类规则回填。 */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

(async function(){
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/', { waitUntil:'domcontentloaded' });
  await p.waitForSelector('.card, .empty', { timeout:60000 });

  let sdkOk = 0;
  for(let i = 0; i < 8 && !sdkOk; i++){
    sdkOk = await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined', { timeout:30000 })
      .then(()=>1).catch(()=>0);
    if(!sdkOk){ process.stdout.write('SDK 重试 ' + (i+1) + '/8 … '); await p.waitForTimeout(6000); }
  }
  if(!sdkOk){ console.log('\nSDK 不可用'); await b.close(); return; }
  console.log('SDK 就绪');

  const r = await p.evaluate(async function(){
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint,
      publishableKey: window.CLOUD_CONFIG.publishableKey
    });
    const pick = window.KB_MATERIAL_PROFILE.pick;
    const list = await cloud.database.from('material_notes').select();
    let all = list.data || [];
    // select 默认可能只返回前 1000 条，按 id 分页补齐
    if(all.length >= 1000){
      const maxId = all[all.length-1].id;
      const page = await cloud.database.from('material_notes').select().gt('id', maxId);
      if(page.data && page.data.length) all = all.concat(page.data);
    }

    let filled = 0, skipped = 0, byHit = {};
    for(const row of all){
      let raw = {};
      try{ raw = JSON.parse(row.raw_text || '{}'); }catch(e){ raw = {}; }
      // 强制覆盖：上一轮规则已改进，需要重刷
      if(false && raw.lines && raw.lines.scene && raw.lines.scene.trim()){
        skipped++;
        continue;
      }
      const prof = pick(row.material, row.category);
      byHit[prof.hit || '(兜底)'] = (byHit[prof.hit || '(兜底)'] || 0) + 1;

      const lines = { scene: prof.scene, pain: prof.pain, sell: prof.sell };
      raw.lines = lines;
      const res = await cloud.database.from('material_notes')
        .update({ raw_text: JSON.stringify(raw) }).eq('id', row.id).select();
      if(res && !res.error) filled++;
      else console.log('更新失败', row.id);
      if(filled % 100 === 0) console.log('  已补 ' + filled + ' 条…');
    }

    const top = Object.entries(byHit).sort((a,b)=>b[1]-a[1]).slice(0,18);
    return { 总数: all.length, 补全: filled, 已有: skipped, 命中分布: top };
  });

  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();