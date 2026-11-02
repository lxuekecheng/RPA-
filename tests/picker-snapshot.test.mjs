import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { OaDriver } from '../src/oa-driver.mjs';
import { ITSM_COLUMNS, TARGET_FEE, normalizeOaRow } from '../src/oa-budget.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

const budgets = {
  'BUDGET-A': { '年度': '2026', '费用说明': '预算A说明', '分摊合计含税': '1000.00', '预算编号': 'BUDGET-A',
    '预算名称': '预算A', '收费属性': TARGET_FEE, '已分摊合同金额': '100.00', '在途分摊合同金额': '50.00' },
  'BUDGET-B': { '年度': '2026', '费用说明': '预算B说明', '分摊合计含税': '2000.55', '预算编号': 'BUDGET-B',
    '预算名称': '预算B', '收费属性': TARGET_FEE, '已分摊合同金额': '800.00', '在途分摊合同金额': '0.01' },
};

async function fixture(t, { incompleteQuery = false } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname === '/query') {
      const code = url.searchParams.get('code');
      requests.push(code);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ rows: budgets[code] ? [budgets[code]] : [], total: incompleteQuery ? 2 : 1, pages: 1 }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (url.pathname === '/') { response.end('<iframe id="picker" src="/picker" style="width:1100px;height:600px"></iframe>'); return; }
    response.end(`<!doctype html><html><body>
      <input id="year" value="2026"><input id="code"><button id="filter" onclick="query()">筛选</button>
      <button id="reopen" onclick="cachedReopen()">重开项目编号列表</button>
      <table class="v-easy-table-htable"><tr>${ITSM_COLUMNS.map(name => '<td>' + name + '</td>').join('')}</tr></table>
      <table><tbody id="rows"></tbody></table>
      <div class="cap4-page__cnt">每页显示 <input value="50"> 条 <span id="totals"></span> 第 <input value="1"> 页</div>
      <script>
        const columns=${JSON.stringify(ITSM_COLUMNS)};
        const initial=${JSON.stringify(budgets['BUDGET-A'])};
        function render(data){
          document.querySelector('#rows').innerHTML=data.rows.map(row=>'<tr class="v-easy-table-row">'+columns.map(name=>'<td><span class="v-td-content">'+row[name]+'</span></td>').join('')+'</tr>').join('');
          document.querySelector('#totals').textContent='共'+data.total+'条记录 共'+data.pages+'页';
        }
        function cachedReopen(){document.querySelector('#code').value='';render({rows:[initial],total:143,pages:3});}
        async function query(){const code=document.querySelector('#code').value;const response=await fetch('/query?code='+encodeURIComponent(code));render(await response.json());}
        render({rows:[initial],total:1,pages:1});
        window.Set=function Set(){this.instance=[];};
      </script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  t.after(() => page.close());
  await page.goto('http://127.0.0.1:' + server.address().port + '/');
  const target = selector => ({ selector, frameChain: ['#picker'] });
  const config = { picker: { resultRows: target('tr.v-easy-table-row'), yearInput: target('#year'), searchInput: target('#code'),
    searchButton: target('#filter'), queryResponsePath: '/query' } };
  const driver = new OaDriver({ profileDir: '/fixture' });
  driver.page = page; driver.timeout = 600;
  return { driver, config, requests, reopen: () => driver.locator(target('#reopen')).click() };
}

test('连续筛选两条预算：重开弹窗的旧行数与分页总数不一致也能主动查询并严格核验新结果', async t => {
  const { driver, config, requests, reopen } = await fixture(t);
  const first = await driver.filterPicker(config, { year: '2026', code: 'BUDGET-A' });
  assert.equal(first.ready, true);
  assert.equal(normalizeOaRow(first.records[0]).amount, '850.00');
  await reopen();
  const cached = await driver.readPickerSnapshot(config);
  assert.equal(cached.ready, false);
  assert.equal(cached.total, 143);
  assert.equal(cached.records.length, 1);
  const second = await driver.filterPicker(config, { year: '2026', code: 'BUDGET-B' });
  assert.deepEqual(requests, ['BUDGET-A', 'BUDGET-B']);
  assert.equal(second.ready, true);
  assert.equal(second.total, 1);
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0]['预算编号'], 'BUDGET-B');
  assert.equal(normalizeOaRow(second.records[0]).amount, '1200.54');
});

test('主动查询后分页总数与行数仍不一致时必须拒绝，不能使用未核验预算', async t => {
  const { driver, config, requests } = await fixture(t, { incompleteQuery: true });
  await assert.rejects(driver.filterPicker(config, { year: '2026', code: 'BUDGET-B' }), /预算列表加载或分页核对超时/);
  assert.deepEqual(requests, ['BUDGET-B']);
  const snapshot = await driver.readPickerSnapshot(config);
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.ready, false);
});
