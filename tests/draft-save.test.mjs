import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { OaDriver } from '../src/oa-driver.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, mode) {
  const savedPath = '/form?method=newColl&from=waitSend&summaryId=-123&affairId=456';
  let persisted = '';
  let saves = 0;
  let draftGets = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/save' && request.method === 'POST') {
      saves++;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      persisted = Buffer.concat(chunks).toString('utf8');
      response.end(savedPath);
      return;
    }
    if (request.url === '/never.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.write('/* pending resource */');
      return;
    }
    const url = new URL(request.url, 'http://fixture.invalid');
    const isDraft = url.searchParams.get('from') === 'waitSend';
    if (isDraft) draftGets++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const action = mode === 'validation' ? `document.body.insertAdjacentHTML('beforeend','<div role="alert">请填写合同必填项</div>');`
      : mode === 'alert' ? `alert('请补充合同日期');`
      : `const result=await fetch('/save',{method:'POST',body:document.querySelector('#value').value});
        const url=await result.text();
        ${mode === 'history' ? "history.replaceState(null,'',url);"
    : mode === 'iframe' ? "document.querySelector('#result').src=url;" : 'location.href=url;'}`;
    response.end(`<!doctype html><html><body>
      <input id="id" type="hidden" value="-123"><input id="value" value="${isDraft ? persisted : ''}">
      <button id="save" onclick="saveDraft()">保存待发</button><iframe id="result"></iframe>
      <script>window.clicks=0; async function saveDraft(){window.clicks++;${action}}
        window.Set=function Set(){this.instance=[];};</script>
      ${isDraft && mode === 'blocked' ? '<script src="/never.js"></script>' : ''}
      </body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await browser.newPage();
  t.after(() => page.close());
  const config = { oaUrl: base + '/login', newFormUrl: base + '/form?method=newColl', saveTimeoutMs: 700,
    save: { draftId: { selector: '#id' } } };
  await page.goto(config.newFormUrl);
  const driver = new OaDriver({ profileDir: '/fixture' });
  driver.page = page; driver.timeout = 700;
  const contract = { budgetCode: 'FIXTURE-1', contractName: '测试合同' };
  await driver.fill({ selector: '#value' }, contract.contractName, '合同名称');
  let reads = 0;
  driver.verifyWritten = async () => { reads++; assert.equal(await driver.read({ selector: '#value' }, '合同名称'), contract.contractName); };
  const button = await driver.unique({ selector: '#save' }, '保存待发');
  let beforeSaveCalls = 0;
  const save = () => driver.saveSeeyon(contract, config, {}, button, async evidence => {
    beforeSaveCalls++; assert.equal(evidence.expectedDraftId, '-123');
  });
  return { driver, config, page, save, stats: () => ({ saves, draftGets, reads, beforeSaveCalls }) };
}

for (const [mode, label] of [['history', '保存后仅更新地址，无整页跳转'], ['iframe', '保存凭据返回 iframe'], ['blocked', '草稿地址已返回但脚本持续加载']]) {
  test(`真实浏览器：${label}仍可验证已持久保存的草稿`, async t => {
    const { save, stats, page } = await fixture(t, mode);
    const receipt = await save();
    assert.equal(receipt.draftId, '-123');
    assert.equal(receipt.affairId, '456');
    assert.equal(stats().saves, 1);
    assert.ok(stats().draftGets >= 1);
    assert.equal(stats().reads, 1);
    assert.equal(stats().beforeSaveCalls, 1);
    assert.equal(page.listenerCount('dialog'), 0);
  });
}

for (const [mode, expected] of [['validation', '请填写合同必填项'], ['alert', '请补充合同日期']]) {
  test(`真实浏览器：保存被${mode === 'alert' ? '原生弹窗' : '页面校验'}拦截时报告具体原因，绝不重复点击`, async t => {
    const { save, stats, page } = await fixture(t, mode);
    await assert.rejects(save(), error => {
      assert.ok(error.message.includes(expected));
      assert.match(error.message, /结果不确定.*禁止自动重试/);
      assert.equal(error.saveEvidence.expectedDraftId, '-123');
      return true;
    });
    assert.equal(stats().saves, 0);
    assert.equal(stats().reads, 0);
    assert.equal(await page.evaluate(() => window.clicks), 1);
  });
}
