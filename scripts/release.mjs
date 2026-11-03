import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const publicDocs = new Set(['docs/测试与发布.md', 'docs/项目技术说明.md', 'docs/oa-connection.md',
  'docs/project-runtime-blueprint.svg', 'docs/project-runtime-blueprint.png']);

export function buildRelease({ root = process.cwd(), outputDir = path.join(root, 'output/releases'), sha, runUrl = '' } = {}) {
  sha ??= git(root, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(sha) || git(root, 'rev-parse', `${sha}^{commit}`) !== sha) throw new Error('发布必须指定完整、有效的 Git commit SHA');
  const pkg = JSON.parse(git(root, 'show', `${sha}:package.json`));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pkg.name) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(pkg.version)) throw new Error('包名称或版本号无效');
  const tracked = git(root, '-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', sha).split('\n');
  const roots = new Set(['README.md', 'AGENTS.md', 'package.json', 'package-lock.json', '启动工具.cmd', 'config/oa.example.json']);
  const files = tracked.filter(file => roots.has(file) || publicDocs.has(file) || /^(src|public|tests|scripts)\//.test(file));
  for (const required of ['README.md', 'package.json', 'package-lock.json', '启动工具.cmd', 'config/oa.example.json', 'src/server.mjs', 'public/index.html']) {
    if (!files.includes(required)) throw new Error(`发布包缺少 ${required}`);
  }
  const tag = `v${pkg.version}-${sha.slice(0, 12)}`;
  const base = `${pkg.name}-${pkg.version}-${sha.slice(0, 12)}-windows`;
  outputDir = path.resolve(outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const archive = path.join(outputDir, `${base}.zip`);
  execFileSync('git', ['archive', '--format=zip', `--prefix=${pkg.name}/`, `--output=${archive}`, sha, '--', ...files], { cwd: root });
  const archiveHash = digest(fs.readFileSync(archive));
  const checksum = `${archive}.sha256`;
  fs.writeFileSync(checksum, `${archiveHash}  ${path.basename(archive)}\n`);
  const manifest = path.join(outputDir, `${base}.json`);
  const build = { name: pkg.name, version: pkg.version, sha, tag, runUrl, nodeVersions: [22, 24], archive: path.basename(archive), sha256: archiveHash, files };
  fs.writeFileSync(manifest, JSON.stringify(build, null, 2) + '\n');
  return { ...build, assets: [archive, checksum, manifest] };
}

export async function publishRelease(build, client) {
  const names = build.assets.map(file => path.basename(file));
  let release = await client.getRelease(build.tag);
  if (release) {
    const tagSha = await client.getTagSha(build.tag);
    if ((tagSha && tagSha !== build.sha) || (!tagSha && !release.draft)
        || (release.draft && release.target_commitish !== build.sha)) throw new Error('已有发布或标签指向不同提交，停止发布');
    if (!release.draft) {
      if (!names.every(name => release.assets.some(asset => asset.name === name))) throw new Error('已有正式发布缺少下载文件，需要核查');
      return release;
    }
  } else {
    release = await client.createRelease({ tag_name: build.tag, target_commitish: build.sha,
      name: `RPA ${build.version} (${build.sha.slice(0, 12)})`, draft: true, prerelease: false,
      body: `自动测试通过后发布。\n\n提交：\`${build.sha}\`\n\nWindows / Node.js 22、24 全量测试通过。\n\n[测试与发布记录](${build.runUrl})\n\n下载 ZIP，解压后双击“启动工具.cmd”。需要 Node.js 22 及以上与 Chrome 或 Edge。升级时保留原有 .local 配置和执行历史。\n\nZIP 的 SHA-256：\`${build.sha256}\`\n\n自动测试使用虚构数据和本机模拟页面；真实 ITSM 验收按项目规则执行。` });
  }
  for (const file of build.assets) {
    const bytes = fs.readFileSync(file);
    const name = path.basename(file);
    const existing = release.assets.find(asset => asset.name === name);
    if (existing) await client.deleteAsset(existing.id);
    const uploaded = await client.uploadAsset(release, name, bytes);
    if (uploaded.size !== bytes.length || (uploaded.digest && uploaded.digest !== `sha256:${digest(bytes)}`)) throw new Error(`上传文件校验失败：${name}`);
  }
  const published = await client.publishRelease(release.id);
  if (await client.getTagSha(build.tag) !== build.sha) throw new Error('发布标签未指向测试通过的提交');
  return published;
}

export function githubClient({ token, repository, fetchImpl = fetch }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('缺少 GitHub 发布身份或仓库信息');
  const api = `https://api.github.com/repos/${repository}`;
  async function request(method, route, body, { missing = false, binary = false } = {}) {
    const url = route.startsWith('https://') ? route : api + route;
    const allowedUpload = url.startsWith(`https://uploads.github.com/repos/${repository}/releases/`);
    if (!url.startsWith(api + '/') && !allowedUpload) throw new Error('无效的 GitHub 发布地址');
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }) },
      body: body === undefined ? undefined : binary ? body : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub 发布请求失败：${method} HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
    return response.status === 204 ? null : response.json();
  }
  return {
    getRelease: tag => request('GET', `/releases/tags/${encodeURIComponent(tag)}`, undefined, { missing: true }),
    async getTagSha(tag) {
      const ref = await request('GET', `/git/ref/tags/${encodeURIComponent(tag)}`, undefined, { missing: true });
      if (!ref) return null;
      if (ref.object.type === 'commit') return ref.object.sha;
      const annotated = await request('GET', `/git/tags/${ref.object.sha}`);
      return annotated.object.type === 'commit' ? annotated.object.sha : null;
    },
    createRelease: body => request('POST', '/releases', body),
    deleteAsset: id => request('DELETE', `/releases/assets/${id}`),
    uploadAsset: (release, name, bytes) => request('POST', release.upload_url.replace(/\{.*$/, '') + `?name=${encodeURIComponent(name)}`, bytes, { binary: true }),
    publishRelease: id => request('PATCH', `/releases/${id}`, { draft: false, make_latest: 'true' })
  };
}

async function main() {
  if (process.argv[2] !== 'publish') throw new Error('使用 node scripts/release.mjs publish');
  if (process.env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)) throw new Error('自动发布仅允许 main 分支测试成功后的流水线执行');
  const sha = process.env.GITHUB_SHA;
  if (git(process.cwd(), 'rev-parse', 'HEAD') !== sha) throw new Error('当前检出与测试提交不一致');
  const build = buildRelease({ sha, runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` });
  const release = await publishRelease(build, githubClient({ token: process.env.GH_TOKEN, repository: process.env.GITHUB_REPOSITORY }));
  console.log(`发布成功：${release.html_url}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 自动发布\n\n[下载 ${build.tag}](${release.html_url})\n\n提交：\`${sha}\`\n\nSHA-256：\`${build.sha256}\`\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
