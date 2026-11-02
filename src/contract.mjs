import { contractText } from '../public/contract-rules.js';

export function buildContract(row, now = new Date()) {
  const projectName = row.projectName ?? row.budgetName;
  return {
    key: row.id, year: row.year, budgetCode: row.budgetCode, budgetName: row.budgetName,
    amount: row.amount, projectName, ...contractText(projectName, now),
    compliance: '不签订', contentStrategy: 'first_enabled_nonempty', sealCustody: '公司保管合同章',
    preserveDefaults: true,
    ...(row.sourceKind === 'oa' ? { sourceKind: 'oa', balance: Object.fromEntries(
      ['year', 'budgetCode', 'budgetName', 'description', 'amount', 'totalAmount', 'allocatedAmount', 'inTransitAmount'].map(key => [key, row[key]])
    ) } : {}),
  };
}
