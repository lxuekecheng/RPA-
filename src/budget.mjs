import { createHash } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';

const REQUIRED_HEADERS = ['年度', '费用说明', '分摊合计含税', '预算编号', '预算名称'];
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export const RULES = Object.freeze([
  { target: '项目编号', source: '预算编号', action: '点击选择按钮，在预算弹窗中精确匹配预算编号' },
  { target: '本次申请金额', source: 'ITSM 实时剩余额度', action: '分摊合计含税 − 已分摊合同金额 − 在途分摊合同金额；精确到分' },
  { target: '收费属性', source: 'ITSM 预算列表', action: '仅处理“控股企业信息分摊费”' },
  { target: '合同名称', source: '当年年份与项目名称', action: '当年年份＋年信息化分摊费用＋项目名称' },
  { target: '合同说明', source: '执行当天的年份（北京时间）', action: '当年年份＋年信息化分摊费用' },
  { target: '合同签订日期', source: '执行当天', action: '按北京时间填写 YYYY-MM-DD' },
  { target: '是否签署公司版廉洁合规协议', source: '固定规则', action: '选择“不签订”' },
  { target: '合同内容', source: '固定规则', action: '选择第一个可选且非空的选项' },
  { target: '公章保管类型', source: '固定规则', action: '选择“公司保管合同章”' },
  { target: '对方公司名称', source: 'ITSM 关联预算自动带出', action: '保留自动带出的值' },
  { target: '对方负责人', source: '收款联系人', action: '直接复制；来源为空时目标留空' },
  { target: '对方负责人联系方式', source: '收款联系人邮箱', action: '直接复制；来源为空时目标留空' },
  { target: '批次完成后', source: '最后一条保存回执', action: '全部保存待发确认后关闭合同录入页面' },
  { target: '合同金额', source: '页面自动计算', action: '不主动写入' },
  { target: '其他已有默认值', source: '合同模板', action: '保留默认值' },
  { target: '完成后操作', source: '左上角按钮', action: '仅点击“保存待发”，保留待检查的草稿' },
].map(Object.freeze));

function importError(message, properties = {}) {
  return Object.assign(new Error(message), properties);
}

function cellData(original) {
  let value = original;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    if (value.result === undefined || value.result === null) {
      return { value: '', text: '', error: '公式没有缓存结果，请在 Excel 中重新计算并保存后再导入' };
    }
    value = value.result;
  }
  if (value === undefined || value === null) return { value: '', text: '' };
  if (value instanceof Date) return { value, text: Number.isNaN(value.getTime()) ? '' : value.toISOString() };
  if (typeof value === 'object') {
    if ('error' in value) return { value: '', text: String(value.error), error: `单元格存在错误 ${value.error}` };
    if (Array.isArray(value.richText)) {
      const text = value.richText.map((part) => String(part.text ?? '')).join('');
      return { value: text, text };
    }
    if ('text' in value) return { value: String(value.text ?? ''), text: String(value.text ?? '') };
    return { value: '', text: '', error: '无法识别单元格内容' };
  }
  return { value, text: String(value) };
}

function hasContent(value) {
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) return true;
  const cell = cellData(value);
  return Boolean(cell.error) || cell.text.trim() !== '';
}

function decodeCsv(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gb18030', { fatal: true }).decode(buffer);
    } catch {
      throw importError('CSV 编码无法识别，请另存为 UTF-8 CSV 后重试。');
    }
  }
}

