import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export function requireCompleteTests(report, exitCode) {
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...report.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
    if (!matches.length) throw new Error(`测试报告缺少 ${name}，不能确认完整执行`);
    counts[name] = Number(matches.at(-1)[1]);
  }
  if (exitCode !== 0 || counts.tests === 0 || counts.pass !== counts.tests
      || counts.fail || counts.cancelled || counts.skipped || counts.todo) {
    throw new Error(`测试未完整通过：${JSON.stringify(counts)}；exit=${exitCode}`);
  }
  return counts;
}

async function main() {
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let report = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { report += chunk; process.stdout.write(chunk); });
  const [code] = await once(child, 'close');
  requireCompleteTests(report, code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
