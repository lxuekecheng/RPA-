import { createDomLocator } from './dom-locator.mjs';
import { ITSM_COLUMNS, assertSameOaBalance } from './oa-budget.mjs';

const REQUIRED_TARGETS = [
  'fields.projectBudgetCode', 'fields.applicationAmount', 'fields.contractName',
  'fields.signingDate', 'fields.complianceNo', 'fields.contractContent', 'fields.description', 'fields.sealType',
  'fields.counterpartyOwner', 'fields.counterpartyContact', 'fields.receivingContact', 'fields.receivingEmail',
  'picker.open', 'picker.searchInput', 'picker.searchButton', 'picker.resultRows', 'picker.confirm',
  'save.button', 'save.draftId',
];

function at(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function validateTarget(target, name, errors) {
  if (!target || typeof target !== 'object' || typeof target.selector !== 'string' || !target.selector.trim()) {
    errors.push(`${name}.selector 未配置`);
  }
  if (target?.fieldLabel !== undefined && (typeof target.fieldLabel !== 'string' || !target.fieldLabel.trim())) errors.push(`${name}.fieldLabel 必须是非空字段名称`);
  if (target?.frameChain !== undefined && (!Array.isArray(target.frameChain)
    || target.frameChain.some((item) => typeof item !== 'string' || !item.trim()))) {
    errors.push(`${name}.frameChain 必须是非空 iframe 选择器组成的数组`);
  }
}

/** Return all missing/invalid connection settings; never navigate or write. */
export function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['ITSM 配置必须是对象'];
  if (config.verified !== true) errors.push('verified 必须为 true；请先完成现场定位器核验');
  for (const key of ['oaUrl', 'newFormUrl']) {
    if (!isHttpUrl(config[key])) errors.push(`${key} 必须是完整的 http/https 地址`);
  }
  if (config.browserChannel !== undefined && !['chrome', 'msedge'].includes(config.browserChannel)) {
    errors.push('browserChannel 只能为 chrome 或 msedge');
  }
  for (const key of ['timeoutMs', 'saveTimeoutMs']) {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 100 || config[key] > 120000)) {
      errors.push(`${key} 必须是 100 至 120000 的整数毫秒数`);
    }
  }
  for (const path of REQUIRED_TARGETS) validateTarget(at(config, path), path, errors);
  if (config.source?.kind === 'oa') {
    for (const key of ['yearInput', 'cancel', 'nextPage']) validateTarget(config.picker?.[key], `picker.${key}`, errors);
    if (config.source.verified !== true) errors.push('ITSM 直接读取与余额规则尚未验证');
    if (!config.picker.queryResponsePath?.startsWith('/')) errors.push('picker.queryResponsePath 未配置');
  }
  if (config.fields?.counterpartyCompany) validateTarget(config.fields.counterpartyCompany, 'fields.counterpartyCompany', errors);
  if (config.content?.open) validateTarget(config.content.open, 'content.open', errors);
  validateTarget(config.seal?.open, 'seal.open', errors);
  validateTarget(config.seal?.options, 'seal.options', errors);
  if (config.compliance?.kind && !['native', 'cap4'].includes(config.compliance.kind)) errors.push('compliance.kind 只能为 native 或 cap4');
  if (config.compliance?.kind === 'cap4' && !config.compliance.checkedSelector?.trim()) errors.push('compliance.checkedSelector 未配置');
  for (const key of ['rowCodeSelector', 'rowSelectSelector']) {
    if (typeof config.picker?.[key] !== 'string' || !config.picker[key].trim()) errors.push(`picker.${key} 未配置`);
  }
  if (config.picker?.mode !== undefined && config.picker.mode !== 'same-page') {
    errors.push('picker.mode 目前仅支持 same-page（包含 iframe）；新窗口须现场适配');
  }
  const kind = config.content?.kind ?? 'native';
  if (!['native', 'custom'].includes(kind)) errors.push('content.kind 只能为 native 或 custom');
  if (kind === 'custom') validateTarget(config.content?.options, 'content.options', errors);
  if (config.content?.placeholderTexts !== undefined && (!Array.isArray(config.content.placeholderTexts)
    || config.content.placeholderTexts.some((item) => typeof item !== 'string'))) {
    errors.push('content.placeholderTexts 必须是字符串数组');
  }
  if (config.save?.mode !== 'seeyon-wait-send') validateTarget(config.save?.success, 'save.success', errors);
  if (config.save?.mode !== 'seeyon-wait-send' && (typeof config.save?.successText !== 'string' || !config.save.successText.trim())) {
    errors.push('save.successText 未配置，请填写现场核实的成功提示完整文字');
  }
  return errors;
}

