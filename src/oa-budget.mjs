import { createHash } from 'node:crypto';

export const TARGET_FEE = '控股企业信息分摊费';
export const ITSM_COLUMNS = Object.freeze(['年度', '费用说明', '分摊合计含税', '预算编号', '预算名称', '收费属性', '已分摊合同金额', '在途分摊合同金额']);
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
export const centsText = cents => `${cents < 0n ? '-' : ''}${(cents < 0n ? -cents : cents) / 100n}.${String((cents < 0n ? -cents : cents) % 100n).padStart(2, '0')}`;

export function oaMoney(value, label, { blankAsZero = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text) {
    if (blankAsZero) return 0n;
    throw new Error(`${label}为空，无法核对金额`);
  }
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label}格式无效或超过两位小数：${text}`);
  const [integer, decimal = ''] = text.replaceAll(',', '').split('.');
  const cents = BigInt(integer) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (cents > MAX_CENTS) throw new Error(`${label}超出安全范围`);
  return cents;
}

export function normalizeOaRow(raw, { blankAllocatedAsZero = true, readAt = new Date().toISOString(), index = 0 } = {}) {
  const source = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('_')).map(([key, value]) => [key, String(value ?? '').trim()]));
  const year = source['年度'] || '';
  const budgetCode = source['预算编号'] || '';
  const budgetName = source['预算名称'] || '';
  const description = source['费用说明'] || '';
  const feeType = source['收费属性'] || '';
  const errors = [];
  if (!/^\d{4}$/.test(year)) errors.push('年度无效');
  if (!budgetCode) errors.push('预算编号为空');
  if (!budgetName) errors.push('预算名称为空');
  let totalAmount = '', allocatedAmount = '', inTransitAmount = '', amount = '';
  let skipReason = feeType === TARGET_FEE ? '' : `收费属性不是${TARGET_FEE}`;
  try {
    const total = oaMoney(source['分摊合计含税'], '分摊合计含税');
    const allocated = oaMoney(source['已分摊合同金额'], '已分摊合同金额', { blankAsZero: blankAllocatedAsZero });
    const transit = oaMoney(source['在途分摊合同金额'], '在途分摊合同金额', { blankAsZero: blankAllocatedAsZero });
    totalAmount = centsText(total); allocatedAmount = centsText(allocated); inTransitAmount = centsText(transit);
    const remaining = total - allocated - transit;
    amount = centsText(remaining);
    if (!skipReason && remaining === 0n) skipReason = '剩余额度为 0，跳过';
    if (!skipReason && remaining < 0n) skipReason = '已分摊与在途金额之和超过预算，跳过并核查';
  } catch (error) { errors.push(error.message); }
  return {
    id: createHash('sha256').update(`${year}\0${budgetCode}`).digest('hex').slice(0, 24),
    sourceKind: 'oa', sourceRow: index + 1, sourcePage: raw._page, readAt,
    year, budgetCode, budgetName, description, feeType, totalAmount, allocatedAmount, inTransitAmount, amount, errors, skipReason, source,
  };
}

export function makeOaPreview(records, { year, blankAllocatedAsZero = true, readAt = new Date().toISOString() } = {}) {
  if (year !== undefined && !/^\d{4}$/.test(String(year))) throw new Error('请输入四位预算年度');
  const selected = records.filter(row => String(row['收费属性'] ?? '').trim() === TARGET_FEE && (!year || String(row['年度']).trim() === String(year)));
  const rows = selected.map((row, index) => normalizeOaRow(row, { blankAllocatedAsZero, readAt, index }));
  const identities = new Map();
  for (const row of rows) {
    if (!identities.has(row.id)) identities.set(row.id, []);
    identities.get(row.id).push(row);
  }
  for (const group of identities.values()) if (group.length > 1) for (const row of group) row.errors.push('同年度预算编号在 ITSM 中重复，禁止自动录入');
  return { sourceKind: 'oa', year: String(year || ''), feeType: TARGET_FEE, readAt, scannedCount: records.length, rows, sheetNames: [], sheetName: 'ITSM 关联预算列表' };
}

export function assertSameOaBalance(contract, raw, options) {
  const fresh = normalizeOaRow(raw, options);
  if (fresh.errors.length) throw new Error(`ITSM 金额核验失败：${fresh.errors.join('；')}`);
  if (fresh.feeType !== TARGET_FEE) throw new Error('收费属性已变化，禁止录入');
  if (fresh.skipReason) throw new Error(`${fresh.skipReason}，请重新读取 ITSM`);
  for (const key of ['year', 'budgetCode', 'budgetName', 'description', 'amount', 'totalAmount', 'allocatedAmount', 'inTransitAmount']) {
    const expected = contract.balance?.[key];
    if (expected !== fresh[key]) throw new Error(`ITSM 预算或余额已变化（${key}），请重新读取 ITSM 后再录入`);
  }
  if (contract.amount !== fresh.amount) throw new Error('申请金额不等于预算减去已分摊和在途金额');
  return fresh;
}