// Strict CSV parsing keeps quoted commas/newlines and reports the physical source line.
function csvRows(text) {
  if (text.includes('\0')) throw importError('CSV 含有无效字符，请另存为 UTF-8 CSV 后重试。');
  const rows = [];
  let values = [];
  let field = '';
  let state = 'start';
  let line = 1;
  let sourceRow = 1;
  let pending = false;
  const finishField = () => { values.push(field); field = ''; state = 'start'; };
  const finishRow = () => {
    finishField();
    rows.push({ sourceRow, values });
    values = [];
    pending = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const newline = char === '\n' || char === '\r';
    if (state === 'quoted') {
      pending = true;
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else state = 'afterQuote';
      } else {
        field += char;
        if (newline) {
          if (char === '\r' && text[i + 1] === '\n') { field += '\n'; i += 1; }
          line += 1;
        }
      }
      continue;
    }
    if (char === ',') { finishField(); pending = true; continue; }
    if (newline) {
      finishRow();
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      line += 1;
      sourceRow = line;
      continue;
    }
    if (state === 'afterQuote') throw importError(`CSV 第 ${line} 行格式错误：结束引号后只能是逗号或换行。`);
    if (char === '"') {
      if (state !== 'start') throw importError(`CSV 第 ${line} 行格式错误：字段中的引号必须按 CSV 规则转义。`);
      state = 'quoted';
    } else {
      field += char;
      state = 'unquoted';
    }
    pending = true;
  }
  if (state === 'quoted') throw importError(`CSV 第 ${sourceRow} 行格式错误：引号未闭合。`);
  if (pending || values.length || field) finishRow();
  return rows;
}

