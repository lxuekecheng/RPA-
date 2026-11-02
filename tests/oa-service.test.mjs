import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RpaService } from '../src/service.mjs';
import { TARGET_FEE } from '../src/oa-budget.mjs';
import { createApp } from '../src/server.mjs';

const root = path.resolve(import.meta.dirname, '..');
const raw = (code, changes = {}) => ({ '年度': '2026', '费用说明': '测试说明', '预算编号': code, '预算名称': '预算 ' + code,
  '收费属性': TARGET_FEE, '分摊合计含税': '1000.00', '已分摊合同金额': '100.00', '在途分摊合同金额': '50.00', ...changes });
function fixture(t, records = [raw('A')]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-source-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const driver = { context: {}, readBudgets: async (config, { year, onProgress }) => {
    calls.push({ kind: 'scan', year }); onProgress({ page: 1, pages: 1, count: records.length, total: records.length }); return records;
  }, fillAndSave: async (contract, config, { beforeSave }) => {
    calls.push({ kind: 'save', contract }); await beforeSave(); return { draftId: 'draft-' + contract.key, savedAt: new Date().toISOString() };
  } };
  const service = new RpaService({ root, dataDir, driver });
  function populate(object) { for (const [key, value] of Object.entries(object)) {
    if (key === 'selector') object[key] = '#fixture'; else if (value && typeof value === 'object' && !Array.isArray(value)) populate(value);
  } }
  populate(service.config);
  service.config.verified = true;
  service.config.oaUrl = 'https://fixture.invalid/login'; service.config.newFormUrl = 'https://fixture.invalid/form';
  service.config.source = { kind: 'oa', verified: true, year: '2026', blankAllocatedAsZero: true };
  Object.assign(service.config.picker, { yearInput: { selector: '#year' }, cancel: { selector: '#cancel' }, nextPage: { selector: '#next' }, queryResponsePath: '/query', rowCodeSelector: '.code', rowSelectSelector: '.select' });
  service.config.save.successText = '保存成功'; service.browserOpen = true;
  fs.writeFileSync(service.configPath, JSON.stringify(service.config));
  return { service, driver, calls, records };
}

test('ITSM 读取仅保留指定收费属性，分开统计正余额、零余额与金额异常', async t => {
  const { service } = fixture(t, [raw('A'), raw('B', { '分摊合计含税': '150.00' }), raw('C', { '分摊合计含税': '' }), raw('D', { '收费属性': '三方项目收入' })]);
  const p = await service.scan({ year: '2026' });
  assert.equal(p.scannedCount, 4); assert.equal(p.rows.length, 3);
  assert.equal(p.validCount, 1); assert.equal(p.skippedCount, 1); assert.equal(p.blockedCount, 1);
  assert.equal(p.totalAmount, '850.00'); assert.equal(p.sourceKind, 'oa');
  assert.throws(() => service.start({ previewId: p.previewId, ids: [p.rows[1].id] }), /无效/);
});

test('执行使用 ITSM 剩余金额；保存后即使 ITSM 未计入在途也不会再次创建', async t => {
  const { service, calls, records } = fixture(t);
  const p = await service.scan({ year: '2026' });
  service.start({ previewId: p.previewId, ids: [p.rows[0].id] }); await service.runPromise;
  const contract = calls.find(call => call.kind === 'save').contract;
  assert.equal(contract.amount, '850.00'); assert.equal(contract.balance.totalAmount, '1000.00');
  const currentYear = contract.signingDate.slice(0, 4);
  assert.equal(contract.contractName, currentYear + '年信息化分摊费用预算 A');
  assert.equal(contract.description, currentYear + '年信息化分摊费用');
  assert.equal(service.history.entries.get(p.rows[0].id).amount, '850.00');
  records[0]['已分摊合同金额'] = '950.00';
  const reread = await service.scan({ year: '2026' });
  assert.equal(reread.rows[0].amount, '0.00'); assert.equal(reread.rows[0].status, 'saved');
  assert.throws(() => service.start({ previewId: reread.previewId, ids: [reread.rows[0].id] }), /已保存/);
});

test('旧文件预览不能在 ITSM 模式执行，直接读取为空时仍可恢复空预览', async t => {
  const { service } = fixture(t, []);
  const csv = '年度,费用说明,分摊合计含税,预算编号,预算名称\n2026,测试,100,A,预算A';
  const legacy = await service.preview({ filename: 'legacy.csv', base64: Buffer.from(csv).toString('base64') });
  assert.throws(() => service.start({ previewId: legacy.previewId, ids: [legacy.rows[0].id] }), /旧文件/);
  const empty = await service.scan({ year: '2026' }); assert.equal(empty.rows.length, 0);
  const restarted = new RpaService({ root, dataDir: service.dataDir, driver: service.driver });
  assert.equal(restarted.getPreview().sourceKind, 'oa'); assert.equal(restarted.getPreview().rows.length, 0);
});

test('ITSM 读取失败保留上次成功快照；读取时禁止启动、再次读取或修改连接', async t => {
  const { service, driver } = fixture(t);
  const first = await service.scan({ year: '2026' });
  let release;
  driver.readBudgets = () => new Promise(resolve => { release = resolve; });
  const reading = service.scan({ year: '2026' });
  await assert.rejects(service.scan({ year: '2026' }), /正在读取/);
  assert.throws(() => service.start({ previewId: first.previewId, ids: [first.rows[0].id] }), /正在导入/);
  assert.throws(() => service.saveConfig(service.config), /正在导入/);
  release([raw('B')]); await reading;
  const goodId = service.getPreview().previewId;
  driver.readBudgets = async () => { throw Error('ITSM 查询失败'); };
  await assert.rejects(service.scan({ year: '2026' }), /查询失败/);
  assert.equal(service.importing, false); assert.equal(service.getPreview().previewId, goodId);
});

