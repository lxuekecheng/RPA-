import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  OaDriver, validateConfig, assertConfig, assertDraftButtonText,
  selectExactBudgetRow, firstEnabledOption, canonicalAmount, matchDraftReceipt,
} from '../src/oa-driver.mjs';

const example = JSON.parse(await readFile(new URL('../config/oa.example.json', import.meta.url), 'utf8'));

function fixtureConfig() {
  const config = structuredClone(example);
  delete config.source; // Feedback-mode fixtures exercise the retained generic adapter.
  config.verified = true;
  config.oaUrl = 'https://oa.example.invalid/login';
  config.newFormUrl = 'https://oa.example.invalid/new';
  function populate(object) {
    for (const [key, value] of Object.entries(object)) {
      if (key === 'selector') object[key] = '[data-test="fixture"]';
      else if (value && typeof value === 'object' && !Array.isArray(value)) populate(value);
    }
  }
  populate(config);
  config.picker.rowCodeSelector = '.code';
  config.picker.rowSelectSelector = 'input[type="radio"]';
  config.save.successText = '测试草稿保存成功';
  return config;
}

test('未接入配置列出全部缺项，不允许误认为可运行', () => {
  const errors = validateConfig(example);
  assert.ok(errors.some((error) => error.includes('verified')));
  assert.ok(errors.some((error) => error.includes('newFormUrl')));
  assert.ok(errors.some((error) => error.includes('fields.applicationAmount.selector')));
  assert.ok(errors.some((error) => error.includes('save.successText')));
  assert.throws(() => assertConfig(example), /尚未就绪/);
  assert.doesNotThrow(() => validateConfig(null));
  assert.doesNotThrow(() => validateConfig([]));
});

test('只接受完整已核验配置，iframe链和自定义选项也要校验', () => {
  const config = fixtureConfig();
  assert.deepEqual(validateConfig(config), []);
  config.content.kind = 'custom';
  config.content.options.selector = '';
  config.fields.contractName.frameChain = [''];
  config.picker.mode = 'popup';
  const errors = validateConfig(config);
  assert.ok(errors.some((error) => error.includes('content.options.selector')));
  assert.ok(errors.some((error) => error.includes('frameChain')));
  assert.ok(errors.some((error) => error.includes('same-page')));
});

test('保存按钮守卫拒绝发送、提交以及包含保存字样的其他按钮', () => {
  assert.doesNotThrow(() => assertDraftButtonText(' 保存待发 '));
  assert.doesNotThrow(() => assertDraftButtonText('暂存待发'));
  for (const text of ['发送', '提交审批', '保存并发送', '保存待发并提交', '']) {
    assert.throws(() => assertDraftButtonText(text), /仅允许/);
  }
});

test('预算编号必须精确且唯一，拒绝相近编号及重复编号', () => {
  assert.equal(selectExactBudgetRow(['TEST-2026-1390', ' TEST-2026-139 '], 'TEST-2026-139'), 1);
  assert.throws(() => selectExactBudgetRow(['TEST-2026-1390'], 'TEST-2026-139'), /0 条/);
  assert.throws(() => selectExactBudgetRow(['A', 'A'], 'A'), /2 条/);
});

test('合同内容取首个有效非空选项，跳过占位、禁用和隐藏项', () => {
  const selected = firstEnabledOption([
    { value: '', label: '请选择' },
    { value: 'placeholder', label: '请选择' },
    { value: 'a', label: '不适用', disabled: true },
    { value: 'b', label: '隐藏项', hidden: true },
    { value: 'c', label: '合同类型一' },
    { value: 'd', label: '合同类型二' },
  ]);
  assert.equal(selected.value, 'c');
  assert.throws(() => firstEnabledOption([{ label: ' ' }]), /没有可用/);
});

test('金额回读比较使用十进制文本，保留分，不使用浮点近似', () => {
  assert.equal(canonicalAmount('35,881.10'), '35881.10');
  assert.equal(canonicalAmount('0010.1'), '10.10');
  assert.equal(canonicalAmount('100'), '100.00');
  assert.throws(() => canonicalAmount('100.001'), /格式/);
});

