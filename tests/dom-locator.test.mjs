import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createDomLocator } from '../src/dom-locator.mjs';
import { OaDriver } from '../src/oa-driver.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, html) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  t.after(() => page.close());
  await page.setContent(html);
  await page.evaluate(() => {
    window.Set = function Set() { this.instance = []; this.key = {}; };
  });
  return { page, $: (selector, frameChain = []) => createDomLocator(page, { selector, frameChain }, { timeout: 500 }) };
}

test('legacy Set: strict CSS queries and scoped nth locators preserve globals', async t => {
  const { page, $ } = await fixture(t, '<ul><li><span>A</span></li><li><span>B</span></li></ul><p hidden>hidden</p>');
  assert.equal(await $('li').count(), 2);
  assert.deepEqual(await $('li').evaluateAll((elements, suffix) => elements.map(e => e.textContent + suffix), '!'), ['A!', 'B!']);
  assert.equal(await $('li').nth(1).locator('span').innerText(), 'B');
  assert.equal(await $('li').first().innerText(), 'A');
  assert.equal(await $('li').last().innerText(), 'B');
  await assert.rejects($('li').innerText(), /必须唯一/);
  assert.equal(await $('p').isVisible(), false);
  await $('missing').waitFor({ state: 'detached' });
  await assert.rejects($('missing').waitFor({ timeout: 90 }), /超时/);
  assert.match(await page.evaluate(() => String(Set)), /this.instance/);
});

test('legacy Set: mouse click and keyboard fill dispatch real input events', async t => {
  const { page, $ } = await fixture(t, '<button id="button">确定</button><input id="input"><textarea id="description"></textarea>');
  await page.evaluate(() => {
    document.querySelector('#button').addEventListener('click', e => document.body.dataset.trusted = String(e.isTrusted));
    document.querySelector('#input').addEventListener('input', e => document.body.dataset.inputTrusted = String(e.isTrusted));
  });
  await $('#button').click();
  assert.equal(await $('body').getAttribute('data-trusted'), 'true');
  await $('#input').fill('TEST-2026-139');
  await $('#input').blur();
  assert.equal(await $('#input').evaluate(e => e.value), 'TEST-2026-139');
  assert.equal(await $('body').getAttribute('data-input-trusted'), 'true');
  await $('#input').fill('');
  assert.equal(await $('#input').evaluate(e => e.value), '');
  await $('#description').fill('中文合同说明\n第二行');
  assert.equal(await $('#description').evaluate(e => e.value), '中文合同说明\n第二行');
});

test('legacy Set: nested iframes resolve by DOM element without main-frame selectors', async t => {
  const { page, $ } = await fixture(t, '<iframe id="outer" name="outer" style="width:700px;height:500px"></iframe>');
  const outer = page.frames().find(frame => frame.name() === 'outer');
  await outer.setContent('<iframe id="inner" name="inner" style="width:500px;height:300px"></iframe>');
  const inner = page.frames().find(frame => frame.name() === 'inner');
  await inner.setContent('<input id="code"><button id="confirm">确定</button>');
  for (const frame of [outer, inner]) {
    await frame.evaluate(() => { window.Set = function Set() { this.instance = []; }; });
  }
  await inner.evaluate(() => document.querySelector('#confirm').addEventListener('click', () => document.body.dataset.clicked = 'yes'));
  const chain = ['#outer', '#inner'];
  await $('#code', chain).fill('预算-123');
  await $('#confirm', chain).click();
  assert.equal(await $('#code', chain).evaluate(e => e.value), '预算-123');
  assert.equal(await $('body', chain).getAttribute('data-clicked'), 'yes');
  assert.equal(await $('#anything', ['#not-yet-loaded']).count(), 0);
});

test('legacy Set: checkbox and select update state and fire standard changes', async t => {
  const { page, $ } = await fixture(t, '<input id="check" type="checkbox"><select id="select"><option value="">请选择</option><option value="A">软件开发</option><option disabled value="B">禁用</option></select>');
  await page.evaluate(() => document.querySelector('#select').addEventListener('change', () => document.body.dataset.changed = 'yes'));
  assert.equal(await $('#check').isChecked(), false);
  await $('#check').check();
  await $('#check').check();
  assert.equal(await $('#check').isChecked(), true);
  assert.deepEqual(await $('#select').selectOption({ index: 1 }), ['A']);
  assert.equal(await $('#select').evaluate(e => e.value), 'A');
  assert.equal(await $('body').getAttribute('data-changed'), 'yes');
  await assert.rejects($('#select').selectOption({ index: 2 }), /不可用/);
});

