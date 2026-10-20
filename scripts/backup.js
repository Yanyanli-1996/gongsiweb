const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const fs=require('fs');
(async function(){
  const b=await chromium.launch();const ctx=await b.newContext();const p=await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.card, .empty',{timeout:60000});
  let ok=0;
  for(let i=0;i<8&&!ok;i++){
    ok=await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined',{timeout:30000}).then(()=>1).catch(()=>0);
    if(!ok){ process.stdout.write('SDK '+(i+1)+' … '); await p.waitForTimeout(6000); }
  }
  if(!ok){ console.log('SDK 不可用'); await b.close(); return; }
  const rows=await p.evaluate(async()=>{
    const cloud=window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint:window.CLOUD_CONFIG.endpoint, publishableKey:window.CLOUD_CONFIG.publishableKey});
    // 按 id 区间分页：每段 200 个 id 区间，避免 limit/排序不稳定
    // id 边界必须先探测（数据 id 不从 1 开始，假设区间会导到 0 条）
    const probe = await cloud.database.from('material_notes').select();
    const ids = (probe.data||[]).map(x=>x.id);
    if(!ids.length) return [];
    const minId = Math.min(...ids), maxId = Math.max(...ids);
    const out = [];
    for(let lo = minId; lo <= maxId + 200; lo += 200){
      const r = await cloud.database.from('material_notes').select()
        .gte('id',lo).lt('id',lo+200);
      if(r.data && r.data.length) out.push(...r.data);
    }
    return out;
  });
  const f='backup-'+new Date().toISOString().slice(0,10)+'.json';
  fs.writeFileSync(f, JSON.stringify(rows,null,1));
  console.log('已导出', rows.length, '条 →', f);
  await b.close();
})();
