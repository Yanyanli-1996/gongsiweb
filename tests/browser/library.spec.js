const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const rows = JSON.parse(fs.readFileSync('data/material_notes-快照.json', 'utf8'));

test('SDK 断网仍显示快照，可搜索、筛选和浏览文案，禁用云端编辑', async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/**', route => route.abort());
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(36);
  await expect(page.locator('.copyitem').first()).toContainText(rows[0].copy_items[0]);
  await expect(page.locator('[data-doce], [data-del]')).toHaveCount(0);
  await page.locator('#q').fill(rows[0].copy_items[0]);
  await expect(page.locator('.card')).toHaveCount(1);
  await page.locator('#reset').click();
  await page.locator('[data-group="床"]').click();
  expect(await page.locator('.card').count()).toBeGreaterThan(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

async function mockCloud(page, fail) {
  await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({contentType:'text/javascript', body: `
    window.testPayload = null;
    window.WorkBuddyCloud = {createWorkBuddyCloud: function(){return {database:{from:function(){
      var writing=false;
      var q={select:function(){return q;},eq:function(){return q;},update:function(p){writing=true;window.testPayload=p;return q;},then:function(resolve,reject){return Promise.resolve(writing ? (${fail} ? {error:{message:'测试保存失败'}} : {data:[Object.assign({}, ${JSON.stringify(rows[0])}, window.testPayload)]}) : {data:${JSON.stringify(rows)}}).then(resolve,reject);}};
      return q;
    }}};}};
  `}));
}

test('云端保存成功后关闭编辑，保留多品类信息', async ({page}) => {
  await mockCloud(page, false);
  await page.goto('/');
  await expect(page.locator('#syncStatus')).toContainText('云端已连接');
  const card = page.locator('.card').first();
  await card.locator('[data-doce]').click();
  await card.locator('[data-f="material"]').fill('测试橡木');
  await card.locator('[data-done]').click();
  await expect(page.locator('#syncStatus')).toHaveText('已保存到云端');
  await expect(card.locator('.cmat')).toHaveText('测试橡木');
  expect(await page.evaluate(() => JSON.parse(testPayload.raw_text).appliesTo)).toEqual(JSON.parse(rows[0].raw_text).appliesTo);
});

test('云端保存失败保留草稿，不能显示已完成', async ({page}) => {
  await mockCloud(page, true);
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await expect(page.locator('#syncStatus')).toContainText('云端已连接');
  const card = page.locator('.card').first();
  await card.locator('[data-doce]').click();
  await card.locator('[data-f="material"]').fill('保留草稿');
  await card.locator('[data-done]').click();
  await expect(page.locator('#syncStatus')).toContainText('保存失败');
  await expect(card.locator('[data-f="material"]')).toHaveValue('保留草稿');
});
