import { contractText } from './contract-rules.js';

'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = document.querySelector('meta[name="local-token"]').content;
  const state = { status: null, connected: false, preview: null, selected: new Set(), focused: null, working: false, launching: false, stopping: false, initialized: false, restored: false, dirty: false, polling: false };
  const labels = { ready: '可录入', invalid: '金额需检查', saved: '已保存待发', skipped: '余额跳过', uncertain: '结果待核查', changed: '内容已变化', running: '正在录入', failed: '上次失败' };
  const eligible = row => ['ready', 'failed'].includes(row.status);
  const rows = () => state.preview?.rows || [];
  const selected = () => rows().filter(row => state.selected.has(row.id) && eligible(row));
  const busy = () => Boolean(state.status?.busy || state.launching);
  const scanning = () => Boolean(state.working || state.status?.importing);
  const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const money = value => {
    const m = /^(-?)(\d+)\.(\d{2})$/.exec(String(value));
    return m ? (m[1] ? '-¥' : '¥') + BigInt(m[2]).toLocaleString('zh-CN') + '.' + m[3] : '—';
  };
  const cents = value => BigInt(String(value).replace('.', ''));
  const totalText = value => String(value / 100n) + '.' + String(value % 100n).padStart(2, '0');
  async function api(path, body) {
    const options = { headers: { 'X-Local-Token': token }, cache: 'no-store' };
    if (body !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '请求失败，请重新打开工具页面');
    return data;
  }
  function feedback(id, message, kind = '') {
    const e = $(id); e.textContent = message || ''; e.hidden = !message;
    e.classList.remove('error', 'warning', 'success'); if (kind) e.classList.add(kind);
  }
  function blockers() {
    const result = [];
    if (!state.connected) result.push('本机服务未连接');
    if (!state.status?.browserOpen) result.push('请打开专用浏览器并登录 ITSM');
    if (!state.status?.config?.verified || state.status?.connectionIssues?.length) result.push('ITSM 读取和录入接入尚未就绪');
    if (state.dirty) result.push('请保存连接配置');
    if (!state.preview || state.preview.sourceKind !== 'oa') result.push('请直接读取 ITSM 预算');
    else if (state.preview.year !== $('budget-year').value.trim()) result.push('年度已变化，请重新读取 ITSM');
    if (scanning()) result.push('正在读取 ITSM');
    if (busy()) result.push('正在录入');
    return result;
  }
  function controls() {
    const locked = busy() || scanning();
    $('scan-button').disabled = locked || !state.connected || !state.status?.browserOpen || state.dirty;
    $('scan-button').textContent = scanning() ? '正在读取 ITSM…' : '读取 ITSM 预算';
    for (const id of ['budget-year', 'oa-url', 'new-form-url', 'browser-channel', 'save-config', 'open-browser']) $(id).disabled = locked || !state.connected;
    const blocked = blockers(), picked = selected(), available = rows().filter(eligible);
    $('trial-button').disabled = blocked.length > 0 || picked.length !== 1;
    $('run-button').disabled = blocked.length > 0 || !picked.length;
    $('trial-button').title = blocked.join('；') || (picked.length !== 1 ? '请只选择一条' : '');
    $('run-button').title = blocked.join('；');
    $('run-button').textContent = picked.length ? '执行所选 ' + picked.length + ' 条' : '执行所选';
    $('stop-button').hidden = !busy(); $('stop-button').disabled = state.stopping;
    $('stop-button').textContent = state.stopping ? '等待当前合同结束' : '当前合同完成后停止';
    $('select-all').disabled = locked || !available.length;
    $('select-all').checked = available.length > 0 && picked.length === available.length;
    $('select-all').indeterminate = picked.length > 0 && picked.length < available.length;
    $('selection-label').textContent = state.preview ? '已选择 ' + picked.length + ' 条 · 可录入 ' + available.length + ' 条' : '尚未读取 ITSM 预算';
    $('execution-hint').textContent = busy() ? '正在重新核对 ITSM 余额，逐条填写并保存待发。' : scanning() ? '正在读取 ITSM 预算分页，请保持专用浏览器打开。' : blocked.length ? blocked.join('；') : picked.length ? '按 ITSM 剩余额度录入 ' + picked.length + ' 份合同。' : '请选择剩余额度大于 0 的预算。';
    $('execution-hint').classList.toggle('ready', !blocked.length);
    $('step-import').classList.toggle('active', !state.preview || scanning());
    $('step-import').classList.toggle('done', Boolean(state.preview));
    $('step-review').classList.toggle('active', Boolean(state.preview) && !locked);
    $('step-run').classList.toggle('active', busy());
    $('activity-state').textContent = busy() ? '正在录入' : scanning() ? '正在读取 ITSM' : '等待操作';
    document.querySelector('.logs-panel').classList.toggle('running', locked);
  }
  function renderStatus() {
    const status = state.status, config = status?.config || {};
    const ready = state.connected && config.verified && !status.connectionIssues.length;
    $('connection-badge').textContent = !state.connected ? '本机服务未连接' : ready ? 'ITSM 接入已验证' : 'ITSM 接入需验证';
    $('connection-badge').classList.toggle('badge-configured', ready);
    $('connection-badge').classList.toggle('badge-neutral', !ready);
    feedback('readiness-summary', ready ? '直接读取 ITSM 预算，筛选控股企业信息分摊费，按剩余额度保存合同草稿。' : '请在专用浏览器登录 ITSM。读取预算后核对金额；完成接入验证后可执行。', ready ? 'success' : 'warning');
    $('browser-state').textContent = status?.browserOpen ? '专用浏览器已打开' : '浏览器未打开';
    $('service-state').textContent = state.connected ? '本机服务已连接' : '本机服务未连接';
    $('connection-diagnostics').hidden = !state.connected || ready;
    $('diagnostics-label').textContent = '查看连接详情';
    $('diagnostics-list').replaceChildren(...(status?.connectionIssues || []).map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
    if (!state.initialized && status) {
      $('oa-url').value = config.oaUrl || ''; $('new-form-url').value = config.newFormUrl || '';
      $('browser-channel').value = config.browserChannel || 'chrome';
      $('budget-year').value = status.source?.year || String(new Date().getFullYear());
      state.initialized = true;
    }
    controls();
  }
  function renderRows() {
    const list = rows(), body = $('rows-body');
    body.replaceChildren(); $('empty-state').hidden = list.length > 0; $('table-wrap').hidden = !list.length;
    $('row-count').textContent = list.length + ' 条';
    $('sheet-label').textContent = state.preview ? 'ITSM · ' + state.preview.year + ' 年 · ' + new Date(state.preview.readAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
    $('total-amount').textContent = state.preview ? money(totalText(list.filter(eligible).reduce((sum, r) => sum + cents(r.amount), 0n))) : '—';
    $('valid-count').textContent = state.preview ? list.filter(eligible).length : '—';
    $('skipped-count').textContent = state.preview ? list.filter(r => r.status === 'skipped').length : '—';
    $('blocked-count').textContent = state.preview ? list.filter(r => ['invalid', 'uncertain', 'changed'].includes(r.status)).length : '—';
    $('saved-count').textContent = state.preview ? list.filter(r => r.status === 'saved').length : '—';
    for (const row of list) {
      const tr = document.createElement('tr'); tr.dataset.rowId = row.id; tr.tabIndex = 0;
      tr.classList.toggle('focused', state.focused === row.id);
      const cell = document.createElement('td'); cell.className = 'checkbox-cell';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state.selected.has(row.id);
      check.disabled = !eligible(row) || busy() || scanning(); check.setAttribute('aria-label', '选择预算 ' + row.budgetCode);
      check.addEventListener('click', e => e.stopPropagation());
      check.addEventListener('change', () => { if (check.checked) state.selected.add(row.id); else state.selected.delete(row.id); controls(); });
      cell.append(check); tr.append(cell);
      for (const key of ['budgetCode', 'budgetName', 'totalAmount', 'allocatedAmount', 'inTransitAmount', 'amount']) {
        const td = document.createElement('td'); td.textContent = ['budgetCode', 'budgetName'].includes(key) ? text(row[key]) : money(row[key]);
        td.title = td.textContent; if (key.includes('Amount') || key === 'amount') td.className = 'amount-cell'; tr.append(td);
      }
      const statusCell = document.createElement('td'), badge = document.createElement('span'); badge.className = 'row-status ' + row.status;
      badge.textContent = labels[row.status] || '未知'; badge.title = row.message || ''; statusCell.append(badge); tr.append(statusCell);
      const focus = () => { state.focused = row.id; for (const e of body.children) e.classList.toggle('focused', e.dataset.rowId === row.id); renderMapping(); };
      tr.addEventListener('click', focus); tr.addEventListener('keydown', e => { if (e.target === tr && ['Enter', ' '].includes(e.key)) { e.preventDefault(); focus(); } }); body.append(tr);
    }
    controls();
  }
  function renderMapping() {
    const row = rows().find(r => r.id === state.focused);
    const contract = contractText(row?.projectName ?? row?.budgetName);
    $('detail-row-label').textContent = row ? row.budgetCode : '选择预算查看';
    feedback('detail-message', row ? [row.message, ...(row.errors || []), row.draftId ? '草稿标识：' + row.draftId : ''].filter(Boolean).join('；') : '', row?.status === 'saved' ? 'success' : row?.errors?.length ? 'error' : 'warning');
    const values = [
      ['收费属性', row?.feeType || '控股企业信息分摊费', '仅处理该属性'],
      ['项目编号', row?.budgetCode, 'ITSM 关联列表精确选择'],
      ['分摊合计含税', money(row?.totalAmount), 'ITSM 当前预算总额'],
      ['已分摊合同金额', money(row?.allocatedAmount), '空白按 0 计算'],
      ['在途分摊合同金额', money(row?.inTransitAmount), '空白按 0 计算'],
      ['本次申请金额', money(row?.amount), '预算总额 − 已分摊 − 在途；录入前和保存前重新查询'],
      ['合同名称', row ? contract.contractName : '当年年份＋年信息化分摊费用＋项目名称', '年度取执行当天，北京时间；项目名称取关联预算名称'],
      ['合同说明', contract.description, '年度取执行当天，北京时间'],
      ['合同签订日期', contract.signingDate, '执行当天，北京时间'],
      ['廉洁合规协议', '不签订', '固定规则'],
      ['合同内容', '第一个有效非空选项', '保持之前规则'],
      ['公章保管类型', '公司保管合同章', '固定选择'],
      ['对方公司名称', '保留 ITSM 自动带出值', '保存前后核对一致'],
      ['对方负责人', '复制收款联系人', '读取下方现有姓名，直接填入上方；来源为空则目标留空'],
      ['对方负责人联系方式', '复制收款联系人邮箱', '读取下方邮箱，直接填入上方；来源为空则目标留空'],
      ['批次完成后', '关闭合同录入页面', '最后一条保存待发确认后关闭，保留 ITSM 主页']
    ];
    $('mapping-list').replaceChildren(...values.map(([label, value, note]) => {
      const div = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'), small = document.createElement('small');
      dt.textContent = label; dd.textContent = text(value); small.textContent = note; dd.append(small); div.append(dt, dd); return div;
    }));
  }
  function renderLogs() {
    $('log-list').replaceChildren(...(state.status?.logs || []).map(log => {
      const div = document.createElement('div'); div.className = 'log-entry ' + log.level;
      const time = document.createElement('time'), dot = document.createElement('span'), p = document.createElement('p');
      time.textContent = new Date(log.time).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      dot.className = 'log-level'; p.textContent = log.message; div.append(time, dot, p); return div;
    }));
  }
  function usePreview(preview) {
    state.preview = preview?.sourceKind === 'oa' ? preview : null; state.selected.clear(); state.focused = rows()[0]?.id || null;
    if (state.preview) $('budget-year').value = state.preview.year;
    renderRows(); renderMapping();
  }
  async function refresh() {
    if (state.polling) return; state.polling = true;
    try {
      state.status = await api('/api/status'); state.connected = true;
      if (!busy()) state.stopping = false;
      for (const row of rows()) {
        const update = state.status.rowStates?.[row.id]; if (update) Object.assign(row, update);
        if (!eligible(row)) state.selected.delete(row.id);
      }
      renderStatus(); renderRows(); renderMapping(); renderLogs();
      if (!state.restored) { state.restored = true; usePreview(await api('/api/preview')); if (state.preview) feedback('import-feedback', '已恢复 ITSM 预览。执行前会重新核对实时余额。', 'success'); }
    } catch { state.connected = false; renderStatus(); } finally { state.polling = false; }
  }
  $('scan-button').addEventListener('click', async () => {
    state.working = true; controls(); feedback('import-feedback', '正在打开合同表单并读取 ITSM 分页…');
    try {
      const preview = await api('/api/oa/scan', { year: $('budget-year').value.trim() }); usePreview(preview);
      feedback('import-feedback', '读取完成：' + preview.scannedCount + ' 条 ITSM 预算中，匹配收费属性 ' + preview.rows.length + ' 条。', 'success');
    } catch (e) { feedback('import-feedback', e.message, 'error'); }
    finally { state.working = false; await refresh(); controls(); }
  });
  $('budget-year').addEventListener('input', controls);
  $('select-all').addEventListener('change', e => { state.selected = new Set(e.target.checked ? rows().filter(eligible).map(r => r.id) : []); renderRows(); });
  $('config-form').addEventListener('input', () => { state.dirty = true; controls(); });
  $('config-form').addEventListener('submit', async e => {
    e.preventDefault(); state.working = true; controls();
    try { await api('/api/config', { oaUrl: $('oa-url').value.trim(), newFormUrl: $('new-form-url').value.trim(), browserChannel: $('browser-channel').value }); state.dirty = false; feedback('config-feedback', '连接配置已保存。', 'success'); }
    catch (error) { feedback('config-feedback', error.message, 'error'); } finally { state.working = false; await refresh(); }
  });
  $('open-browser').addEventListener('click', async () => {
    state.working = true; controls();
    try { await api('/api/browser/open', {}); feedback('config-feedback', '请在专用浏览器登录 ITSM，再点击读取预算。', 'success'); }
    catch (e) { feedback('config-feedback', e.message, 'error'); } finally { state.working = false; await refresh(); }
  });
  async function run(trial) {
    const picked = selected(); if (blockers().length || !picked.length || (trial && picked.length !== 1)) return;
    state.launching = true; controls();
    try { const result = await api('/api/run', { previewId: state.preview.previewId, ids: picked.map(r => r.id) }); feedback('run-feedback', '已开始处理 ' + result.count + ' 条预算。', 'success'); }
    catch (e) { feedback('run-feedback', e.message, 'error'); } finally { state.launching = false; await refresh(); }
  }
  $('trial-button').addEventListener('click', () => run(true)); $('run-button').addEventListener('click', () => run(false));
  $('stop-button').addEventListener('click', async () => { state.stopping = true; controls(); try { await api('/api/run/stop', {}); } catch (e) { feedback('run-feedback', e.message, 'error'); state.stopping = false; } });
  renderRows(); renderMapping(); refresh(); setInterval(refresh, 2000);
})();
