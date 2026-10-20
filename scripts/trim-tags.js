/* 标签重要性排序 + 截断
   每张卡只显示前 10 个最关键的标签，顺序按「材质本体 → 核心功能 → 触感 → 环保 → 其他」

   分级：
     P1 材质本体（必须有：实木/真皮/板材/海绵…）
     P2 核心功能（决定能不能用：低甲醛/承重稳固/耐刮耐磨/易清洁/静音…）
     P3 触感体验（质感亲肤/柔韧透气/天然木纹…）
     P4 环保等级（E0级/ENF级/环保升级…）
     P5 其他泛化描述（耐用结实/性价比高/造型简洁…，价值最低）
   同级内按全局出现频次排（用得多的更可能是重点） */

const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

/* —— 材质本体：最高优先级 —— */
var P1 = [
  '实木','全实木','实木材质','整木材质','实木框架','实木排骨架','天然原木','自然原木',
  '白蜡木','橡木','黑胡桃木','榉木','楸木','松木','橡胶木','水曲柳',
  '真皮','头层牛皮','半青皮','PU皮','科技皮',
  '板材','板式','板木结合','人造板','E0级板材','ENF级板材','环保板材','颗粒板','生态牛皮',
  '布艺','软包面料','雪尼尔','猫抓布','科技布','网布','仿棉麻','绒感布',
  '海绵','高回弹','记忆棉','乳胶','椰棕','独立弹簧','排骨架',
  '岩板','玻璃','黄麻'
];

/* —— 核心功能 —— */
var P2 = [
  '承重稳固','结构稳定','不易变形','不易变形','坚固耐用','耐刮耐磨','耐久耐磨','耐磨',
  '易清洁','可拆洗','防水','防污','抗菌','防抓','透气','静音','轻音',
  '护脊支撑','分区支撑','回弹支撑','环保升级','超低甲醛','低甲醛','零甲醛',
  '抗造','耐用年限长','环保',
  '不渗色','耐高温','零孔隙','易打理','防水防污','防潮','防蛀','抗菌防抓','无异味',
  '软弹','高密度','回弹','承托','护颈','护臀','分散压力','独立袋装','零胶零棕','0胶0棕'
];

/* —— 触感体验 —— */
var P3 = [
  '质感亲肤','柔韧透气','天然木纹','清晰木纹','山形木纹','皮革质感','柔软坐感','软包质感',
  '厚实柔韧','亲肤','细腻','顺滑'
];

/* —— 环保等级（较次要，因为常与材质重复） —— */
var P4 = ['E0级','ENF级','环保板材','母婴级','母婴级A类面料'];

var MAX_TAGS = 10;

(async function(){
  const b=await chromium.launch();const ctx=await b.newContext();const p=await ctx.newPage();
  await p.goto('https://material-kb.app.workbuddy.host/',{waitUntil:'domcontentloaded'});
  await p.waitForSelector('.card, .empty',{timeout:60000});
  let ok=0;
  for(let i=0;i<10&&!ok;i++){
    ok=await p.waitForFunction(()=>typeof window.WorkBuddyCloud!=='undefined',{timeout:30000}).then(()=>1).catch(()=>0);
    if(!ok){ process.stdout.write('SDK '+(i+1)+' '); await p.waitForTimeout(7000); }
  }
  if(!ok){ console.log('SDK 不可用'); await b.close(); return; }
  console.log('SDK 就绪');

  const DRY = process.argv.indexOf('--dry') > -1;
  const r = await p.evaluate(async function(opt){
    var P1=opt.P1, P2=opt.P2, P3=opt.P3, P4=opt.P4, MAX=opt.MAX;
    var cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint, publishableKey: window.CLOUD_CONFIG.publishableKey });

    function grade(t){
      for(var i=0;i<P1.length;i++) if(P1.indexOf(t)>-1 || t.indexOf(P1[i])>-1) return 1;
      for(var j=0;j<P2.length;j++) if(P2[j]===t || t.indexOf(P2[j])>-1) return 2;
      for(var k=0;k<P3.length;k++) if(P3[k]===t || t.indexOf(P3[k])>-1) return 3;
      for(var m=0;m<P4.length;m++) if(P4[m]===t || t.indexOf(P4[m])>-1) return 4;
      return 5;
    }

    // 探 id 边界
    var probe = await cloud.database.from('material_notes').select();
    var pids = (probe.data||[]).map(function(x){ return x.id; });
    var minId = Math.min.apply(null, pids.concat([0]));
    var maxId = Math.max.apply(null, pids.concat([0]));
    var all = [];
    for(var lo = minId; lo <= maxId + 200; lo += 200){
      var pg = await cloud.database.from('material_notes').select().gte('id', lo).lt('id', lo + 200);
      if(pg.data && pg.data.length) all = all.concat(pg.data);
    }
    console.log('  读到 ' + all.length + ' 条');

    // 全局频次（同级内排序用）
    var freq = {};
    all.forEach(function(row){ (row.tags||[]).forEach(function(t){ freq[t]=(freq[t]||0)+1; }); });

    var changed = 0, trimmed = 0;
    for(var i = 0; i < all.length; i++){
      var row = all[i];
      var tags = row.tags || [];
      if(tags.length <= MAX) continue;

      var scored = tags.map(function(t){
        return { t: t, g: grade(t), f: freq[t]||0 };
      });
      scored.sort(function(a, b){
        if(a.g !== b.g) return a.g - b.g;
        if(a.f !== b.f) return b.f - a.f;
        return b.t.length - a.t.length;   // 同频次取信息量更大的
      });
      var kept = scored.slice(0, MAX).map(function(x){ return x.t; });
      // 去重（可能因包含匹配重复）
      var seen = {}, uniq = [];
      kept.forEach(function(t){ if(!seen[t]){ seen[t]=1; uniq.push(t); } });

      if(!opt.dry){ await cloud.database.from('material_notes')
        .update({ tags: uniq }).eq('id', row.id).select(); }
      changed++; trimmed += (tags.length - uniq.length);
    }

    // 统计结果
    var after = await cloud.database.from('material_notes').select();
    var lens = (after.data||[]).map(function(x){ return (x.tags||[]).length; });
    var maxL = Math.max.apply(null, lens.concat([0]));
    var minL = Math.min.apply(null, lens.concat([999]));

    return {
      处理: changed, 共: all.length, 共裁掉: trimmed,
      当前最多标签数: maxL, 当前最少: minL
    };
  }, { P1:P1, P2:P2, P3:P3, P4:P4, MAX:MAX_TAGS, dry:DRY });

  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();