test('缺失配置在导航和写入前失败，未打开浏览器也可安全关闭', async () => {
  const driver = new OaDriver({ profileDir: '/fixture/independent-profile' });
  let navigated = false;
  driver.page = { goto() { navigated = true; }, isClosed: () => false };
  driver.context = {};
  await assert.rejects(driver.fillAndSave({}, example), /尚未就绪/);
  assert.equal(navigated, false);
  driver.context = null;
  await driver.close();
  await driver.close();
});

function savingFixture({ oldSuccess = false, produceSuccess = true, draftId = 'draft-fixture-1' } = {}) {
  const config = fixtureConfig();
  const contract = {
    budgetCode: 'TEST-2026-139', contractName: '测试预算', amount: '35881.10',
    signingDate: '2026-10-26', description: '测试说明', compliance: '不签订',
    contentStrategy: 'first_enabled_nonempty',
    sealCustody: '公司保管合同章',
  };
  const events = [];
  let clicked = false;
  const driver = new OaDriver({ profileDir: '/fixture/independent-profile' });
  driver.context = {};
  driver.page = {
    isClosed: () => false,
    goto: async () => { events.push('navigate'); },
    setDefaultTimeout() {},
    url: () => 'https://oa.example.invalid/draft/1',
  };
  driver.pickBudget = async () => {};
  driver.fill = async () => {};
  driver.chooseContent = async () => ({ kind: 'native', value: 'first', index: 1 });
  driver.chooseSeal = async () => {};
  driver.copyCounterpartyFields = async () => ({ contact: '', email: '' });
  driver.verifyWritten = async () => { events.push('verify'); };
  driver.unique = async (target) => target === config.fields.complianceNo
    ? { evaluate: async () => true, check: async () => {} }
    : {
      evaluate: async () => '保存待发', isEnabled: async () => true,
      click: async () => { clicked = true; events.push('click'); },
    };
  driver.locator = (target) => {
    if (target === config.save.success) {
      const shown = () => oldSuccess || (clicked && produceSuccess);
      const locator = {
        count: async () => shown() ? 1 : 0,
        isVisible: async () => shown(),
        innerText: async () => config.save.successText,
      };
      locator.nth = () => locator;
      return locator;
    }
    return { count: async () => 1 };
  };
  driver.read = async () => draftId;
  driver.poll = async (check, message) => { if (!await check()) throw new Error(message); };
  return { driver, config, contract, events };
}

test('保存前先核验再 await 状态落盘，返回确切新提示及草稿凭据', async () => {
  const { driver, config, contract, events } = savingFixture();
  const result = await driver.fillAndSave(contract, config, {
    beforeSave: async () => { await Promise.resolve(); events.push('persist-saving'); },
  });
  assert.deepEqual(events, ['navigate', 'verify', 'persist-saving', 'click']);
  assert.equal(result.draftId, 'draft-fixture-1');
  assert.equal(result.url, 'https://oa.example.invalid/draft/1');
  assert.ok(Number.isFinite(Date.parse(result.savedAt)));
});

test('状态落盘失败时不得点击保存', async () => {
  const { driver, config, contract, events } = savingFixture();
  await assert.rejects(driver.fillAndSave(contract, config, {
    beforeSave: async () => { throw new Error('磁盘写入失败'); },
  }), /磁盘写入失败/);
  assert.equal(events.includes('click'), false);
});

test('页面残留旧成功提示时不得点击保存', async () => {
  const { driver, config, contract, events } = savingFixture({ oldSuccess: true });
  await assert.rejects(driver.fillAndSave(contract, config, {
    beforeSave: async () => { events.push('persist-saving'); },
  }), /已有可见成功提示/);
  assert.equal(events.includes('click'), false);
  assert.equal(events.includes('persist-saving'), false);
});