function expandNumericExponent(number) {
  const text = String(number);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split('e');
  const sign = coefficient.startsWith('-') ? '-' : '';
  const unsigned = coefficient.replace(/^[+-]/, '');
  const [integer, fraction = ''] = unsigned.split('.');
  const digits = integer + fraction;
  const decimalAt = integer.length + Number(exponentText);
  if (decimalAt <= 0) return `${sign}0.${'0'.repeat(-decimalAt)}${digits}`;
  if (decimalAt >= digits.length) return sign + digits + '0'.repeat(decimalAt - digits.length);
  return `${sign}${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
}

function normalizeAmount(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('金额必须是有限数值');
  if (!['number', 'string'].includes(typeof value)) throw new Error('金额必须是数值');
  let text = typeof value === 'number' ? expandNumericExponent(value) : value.trim();
  if (!text) throw new Error('金额不能为空');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('金额格式无效；请使用最多两位小数的数字，千位逗号须每三位分组，不接受科学计数法文本');
  }
  text = text.replaceAll(',', '');
  const negative = text.startsWith('-');
  const [integer, fraction = ''] = text.replace(/^[+-]/, '').split('.');
  const cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (negative || cents === 0n) throw new Error('金额必须大于零');
  if (cents > MAX_CENTS) throw new Error('金额超出安全范围（最多 90071992547409.91 元）');
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** Convert an already normalized amount to integer cents without floating point. */
export function amountCents(amount) {
  if (typeof amount !== 'string' || !/^-?\d+\.\d{2}$/.test(amount)) {
    throw new Error('金额必须是保留两位小数的规范字符串');
  }
  const negative = amount.startsWith('-');
  const [integer, fraction] = amount.replace(/^-/, '').split('.');
  const cents = BigInt(integer) * 100n + BigInt(fraction);
  return negative ? -cents : cents;
}

function parseRows(records, { strictWidth = false } = {}) {
  const candidates = records.filter((row) => row.sourceRow <= 20);
  let headerIndex = -1;
  let headers;
  for (const record of candidates) {
    const names = record.values.map((value) => cellData(value).text.trim().replace(/^\uFEFF/, ''));
    if (REQUIRED_HEADERS.every((header) => names.includes(header))) {
      headers = names;
      headerIndex = records.indexOf(record);
      break;
    }
  }
  if (headerIndex < 0) throw importError(`前 20 行未找到完整预算表头，需要包含：${REQUIRED_HEADERS.join('、')}。`);
  const duplicateHeaders = REQUIRED_HEADERS.filter((header) => headers.filter((name) => name === header).length > 1);
  if (duplicateHeaders.length) throw importError(`必需表头重复：${duplicateHeaders.join('、')}。请保留唯一对应列。`);
  const positions = Object.fromEntries(REQUIRED_HEADERS.map((header) => [header, headers.indexOf(header)]));
  const rows = [];
  for (const record of records.slice(headerIndex + 1)) {
    if (!record.values.some(hasContent)) continue;
    if (strictWidth && record.values.length !== headers.length) {
      throw importError(`CSV 第 ${record.sourceRow} 行列数与表头不一致（应为 ${headers.length} 列，实际 ${record.values.length} 列），请检查逗号与引号。`);
    }
    const errors = [];
    const cells = Object.fromEntries(REQUIRED_HEADERS.map((header) => {
      const cell = cellData(record.values[positions[header]]);
      if (cell.error) errors.push(`${header}：${cell.error}`);
      return [header, cell];
    }));
    const year = cells['年度'].text.trim();
    const budgetCode = cells['预算编号'].text.trim();
    const budgetName = cells['预算名称'].text.trim();
    const description = cells['费用说明'].text;
    if (!cells['年度'].error && !/^\d{4}$/.test(year)) errors.push('年度：须填写四位年份');
    if (!cells['预算编号'].error && !budgetCode) errors.push('预算编号：不能为空');
    if (!cells['预算名称'].error && !budgetName) errors.push('预算名称：不能为空');
    let amount = '';
    if (!cells['分摊合计含税'].error) {
      try { amount = normalizeAmount(cells['分摊合计含税'].value); }
      catch (error) { errors.push(`分摊合计含税：${error.message}`); }
    }
    const source = {};
    headers.forEach((header, index) => {
      const base = header || `未命名列${index + 1}`;
      let name = base;
      let suffix = 2;
      while (Object.hasOwn(source, name)) name = `${base} (${suffix++})`;
      Object.defineProperty(source, name, { value: cellData(record.values[index]).text, enumerable: true, configurable: true, writable: true });
    });
    const id = createHash('sha256').update(`${year}\0${budgetCode}`).digest('hex').slice(0, 24);
    rows.push({ id, sourceRow: record.sourceRow, year, budgetCode, budgetName, description, amount, errors, source });
  }
  const duplicates = new Map();
  for (const row of rows) {
    if (!row.year || !row.budgetCode) continue;
    const key = `${row.year}\0${row.budgetCode}`;
    if (!duplicates.has(key)) duplicates.set(key, []);
    duplicates.get(key).push(row);
  }
  for (const group of duplicates.values()) {
    if (group.length < 2) continue;
    const message = `同年度预算编号重复（第 ${group.map((row) => row.sourceRow).join('、')} 行），请核对后再导入`;
    for (const row of group) row.errors.push(message);
  }
  if (!rows.length) throw importError('预算表中没有可导入的数据行。');
  return rows;
}

/** Read a budget workbook or CSV without changing the source file. */
export async function parseBudget(buffer, filename, { sheetName } = {}) {
  const extension = path.extname(String(filename)).toLowerCase();
  if (extension === '.xls') throw importError('暂不支持旧版 .xls，请用 Excel 另存为 .xlsx 后再导入。');
  if (extension === '.csv') {
    const selectedName = 'CSV';
    if (sheetName && sheetName !== selectedName) throw importError('CSV 只有一个数据表。', { sheetNames: [selectedName] });
    return { rows: parseRows(csvRows(decodeCsv(buffer)), { strictWidth: true }), sheetNames: [selectedName], sheetName: selectedName };
  }
  if (extension !== '.xlsx') throw importError('请导入 .xlsx 或 .csv 预算文件。');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw importError('无法读取 Excel 文件，请确认文件是有效且未加密的 .xlsx。'); }
  const sheets = workbook.worksheets.filter((sheet) => {
    let nonempty = false;
    sheet.eachRow((row) => { if (row.values.some(hasContent)) nonempty = true; });
    return nonempty;
  });
  const sheetNames = sheets.map((sheet) => sheet.name);
  if (!sheetNames.length) throw importError('Excel 文件没有非空工作表。');
  if (!sheetName && sheets.length > 1) {
    throw importError('文件包含多个非空工作表，请选择要导入的工作表。', { code: 'SHEET_REQUIRED', sheetNames });
  }
  const sheet = sheetName ? sheets.find((candidate) => candidate.name === sheetName) : sheets[0];
  if (!sheet) throw importError('指定的工作表不存在或为空，请重新选择。', { code: 'SHEET_REQUIRED', sheetNames });
  const records = [];
  sheet.eachRow({ includeEmpty: true }, (row, sourceRow) => {
    records.push({ sourceRow, values: Array.from(row.values).slice(1) });
  });
  return { rows: parseRows(records), sheetNames, sheetName: sheet.name };
}

export { buildContract } from './contract.mjs';
