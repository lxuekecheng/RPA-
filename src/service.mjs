import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseBudget, amountCents, RULES } from './budget.mjs';
import { buildContract } from './contract.mjs';
import { History } from './history.mjs';
import { OaDriver, validateConfig } from './oa-driver.mjs';
import { makeOaPreview, TARGET_FEE } from './oa-budget.mjs';

const eligible = state => ['ready', 'failed'].includes(state.status);
const money = cents => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;

export class RpaService {
  constructor({ root, dataDir = path.join(root, '.local'), driver } = {}) {
    this.root = root;
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.configPath = path.join(dataDir, 'oa.json');
    this.config = fs.existsSync(this.configPath)
      ? JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
      : JSON.parse(fs.readFileSync(path.join(root, 'config/oa.example.json'), 'utf8'));
    this.history = new History(path.join(dataDir, 'history.jsonl'));
    this.logs = [];
    this.previews = new Map();
    this.previewPath = path.join(dataDir, 'latest-preview.json');
    this.importing = false;
    this.busy = false;
    this.browserOpen = false;
    this.stopRequested = false;
    this.activeRows = new Map();
    this.restorePreview();
    this.driver = driver || new OaDriver({ profileDir: path.join(dataDir, 'browser-profile'), emit: message => this.log('info', typeof message === 'string' ? message : JSON.stringify(message)) });
    this.log('info', '工具已启动。请登录 ITSM，直接读取关联预算并按剩余额度录入。');
  }

  log(level, message) {
    this.logs.push({ time: new Date().toISOString(), level, message });
    if (this.logs.length > 150) this.logs.shift();
  }