test('legacy Set: disabled controls and overlays are rejected before clicks', async t => {
  const { page, $ } = await fixture(t, '<button id="target" style="position:absolute;left:20px;top:20px;width:100px;height:40px">确定</button><div style="position:absolute;left:0;top:0;width:200px;height:100px;z-index:9;background:white"></div><input id="disabled" disabled><input id="readonly" readonly><a id="disabled-link" disableattr="true">确定</a>');
  await page.evaluate(() => document.querySelector('#target').addEventListener('click', () => document.body.dataset.clicked = 'yes'));
  await assert.rejects($('#target').click(), /被遮挡/);
  assert.equal(await $('body').getAttribute('data-clicked'), null);
  await assert.rejects($('#disabled').fill('wrong'), /禁用/);
  await assert.rejects($('#readonly').fill('wrong'), /可编辑/);
  assert.equal(await $('#disabled-link').isEnabled(), false);
});

test('legacy Set: an overlay in the parent frame blocks child-frame clicks', async t => {
  const { page, $ } = await fixture(t, '<iframe id="child" name="child" style="width:500px;height:300px"></iframe><div style="position:absolute;left:0;top:0;width:1000px;height:800px;z-index:100;background:white"></div>');
  const child = page.frames().find(frame => frame.name() === 'child');
  await child.setContent('<button id="target">确定</button>');
  await assert.rejects($('#target', ['#child']).click(), /iframe 被遮挡/);
});

test('字段名称在 iframe 内精确定位，兼容隐藏标题和可见标签并去重', async t => {
  const { page } = await fixture(t, '<iframe id="zwIframe" name="form" style="width:900px;height:500px"></iframe>');
  const form = page.frames().find(frame => frame.name() === 'form');
  await form.setContent(`<table><tr>
    <td>收款联系人</td><td><div class="cap-field"><span hidden class="field-title">收款联系人</span><div class="field-content-wrapper"><input value="张三"></div></div></td>
    <td>收款联系人邮箱</td><td><div class="cap-field"><span hidden class="field-title">ESI邮箱</span><div class="field-content-wrapper"><input value="a@example.invalid"></div></div></td>
    </tr></table>`);
  const target = fieldLabel => createDomLocator(page, { fieldLabel, selector: '.field-content-wrapper input', frameChain: ['#zwIframe'] }, { timeout: 200 });
  assert.equal(await target('收款联系人').count(), 1);
  assert.equal(await target('收款联系人邮箱').evaluate(e => e.value), 'a@example.invalid');
  assert.equal(await target('不存在').count(), 0);
  await target('收款联系人').fill('李四');
  assert.equal(await target('收款联系人').evaluate(e => e.value), '李四');
  assert.equal(await target('收款联系人邮箱').evaluate(e => e.value), 'a@example.invalid');
  await form.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="cap-field"><span hidden class="field-title">收款联系人</span><div class="field-content-wrapper"><input></div></div>'));
  await assert.rejects(target('收款联系人').fill('不应写入'), /必须唯一/);
});

