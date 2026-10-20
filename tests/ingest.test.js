const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('app/ingest.js', 'utf8');

function setup({ delayed = false, fail = false } = {}) {
  let payload;
  const old = { id: 42, material: '橡木', category: '桌', feel: '坚固', tags: ['耐用'], fit: '日常使用', caution: '保持干燥', raw_text: JSON.stringify({ appliesTo: ['桌', '床'], materials: ['橡木', '松木'], size: '120cm', title: '原始标题', matFeature: '山形纹理', history: [] }) };
  const database = { from() {
    let writing = false;
    const q = {
      select() { return q; }, eq() { return q; },
      update(value) { payload = value; writing = true; return q; },
      then(resolve, reject) { return Promise.resolve(writing && fail ? { error: { message: '权限不足' } } : { data: [writing ? { ...old, ...payload } : old] }).then(resolve, reject); }
    };
    return q;
  } };
  const timers = [];
  const context = { console, setTimeout: fn => (timers.push(fn), timers.length), clearTimeout() {}, CLOUD_CONFIG: {endpoint:'https://example.com',publishableKey:'public'}, KB_TAGS: {tree:{}} };
  context.window = context;
  const sdk = { createWorkBuddyCloud: () => ({database}) };
  if (!delayed) context.WorkBuddyCloud = sdk;
  vm.runInNewContext(source, context);
  if (!delayed) context.KB_ON_SDK_READY();
  return { context, timers, sdk, payload: () => payload };
}

test('编辑保存保留多品类、多个材质及旧扩展字段，并追加历史', async () => {
  const fixture = setup();
  await fixture.context.KB_INGEST.update(42, {category:'桌', materials:['黑胡桃木','松木'], keywords:['纹理'], tags:['耐用'], copy:[{type:'卖点',text:'坚固'}], lines:{sell:'新卖点'}, sourceText:'原始素材'});
  const payload = fixture.payload();
  const extra = JSON.parse(payload.raw_text);
  assert.deepEqual(extra.appliesTo, ['桌','床']);
  assert.deepEqual(extra.materials, ['黑胡桃木','松木']);
  assert.equal(extra.matFeature, '山形纹理');
  assert.equal(extra.size, '120cm');
  assert.equal(extra.title, '原始标题');
  assert.equal(payload.fit, '日常使用');
  assert.equal(extra.history.length, 1);
});

test('SDK 晚于页面加载时，初始化后再读取数据库', async () => {
  const fixture = setup({delayed:true});
  const pending = fixture.context.KB_INGEST.list();
  fixture.context.WorkBuddyCloud = fixture.sdk;
  fixture.timers.shift()();
  assert.equal((await pending)[0].id, 42);
});

test('云端拒绝保存时向调用方抛出错误', async () => {
  const fixture = setup({fail:true});
  await assert.rejects(fixture.context.KB_INGEST.update(42, {materials:['橡木'],tags:[]}), /权限不足/);
});
