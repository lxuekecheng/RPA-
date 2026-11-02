import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpaService } from '../src/service.mjs';
import { History } from '../src/history.mjs';
import { createApp } from '../src/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csv = '年度,费用说明,分摊合计含税,预算编号,预算名称\n2026,测试说明,35881.10,TEST-1,测试预算甲\n2026,第二条,18983.10,TEST-2,测试预算乙';
const input = { filename: 'fixture.csv', base64: Buffer.from(csv).toString('base64') };

function fixture(t, save) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const driver = { open: async () => {}, close: async () => {}, fillAndSave: save || (async (contract, config, { beforeSave }) => {
    await beforeSave(); return { draftId: `draft-${contract.key}`, savedAt: new Date().toISOString(), url: 'https://fixture.invalid/draft' };
  }) };
  const service = new RpaService({ root, dataDir, driver });
  delete service.config.source; // Legacy parser tests; production mode is covered in oa-service.test.mjs.
  const complete = object => {
    for (const [key, value] of Object.entries(object)) {
      if (key === 'selector') object[key] = '#fixture';
      else if (value && typeof value === 'object' && !Array.isArray(value)) complete(value);
    }
  };
  complete(service.config);
  Object.assign(service.config, { verified: true, oaUrl: 'https://fixture.invalid/login', newFormUrl: 'https://fixture.invalid/new' });
  Object.assign(service.config.picker, { rowCodeSelector: '.code', rowSelectSelector: '.choose' });
  service.config.save.successText = '测试保存成功';
  service.browserOpen = true;
  fs.writeFileSync(service.configPath, JSON.stringify(service.config));
  return service;
}

test('保存成功后跨文件名/重新导入/进程重启均不重复创建，内容变更需核查', async t => {
  const service = fixture(t);
  const preview = await service.preview(input);
  assert.equal(preview.totalAmount, '54864.20');
  service.start({ previewId: preview.previewId, ids: [preview.rows[0].id] });
  await service.runPromise;
  const second = await service.preview({ ...input, filename: 'renamed.csv' });
  assert.equal(second.rows[0].status, 'saved');
  assert.equal(second.validCount, 1);
  assert.throws(() => service.start({ previewId: second.previewId, ids: [second.rows[0].id] }), /已保存/);
  const restarted = new History(service.history.filename);
  assert.equal(restarted.state(second.rows[0]).status, 'saved');
  assert.equal(restarted.state({ ...second.rows[0], amount: '35881.11' }).status, 'changed');
});

test('点击保存后异常标记待核查并停止后续预算，重启后禁止重试', async t => {
  let calls = 0;
  const service = fixture(t, async (contract, config, { beforeSave }) => { calls++; await beforeSave(); throw new Error('保存响应超时'); });
  const preview = await service.preview(input);
  service.start({ previewId: preview.previewId, ids: preview.rows.map(row => row.id) });
  await service.runPromise;
  assert.equal(calls, 1);
  assert.equal(service.history.state(preview.rows[0]).status, 'uncertain');
  assert.equal(new History(service.history.filename).state(preview.rows[0]).status, 'uncertain');
  assert.equal(service.history.state(preview.rows[1]).status, 'ready');
});

test('保存前失败允许修复后重试；批次互斥，停止等待当前合同完成', async t => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const service = fixture(t, async (contract, config, { beforeSave }) => {
    calls++; entered(); await gate; await beforeSave();
    return { draftId: 'fixture-draft', savedAt: new Date().toISOString() };
  });
  const preview = await service.preview(input);
  const request = { previewId: preview.previewId, ids: preview.rows.map(row => row.id) };
  service.start(request);
  await ready;
  assert.throws(() => service.start(request), /已有一轮/);
  await assert.rejects(service.preview(input), /锁定/);
  service.stop(); release(); await service.runPromise;
  assert.equal(calls, 1);
  assert.equal(service.history.state(preview.rows[0]).status, 'saved');
  service.driver.fillAndSave = async () => { throw new Error('找不到预算编号'); };
  service.start({ previewId: preview.previewId, ids: [preview.rows[1].id] });
  await service.runPromise;
  assert.equal(service.history.state(preview.rows[1]).status, 'failed');
});

test('未核验配置、无效数据、重复选择在浏览器写入前拒绝', async t => {
  const service = fixture(t);
  const preview = await service.preview(input);
  assert.throws(() => service.start({ previewId: preview.previewId, ids: [preview.rows[0].id, preview.rows[0].id] }), /不重复/);
  service.config.verified = false;
  assert.throws(() => service.start({ previewId: preview.previewId, ids: [preview.rows[0].id] }), /尚未就绪/);
  assert.equal(service.history.entries.size, 0);
});

test('中断的填写/保存记录与损坏日志不会静默视为新预算', async t => {
  const service = fixture(t);
  const { rows } = await service.preview(input);
  service.history.put(rows[0], 'filling');
  assert.equal(new History(service.history.filename).state(rows[0]).status, 'uncertain');
  fs.appendFileSync(service.history.filename, '{broken');
  assert.throws(() => new History(service.history.filename), /损坏/);
});