test('没有新成功提示或非空草稿号时报告结果不确定，绝不自动再点一次', async () => {
  for (const options of [{ produceSuccess: false }, { draftId: '' }]) {
    const { driver, config, contract, events } = savingFixture(options);
    await assert.rejects(driver.fillAndSave(contract, config), /结果不确定.*禁止自动重试/);
    assert.equal(events.filter((event) => event === 'click').length, 1);
  }
});

test('CAP4 不签订单选已选中时不重复点击，未选中时只点击一次', async () => {
  for (const initiallyChecked of [true, false]) {
    const { driver, config, contract } = savingFixture();
    config.compliance = { kind: 'cap4', checkedSelector: '.selected' };
    let checked = initiallyChecked;
    let clicks = 0;
    const unique = driver.unique;
    driver.unique = async (target, ...args) => target === config.fields.complianceNo
      ? { click: async () => { checked = !checked; clicks++; } }
      : unique(target, ...args);
    driver.complianceChecked = async () => checked;
    await driver.fillAndSave(contract, config);
    assert.equal(checked, true);
    assert.equal(clicks, initiallyChecked ? 0 : 1);
  }
});

function draftFixture({ destination = 'https://oa.example.invalid/new?from=waitSend&summaryId=-123&affairId=456', messages = [] } = {}) {
  const result = savingFixture({ draftId: '-123' });
  const { driver, config, events } = result;
  config.save.mode = 'seeyon-wait-send';
  let url = config.newFormUrl;
  const listeners = new Map();
  const frame = { url: () => url, evaluate: async () => messages };
  driver.page.on = (event, callback) => listeners.set(event, callback);
  driver.page.off = (event, callback) => { if (listeners.get(event) === callback) listeners.delete(event); };
  driver.page.frames = () => [frame];
  driver.page.url = () => url;
  driver.page.goto = async (target, options) => { events.push(options.waitUntil === 'commit' ? 'reload-draft' : 'navigate'); url = target; return { ok: () => true }; };
  driver.page.waitForNavigation = async () => { throw Error('不能依赖导航事件或 DOMContentLoaded'); };
  const unique = driver.unique;
  driver.unique = async (target, ...args) => {
    const locator = await unique(target, ...args);
    if (target !== config.save.button) return locator;
    const click = locator.click;
    locator.click = async () => { await click(); url = destination; listeners.get('framenavigated')?.(frame); };
    return locator;
  };
  return { ...result, listeners };
}

test('保存按草稿凭据确认并重新 GET 回读，不依赖整页加载事件', async () => {
  const { driver, config, contract, events, listeners } = draftFixture();
  const result = await driver.fillAndSave(contract, config, { beforeSave: async evidence => {
    assert.deepEqual(evidence, { expectedDraftId: '-123' }); events.push('persist-saving');
  } });
  assert.equal(result.draftId, '-123');
  assert.equal(result.affairId, '456');
  assert.deepEqual(events, ['navigate', 'verify', 'persist-saving', 'click', 'reload-draft', 'verify']);
  assert.equal(listeners.size, 0);
});

test('未取得凭据或编号不符时只点一次，保留待核查标识和页面提示', async () => {
  for (const destination of ['https://oa.example.invalid/new', 'https://oa.example.invalid/new?from=waitSend&summaryId=-999&affairId=456']) {
    const { driver, config, contract, events, listeners } = draftFixture({ destination, messages: ['请填写合同必填项'] });
    await assert.rejects(driver.fillAndSave(contract, config), /结果不确定.*禁止自动重试/);
    assert.equal(events.filter(event => event === 'click').length, 1);
    assert.equal(events.filter(event => event === 'verify').length, 1);
    assert.equal(events.includes('reload-draft'), false);
    assert.equal(listeners.size, 0);
  }
});

