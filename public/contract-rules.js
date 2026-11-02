/** Shared by the execution driver and the browser preview. */
export function contractText(projectName, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const description = date.year + '年信息化分摊费用';
  return {
    contractYear: date.year,
    contractName: description + String(projectName ?? '').trim(),
    description,
    signingDate: date.year + '-' + date.month + '-' + date.day,
  };
}
