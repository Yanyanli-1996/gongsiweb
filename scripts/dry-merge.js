/* 干跑：只统计分组，不写库。用于确认合并方案合理 */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
(async function(){
  const b = await chromium.launch();const ctx = await b.newContext();const p = await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/', { waitUntil:'domcontentloaded' });
  await p.waitForSelector('.card, .empty', { timeout:60000 });
  let sdkOk = 0;
  for(let i = 0; i < 8 && !sdkOk; i++){
    sdkOk = await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined', { timeout:30000 })
      .then(()=>1).catch(()=>0);
    if(!sdkOk){ process.stdout.write('SDK ' + (i+1) + ' … '); await p.waitForTimeout(6000); }
  }
  if(!sdkOk){ console.log('SDK 不可用'); await b.close(); return; }

  const r = await p.evaluate(async function(){
    const M = window.KB_MAT_PROFILE;
    const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint, publishableKey: window.CLOUD_CONFIG.publishableKey });
    var all = [];
    var page = await cloud.database.from('material_notes').select();
    all = all.concat(page.data || []);
    while(all.length >= 1000){
      var maxId = all[all.length-1].id;
      var more = await cloud.database.from('material_notes').select().gt('id', maxId);
      if(!more.data || !more.data.length) break;
      all = all.concat(more.data);
    }
    var groups = {};
    all.forEach(function(row){
      var norm = M.normalize(row.material);
      var key = norm + ' | ' + (row.category || '');
      (groups[key] = groups[key] || []).push(row);
    });
    var list = Object.keys(groups).map(function(k){
      return { 组:k, 条数:groups[k].length, 特点:M.get(k.split(' | ')[0]).feat };
    }).sort(function(a, c){ return c.条数 - a.条数; });
    return { 总条数: all.length, 归并后: list.length, 明细: list.slice(0, 30) };
  });
  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();