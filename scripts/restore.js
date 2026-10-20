/* 从备份恢复全部数据（清空后重建） */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const fs = require('fs');
(async function(){
  const rows = JSON.parse(fs.readFileSync('backup-2026-10-19.json','utf8'));
  console.log('备份 ' + rows.length + ' 条待恢复');

  const b = await chromium.launch();const ctx = await b.newContext();const p = await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.card, .empty',{timeout:60000});
  let ok=0;
  for(let i=0;i<8&&!ok;i++){
    ok=await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined',{timeout:30000}).then(()=>1).catch(()=>0);
    if(!ok){ process.stdout.write('SDK '+(i+1)+' … '); await p.waitForTimeout(6000); }
  }
  if(!ok){ console.log('SDK 不可用'); await b.close(); return; }

  const r = await p.evaluate(async function(data){
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint, publishableKey: window.CLOUD_CONFIG.publishableKey });

    // 清空
    for(let lo = 0; lo <= 2000; lo += 200){
      const pg = await cloud.database.from('material_notes').select().gte('id', lo).lt('id', lo + 200);
      const ids = (pg.data||[]).map(x => x.id);
      for(const id of ids) await cloud.database.from('material_notes').delete().eq('id', id).select();
    }

    // 分批插回
    let done = 0, fail = 0;
    for(let i = 0; i < data.length; i += 30){
      const batch = data.slice(i, i + 30).map(function(x){
        return {
          category: x.category || '',
          material: x.material || '',
          source_text: x.source_text || '',
          image_path: x.image_path || '',
          feel: x.feel || '',
          tags: x.tags || [],
          copy_items: x.copy_items || [],
          fit: x.fit || '',
          caution: x.caution || '',
          raw_text: x.raw_text || '',
          confidence: x.confidence == null ? null : x.confidence
        };
      });
      const ins = await cloud.database.from('material_notes').insert(batch).select();
      if(ins && ins.error){ fail += batch.length; }
      else done += batch.length;
      if((i + 30) % 300 === 0) done;
    }
    return { done: done, fail: fail };
  }, rows);

  console.log('\n恢复结果:', JSON.stringify(r));
  await b.close();
})();