test('本机API要求会话token及同源；上传接口已移除，历史预览可读取', async t => {
  const service = fixture(t);
  const { server } = createApp({ service, token: 'fixture-local-token' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/status`)).status, 403);
  assert.equal((await fetch(`${url}/api/preview`)).status, 403);
  const headers = { 'X-Local-Token': 'fixture-local-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${url}/api/status`, { headers: { ...headers, Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await fetch(`${url}/api/preview`, { headers: { ...headers, Origin: 'https://other.invalid' } })).status, 403);
  assert.equal(await (await fetch(`${url}/api/preview`, { headers })).json(), null);
  const response = await fetch(`${url}/api/preview`, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(response.status, 404);
  await response.json();
  const uploaded = await service.preview(input);
  assert.equal(uploaded.validCount, 2);
  const restored = await (await fetch(`${url}/api/preview`, { headers })).json();
  assert.deepEqual(restored, uploaded);
  const page = await (await fetch(url)).text();
  assert.ok(page.includes('fixture-local-token'));
  assert.ok(!page.includes('__APP_TOKEN__'));
  assert.equal((await fetch(`${url}/.local/history.jsonl`)).status, 404);
});

test('重启恢复最近预算并按历史重算状态，不信任旧预览状态', async t => {
  const service = fixture(t);
  const preview = await service.preview(input);
  service.history.put(preview.rows[0], 'saved', { draftId: 'confirmed-draft' });
  service.history.put(preview.rows[1], 'saving');
  const snapshot = JSON.parse(fs.readFileSync(service.previewPath, 'utf8'));
  for (const row of snapshot.preview.rows) Object.assign(row, { status: 'ready', message: '过期状态', draftId: 'stale' });
  fs.writeFileSync(service.previewPath, JSON.stringify(snapshot));
  const restarted = new RpaService({ root, dataDir: service.dataDir, driver: service.driver });
  const restored = restarted.getPreview();
  assert.equal(restored.previewId, preview.previewId);
  assert.equal(restored.filename, input.filename);
  assert.equal(restored.rows.length, 2);
  assert.equal(restored.rows[0].status, 'saved');
  assert.equal(restored.rows[0].draftId, 'confirmed-draft');
  assert.equal(restored.rows[1].status, 'uncertain');
  assert.equal(restored.rows[1].draftId, undefined);
  assert.equal(restored.validCount, 0);
  assert.equal(restored.totalAmount, '0.00');
  assert.equal(restarted.status().rowStates[preview.rows[1].id].status, 'uncertain');
});

test('无效预算行可以恢复，解析失败不覆盖最近成功预览', async t => {
  const service = fixture(t);
  const invalidInput = { filename: 'invalid.csv', base64: Buffer.from(csv.replace('35881.10', 'invalid')).toString('base64') };
  const preview = await service.preview(invalidInput);
  assert.equal(preview.rows[0].status, 'invalid');
  const snapshot = fs.readFileSync(service.previewPath, 'utf8');
  await assert.rejects(service.preview({ filename: 'broken.csv', base64: Buffer.from('not a budget').toString('base64') }), /表头/);
  assert.equal(service.importing, false);
  assert.equal(fs.readFileSync(service.previewPath, 'utf8'), snapshot);
  assert.equal(service.getPreview().previewId, preview.previewId);
  const restarted = new RpaService({ root, dataDir: service.dataDir, driver: service.driver });
  assert.equal(restarted.getPreview().rows[0].status, 'invalid');
  assert.equal(restarted.getPreview().validCount, 1);
  assert.equal(restarted.getPreview().totalAmount, '18983.10');
  assert.deepEqual(fs.readdirSync(service.dataDir).filter(name => name.endsWith('.tmp')), []);
});

test('损坏预览不会阻止工具启动，也不会被静默当成可执行预算', t => {
  const service = fixture(t);
  fs.writeFileSync(service.previewPath, '{broken');
  const restarted = new RpaService({ root, dataDir: service.dataDir, driver: service.driver });
  assert.equal(restarted.getPreview(), null);
  assert.match(restarted.logs.find(entry => entry.level === 'warning').message, /重新读取 ITSM/);
  assert.equal(fs.readFileSync(service.previewPath, 'utf8'), '{broken');
});

test('导入期间拒绝第二次导入及录入/浏览器/配置操作，完成后释放锁', async t => {
  const service = fixture(t);
  const pending = service.preview(input);
  assert.equal(service.status().importing, true);
  const secondImport = assert.rejects(service.preview(input), /正在导入/);
  assert.throws(() => service.start({ previewId: 'pending', ids: ['pending'] }), /正在导入/);
  const openBrowser = assert.rejects(service.openBrowser(), /正在导入/);
  assert.throws(() => service.saveConfig(service.config), /正在导入/);
  await Promise.all([secondImport, openBrowser]);
  const preview = await pending;
  assert.equal(service.status().importing, false);
  assert.equal(service.getPreview().previewId, preview.previewId);
});
