import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { amountCents, buildContract, parseBudget, RULES } from '../src/budget.mjs';

const headers = ['年度', '费用说明', '分摊合计含税', '下发渠道', '预算编号', '预算名称', '制单人', '制单日期', '收费属性'];
const values = (amount = '35,881.10', overrides = {}) => {
  const row = { 年度: '2026', 费用说明: '预算费用说明', 分摊合计含税: amount, 预算编号: 'TEST-2026-139', 预算名称: '示例预算名称', ...overrides };
  return headers.map((header) => row[header] ?? '');
};
const csvCell = (value) => /[",\r\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value);
const csv = (...rows) => Buffer.from([headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'));
async function xlsx(sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) workbook.addWorksheet(name).addRows(rows);
  return workbook.xlsx.writeBuffer();
}

test('CSV preserves quoted descriptions, reads BOM, and uses stable identity across reordered files', async () => {
  const row = values('35,881.10', { 费用说明: '第一行,"引号"\r\n第二行' });
  const first = await parseBudget(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv(row)]), '预算.csv');
  assert.equal(first.rows[0].description, '第一行,"引号"\r\n第二行');
  assert.equal(first.rows[0].amount, '35881.10');
  assert.deepEqual(first.rows[0].errors, []);
  assert.equal(first.rows[0].sourceRow, 2);
  const reordered = await parseBudget(csv(values('1', { 预算编号: 'B' }), row), '其他文件.csv');
  assert.equal(first.rows[0].id, reordered.rows[1].id);
  assert.match(first.rows[0].id, /^[a-f0-9]{24}$/);
  assert.doesNotThrow(() => JSON.stringify(first));
});

test('GB18030 CSV imports Chinese headers and values', async () => {
  // GB18030: 年度,费用说明,分摊合计含税,预算编号,预算名称 + one data row.
  const input = Buffer.from('c4eab6c82cb7d1d3c3cbb5c3f72cb7d6ccafbacfbcc6baaccbb02cd4a4cbe3b1e0bac52cd4a4cbe3c3fbb3c60a323032362ccbb5c3f72c31302c422cc3fbb3c6', 'hex');
  const result = await parseBudget(input, '预算.csv');
  assert.equal(result.rows[0].description, '说明');
  assert.equal(result.rows[0].budgetName, '名称');
  assert.equal(result.rows[0].amount, '10.00');
});

test('CSV rejects malformed quoting instead of silently shifting columns', async () => {
  for (const tail of ['2026,"never closes', '2026,bad"quote,1,B,N', '2026,"text"garbage,1,B,N']) {
    await assert.rejects(parseBudget(Buffer.from(`${headers.join(',')}\n${tail}`), 'bad.csv'), /CSV.*格式错误/);
  }
  await assert.rejects(parseBudget(Buffer.from(`${headers.join(',')}\n2026,说明,12,345.67,,B,N,,,`), 'shifted.csv'), /列数与表头不一致/);
});

test('finds header within first 20 lines, ignores empty rows, and permits empty description', async () => {
  const result = await parseBudget(await xlsx({ 预算: [['年度预算清单'], [], headers, [], values(1.2, { 费用说明: '' })] }), '预算.xlsx');
  assert.equal(result.rows[0].sourceRow, 5);
  assert.equal(result.rows[0].amount, '1.20');
  assert.equal(result.rows[0].description, '');
  assert.deepEqual(result.rows[0].errors, []);
  await assert.rejects(parseBudget(await xlsx({ 预算: [...Array.from({ length: 20 }, () => ['说明']), headers, values()] }), 'late.xlsx'), /前 20 行/);
});

test('required header absence/duplication is rejected before importing rows', async () => {
  const duplicate = Buffer.from([...headers, '预算编号'].join(',') + '\n' + [...values(), 'B'].join(','));
  await assert.rejects(parseBudget(duplicate, 'duplicate.csv'), /必需表头重复：预算编号/);
  const missing = Buffer.from(headers.filter((header) => header !== '费用说明').join(','));
  await assert.rejects(parseBudget(missing, 'missing.csv'), /完整预算表头/);
});

