import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function fingerprint(row) {
  return createHash('sha256').update(JSON.stringify([
    1, row.year, row.budgetCode, row.budgetName, row.amount, row.description,
  ])).digest('hex');
}

// Append-only, synced before the final ITSM save click. An interrupted save never retries automatically.
export class History {
  constructor(filename) {
    this.filename = filename;
    this.entries = new Map();
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) {
      const lines = fs.readFileSync(filename, 'utf8').split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try {
          const item = JSON.parse(lines[index]);
          if (!item.key || !item.status || !item.fingerprint) throw new Error('缺少记录字段');
          this.entries.set(item.key, item);
        } catch {
          throw new Error(`执行记录第 ${index + 1} 行损坏，请保留文件并修复后再运行：${filename}`);
        }
      }
    }
  }

  put(row, status, extra = {}) {
    const entry = { ...extra, key: row.id, year: row.year, budgetCode: row.budgetCode,
      ...(row.sourceKind === 'oa' ? { sourceKind: 'oa', amount: row.amount, totalAmount: row.totalAmount, allocatedAmount: row.allocatedAmount, inTransitAmount: row.inTransitAmount } : {}),
      fingerprint: fingerprint(row), status, updatedAt: new Date().toISOString() };
    const fd = fs.openSync(this.filename, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.entries.set(row.id, entry);
    return entry;
  }

  state(row) {
    if (row.errors?.length) return { status: 'invalid', message: row.errors.join('；') };
    const previous = this.entries.get(row.id);
    if (!previous) return row.skipReason ? { status: 'skipped', message: row.skipReason } : { status: 'ready', message: '待录入' };
    if (['filling', 'saving', 'uncertain'].includes(previous.status)) {
      return { status: 'uncertain', message: '上次录入未确认结果，请先在 ITSM 核查，禁止自动重建', draftId: previous.draftId };
    }
    if (previous.status === 'saved') {
      if (row.sourceKind === 'oa') return { status: 'saved', message: '本机已有保存待发草稿，跳过，避免 ITSM 尚未计入在途造成重复', draftId: previous.draftId };
      if (previous.fingerprint !== fingerprint(row)) return { status: 'changed', message: '这条预算已有草稿，但导入内容已变更，请人工核查', draftId: previous.draftId };
      return { status: 'saved', message: '已保存待发，本次跳过', draftId: previous.draftId };
    }
    if (row.skipReason) return { status: 'skipped', message: row.skipReason };
    return { status: 'failed', message: previous.message || '上次在保存前停止，可重新执行' };
  }
}