function receivingFormHtml({ sourceContact = '', sourceEmail = '', owner = '旧负责人', contact = '旧联系方式' } = {}) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<table><tr>
    <td>对方负责人</td><td><div id="field0026_id"><input value="${escape(owner)}"></div></td>
    <td>对方负责人联系方式</td><td><div id="field0028_id"><input value="${escape(contact)}"></div></td>
    </tr><tr>
    <td>收款联系人</td><td><div class="cap-field" id="field1421_id"><span hidden class="field-title">收款联系人</span><div class="field-content-wrapper"><div class="cap4-people__text">${escape(sourceContact)}</div><button id="picker">选人</button></div></div></td>
    <td>收款联系人邮箱</td><td><div class="cap-field" id="field1427_id"><span hidden class="field-title">ESI邮箱</span><div class="field-content-wrapper"><input value="${escape(sourceEmail)}"></div></div></td>
    </tr></table><script>
      window.Set=function Set(){this.instance=[];};
      window.pickerClicks=0;window.sourceInputEvents=0;window.targetEvents=[];
      const owner=document.querySelector('#field0026_id input');
      const contact=document.querySelector('#field0028_id input');
      window.targetModel={owner:owner.value,contact:contact.value};
      document.querySelector('#picker').addEventListener('click',()=>window.pickerClicks++);
      document.querySelector('#field1427_id input').addEventListener('input',()=>window.sourceInputEvents++);
      for(const [key,element] of [['owner',owner],['contact',contact]]){
        element.addEventListener('input',event=>{
          window.targetModel[key]=element.value;
          window.targetEvents.push({key,type:'input',trusted:event.isTrusted});
        });
        element.addEventListener('blur',event=>window.targetEvents.push({key,type:'blur',trusted:event.isTrusted}));
      }
    </script>`;
}

async function receivingFixture(t, data) {
  const { page } = await fixture(t, '<iframe id="zwIframe" name="form" style="width:900px;height:500px"></iframe>');
  const form = page.frames().find(frame => frame.name() === 'form');
  await form.setContent(receivingFormHtml(data));
  const target = selector => ({ selector, frameChain: ['#zwIframe'] });
  const config = { fields: {
    counterpartyOwner: target('#field0026_id input'), counterpartyContact: target('#field0028_id input'),
    receivingContact: { ...target('.field-content-wrapper'), fieldLabel: '收款联系人' },
    receivingEmail: { ...target('.field-content-wrapper'), fieldLabel: '收款联系人邮箱' },
  } };
  const driver = new OaDriver({ profileDir: '/fixture' });
  driver.page = page; driver.timeout = 300;
  return { driver, config, form };
}

test('从下方收款字段复制到上方对方负责人，分别处理空值，保持来源且不点选人', async t => {
  const { driver, config, form } = await receivingFixture(t);
  for (const [contact, email] of [
    ['张三', 'a@example.invalid'], ['', 'a@example.invalid'], ['李四', ''], ['', ''],
  ]) {
    await form.evaluate(({ contact, email }) => {
      document.querySelector('#field1421_id .cap4-people__text').textContent = contact;
      document.querySelector('#field1427_id input').value = email;
      document.querySelector('#field0026_id input').value = '旧负责人';
      document.querySelector('#field0028_id input').value = '旧联系方式';
    }, { contact, email });
    const copied = await driver.copyCounterpartyFields(config);
    assert.deepEqual(copied, { contact, email });
    await driver.verifyCounterpartyFields(config, copied);
    const actual = await form.evaluate(() => ({
      sourceContact: document.querySelector('#field1421_id .cap4-people__text').textContent,
      sourceEmail: document.querySelector('#field1427_id input').value,
      owner: document.querySelector('#field0026_id input').value,
      contact: document.querySelector('#field0028_id input').value,
      model: window.targetModel,
    }));
    assert.deepEqual(actual, { sourceContact: contact, sourceEmail: email, owner: contact, contact: email, model: { owner: contact, contact: email } });
  }
  assert.equal(await form.evaluate(() => window.pickerClicks), 0);
  assert.equal(await form.evaluate(() => window.sourceInputEvents), 0);
  const events = await form.evaluate(() => window.targetEvents);
  assert.ok(events.length >= 16 && events.every(event => event.trusted));
  for (const key of ['owner', 'contact']) {
    assert.equal(events.filter(event => event.key === key && event.type === 'blur').length, 4);
    assert.ok(events.filter(event => event.key === key && event.type === 'input').length >= 4);
  }
  assert.match(await form.evaluate(() => String(Set)), /this.instance/);
});

test('联系人复制通过输入更新表单模型，重建保存页后回读并拦截来源及目标变化', async t => {
  const source = { sourceContact: '张三', sourceEmail: 'a@example.invalid' };
  const { driver, config, form } = await receivingFixture(t, source);
  const copied = await driver.copyCounterpartyFields(config);
  const persisted = await form.evaluate(() => window.targetModel);
  assert.deepEqual(persisted, { owner: '张三', contact: 'a@example.invalid' });
  await form.setContent(receivingFormHtml({ ...source, ...persisted }));
  await driver.verifyCounterpartyFields(config, copied);
  await form.evaluate(() => { document.querySelector('#field0026_id input').value = ''; });
  await assert.rejects(driver.verifyCounterpartyFields(config, copied), /对方负责人回读不一致/);
  await form.evaluate(() => { document.querySelector('#field0026_id input').value = '张三'; document.querySelector('#field0028_id input').value = ''; });
  await assert.rejects(driver.verifyCounterpartyFields(config, copied), /对方负责人联系方式回读不一致/);
  await form.evaluate(() => { document.querySelector('#field0028_id input').value = 'a@example.invalid'; document.querySelector('#field1421_id .cap4-people__text').textContent = '李四'; });
  await assert.rejects(driver.verifyCounterpartyFields(config, copied), /发生变化/);
  await form.evaluate(() => { document.querySelector('#field1421_id .cap4-people__text').textContent = '张三'; document.querySelector('#field1427_id input').value = 'changed@example.invalid'; });
  await assert.rejects(driver.verifyCounterpartyFields(config, copied), /发生变化/);
});