test('成功提示和同源地址不足以确认保存，路径、标识和待发来源均须匹配', () => {
  const config = fixtureConfig();
  const valid = 'https://oa.example.invalid/new?from=waitSend&summaryId=-123&affairId=456';
  assert.equal(matchDraftReceipt(valid, '-123', config).draftId, '-123');
  for (const value of [valid.replace('oa.example.invalid', 'other.invalid'), valid.replace('/new?', '/login?'),
    valid.replace('-123', '-999'), valid.replace('waitSend', 'bizconfig'), valid.replace('affairId=456', 'affairId=')]) {
    assert.equal(matchDraftReceipt(value, '-123', config), null);
  }
});

test('服务器重新打开的草稿丢失填写值时保持待核查，不能仅凭 URL 判成功', async () => {
  const { driver, config, contract, events } = draftFixture();
  let verifies = 0;
  driver.verifyWritten = async () => { if (++verifies === 2) throw Error('对方负责人回读不一致'); };
  await assert.rejects(driver.fillAndSave(contract, config), error => {
    assert.match(error.message, /对方负责人回读不一致.*结果不确定/);
    assert.equal(error.saveEvidence.expectedDraftId, '-123');
    assert.equal(error.saveEvidence.affairId, '456');
    return true;
  });
  assert.equal(events.filter(event => event === 'click').length, 1);
});

test('已经打开同一待发草稿时不再点击保存，也不写入 saving 状态', async () => {
  const { driver, config, contract, events } = draftFixture();
  driver.page.frames = () => [{ url: () => 'https://oa.example.invalid/new?from=waitSend&summaryId=-123&affairId=456' }];
  await assert.rejects(driver.fillAndSave(contract, config, { beforeSave: async () => events.push('persist-saving') }), /阻止重复保存/);
  assert.equal(events.includes('click'), false);
  assert.equal(events.includes('persist-saving'), false);
});

test('草稿地址匹配但服务器回读失败时不能报告保存成功', async () => {
  const { driver, config, contract, events } = draftFixture();
  const goto = driver.page.goto;
  driver.page.goto = async (url, options) => {
    const response = await goto(url, options);
    return options.waitUntil === 'commit' ? { ok: () => false, status: () => 503 } : response;
  };
  await assert.rejects(driver.fillAndSave(contract, config), /草稿回读请求失败：HTTP 503.*结果不确定/);
  assert.equal(events.filter(event => event === 'click').length, 1);
  assert.equal(events.filter(event => event === 'verify').length, 1);
});

test('整批结束只关闭跟踪的录入页，保留主页及其他标签，下一批可继续使用', async () => {
  const closed = [];
  const home = { isClosed: () => false };
  const other = { isClosed: () => false };
  const entry = { isClosed: () => false, close: async () => closed.push('entry') };
  const driver = new OaDriver({ profileDir: '/fixture' });
  driver.context = { pages: () => [home, other, entry], close: async () => closed.push('browser') };
  driver.homePage = home; driver.page = entry; driver.entryPage = entry;
  assert.equal(await driver.closeEntryPage(), true);
  assert.deepEqual(closed, ['entry']);
  assert.equal(driver.page, home);
  assert.equal(driver.homePage, home);
  assert.equal(driver.entryPage, null);
  assert.equal(await driver.closeEntryPage(), false);
  // Closing an untracked page or the home page is never allowed.
  driver.entryPage = home;
  assert.equal(await driver.closeEntryPage(), false);
  assert.deepEqual(closed, ['entry']);
});

test('主页已关闭且只剩录入页时先新建标签，保留浏览器会话', async () => {
  const events = [];
  const entry = { isClosed: () => false, close: async () => events.push('close-entry') };
  const replacement = { isClosed: () => false };
  const driver = new OaDriver({ profileDir: '/fixture' });
  driver.context = { pages: () => [entry], newPage: async () => { events.push('new-page'); return replacement; } };
  driver.homePage = { isClosed: () => true }; driver.page = entry; driver.entryPage = entry;
  assert.equal(await driver.closeEntryPage(), true);
  assert.deepEqual(events, ['new-page', 'close-entry']);
  assert.equal(driver.page, replacement);
});
