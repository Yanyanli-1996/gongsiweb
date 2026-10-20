/* 只做插入：把备份写回数据库（不删除任何东西） */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const fs = require('fs');
(async function(){
  const rows = JSON.parse(fs.readFileSync('backup-2026-10-19.json','utf8'));
  console.log('待插入 ' + rows.length + ' 条');

  const b = await chromium.launch();const ctx = await b.newContext();const p = await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.card, .empty',{timeout:60000});
  let ok=0;
  for(let i=0;i<10&&!ok;i++){
    ok=await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined',{timeout:30000}).then(()=>1).catch(()=>0);
    if(!ok){ process.stdout.write('SDK '+(i+1)+' '); await p.waitForTimeout(7000); }
  }
  if(!ok){ console.log('SDK 不可用'); await b.close(); return; }
  console.log('SDK 就绪');

  const r = await p.evaluate(async function(data){
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint, publishableKey: window.CLOUD_CONFIG.publishableKey });
    var done = 0, fail = 0;
    for(var i = 0; i < data.length; i += 20){
      var batch = data.slice(i, i + 20).map(function(x){
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
      var ins = await cloud.database.from('material_notes').insert(batch).select();
      if(ins && ins.error){ fail += batch.length; }
      else { done += (ins.data ? ins.data.length : 0); }
    }
    // 核对
    var cnt = 0;
    for(var lo = 0; lo <= 3000; lo += 200){
      var pg = await cloud.database.from('material_notes').select().gte('id', lo).lt('id', lo + 200);
      if(pg.data) cnt += pg.data.length;
    }
    return { inserted: done, failed: fail, dbCount: cnt };
  }, rows);

  console.log('结果:', JSON.stringify(r));
  await b.close();
})();