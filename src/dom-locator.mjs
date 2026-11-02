/**
 * CSS-only Playwright adapter for legacy pages which replace window.Set.
 * It uses DOM queries/evaluation plus protocol mouse/keyboard input, never
 * Playwright's selector injected script and never replaces page globals.
 */

function queryDom({ steps, result }) {
  let nodes = [document];
  for (const step of steps) {
    if (step.fieldLabel) {
      const found = [];
      const normalize = text => String(text ?? '').replace(/\s/g, '');
      const expected = normalize(step.fieldLabel);
      for (const root of nodes) {
        for (const title of root.querySelectorAll('.field-title')) {
          const field = title.closest('.cap-field');
          if (normalize(title.textContent) === expected && field && !found.includes(field)) found.push(field);
        }
        for (const cell of root.querySelectorAll('td')) {
          if (normalize(cell.innerText) !== expected) continue;
          const next = cell.nextElementSibling;
          const field = next?.tagName === 'TD' ? next.querySelector('.cap-field') : null;
          if (field && !found.includes(field)) found.push(field);
        }
      }
      nodes = found;
    } else if (step.index !== undefined) {
      const index = step.index < 0 ? nodes.length + step.index : step.index;
      nodes = nodes[index] ? [nodes[index]] : [];
    } else {
      const found = [];
      for (const root of nodes) {
        for (const element of root.querySelectorAll(step.selector)) {
          if (!found.includes(element)) found.push(element);
        }
      }
      nodes = found;
    }
  }
  if (result === 'count') return nodes.length;
  if (result === 'elements') return nodes;
  if (nodes.length !== 1) throw new Error(`DOM 定位必须唯一，实际为 ${nodes.length} 个元素`);
  return nodes[0];
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createDomLocator(page, target, { timeout = 15000 } = {}) {
  if (!page || typeof target?.selector !== 'string' || !target.selector.trim()) {
    throw new Error('DOM 定位需要页面及非空 CSS selector');
  }
  if (target.frameChain !== undefined && (!Array.isArray(target.frameChain)
    || target.frameChain.some(selector => typeof selector !== 'string' || !selector.trim()))) {
    throw new Error('frameChain 必须是非空 CSS selector 数组');
  }
  if (target.fieldLabel !== undefined && (typeof target.fieldLabel !== 'string' || !target.fieldLabel.trim())) throw new Error('fieldLabel 必须是非空字段名称');
  return new DomLocator(page, target.frameChain || [], [
    ...(target.fieldLabel ? [{ fieldLabel: target.fieldLabel }] : []), { selector: target.selector },
  ], timeout);
}

class DomLocator {
  constructor(page, frameChain, steps, timeout) {
    this.page = page;
    this.frameChain = frameChain;
    this.steps = steps;
    this.timeout = timeout;
  }

  nth(index) {
    if (!Number.isInteger(index)) throw new Error('nth index 必须是整数');
    return new DomLocator(this.page, this.frameChain, [...this.steps, { index }], this.timeout);
  }
  first() { return this.nth(0); }
  last() { return this.nth(-1); }
  locator(selector) {
    if (typeof selector !== 'string' || !selector.trim()) throw new Error('子定位需要非空 CSS selector');
    return new DomLocator(this.page, this.frameChain, [...this.steps, { selector }], this.timeout);
  }

  async frame() {
    let frame = this.page.mainFrame();
    for (const selector of this.frameChain) {
      const steps = [{ selector }];
      const count = await frame.evaluate(queryDom, { steps, result: 'count' });
      if (count === 0) return null;
      if (count !== 1) throw new Error(`iframe 定位必须唯一，实际为 ${count} 个元素`);
      const handle = await frame.evaluateHandle(queryDom, { steps, result: 'element' });
      try {
        const element = handle.asElement();
        if (!element) throw new Error('frameChain 未定位到元素');
        frame = await element.contentFrame();
        if (!frame) return null;
      } finally { await handle.dispose(); }
    }
    return frame;
  }

  async count() {
    const frame = await this.frame();
    return frame ? frame.evaluate(queryDom, { steps: this.steps, result: 'count' }) : 0;
  }

  async withElement(action) {
    const frame = await this.frame();
    if (!frame) throw new Error('iframe 尚未加载或不存在');
    const handle = await frame.evaluateHandle(queryDom, { steps: this.steps, result: 'element' });
    try {
      const element = handle.asElement();
      if (!element) throw new Error('DOM 定位未取得元素');
      return await action(element, frame);
    } finally { await handle.dispose(); }
  }

  async evaluate(callback, argument) {
    if (typeof callback !== 'function') throw new Error('evaluate 只接受函数');
    return this.withElement(element => element.evaluate(callback, argument));
  }

  async evaluateAll(callback, argument) {
    const frame = await this.frame();
    if (!frame) return callback([], argument);
    const handle = await frame.evaluateHandle(queryDom, { steps: this.steps, result: 'elements' });
    try { return await handle.evaluate(callback, argument); }
    finally { await handle.dispose(); }
  }

  async isVisible() {
    if (await this.count() === 0) return false;
    return this.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return element.isConnected && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    });
  }

  async isEnabled() {
    return this.evaluate(element => !element.matches(':disabled')
      && !element.closest('[aria-disabled="true"]')
      && element.getAttribute('disableattr') !== 'true');
  }

  async waitFor({ state = 'visible', timeout = this.timeout } = {}) {
    if (!['visible', 'hidden', 'attached', 'detached'].includes(state)) throw new Error(`不支持的等待状态：${state}`);
    const deadline = Date.now() + timeout;
    do {
      const count = await this.count();
      if (state === 'detached' && count === 0) return;
      if (state === 'attached' && count === 1) return;
      if (state === 'hidden' && (count === 0 || !await this.isVisible())) return;
      if (state === 'visible' && count === 1 && await this.isVisible()) return;
      if (count > 1) throw new Error(`DOM 定位必须唯一，实际为 ${count} 个元素`);
      if (Date.now() >= deadline) break;
      await delay(75);
    } while (true);
    throw new Error(`等待元素 ${state} 超时（${timeout} ms）`);
  }

  async getAttribute(name) { return this.evaluate((element, attr) => element.getAttribute(attr), name); }
  async innerText() { return this.evaluate(element => element.innerText ?? element.textContent ?? ''); }
  async blur() { return this.evaluate(element => element.blur()); }

  async click() {
    await this.waitFor();
    if (!await this.isEnabled()) throw new Error('目标元素已禁用');
    return this.withElement(async (element, frame) => {
      // Scroll iframe ancestors first. All handles are obtained via protocol,
      // so even the top frame can have a legacy Set constructor.
      const ancestors = [];
      for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
        ancestors.push(await current.frameElement());
      }
      try {
        for (const ancestor of [...ancestors].reverse()) {
          await ancestor.evaluate(node => node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }));
        }
        await element.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
        const first = await element.boundingBox();
        await delay(60);
        const box = await element.boundingBox();
        if (!box || !first || box.width <= 0 || box.height <= 0
          || ['x', 'y', 'width', 'height'].some(key => Math.abs(first[key] - box[key]) > 1)) {
          throw new Error('目标元素不可见或仍在移动，未执行点击');
        }
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const receivesPointer = await element.evaluate(node => {
          const rect = node.getBoundingClientRect();
          const hit = node.ownerDocument.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return hit === node || node.contains(hit);
        });
        if (!receivesPointer) throw new Error('目标元素被遮挡，未执行点击');
        for (const ancestor of ancestors) {
          const parentBox = await ancestor.boundingBox();
          if (!parentBox) throw new Error('iframe 不可见，未执行点击');
          const unobscured = await ancestor.evaluate((node, point) => {
            const rect = node.getBoundingClientRect();
            const hit = node.ownerDocument.elementFromPoint(rect.x + point.dx, rect.y + point.dy);
            return hit === node || node.contains(hit);
          }, { dx: x - parentBox.x, dy: y - parentBox.y });
          if (!unobscured) throw new Error('iframe 被遮挡，未执行点击');
        }
        await this.page.mouse.click(x, y);
      } finally { for (const ancestor of ancestors) await ancestor.dispose(); }
    });
  }

  async fill(value) {
    if (typeof value !== 'string') throw new Error('fill 值必须是字符串');
    await this.waitFor();
    if (!await this.isEnabled()) throw new Error('输入框已禁用');
    await this.evaluate(element => {
      const textInput = element instanceof HTMLInputElement
        && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(element.type);
      if (!(textInput || element instanceof HTMLTextAreaElement || element.isContentEditable) || element.readOnly) {
        throw new Error('fill 仅支持可编辑的文本输入框、textarea 或 contenteditable');
      }
      element.focus();
      if (element.ownerDocument.activeElement !== element) throw new Error('输入框未取得焦点');
    });
    await this.page.keyboard.press('ControlOrMeta+A');
    if (value) await this.page.keyboard.insertText(value);
    else await this.page.keyboard.press('Backspace');
    // Chromium leaves a placeholder <br> after clearing contenteditable.
    const actual = await this.evaluate((element, clearing) => element.isContentEditable
      ? clearing && !element.textContent ? '' : element.innerText
      : element.value, value === '');
    if (actual !== value) throw new Error('输入后的值与预期不一致');
  }

  async isChecked() {
    return this.evaluate(element => {
      if (!(element instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(element.type)) {
        throw new Error('isChecked 仅支持原生 checkbox/radio');
      }
      return element.checked;
    });
  }

  async check() {
    if (!await this.isChecked()) await this.click();
    if (!await this.isChecked()) throw new Error('点击后未选中 checkbox/radio');
  }

  async selectOption({ index }) {
    if (!Number.isInteger(index) || index < 0) throw new Error('selectOption 需要有效选项 index');
    await this.waitFor();
    if (!await this.isEnabled()) throw new Error('下拉框已禁用');
    return this.evaluate((element, selectedIndex) => {
      if (!(element instanceof HTMLSelectElement)) throw new Error('selectOption 仅支持原生 select');
      const option = element.options[selectedIndex];
      if (!option || option.disabled || option.hidden || option.parentElement.matches('optgroup:disabled')) {
        throw new Error('指定下拉选项不可用');
      }
      element.selectedIndex = selectedIndex;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return [element.value];
    }, index);
  }
}