export function assertConfig(config) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`ITSM 接入配置尚未就绪：\n${errors.join('\n')}`);
}

function normalizedText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }

export function matchDraftReceipt(value, expectedId, config) {
  try {
    const url = new URL(value);
    const form = new URL(config.newFormUrl);
    if (url.origin !== new URL(config.oaUrl).origin || url.pathname !== form.pathname
      || url.searchParams.get('from') !== 'waitSend' || url.searchParams.get('summaryId') !== expectedId
      || (form.searchParams.has('method') && url.searchParams.get('method') !== form.searchParams.get('method'))
      || !/^-?\d+$/.test(url.searchParams.get('affairId') || '')) return null;
    return { draftId: expectedId, affairId: url.searchParams.get('affairId'), url: url.href };
  } catch { return null; }
}

function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    const diagnostic = new URL(url.origin + url.pathname);
    for (const name of ['method', 'from', 'summaryId', 'affairId']) {
      if (url.searchParams.has(name)) diagnostic.searchParams.set(name, url.searchParams.get(name));
    }
    return diagnostic.href;
  } catch { return '页面已关闭或地址不可用'; }
}

export function assertDraftButtonText(text) {
  const actual = normalizedText(text);
  if (actual !== '保存待发' && actual !== '暂存待发') {
    throw new Error(`保存按钮文字不符合约定：${actual || '（空白）'}。仅允许“保存待发”或“暂存待发”`);
  }
}

export function selectExactBudgetRow(codes, budgetCode) {
  const expected = String(budgetCode).trim();
  const matches = codes.map((code, index) => String(code).trim() === expected ? index : -1).filter((index) => index >= 0);
  if (matches.length !== 1) throw new Error(`预算编号 ${expected} 精确匹配 ${matches.length} 条，必须且只能匹配 1 条`);
  return matches[0];
}

export function firstEnabledOption(options, placeholderTexts = ['请选择', '请选择...', '请选择…']) {
  const ignored = new Set(placeholderTexts.map(normalizedText));
  const chosen = options.find((option) => !option.disabled && !option.hidden
    && normalizedText(option.label) && !ignored.has(normalizedText(option.label))
    && (option.value === undefined || String(option.value).trim() !== ''));
  if (!chosen) throw new Error('合同内容没有可用的非空选项');
  return chosen;
}

export function canonicalAmount(value) {
  const cleaned = String(value).replace(/[\s,，￥¥]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) throw new Error(`金额格式无法核对：${value}`);
  const [integer, decimal = ''] = cleaned.split('.');
  return `${BigInt(integer)}.${decimal.padEnd(2, '0')}`;
}

function assertContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('合同数据不能为空');
  for (const key of ['budgetCode', 'contractName', 'signingDate']) {
    if (typeof contract[key] !== 'string' || !contract[key].trim()) throw new Error(`合同数据 ${key} 不能为空`);
  }
  if (!/^\d+\.\d{2}$/.test(contract.amount) || BigInt(contract.amount.replace('.', '')) <= 0n) {
    throw new Error('合同 amount 必须为大于零且保留两位小数的金额字符串');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(contract.signingDate)) throw new Error('signingDate 必须使用 YYYY-MM-DD');
  if (contract.compliance !== '不签订') throw new Error('合规协议只允许“不签订”');
  if (contract.contentStrategy !== 'first_enabled_nonempty') throw new Error('合同内容必须采用首个有效非空选项');
  if (contract.sealCustody !== '公司保管合同章') throw new Error('公章保管类型必须为“公司保管合同章”');
  if (typeof contract.description !== 'string') throw new Error('description 必须为字符串');
}

export class OaDriver {
  constructor({ profileDir, emit = () => {} } = {}) {
    if (typeof profileDir !== 'string' || !profileDir.trim()) throw new Error('必须提供独立的浏览器 profileDir');
    this.profileDir = profileDir;
    this.emit = emit;
    this.context = null;
    this.page = null;
    this.entryPage = null;
  }

