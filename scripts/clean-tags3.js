/* 标签清理：只保留「材质本身 + 物理特性 + 触感 + 适用人群」
   删除：风格（中古风/复古风/奶油风）、颜色（原木色/白色系/胡桃色）、
        规格（1.8m床/1500*2000）、认证背书（GB28007/福布斯500强/CNAS）、
        促销服务（12期免息/上门取旧/质保）、场景（卧室/客厅/餐厅/书房）、
        品类名（电脑椅/布艺沙发） */
const { chromium } = require('C:/Users/11844/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

/* —— 要删的类别 —— */
var DROP = [
  /* 风格 */
  /风$|风·|风格|北欧|中古|复古|奶油|现代简约|意式|法式|韩式|日式|轻奢|北欧|侘寂|新中式/,
  /* 颜色：纯色名 + 色系 + 具体色值 */
  /^(白色|黑色|灰色|米色|棕色|原木色|胡桃色|奶茶色|燕麦色|奶油色|浅灰|深灰|米白|象牙白|咖啡色|焦糖色|藏蓝|藏青|雾霾蓝|豆绿|墨绿|橄榄绿|酒红|砖红)$/,
  /色$|色系|原木色|胡桃色|奶油白|海盐蓝|蜂蜜黄|椰奶白|薄荷绿|奶茶色|燕麦|白色系|绿色系|棕色系|灰色系|米色系/,
  /* 规格数字 */
  /\d+\s*[xX*×]\s*\d+|^\d|尺寸|规格|容量/,
  /* 认证背书 */
  /认证|国标|起草|质检|检测|专利|排名|销量|背书|500强|福布斯|上榜|蝉联|斩获|荣获|CNAS|官方认可|亚洲品牌|品牌/,
  /* 促销服务 */
  /免息|分期|包邮|质保|保修|年保|终身|以旧换新|上门|取旧|安装|服务|包退|包换|直降|立减|补贴|价保|折扣|限时|新品|清仓|现货|预售/,
  /* 空间场景 */
  /卧室|客厅|餐厅|书房|儿童房|阳台|玄关|办公|小户型|大户型/,
  /* 品类名（整词） */
  /^(电脑椅|餐椅|茶几|餐桌|沙发|沙发床|床|床垫|柜类|衣柜|书架|置物架|书桌|衣帽架|床头柜|鞋柜|电视柜|餐边柜|斗柜|凳类|休闲椅|按摩椅|懒人沙发|梳妆台|布艺沙发|儿童床|功能沙发|儿童学习椅|儿童学习桌|电动升降桌|升降桌|搁板|边柜|换鞋凳)$/
];

var SPEC_DIM = /^[\d.]+\s*(m|M|米|mm|MM|cm|CM|公分|寸|英寸|㎡|kg|KG|度|档|人位|位|排|层)?\s*[床桌柜沙发椅凳架宽长高深直排款容量]*$/;

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
    var drops = opt.drops;
    var dry = opt.dry;
    var RS = drops.map(function(s){ return new RegExp(s, 'i'); });
    var SPEC = new RegExp(opt.specS);
    var cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: window.CLOUD_CONFIG.endpoint, publishableKey: window.CLOUD_CONFIG.publishableKey });

    function keep(t){
      if(!t) return false;
      if(t.length < 2) return false;
      if(SPEC.test(t)) return false;
      for(var i = 0; i < RS.length; i++){ if(RS[i].test(t)) return false; }
      if(/^[★☆]/.test(t)) return false;
      return true;
    }

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

    var removed = {}, changed = 0;
    for(var i = 0; i < all.length; i++){
      var row = all[i];
      var tags = row.tags || [];
      var kept = [];
      tags.forEach(function(t){
        if(keep(t)) kept.push(t);
        else removed[t] = (removed[t]||0) + 1;
      });
      var kws = String(row.feel || '').split(/[,、，]/).map(function(s){ return s.trim(); })
        .filter(Boolean).filter(function(k){ return keep(k); });

      var tc = kept.length !== tags.length;
      var fc = kws.join(',') !== (row.feel || '');
      if(!tc && !fc) continue;
      if(!dry){ await cloud.database.from('material_notes')
        .update({ tags: kept, feel: kws.join(',') }).eq('id', row.id).select(); }
      changed++;
    }

    // 统计清理后还剩什么标签
    var after = await cloud.database.from('material_notes').select();
    var left = {};
    (after.data||[]).forEach(function(row){
      (row.tags||[]).forEach(function(t){ left[t] = (left[t]||0)+1; });
    });
    var leftTop = Object.entries(left).sort(function(a,b){ return b[1]-a[1]; }).slice(0,30);

    return {
      处理: changed, 共: all.length,
      删除最多: Object.entries(removed).sort(function(a,b){ return b[1]-a[1]; }).slice(0,20),
      剩余标签: leftTop
    };
  }, { drops: DROP.map(String), specS: SPEC_DIM.source, dry: DRY });

  console.log(JSON.stringify(r, null, 1));
  await b.close();
})();