test('all same-year same-budget duplicates are invalid, while different years are distinct', async () => {
  const result = await parseBudget(csv(values(), values('2'), values('3', { 年度: '2027' })), 'dupes.csv');
  assert.match(result.rows[0].errors.join(';'), /预算编号重复/);
  assert.match(result.rows[1].errors.join(';'), /预算编号重复/);
  assert.deepEqual(result.rows[2].errors, []);
  assert.equal(result.rows[0].id, result.rows[1].id);
  assert.notEqual(result.rows[0].id, result.rows[2].id);
});

test('amount validation never rounds excess decimals or accepts malformed/nonpositive/unsafe input', async () => {
  const invalid = ['1.001', '0', '-1', 'NaN', 'Infinity', '1e3', '12,34.56', '1,234,56', '', '90071992547409.92'];
  const result = await parseBudget(csv(...invalid.map((amount, index) => values(amount, { 预算编号: `B${index}` }))), 'invalid.csv');
  for (const row of result.rows) {
    assert.equal(row.amount, '');
    assert.match(row.errors.join(';'), /分摊合计含税/);
  }
  const valid = await parseBudget(csv(values('90071992547409.91')), 'max.csv');
  assert.equal(amountCents(valid.rows[0].amount), BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(amountCents('0.10') + amountCents('0.20'), 30n);
  assert.throws(() => amountCents('1e3'), /规范字符串/);
});

test('xlsx numbers use numerical semantics and uncached/error formulas are rejected', async () => {
  const result = await parseBudget(await xlsx({ 预算: [headers,
    values(1e3, { 预算编号: 'A' }),
    values({ formula: '1+1', result: 2 }, { 预算编号: 'B' }),
    values({ formula: '1+1' }, { 预算编号: 'C' }),
    values({ formula: '1/0', result: { error: '#DIV/0!' } }, { 预算编号: 'D' }),
    values(1.001, { 预算编号: 'E' }),
  ] }), 'formulas.xlsx');
  assert.equal(result.rows[0].amount, '1000.00');
  assert.equal(result.rows[1].amount, '2.00');
  assert.match(result.rows[2].errors.join(';'), /公式没有缓存结果/);
  assert.match(result.rows[3].errors.join(';'), /单元格存在错误/);
  assert.equal(result.rows[4].amount, '');
});

test('multiple nonempty worksheets require explicit selection and omit empty worksheets', async () => {
  const input = await xlsx({ 空白: [], 一月: [headers, values()], 二月: [headers, values('2')] });
  await assert.rejects(parseBudget(input, 'multiple.xlsx'), (error) => {
    assert.equal(error.code, 'SHEET_REQUIRED');
    assert.deepEqual(error.sheetNames, ['一月', '二月']);
    return true;
  });
  const result = await parseBudget(input, 'multiple.xlsx', { sheetName: '二月' });
  assert.equal(result.sheetName, '二月');
  assert.equal(result.rows[0].amount, '2.00');
  await assert.rejects(parseBudget(input, 'multiple.xlsx', { sheetName: '空白' }), /不存在或为空/);
  await assert.rejects(parseBudget(input, 'legacy.xls'), /另存为 .xlsx/);
});

test('invalid required values appear in the row preview, including original values', async () => {
  const result = await parseBudget(csv(values('100', { 年度: '26', 预算编号: '', 预算名称: '' })), 'invalid.csv');
  assert.equal(result.rows[0].errors.length, 3);
  assert.equal(result.rows[0].source['年度'], '26');
});

test('contract rules use Shanghai date, exact budget mapping, seal custody and preserve defaults', async () => {
  const { rows: [row] } = await parseBudget(csv(values()), '预算.csv');
  const contract = buildContract(row, new Date('2026-10-25T16:30:00Z'));
  assert.equal(contract.signingDate, '2026-10-26');
  assert.equal(contract.key, row.id);
  assert.equal(contract.budgetCode, 'TEST-2026-139');
  assert.equal(contract.contractName, '2026年信息化分摊费用示例预算名称');
  assert.equal(contract.amount, '35881.10');
  assert.equal(contract.description, '2026年信息化分摊费用');
  assert.equal(contract.compliance, '不签订');
  assert.equal(contract.contentStrategy, 'first_enabled_nonempty');
  assert.equal(contract.preserveDefaults, true);
  assert.equal(contract.sealCustody, '公司保管合同章');
  assert.equal('contractAmount' in contract, false);
  assert.ok(RULES.every((rule) => ['target', 'source', 'action'].every((key) => typeof rule[key] === 'string')));
});