  async open(config) {
    if (!isHttpUrl(config?.oaUrl)) throw new Error('请先配置 oaUrl（http/https 地址），再打开浏览器登录');
    const channel = config.browserChannel || 'chrome';
    if (!['chrome', 'msedge'].includes(channel)) throw new Error('browserChannel 只能为 chrome 或 msedge');
    if (!this.context) {
      const { chromium } = await import('playwright');
      this.context = await chromium.launchPersistentContext(this.profileDir, { channel, headless: false });
      this.context.on('close', () => { this.context = null; this.page = null; this.homePage = null; this.entryPage = null; });
    }
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.goto(config.oaUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs || 15000 });
    this.homePage = this.page;
    this.emit({ type: 'browser-opened', message: '请在独立浏览器窗口中完成 ITSM 登录。浏览器沿用系统网络设置。' });
  }

  async close() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.homePage = null;
    this.entryPage = null;
    if (context) await context.close();
  }

  async closeEntryPage() {
    const entry = this.entryPage;
    if (!entry || entry === this.homePage || entry.isClosed()) return false;
    let home = this.homePage && !this.homePage.isClosed() ? this.homePage : null;
    if (!home) home = this.context.pages().find(page => page !== entry && !page.isClosed()) || await this.context.newPage();
    await entry.close();
    this.entryPage = null;
    this.page = home;
    this.homePage = home;
    return true;
  }

  locator(target) {
    return createDomLocator(this.page, target, { timeout: this.timeout || 15000 });
  }

  async unique(target, label, { visible = true } = {}) {
    const locator = this.locator(target);
    await locator.waitFor({ state: visible ? 'visible' : 'attached', timeout: this.timeout });
    if (await locator.count() !== 1) throw new Error(`${label} 定位结果不是唯一元素`);
    return locator;
  }

  async read(target, label, { visible = true } = {}) {
    const locator = await this.unique(target, label, { visible });
    return locator.evaluate((element) => {
      if (element instanceof HTMLInputElement) {
        if (element.type === 'file') return String(element.files?.length || '');
        if (['radio', 'checkbox'].includes(element.type)) return element.checked ? 'true' : '';
        return element.value;
      }
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
      return element.innerText ?? element.textContent ?? '';
    });
  }

  async fill(target, value, label) {
    const locator = await this.unique(target, label);
    await locator.fill(value);
    await locator.blur();
  }

  async poll(check, message, timeout = this.timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await this.page.waitForTimeout(100);
    }
    throw new Error(message);
  }

  async receivingValue(target, label) {
    const field = await this.unique(target, label);
    return field.evaluate(element => {
      const visible = e => getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && getComputedStyle(e).opacity !== '0' && e.getClientRects().length > 0;
      const controls = [element, ...element.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]')]
        .filter(e => visible(e) && (e.matches('input:not([type="hidden"]),textarea') || e.isContentEditable));
      if (controls.length > 1) throw Error('存在多个取值控件，无法唯一核对');
      if (controls.length === 1) return String(controls[0].isContentEditable ? controls[0].innerText : controls[0].value).trim();
      const values = [element, ...element.querySelectorAll('.cap4-people__text, .cap4-people__browse, .cap4-text__browse')]
        .filter(e => visible(e) && e.matches('.cap4-people__text, .cap4-people__browse, .cap4-text__browse'));
      if (values.length !== 1) throw Error('收款字段的取值区域未唯一匹配');
      return values[0].innerText.trim();
    });
  }

  async copyCounterpartyFields(config) {
    const copied = {
      contact: await this.receivingValue(config.fields.receivingContact, '收款联系人'),
      email: await this.receivingValue(config.fields.receivingEmail, '收款联系人邮箱'),
    };
    await this.fill(config.fields.counterpartyOwner, copied.contact, '对方负责人');
    await this.fill(config.fields.counterpartyContact, copied.email, '对方负责人联系方式');
    await this.verifyCounterpartyFields(config, copied);
    return copied;
  }

  async verifyCounterpartyFields(config, copied) {
    if (!copied) throw Error('缺少联系人复制核验快照');
    const contact = await this.receivingValue(config.fields.receivingContact, '收款联系人');
    const email = await this.receivingValue(config.fields.receivingEmail, '收款联系人邮箱');
    if (contact !== copied.contact || email !== copied.email) throw Error('收款联系人或邮箱发生变化，联系人核对停止');
    if (String(await this.read(config.fields.counterpartyOwner, '对方负责人')).trim() !== copied.contact) throw Error('对方负责人回读不一致');
    if (String(await this.read(config.fields.counterpartyContact, '对方负责人联系方式')).trim() !== copied.email) throw Error('对方负责人联系方式回读不一致');
  }

  async prepareForm(config) {
    if (!this.context || !this.page || this.page.isClosed()) throw new Error('请先打开专用浏览器并登录 ITSM');
    this.timeout = config.timeoutMs || 15000;
    if (this.page === this.homePage) this.page = await this.context.newPage();
    this.entryPage = this.page;
    this.page.setDefaultTimeout(this.timeout);
    await this.page.goto(config.newFormUrl, { waitUntil: 'domcontentloaded', timeout: this.timeout });
    await this.unique(config.picker.open, '项目编号按钮');
  }

  async readPickerSnapshot(config) {
    return this.locator({ selector: 'body', frameChain: config.picker.resultRows.frameChain }).evaluate((body, settings) => {
      const headings = [...body.querySelectorAll('table.v-easy-table-htable tr:first-child td')].map(e => e.textContent.trim());
      if (!headings.length) return { ready: false };
      const missing = settings.columns.filter(name => headings.filter(h => h === name).length !== 1);
      if (missing.length) throw new Error(`ITSM 关联列表表头缺失或重复：${missing.join('、')}`);
      const pager = body.querySelector('.cap4-page__cnt');
      const total = Number(pager?.textContent.match(/共\s*(\d+)\s*条记录/)?.[1] ?? NaN);
      const pages = Number(pager?.textContent.match(/共\s*(\d+)\s*页/)?.[1] ?? NaN);
      const inputs = pager?.querySelectorAll('input');
      const pageSize = Number(inputs?.[0]?.value);
      const page = Number(inputs?.[1]?.value);
      if (![total, pages, pageSize, page].every(Number.isInteger) || total < 0 || pageSize < 1) return { ready: false };
      const rows = [...body.querySelectorAll(settings.rowSelector)];
      const records = rows.map((row, index) => {
        const cells = [...row.children].filter(e => e.tagName === 'TD');
        if (cells.length !== headings.length) return null;
        const record = { _index: index, _page: page };
        headings.forEach((heading, i) => {
          if (heading) {
            const content = cells[i].querySelector('.v-td-content');
            record[heading] = (content?.getAttribute('title') ?? content?.textContent ?? cells[i].textContent).trim();
          }
        });
        return record;
      });
      const expectedRows = Math.max(0, Math.min(pageSize, total - (page - 1) * pageSize));
      return { ready: records.every(Boolean) && records.length === expectedRows && (total === 0 || pages === Math.ceil(total / pageSize)), headings, total, pages, pageSize, page, records };
    }, { columns: ITSM_COLUMNS, rowSelector: config.picker.resultRows.selector });
  }

  async pickerReady(config, predicate = () => true) {
    let snapshot;
    await this.poll(async () => {
      if (!await this.locator({ selector: 'table.v-easy-table-htable', frameChain: config.picker.resultRows.frameChain }).count()) return false;
      snapshot = await this.readPickerSnapshot(config);
      return snapshot.ready && predicate(snapshot);
    }, 'ITSM 预算列表加载或分页核对超时，请重新读取');
    return snapshot;
  }

  async pickerQuery(config, action) {
    if (!config.picker.queryResponsePath) { await action(); return; }
    const frame = await this.locator(config.picker.resultRows).frame();
    const response = this.page.waitForResponse(r => new URL(r.url()).pathname === config.picker.queryResponsePath
      && r.request().frame() === frame, { timeout: this.timeout }).then(r => r, () => null);
    await action();
    const received = await response;
    if (!received) throw Object.assign(new Error('ITSM 预算查询响应超时或连接中断'), { queryNetworkFailure: true });
    if (!received.ok()) {
      const status = received.status();
      throw Object.assign(new Error(`ITSM 预算查询请求失败：HTTP ${status}`), { queryNetworkFailure: [408, 502, 503, 504].includes(status) });
    }
    const interrupted = await received.finished();
    if (interrupted) throw Object.assign(new Error(`ITSM 预算查询响应中断：${interrupted.message || interrupted}`), { queryNetworkFailure: true });
  }

  async filterPicker(config, { year, code = '' }) {
    // A reopened picker may still show stale rows/pagination. Query controls
    // must be usable before filtering; validate the resulting data afterwards.
    for (const [target, label] of [
      [config.picker.yearInput, '预算年度'], [config.picker.searchInput, '预算编号'],
      [config.picker.searchButton, '筛选按钮'],
    ]) {
      await this.unique(target, label);
    }
    await this.fill(config.picker.yearInput, String(year), '预算年度');
    await this.fill(config.picker.searchInput, code, '预算编号');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.pickerQuery(config, async () => (await this.unique(config.picker.searchButton, '筛选按钮')).click());
        break;
      } catch (error) {
        if (!error.queryNetworkFailure || attempt > 0) throw error;
        this.emit({ type: 'budget-query-retry', budgetCode: code, message: `${error.message}；相同条件重新查询一次` });
        await this.page.waitForTimeout(300);
      }
    }
    return this.pickerReady(config, s => s.page === 1 && s.records.every(r => r['年度'] === String(year)
      && (!code || r['预算编号'].includes(code))));
  }

  async readBudgets(config, { year, onProgress = () => {} } = {}) {
    await this.prepareForm(config);
    await (await this.unique(config.picker.open, '项目编号按钮')).click();
    let snapshot = await this.filterPicker(config, { year });
    const total = snapshot.total, pages = snapshot.pages;
    const records = [], seen = new Set();
    while (true) {
      if (snapshot.total !== total || snapshot.pages !== pages) throw new Error('ITSM 列表总数在读取过程中变化，请重新读取');
      for (const record of snapshot.records) {
        const identity = `${record['年度']}\0${record['预算编号']}`;
        if (seen.has(identity)) throw new Error('ITSM 翻页出现重复预算编号，已停止，避免漏读或重复录入');
        seen.add(identity); records.push(record);
      }
      onProgress({ page: snapshot.page, pages, count: records.length, total });
      if (!total || snapshot.page >= pages) break;
      const previousPage = snapshot.page;
      const previousFirst = snapshot.records[0]?.['预算编号'];
      await this.pickerQuery(config, async () => (await this.unique(config.picker.nextPage, '下一页')).click());
      snapshot = await this.pickerReady(config, s => s.page === previousPage + 1 && s.records[0]?.['预算编号'] !== previousFirst);
    }
    if (records.length !== total) throw new Error(`ITSM 读取条数不完整：${records.length}/${total}`);
    await (await this.unique(config.picker.cancel, '取消预算选择')).click();
    return records;
  }

  async lookupOaBudget(contract, config) {
    await (await this.unique(config.picker.open, '项目编号选择器')).click();
    const snapshot = await this.filterPicker(config, { year: contract.year, code: contract.budgetCode });
    const matches = snapshot.records.filter(r => r['预算编号'] === contract.budgetCode && r['年度'] === contract.year);
    if (snapshot.total !== 1 || matches.length !== 1) throw new Error(`预算 ${contract.budgetCode} 在 ITSM 中未唯一匹配`);
    const record = matches[0];
    assertSameOaBalance(contract, record, config.source);
    return record;
  }

  async pickOaBudget(contract, config) {
    const record = await this.lookupOaBudget(contract, config);
    const row = this.locator(config.picker.resultRows).nth(record._index);
    await row.locator(config.picker.rowSelectSelector).click();
    if (!await row.locator(config.picker.rowCheckedSelector).isChecked()) throw new Error('预算行未选中');
    await (await this.unique(config.picker.confirm, '预算选择确定按钮')).click();
    await this.poll(async () => (await this.read(config.fields.projectBudgetCode, '关联预算编号')).trim() === contract.budgetCode, '关联预算编号回读不符');
  }

  async checkLiveBalance(contract, config) {
    try { await this.lookupOaBudget(contract, config); }
    finally {
      const cancel = this.locator(config.picker.cancel);
      if (await cancel.count() === 1 && await cancel.isVisible()) await cancel.click();
    }
  }

  async pickBudget(contract, config) {
    if (contract.sourceKind === 'oa') return this.pickOaBudget(contract, config);
    const originalPages = new Set(this.context.pages());
    await (await this.unique(config.picker.open, '项目编号选择器')).click();
    if (this.context.pages().some((page) => !originalPages.has(page))) {
      throw new Error('预算选择器打开了新窗口；当前配置只支持同页或 iframe，请现场适配新窗口');
    }
    await this.fill(config.picker.searchInput, contract.budgetCode, '预算编号查询框');
    await (await this.unique(config.picker.searchButton, '预算查询按钮')).click();
    const rows = this.locator(config.picker.resultRows);
    let selected = -1;
    const readCodes = async () => {
      const cells = await rows.evaluateAll((elements, selector) => elements.map(row => {
        const matches = row.querySelectorAll(selector);
        return { count: matches.length, code: matches[0]?.innerText || '' };
      }), config.picker.rowCodeSelector);
      if (cells.some(cell => cell.count > 1)) throw new Error('预算查询结果的编号列定位不唯一');
      // Filtering replaces table rows asynchronously; inspect one DOM snapshot.
      if (cells.some(cell => cell.count === 0)) return [];
      return cells.map(cell => cell.code);
    };
    await this.poll(async () => {
      const codes = await readCodes();
      if (config.picker.requireSingleResult && codes.length !== 1) return false;
      const count = codes.filter((code) => code.trim() === contract.budgetCode.trim()).length;
      if (count > 1) selectExactBudgetRow(codes, contract.budgetCode);
      if (count === 0) return false;
      selected = selectExactBudgetRow(codes, contract.budgetCode);
      return true;
    }, `未找到唯一的预算编号 ${contract.budgetCode}，已停止`);
    selected = selectExactBudgetRow(await readCodes(), contract.budgetCode);
    const selectControl = rows.nth(selected).locator(config.picker.rowSelectSelector);
    if (await selectControl.count() !== 1) throw new Error('预算行的选择控件定位不唯一');
    await selectControl.click();
    if (config.picker.rowCheckedSelector && !await rows.nth(selected).locator(config.picker.rowCheckedSelector).isChecked()) throw new Error('预算行未选中，已停止');
    await (await this.unique(config.picker.confirm, '预算选择确认按钮')).click();
    await this.poll(async () => (await this.read(config.fields.projectBudgetCode, '关联预算编号')).trim() === contract.budgetCode.trim(),
      '页面关联的预算编号与导入预算编号不一致，已停止');
  }

  async chooseContent(config) {
    const field = await this.unique(config.fields.contractContent, '合同内容');
    const placeholders = config.content?.placeholderTexts;
    if ((config.content?.kind ?? 'native') === 'native') {
      const options = await field.evaluate((element) => {
        if (!(element instanceof HTMLSelectElement)) throw new Error('合同内容不是原生 select；请配置 custom 并完成现场适配');
        return [...element.options].map((option, index) => ({
          index, value: option.value, label: option.textContent || '', hidden: option.hidden,
          disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
        }));
      });
      const chosen = firstEnabledOption(options, placeholders);
      await field.selectOption({ index: chosen.index });
      await field.blur();
      return { kind: 'native', ...chosen };
    }
    await (config.content.open ? await this.unique(config.content.open, '合同内容下拉按钮') : field).click();
    const options = this.locator(config.content.options);
    await options.first().waitFor({ state: 'visible', timeout: this.timeout });
    const candidates = [];
    for (let index = 0; index < await options.count(); index++) {
      const option = options.nth(index);
      candidates.push({ index, label: await option.innerText(), hidden: !await option.isVisible(),
        disabled: !await option.isEnabled() || await option.getAttribute('aria-disabled') === 'true' });
    }
    const chosen = firstEnabledOption(candidates, placeholders);
    await options.nth(chosen.index).click();
    return { kind: 'custom', ...chosen };
  }

  async chooseSeal(config) {
    await (await this.unique(config.seal.open, '公章保管类型下拉按钮')).click();
    const options = this.locator(config.seal.options);
    await options.first().waitFor({ state: 'visible', timeout: this.timeout });
    const matches = [];
    for (let i = 0; i < await options.count(); i++) {
      if (await options.nth(i).isVisible() && normalizedText(await options.nth(i).innerText()) === '公司保管合同章') matches.push(i);
    }
    if (matches.length !== 1) throw new Error('公章保管类型“公司保管合同章”未唯一匹配');
    await options.nth(matches[0]).click();
  }

  async complianceChecked(config) {
    const locator = await this.unique(config.fields.complianceNo, '不签订合规协议');
    return config.compliance?.kind === 'cap4'
      ? await locator.locator(config.compliance.checkedSelector).count() === 1
      : locator.isChecked();
  }

  async verifyWritten(contract, config, content) {
    for (const [key, expected, label] of [
      ['projectBudgetCode', contract.budgetCode, '关联预算编号'],
      ['contractName', contract.contractName, '合同名称'],
      ['signingDate', contract.signingDate, '合同签订日期'],
      ['description', contract.description, '合同说明'],
    ]) {
      const actual = await this.read(config.fields[key], label);
      const normalize = (value) => String(value).replace(/\r\n/g, '\n').trim();
      if (normalize(actual) !== normalize(expected)) throw new Error(`${label} 回读不一致，已停止`);
    }
    if (canonicalAmount(await this.read(config.fields.applicationAmount, '本次申请金额')) !== canonicalAmount(contract.amount)) {
      throw new Error('本次申请金额回读不一致，已停止');
    }
    if (!await this.complianceChecked(config)) {
      throw new Error('合规协议未保持“不签订”，已停止');
    }
    if (await this.read(config.fields.sealType, '公章保管类型') !== '公司保管合同章') throw new Error('公章保管类型回读不一致，已停止');
    if (config.fields.counterpartyCompany && content.autoCompany !== undefined
      && await this.read(config.fields.counterpartyCompany, '对方公司名称') !== content.autoCompany) throw new Error('ITSM 自动带出的对方公司名称发生变化，已停止');
    if (content.kind === 'native') {
      const actual = await (await this.unique(config.fields.contractContent, '合同内容')).evaluate((element) => ({
        value: element.value, index: element.selectedIndex,
      }));
      if (actual.value !== content.value || actual.index !== content.index) throw new Error('合同内容回读不一致，已停止');
    } else if (normalizedText(await this.read(config.fields.contractContent, '合同内容')) !== normalizedText(content.label)) {
      throw new Error('合同内容回读不一致，已停止');
    }
    await this.verifyCounterpartyFields(config, content.counterparty);
  }

  async assertNoOldSuccess(config) {
    const feedback = this.locator(config.save.success);
    for (let index = 0; index < await feedback.count(); index++) {
      if (await feedback.nth(index).isVisible()) throw new Error('保存前页面已有可见成功提示，无法证明本次保存成功；请清除旧提示并核实配置');
    }
  }

  /** Fill one fresh form and save once. Never click send; never retry a save. */
  async fillAndSave(contract, config, { beforeSave = async () => {} } = {}) {
    assertConfig(config);
    assertContract(contract);
    if (config.source?.kind === 'oa' && contract.sourceKind !== 'oa') throw new Error('当前仅允许从 ITSM 读取预算并按余额录入，不能执行旧文件清单');
    if (typeof beforeSave !== 'function') throw new Error('beforeSave 必须为函数');
    if (!this.context || !this.page || this.page.isClosed()) throw new Error('请先打开独立浏览器并完成 ITSM 登录');
    this.timeout = config.timeoutMs || 15000;
    if (this.page === this.homePage) this.page = await this.context.newPage();
    this.entryPage = this.page;
    this.page.setDefaultTimeout(this.timeout);
    await this.page.goto(config.newFormUrl, { waitUntil: 'domcontentloaded', timeout: this.timeout });
    this.emit({ type: 'contract-filling', budgetCode: contract.budgetCode });
    await this.pickBudget(contract, config);
    await this.fill(config.fields.applicationAmount, contract.amount, '本次申请金额');
    await this.fill(config.fields.contractName, contract.contractName, '合同名称');
    await this.fill(config.fields.signingDate, contract.signingDate, '合同签订日期');
    const compliance = await this.unique(config.fields.complianceNo, '不签订合规协议');
    if (config.compliance?.kind === 'cap4') {
      if (!await this.complianceChecked(config)) await compliance.click();
      await this.poll(() => this.complianceChecked(config), '合规协议未选中“不签订”');
    }
    else {
      if (!await compliance.evaluate((element) => element instanceof HTMLInputElement && element.type === 'radio')) throw new Error('“不签订”配置必须定位原生 radio 或已适配的 CAP4 控件');
      await compliance.check();
    }
    const content = await this.chooseContent(config);
    if (config.fields.counterpartyCompany) content.autoCompany = await this.read(config.fields.counterpartyCompany, '对方公司名称');
    await this.chooseSeal(config);
    await this.fill(config.fields.description, contract.description, '合同说明');
    content.counterparty = await this.copyCounterpartyFields(config);
    await this.verifyWritten(contract, config, content);
    if (contract.sourceKind === 'oa') {
      await this.checkLiveBalance(contract, config);
      await this.verifyWritten(contract, config, content);
    }
    const saveButton = await this.unique(config.save.button, '保存待发按钮');
    const text = await saveButton.evaluate((element) => element instanceof HTMLInputElement ? element.value : element.innerText);
    assertDraftButtonText(text);
    if (!await saveButton.isEnabled()) throw new Error('保存待发按钮不可用');
    if (config.save.mode === 'seeyon-wait-send') return this.saveSeeyon(contract, config, content, saveButton, beforeSave);
    await this.assertNoOldSuccess(config);
    await beforeSave();
    await saveButton.click();
    const saveTimeout = config.saveTimeoutMs || 15000;
    await this.poll(async () => {
      const feedback = this.locator(config.save.success);
      if (await feedback.count() > 1) throw new Error('保存成功提示定位不唯一，无法确认结果');
      return await feedback.count() === 1 && await feedback.isVisible()
        && normalizedText(await feedback.innerText()) === normalizedText(config.save.successText);
    }, '点击保存后未取得新的确切成功提示；结果不确定，请人工核查，禁止自动重试', saveTimeout);
    let draftId = '';
    await this.poll(async () => {
      const locator = this.locator(config.save.draftId);
      if (await locator.count() > 1) throw new Error('草稿编号定位不唯一，无法确认结果');
      if (await locator.count() !== 1) return false;
      draftId = String(await this.read(config.save.draftId, '草稿编号', { visible: false })).trim();
      return Boolean(draftId);
    }, '点击保存后未取得非空草稿编号；结果不确定，请人工核查，禁止自动重试', saveTimeout);
    const result = { draftId, url: this.page.url(), savedAt: new Date().toISOString() };
    this.emit({ type: 'contract-saved', budgetCode: contract.budgetCode, draftId });
    return result;
  }

  async saveSeeyon(contract, config, content, saveButton, beforeSave) {
    const page = this.page;
    const expectedId = String(await this.read(config.save.draftId, '待保存草稿标识', { visible: false })).trim();
    if (!/^-?\d+$/.test(expectedId)) throw new Error('未取得有效的待保存草稿标识');
    const frames = () => page.frames();
    const initialUrls = frames().map(frame => frame.url());
    if (initialUrls.some(url => matchDraftReceipt(url, expectedId, config))) throw Error('页面已是该合同的待发草稿，已阻止重复保存');
    let receipt = null;
    let dialogMessage = '';
    const inspectNavigation = frame => { receipt ||= matchDraftReceipt(frame.url(), expectedId, config); };
    const inspectDialog = dialog => {
      dialogMessage = normalizedText(dialog.message()).slice(0, 500) || '保存后出现待处理弹窗';
      // Record alerts and decline unexpected confirmations; never accept another action.
      dialog.dismiss().catch(() => {});
    };
    page.on('framenavigated', inspectNavigation);
    page.on('dialog', inspectDialog);
    let saving = false;
    try {
      await beforeSave({ expectedDraftId: expectedId });
      saving = true;
      await saveButton.click();
      await this.poll(async () => {
        if (dialogMessage) throw Error(`ITSM 弹窗：${dialogMessage}`);
        for (const frame of frames()) inspectNavigation(frame);
        return Boolean(receipt);
      }, '未取得匹配的待发草稿凭据（可能未跳转、请求失败或登录失效）', config.saveTimeoutMs || 30000);
      // Only GET an observed server-issued draft URL. A fresh document proves that
      // the values persisted; the unsaved input state and old success tips do not.
      const reloaded = await page.goto(receipt.url, { waitUntil: 'commit', timeout: config.saveTimeoutMs || 30000 });
      if (!reloaded?.ok()) throw Error(`草稿回读请求失败：${reloaded ? 'HTTP ' + reloaded.status() : '未取得服务器响应'}`);
      if (!matchDraftReceipt(page.url(), expectedId, config)) throw Error('重新打开草稿后跳转至其他页面，可能登录失效');
      await this.verifyWritten(contract, config, content);
      const result = { ...receipt, savedAt: new Date().toISOString() };
      this.emit({ type: 'contract-saved', budgetCode: contract.budgetCode, draftId: expectedId });
      return result;
    } catch (cause) {
      if (!saving) throw cause;
      const messages = dialogMessage ? [dialogMessage] : await this.savePageMessages(page);
      const observedUrl = diagnosticUrl(page.url());
      const details = messages.length ? `；页面提示：${messages.join('；')}` : '';
      const error = new Error(`保存待发未确认：${cause.message}${details}；待核查草稿标识 ${expectedId}；当前页面 ${observedUrl}。结果不确定，请人工核查，禁止自动重试`);
      error.saveEvidence = { expectedDraftId: expectedId, observedUrl, ...(receipt ? { draftUrl: receipt.url, affairId: receipt.affairId } : {}) };
      throw error;
    } finally {
      page.off('framenavigated', inspectNavigation);
      page.off('dialog', inspectDialog);
    }
  }

  async savePageMessages(page = this.page) {
    const messages = [];
    for (const frame of page.frames()) {
      try {
        const found = await frame.evaluate(() => [...document.querySelectorAll('[role="alert"], [role="dialog"], .layui-layer-dialog')]
          .filter(element => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length;
          }).map(element => element.innerText.replace(/\s+/g, ' ').trim().slice(0, 500)).filter(Boolean));
        for (const message of found) if (!messages.includes(message)) messages.push(message);
      } catch { /* A closed or navigating frame cannot provide diagnostics. */ }
    }
    return messages.slice(0, 3);
  }
}
