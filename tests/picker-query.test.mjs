import test from 'node:test';
import assert from 'node:assert/strict';
import { OaDriver } from '../src/oa-driver.mjs';

function fixture(responses = [{ status: 200 }]) {
  const target = name => ({ selector: '#' + name });
  const config = { picker: {
    queryResponsePath: '/query', resultRows: target('rows'),
    yearInput: target('year'), searchInput: target('code'), searchButton: target('filter'),
    open: target('open'), nextPage: target('next'), cancel: target('cancel'),
  } };
  const frame = {};
  const calls = { queries: 0, finished: 0, ready: 0, clicks: [], fills: [] };
  const pending = [...responses];
  const snapshot = { ready: true, page: 1, pages: 1, total: 1,
    records: [{ '年度': '2026', '预算编号': 'TEST-2026-031' }] };
  const driver = new OaDriver({ profileDir: '/fixture/picker-query' });
  driver.timeout = 100;
  driver.page = {
    waitForTimeout: async () => {},
    waitForResponse: async predicate => {
      calls.queries++;
      const result = pending.shift();
      if (!result) throw Error('测试未提供更多响应，不应继续重试');
      if (result.noResponse) throw Error('Timeout waiting for response');
      const response = {
        url: () => 'https://fixture.invalid/query',
        request: () => ({ frame: () => frame }),
        ok: () => result.status >= 200 && result.status < 300,
        status: () => result.status,
        finished: async () => { calls.finished++; return result.finishError || null; },
      };
      assert.equal(predicate(response), true);
      return response;
    },
  };
  driver.locator = () => ({ frame: async () => frame });
  driver.unique = async item => ({ click: async () => { calls.clicks.push(item.selector); } });
  driver.fill = async (item, value) => { calls.fills.push([item.selector, value]); };
  driver.pickerReady = async (settings, predicate = () => true) => {
    calls.ready++;
    assert.equal(predicate(snapshot), true);
    return snapshot;
  };
  return { driver, config, calls, pending, snapshot };
}

test('预算查询 HTTP 502 保留状态码并标记临时网络失败', async () => {
  const { driver, config, calls } = fixture([{ status: 502 }]);
  await assert.rejects(driver.pickerQuery(config, async () => calls.clicks.push('#filter')), error => {
    assert.match(error.message, /HTTP\s*502/);
    assert.equal(error.queryNetworkFailure, true);
    return true;
  });
  assert.equal(calls.queries, 1);
  assert.equal(calls.finished, 0);
  assert.equal(calls.ready, 0);
});

test('HTTP 200 后响应中断立即拒绝，不进入分页就绪轮询', async () => {
  const { driver, config, calls } = fixture([{ status: 200, finishError: Error('net::ERR_CONNECTION_RESET') }]);
  await assert.rejects(driver.pickerQuery(config, async () => calls.clicks.push('#filter')), error => {
    assert.equal(error.queryNetworkFailure, true);
    return true;
  });
  assert.equal(calls.queries, 1);
  assert.equal(calls.finished, 1);
  assert.equal(calls.ready, 0);
});

test('相同年度编号的只读筛选临时失败一次后可重试成功', async () => {
  const { driver, config, calls, snapshot } = fixture([{ status: 502 }, { status: 200 }]);
  const result = await driver.filterPicker(config, { year: '2026', code: 'TEST-2026-031' });
  assert.equal(result, snapshot);
  assert.equal(calls.queries, 2);
  assert.deepEqual(calls.clicks, ['#filter', '#filter']);
  assert.equal(calls.ready, 1);
  assert.ok(calls.fills.some(([selector, value]) => selector === '#year' && value === '2026'));
  assert.ok(calls.fills.some(([selector, value]) => selector === '#code' && value === 'TEST-2026-031'));
  assert.ok(calls.fills.every(([selector, value]) => value === (selector === '#year' ? '2026' : 'TEST-2026-031')));
});

test('只读筛选连续网络失败最多尝试两次，不继续第三次或进入分页轮询', async () => {
  const { driver, config, calls, pending } = fixture([{ status: 502 }, { status: 503 }, { status: 200 }]);
  await assert.rejects(driver.filterPicker(config, { year: '2026', code: 'TEST-2026-031' }), error => {
    assert.equal(error.queryNetworkFailure, true);
    return true;
  });
  assert.equal(calls.queries, 2);
  assert.equal(calls.ready, 0);
  assert.equal(pending.length, 1);
});

test('没有收到响应时也只允许相同条件重试一次', async () => {
  const { driver, config, calls } = fixture([{ noResponse: true }, { status: 200 }]);
  await driver.filterPicker(config, { year: '2026', code: 'TEST-2026-031' });
  assert.equal(calls.queries, 2);
  assert.equal(calls.ready, 1);
});

test('筛选后的数据完整性失败不通过重新查询掩盖', async () => {
  const { driver, config, calls } = fixture([{ status: 200 }, { status: 200 }]);
  driver.pickerReady = async () => { calls.ready++; throw Error('ITSM 关联列表表头缺失或重复：预算编号'); };
  await assert.rejects(driver.filterPicker(config, { year: '2026', code: 'TEST-2026-031' }), /表头缺失或重复/);
  assert.equal(calls.queries, 1);
  assert.equal(calls.ready, 1);
});

test('下一页操作网络失败不自动点击第二次，避免跳过一页', async () => {
  const { driver, config, calls } = fixture([{ status: 502 }, { status: 200 }]);
  driver.prepareForm = async () => {};
  driver.filterPicker = async () => ({ ready: true, page: 1, pages: 2, total: 2,
    records: [{ '年度': '2026', '预算编号': 'FIRST' }] });
  await assert.rejects(driver.readBudgets(config, { year: '2026' }), /HTTP\s*502/);
  assert.equal(calls.queries, 1);
  assert.deepEqual(calls.clicks, ['#open', '#next']);
  assert.equal(calls.ready, 0);
});
