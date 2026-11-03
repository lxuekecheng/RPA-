import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildRelease, publishRelease, githubClient } from '../scripts/release.mjs';
import { requireCompleteTests } from '../scripts/verify-suite.mjs';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-release-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixtureRepo(t) {
  const root = scratch(t);
  const files = { 'package.json': JSON.stringify({ name: 'fixture-rpa', version: '0.1.0' }), 'package-lock.json': '{}',
    'README.md': 'fixture', '启动工具.cmd': '@echo off', 'config/oa.example.json': '{}', 'config/oa.local.json': 'private-config',
    'src/server.mjs': 'export const tested = true;\n', 'public/index.html': '<p>fixture</p>', 'tests/example.test.mjs': '// fixture',
    'scripts/example.mjs': '// fixture', '.local/history.jsonl': 'private-history', 'node_modules/private.txt': 'dependency',
    '.env': 'PRIVATE=fixture', 'docs/observed-oa.md': 'private-acceptance' };
  for (const [name, content] of Object.entries(files)) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'tested fixture');
  return { root, sha: git('rev-parse', 'HEAD') };
}

test('发布 ZIP 只包含指定提交的程序与示例配置，排除真实配置、历史、会话及未提交改动', t => {
  const { root, sha } = fixtureRepo(t);
  fs.writeFileSync(path.join(root, 'src/server.mjs'), 'untested edit');
  const build = buildRelease({ root, sha, runUrl: 'https://example.invalid/ci' });
  const inspected = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String.raw`
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($env:RPA_TEST_ARCHIVE)
    try {
      $names = @($archive.Entries | ForEach-Object { $_.FullName })
      $entry = $archive.GetEntry('fixture-rpa/src/server.mjs')
      if ($null -eq $entry) { throw 'Missing committed source in ZIP' }
      $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8)
      try { $source = $reader.ReadToEnd() } finally { $reader.Dispose() }
      [pscustomobject]@{ names = $names; source = $source } | ConvertTo-Json -Compress
    } finally { $archive.Dispose() }
  `], { encoding: 'utf8', env: { ...process.env, RPA_TEST_ARCHIVE: build.assets[0] } }));
  const entries = inspected.names.join('\n');
  assert.match(entries, /fixture-rpa\/src\/server.mjs/);
  assert.match(entries, /fixture-rpa\/config\/oa.example.json/);
  assert.ok(inspected.names.includes('fixture-rpa/启动工具.cmd'));
  assert.doesNotMatch(entries, /\.local|oa.local.json|node_modules|\.env|observed-oa/);
  assert.equal(inspected.source, 'export const tested = true;\n');
  const actualHash = createHash('sha256').update(fs.readFileSync(build.assets[0])).digest('hex');
  assert.equal(build.sha256, actualHash);
  assert.match(fs.readFileSync(build.assets[1], 'utf8'), new RegExp(`^${actualHash}  `));
  assert.equal(JSON.parse(fs.readFileSync(build.assets[2], 'utf8')).sha, sha);
});

const report = changes => Object.entries({ tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...changes }).map(([name, value]) => `# ${name} ${value}`).join('\n');
test('测试门槛接受完整执行且全部通过的报告', () => { assert.equal(requireCompleteTests(report(), 0).pass, 3); });
test('零用例、跳过、待办、取消、失败、报告缺失或进程异常均阻止发布前测试通过', () => {
  for (const changes of [{ tests: 0, pass: 0 }, { skipped: 1, pass: 2 }, { todo: 1, pass: 2 }, { cancelled: 1, pass: 2 }, { fail: 1, pass: 2 }]) {
    assert.throws(() => requireCompleteTests(report(changes), 0), /未完整通过/);
  }
  assert.throws(() => requireCompleteTests(report(), 1), /未完整通过/);
  assert.throws(() => requireCompleteTests('TAP version 13', 0), /缺少/);
});

function releaseFixture(t, { existing = null, tagSha = null, failUpload = false } = {}) {
  const file = path.join(scratch(t), 'fixture.zip'); fs.writeFileSync(file, 'fixture archive');
  const build = { version: '0.1.0', sha: 'a'.repeat(40), tag: 'v0.1.0-aaaaaaaaaaaa', runUrl: 'https://example.invalid/ci', sha256: 'fixture', assets: [file] };
  const calls = [];
  let release = existing;
  const client = {
    async getRelease() { return release; },
    async getTagSha() { return tagSha; },
    async createRelease(body) { calls.push(['create', body]); release = { ...body, id: 1, assets: [], html_url: 'https://example.invalid/release' }; return release; },
    async deleteAsset(id) { calls.push(['delete', id]); release.assets = release.assets.filter(asset => asset.id !== id); },
    async uploadAsset(_release, name, bytes) { calls.push(['upload', name]); if (failUpload) throw new Error('upload failed'); const asset = { id: 2, name, size: bytes.length }; release.assets.push(asset); return asset; },
    async publishRelease() { calls.push(['publish']); release.draft = false; tagSha = build.sha; return release; }
  };
  return { build, client, calls, get release() { return release; } };
}

test('先创建草稿并上传文件，全部成功后才公开 Release，标签对应已测试提交', async t => {
  const f = releaseFixture(t);
  const result = await publishRelease(f.build, f.client);
  assert.deepEqual(f.calls.map(call => call[0]), ['create', 'upload', 'publish']);
  assert.equal(f.calls[0][1].target_commitish, f.build.sha);
  assert.equal(f.calls[0][1].draft, true);
  assert.equal(result.draft, false);
});
test('上传失败时保留发布草稿，不会把不完整的下载包公开', async t => {
  const f = releaseFixture(t, { failUpload: true });
  await assert.rejects(publishRelease(f.build, f.client), /upload failed/);
  assert.equal(f.release.draft, true);
  assert.ok(!f.calls.some(call => call[0] === 'publish'));
});
test('已有标签指向其他提交时立即停止，不替换或公开文件', async t => {
  const f = releaseFixture(t, { existing: { draft: true, target_commitish: 'a'.repeat(40), assets: [] }, tagSha: 'b'.repeat(40) });
  await assert.rejects(publishRelease(f.build, f.client), /不同提交/);
  assert.deepEqual(f.calls, []);
});
test('重跑已成功发布的提交复用原 Release，不覆盖正式下载文件', async t => {
  const existing = { draft: false, assets: [{ name: 'fixture.zip' }] };
  const f = releaseFixture(t, { existing, tagSha: 'a'.repeat(40) });
  assert.equal(await publishRelease(f.build, f.client), existing);
  assert.deepEqual(f.calls, []);
});
test('重跑未完成草稿时只替换草稿附件，上传完成后发布', async t => {
  const f = releaseFixture(t, { existing: { id: 1, draft: true, target_commitish: 'a'.repeat(40), assets: [{ id: 9, name: 'fixture.zip' }] } });
  await publishRelease(f.build, f.client);
  assert.deepEqual(f.calls.map(call => call[0]), ['delete', 'upload', 'publish']);
});
test('GitHub 权限错误不能伪装成没有旧发布，404 才按不存在处理', async () => {
  const client = githubClient({ token: 'fixture-token', repository: 'fixture/repo', fetchImpl: async () => new Response('Forbidden', { status: 403 }) });
  await assert.rejects(client.getRelease('v0.1.0'), /HTTP 403/);
  const missing = githubClient({ token: 'fixture-token', repository: 'fixture/repo', fetchImpl: async () => new Response('', { status: 404 }) });
  assert.equal(await missing.getRelease('v0.1.0'), null);
});