test('实时余额变化在保存前失败且停止后续；结果不确定的记录即使零余额也不自动解锁', async t => {
  const { service, driver, records } = fixture(t, [raw('A'), raw('B')]);
  const p = await service.scan({ year: '2026' }); let attempts = 0;
  driver.fillAndSave = async () => { attempts++; throw Error('ITSM 余额已变化，请重新读取'); };
  service.start({ previewId: p.previewId, ids: p.rows.map(row => row.id) }); await service.runPromise;
  assert.equal(attempts, 1); assert.equal(service.history.state(p.rows[0]).status, 'failed');
  assert.equal(service.history.state(p.rows[1]).status, 'ready');
  service.history.put(p.rows[0], 'saving'); records[0]['已分摊合同金额'] = '950.00';
  const changed = await service.scan({ year: '2026' }); assert.equal(changed.rows[0].status, 'uncertain');
});

test('ITSM 读取接口要求 token，上传接口关闭且页面不再提供文件上传', async t => {
  const { service } = fixture(t); const { server } = createApp({ service, token: 'local-oa-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-Local-Token': 'local-oa-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(url + '/api/oa/scan', { method: 'POST', body: '{}' })).status, 403);
  const response = await fetch(url + '/api/oa/scan', { method: 'POST', headers, body: JSON.stringify({ year: '2026' }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).rows[0].amount, '850.00');
  const removed = await fetch(url + '/api/preview', { method: 'POST', headers, body: '{}' }); assert.equal(removed.status, 404); await removed.json();
  const html = await (await fetch(url)).text(); assert.ok(html.includes('scan-button')); assert.ok(!html.includes('type="file"'));
  assert.ok(html.includes('type="module"')); assert.ok(html.includes('<title>ITSM'));
  const sharedRules = await fetch(url + '/contract-rules.js');
  assert.equal(sharedRules.status, 200); assert.match(sharedRules.headers.get('content-type'), /javascript/);
  assert.ok((await sharedRules.text()).includes('年信息化分摊费用'));
});

test('十条全部确认保存并落盘后才关闭一次录入页', async t => {
  const { service, driver, calls } = fixture(t, Array.from({ length: 10 }, (_, i) => raw('BATCH-' + i)));
  const p = await service.scan({ year: '2026' });
  let closed = 0;
  const save = driver.fillAndSave;
  driver.fillAndSave = async (...args) => { assert.equal(closed, 0); return save(...args); };
  driver.closeEntryPage = async () => {
    closed++;
    assert.equal(calls.filter(c => c.kind === 'save').length, 10);
    for (const row of p.rows) assert.equal(service.history.state(row).status, 'saved');
    return true;
  };
  service.start({ previewId: p.previewId, ids: p.rows.map(row => row.id) }); await service.runPromise;
  assert.equal(closed, 1);
  assert.ok(service.logs.some(log => log.message.includes('录入页面已关闭')));
});

test('中途停止、填写失败或保存不确定时保留录入页', async t => {
  for (const mode of ['stop', 'failed', 'uncertain']) {
    const { service, driver } = fixture(t, [raw('A'), raw('B')]);
    const p = await service.scan({ year: '2026' });
    let closes = 0;
    driver.closeEntryPage = async () => { closes++; return true; };
    driver.fillAndSave = async (contract, config, { beforeSave }) => {
      if (mode === 'failed') throw Error('填写失败');
      await beforeSave();
      if (mode === 'uncertain') throw Error('保存结果不确定');
      service.stop();
      return { draftId: 'draft-A', savedAt: new Date().toISOString() };
    };
    service.start({ previewId: p.previewId, ids: p.rows.map(row => row.id) }); await service.runPromise;
    assert.equal(closes, 0);
    assert.equal(service.history.state(p.rows[0]).status, mode === 'stop' ? 'saved' : mode);
    assert.equal(service.history.state(p.rows[1]).status, 'ready');
  }
});

test('关闭录入页失败保留已保存状态，记录提示且不重复保存', async t => {
  const { service, driver, calls } = fixture(t);
  const p = await service.scan({ year: '2026' });
  driver.closeEntryPage = async () => { throw Error('关闭失败'); };
  service.start({ previewId: p.previewId, ids: [p.rows[0].id] }); await service.runPromise;
  assert.equal(service.history.state(p.rows[0]).status, 'saved');
  assert.equal(calls.filter(c => c.kind === 'save').length, 1);
  assert.ok(service.logs.some(log => log.level === 'warning' && log.message.includes('录入页面未能关闭')));
});

test('保存结果不确定时持久保留待核查标识和观测凭据，重启后继续禁止重复创建', async t => {
  const { service, driver } = fixture(t);
  const p = await service.scan({ year: '2026' });
  driver.fillAndSave = async (contract, config, { beforeSave }) => {
    await beforeSave({ expectedDraftId: '-123' });
    assert.equal(service.history.entries.get(p.rows[0].id).expectedDraftId, '-123');
    const error = new Error('保存后回读不一致');
    error.saveEvidence = { expectedDraftId: '-123', observedUrl: 'https://fixture.invalid/form?from=waitSend&summaryId=-123&affairId=456' };
    throw error;
  };
  service.start({ previewId: p.previewId, ids: [p.rows[0].id] }); await service.runPromise;
  const restarted = new RpaService({ root, dataDir: service.dataDir, driver });
  const entry = restarted.history.entries.get(p.rows[0].id);
  assert.equal(entry.expectedDraftId, '-123');
  assert.match(entry.observedUrl, /summaryId=-123/);
  assert.equal(restarted.getPreview().rows[0].status, 'uncertain');
});