  restorePreview() {
    if (!fs.existsSync(this.previewPath)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.previewPath, 'utf8'));
      const preview = saved.preview;
      if (this.config.source?.kind === 'oa' && preview?.sourceKind !== 'oa') {
        this.log('info', '已切换为 ITSM 直接读取模式，旧文件预览不再用于执行；已有草稿记录继续保留。');
        return;
      }
      if (saved.version !== 1 || !preview || typeof preview.previewId !== 'string' || !preview.previewId ||
          !Array.isArray(preview.rows) || !Array.isArray(preview.sheetNames) || typeof preview.sheetName !== 'string' ||
          preview.rows.some(row => !row || typeof row.id !== 'string' || !row.id || !Array.isArray(row.errors) ||
            ['year', 'budgetCode', 'budgetName', 'description', 'amount'].some(key => typeof row[key] !== 'string'))) {
        throw new Error('预览数据格式不正确');
      }
      // History is authoritative: persisted preview statuses are never restored.
      this.decoratePreview(preview);
      this.previews.set(preview.previewId, preview);
      this.log('info', `已恢复上次 ${preview.rows.length} 条预算预览，执行状态按本机历史重新核对。`);
    } catch (error) {
      this.log('warning', `上次预算预览无法恢复，请重新读取 ITSM：${error.message}`);
    }
  }

  decoratePreview(preview) {
    const rows = preview.rows.map(({ status, message, draftId, ...row }) => ({ ...row, ...(this.activeRows.get(row.id) || this.history.state(row)) }));
    const valid = rows.filter(eligible);
    return { ...preview, rows, totalAmount: money(valid.reduce((sum, row) => sum + amountCents(row.amount), 0n)), validCount: valid.length,
      savedCount: rows.filter(r => r.status === 'saved').length, skippedCount: rows.filter(r => r.status === 'skipped').length,
      blockedCount: rows.filter(r => ['invalid', 'uncertain', 'changed'].includes(r.status)).length };
  }

  getPreview() {
    const preview = this.previews.values().next().value;
    return preview ? this.decoratePreview(preview) : null;
  }

  persistPreview(preview) {
    const temporary = `${this.previewPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, preview }));
      fs.renameSync(temporary, this.previewPath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  status() {
    const rowStates = {};
    for (const preview of this.previews.values()) {
      for (const row of preview.rows) rowStates[row.id] = this.activeRows.get(row.id) || this.history.state(row);
    }
    return { config: { oaUrl: this.config.oaUrl || '', newFormUrl: this.config.newFormUrl || '',
      browserChannel: this.config.browserChannel || 'chrome', verified: this.config.verified === true },
      source: { kind: 'oa', feeType: TARGET_FEE, year: this.config.source?.year || new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()), blankAllocatedAsZero: this.config.source?.blankAllocatedAsZero !== false },
      connectionIssues: validateConfig(this.config), browserOpen: this.browserOpen && this.driver.context !== null,
      busy: this.busy, importing: this.importing, rules: RULES, logs: this.logs, rowStates };
  }

  saveConfig(input) {
    if (this.importing) throw new Error('正在导入预算，请稍候再修改连接设置');
    if (this.busy) throw new Error('正在录入，请等待本轮结束后修改连接设置');
    for (const key of ['oaUrl', 'newFormUrl']) {
      if (typeof input[key] !== 'string') throw new Error('网址格式不正确');
      if (input[key]) {
        let url;
        try { url = new URL(input[key]); } catch { throw new Error('请输入完整 http:// 或 https:// ITSM 网址'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('ITSM 地址必须是没有内嵌账号密码的 HTTP(S) 网址');
      }
    }
    if (!['chrome', 'msedge'].includes(input.browserChannel)) throw new Error('请选择 Chrome 或 Edge');
    const changed = ['oaUrl', 'newFormUrl', 'browserChannel'].some(key => this.config[key] !== input[key]);
    this.config = { ...this.config, oaUrl: input.oaUrl.trim(), newFormUrl: input.newFormUrl.trim(), browserChannel: input.browserChannel,
      verified: changed ? false : this.config.verified };
    const temporary = `${this.configPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.config, null, 2));
    fs.renameSync(temporary, this.configPath);
    this.log('info', changed ? '连接设置已保存，需重新确认页面定位后才能录入。' : '连接设置已保存。');
    return this.status();
  }

  async preview({ filename, base64, sheetName }) {
    if (this.busy) throw new Error('录入进行中，当前预算预览已锁定');
    if (this.importing) throw new Error('正在导入预算，请等待本次解析完成');
    if (typeof filename !== 'string' || typeof base64 !== 'string' || !base64 || base64.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('文件为空、编码无效或超过 18 MB');
    this.importing = true;
    try {
      const parsed = await parseBudget(Buffer.from(base64, 'base64'), filename, { sheetName });
      if (!parsed.rows.length) throw new Error('表头下没有预算数据');
      const preview = { ...parsed, filename, previewId: randomUUID() };
      const decorated = this.decoratePreview(preview);
      this.persistPreview(preview);
      this.previews.clear();
      this.previews.set(preview.previewId, preview);
      this.log('info', `已读取 ${filename}：${preview.rows.length} 条预算，${decorated.validCount} 条数据校验通过、待处理。是否能执行还取决于 ITSM 页面接入状态。`);
      return decorated;
    } finally { this.importing = false; }
  }

  async scan({ year } = {}) {
    if (this.busy) throw new Error('正在录入，不能重新读取 ITSM');
    if (this.importing) throw new Error('正在读取 ITSM 预算，请等待本次完成');
    if (!this.status().browserOpen) throw new Error('请先打开专用浏览器并登录 ITSM');
    const selectedYear = String(year ?? this.status().source.year).trim();
    if (!/^\d{4}$/.test(selectedYear)) throw new Error('请输入四位预算年度');
    this.importing = true;
    try {
      this.log('info', `开始从 ITSM 读取 ${selectedYear} 年预算；仅处理${TARGET_FEE}。`);
      const records = await this.driver.readBudgets(this.config, { year: selectedYear,
        onProgress: p => this.log('info', `ITSM 读取进度：第 ${p.page}/${p.pages || 1} 页，${p.count}/${p.total} 条。`) });
      const parsed = makeOaPreview(records, { year: selectedYear, blankAllocatedAsZero: this.config.source?.blankAllocatedAsZero !== false });
      const preview = { ...parsed, previewId: randomUUID() };
      this.persistPreview(preview);
      this.previews.clear(); this.previews.set(preview.previewId, preview);
      const decorated = this.decoratePreview(preview);
      this.log('success', `已读取 ITSM ${records.length} 条预算，其中${TARGET_FEE} ${preview.rows.length} 条；待处理 ${decorated.validCount} 条，已保存 ${decorated.savedCount} 条，余额跳过 ${decorated.skippedCount} 条，需检查 ${decorated.blockedCount} 条。`);
      return decorated;
    } finally { this.importing = false; }
  }

  async openBrowser() {
    if (this.importing) throw new Error('正在导入预算，请稍候再打开浏览器');
    if (this.busy) throw new Error('正在录入，请勿切换浏览器');
    if (!this.config.oaUrl) throw new Error('请先填写并保存 ITSM 网址');
    this.busy = true;
    try {
      await this.driver.open(this.config);
      this.browserOpen = true;
      this.log('info', this.config.verified ? 'ITSM 专用浏览器已打开。请确认已登录后选择预算执行。' : 'ITSM 浏览器已打开，请在该窗口登录。页面接入验证完成前仅可预览。');
      return { browserOpen: true };
    } finally { this.busy = false; }
  }

  start({ previewId, ids }) {
    if (this.importing) throw new Error('正在导入预算，请等待本次解析完成');
    if (this.busy) throw new Error('已有一轮录入正在执行');
    const issues = validateConfig(this.config);
    if (issues.length) throw new Error(`ITSM 页面尚未就绪：${issues.join('；')}`);
    if (!this.status().browserOpen) throw new Error('请先打开并登录 ITSM 浏览器');
    const preview = this.previews.get(previewId);
    if (!preview) throw new Error('预览已过期，请重新导入文件');
    if (this.config.source?.kind === 'oa' && preview.sourceKind !== 'oa') throw new Error('请直接读取 ITSM，旧文件清单不能执行');
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('请选择不重复的待录入预算');
    const rows = ids.map(id => preview.rows.find(row => row.id === id));
    if (rows.some(row => !row || !eligible(this.history.state(row)))) throw new Error('所选预算含有无效、已保存、变更或待核查记录，请刷新预览');
    this.busy = true;
    this.stopRequested = false;
    this.runPromise = this.run(rows).catch(error => this.log('error', `录入停止：${error.message}`)).finally(() => { this.busy = false; this.activeRows.clear(); });
    return { started: true, count: rows.length };
  }

  async run(rows) {
    let completed = 0;
    for (const row of rows) {
      if (this.stopRequested) break;
      let saving = false;
      let saveEvidence = {};
      this.history.put(row, 'filling');
      this.activeRows.set(row.id, { status: 'running', message: '正在填写并核对' });
      this.log('info', `${row.budgetCode}：开始填写。`);
      try {
        const receipt = await this.driver.fillAndSave(buildContract(row), this.config, {
          beforeSave: async (evidence) => {
            if (typeof evidence?.expectedDraftId === 'string') saveEvidence = { expectedDraftId: evidence.expectedDraftId };
            this.history.put(row, 'saving', saveEvidence);
            saving = true;
            this.activeRows.set(row.id, { status: 'running', message: '已核对，正在保存待发' });
          },
        });
        if (!saving || !receipt?.draftId || !receipt?.savedAt) throw new Error('未取得可确认的草稿保存凭据');
        this.history.put(row, 'saved', receipt);
        completed++;
        this.log('success', `${row.budgetCode}：已保存待发，草稿标识 ${receipt.draftId}。`);
      } catch (error) {
        const status = saving ? 'uncertain' : 'failed';
        this.history.put(row, status, { ...saveEvidence, ...error.saveEvidence, message: error.message });
        this.log('error', `${row.budgetCode}：${saving ? '保存结果待核查，禁止自动重建。' : '保存前停止。'}${error.message}`);
        break;
      } finally { this.activeRows.delete(row.id); }
    }
    if (completed > 0 && completed === rows.length && typeof this.driver.closeEntryPage === 'function') {
      try {
        if (await this.driver.closeEntryPage()) this.log('info', '本批全部保存待发已确认，合同录入页面已关闭。');
      } catch (error) { this.log('warning', `合同均已保存待发，但录入页面未能关闭：${error.message}`); }
    }
    this.log('info', this.stopRequested ? '已在当前合同结束后停止。' : '本轮处理结束，请查看每条预算的结果。');
  }

  stop() { this.stopRequested = true; return { stopRequested: true }; }
}
