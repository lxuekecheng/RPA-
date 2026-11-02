import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContract } from '../src/contract.mjs';
import { contractText } from '../public/contract-rules.js';
import { normalizeOaRow, assertSameOaBalance, TARGET_FEE } from '../src/oa-budget.mjs';

const row = { id: 'example', year: '2025', budgetCode: 'TEST-2025-001', budgetName: '示例医药有限公司', description: '旧费用说明', amount: '100.00' };

test('合同使用执行当年，名称按示例拼接，说明不再复制原始费用说明', () => {
  const contract = buildContract(row, new Date('2026-10-28T04:00:00Z'));
  assert.equal(contract.contractName, '2026年信息化分摊费用示例医药有限公司');
  assert.equal(contract.description, '2026年信息化分摊费用');
  assert.equal(contract.year, '2025'); // The budget identity and duplicate checks keep their original year.
  assert.equal(contract.contractYear, '2026');
});

test('名称、说明和签订日期在北京时间跨年时一起更新', () => {
  const before = buildContract(row, new Date('2026-12-31T15:59:59Z'));
  const after = buildContract(row, new Date('2026-12-31T16:00:00Z'));
  assert.equal(before.description, '2026年信息化分摊费用');
  assert.equal(before.signingDate, '2026-12-31');
  assert.equal(after.description, '2027年信息化分摊费用');
  assert.equal(after.contractName, '2027年信息化分摊费用示例医药有限公司');
  assert.equal(after.signingDate, '2027-01-01');
});

test('优先使用明确的项目名称，页面预览和执行使用相同格式函数', () => {
  const now = new Date('2028-05-01T00:00:00Z');
  const projectName = '项目名称';
  const actual = buildContract({ ...row, projectName }, now);
  const preview = contractText(projectName, now);
  assert.equal(actual.contractName, '2028年信息化分摊费用项目名称');
  assert.equal(actual.contractName, preview.contractName);
  assert.equal(actual.description, preview.description);
  assert.equal(actual.signingDate, preview.signingDate);
});

test('生成的新合同说明与原始预算说明独立，不破坏实时余额核验', () => {
  const raw = { '年度': '2026', '预算编号': 'TEST-1', '预算名称': row.budgetName, '费用说明': '原始预算说明',
    '收费属性': TARGET_FEE, '分摊合计含税': '100.00', '已分摊合同金额': '10.00', '在途分摊合同金额': '20.00' };
  const budget = normalizeOaRow(raw);
  const contract = buildContract(budget, new Date('2027-02-01T00:00:00Z'));
  assert.equal(contract.description, '2027年信息化分摊费用');
  assert.equal(contract.balance.description, '原始预算说明');
  assert.equal(budget.description, '原始预算说明');
  assert.doesNotThrow(() => assertSameOaBalance(contract, raw));
  assert.throws(() => assertSameOaBalance(contract, { ...raw, '费用说明': '已变更的原始说明' }), /变化/);
});
