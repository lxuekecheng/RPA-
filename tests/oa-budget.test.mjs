import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_FEE, oaMoney, normalizeOaRow, makeOaPreview, assertSameOaBalance } from '../src/oa-budget.mjs';
import { buildContract } from '../src/budget.mjs';

const raw = (changes = {}) => ({ '年度': '2026', '预算编号': 'TEST-2026-001', '预算名称': '测试预算', '费用说明': '测试说明',
  '收费属性': TARGET_FEE, '分摊合计含税': '100,000.00', '已分摊合同金额': '25,000.00', '在途分摊合同金额': '15,000.00', ...changes });

test('申请金额用整数分计算，并将三项原始金额带入保存核验快照', () => {
  const row = normalizeOaRow(raw());
  assert.equal(row.amount, '60000.00');
  const contract = buildContract(row);
  assert.equal(contract.balance.totalAmount, '100000.00');
  assert.equal(contract.balance.allocatedAmount, '25000.00');
  assert.equal(contract.balance.inTransitAmount, '15000.00');
  assert.equal(contract.amount, '60000.00');
  assert.doesNotThrow(() => assertSameOaBalance(contract, raw()));
});

test('仅筛选精确收费属性及指定年度，ITSM 预算身份与旧清单一致', () => {
  const p = makeOaPreview([raw(), raw({ '收费属性': '三方项目收入', '预算编号': 'OTHER' }), raw({ '年度': '2025' })], { year: '2026' });
  assert.equal(p.rows.length, 1);
  assert.equal(p.scannedCount, 3);
  assert.equal(p.sourceKind, 'oa');
  assert.equal(p.rows[0].id, normalizeOaRow(raw()).id);
  assert.throws(() => makeOaPreview([], { year: '26' }), /四位/);
});

test('分摊和在途空白按用户规则取零，总额空白始终拒绝', () => {
  assert.equal(normalizeOaRow(raw({ '已分摊合同金额': '', '在途分摊合同金额': '' })).amount, '100000.00');
  assert.match(normalizeOaRow(raw({ '分摊合计含税': '' })).errors.join('；'), /分摊合计含税为空/);
  assert.match(normalizeOaRow(raw({ '已分摊合同金额': '' }), { blankAllocatedAsZero: false }).errors.join('；'), /已分摊合同金额为空/);
});

test('余额为零或负数跳过，浮点边界不会产生多余一分钱', () => {
  const zero = normalizeOaRow(raw({ '分摊合计含税': '0.30', '已分摊合同金额': '0.10', '在途分摊合同金额': '0.20' }));
  assert.equal(zero.amount, '0.00'); assert.match(zero.skipReason, /为 0/);
  const over = normalizeOaRow(raw({ '分摊合计含税': '39999.99' }));
  assert.equal(over.amount, '-0.01'); assert.match(over.skipReason, /超过预算/);
});

test('拒绝负数、非数字、超精度、科学计数法和错误千分位', () => {
  for (const value of ['-1', '1.001', '1e3', '1,00.00', 'NaN', '未统计', '90071992547409.92']) assert.throws(() => oaMoney(value, '测试金额'));
  assert.equal(oaMoney('90071992547409.91', '测试金额'), BigInt(Number.MAX_SAFE_INTEGER));
});

test('金额任意分量、属性、名称或年度变化都要求重读，不能继续使用旧余额', () => {
  const contract = buildContract(normalizeOaRow(raw()));
  for (const changes of [
    { '分摊合计含税': '100001.00' }, { '已分摊合同金额': '25000.01' }, { '在途分摊合同金额': '15000.01' },
    { '已分摊合同金额': '26000.00', '在途分摊合同金额': '14000.00' },
    { '收费属性': '三方项目收入' }, { '预算名称': '已修改' }, { '年度': '2025' },
  ]) assert.throws(() => assertSameOaBalance(contract, raw(changes)), /变化|重新读取/);
  assert.throws(() => assertSameOaBalance({ ...contract, amount: '100000.00' }, raw()), /申请金额/);
});

test('同年重复编号不可录入，不同年度相同编号可以分别识别', () => {
  const duplicate = makeOaPreview([raw(), raw()]);
  assert.ok(duplicate.rows.every(row => row.errors.some(error => error.includes('重复'))));
  const different = makeOaPreview([raw(), raw({ '年度': '2025' })]);
  assert.notEqual(different.rows[0].id, different.rows[1].id);
});
