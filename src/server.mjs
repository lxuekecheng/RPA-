import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { RpaService } from './service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 26 * 1024 * 1024;

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('文件超过上传限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求不是有效 JSON'); }
}

export function createApp({ service = new RpaService({ root }), token = randomBytes(32).toString('hex') } = {}) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      const expectedHost = `127.0.0.1:${server.address()?.port}`;
      if (request.headers.host !== expectedHost) return json(403, { error: '仅接受本机地址请求' });
      const pathname = new URL(request.url, `http://${expectedHost}`).pathname;
      if (pathname.startsWith('/api/')) {
        const supplied = Buffer.from(String(request.headers['x-local-token'] || ''));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(403, { error: '请从本机工具首页重新打开页面' });
        const origin = request.headers.origin;
        if (origin && origin !== `http://${expectedHost}`) return json(403, { error: '请求来源不匹配' });
        if (request.method === 'GET' && pathname === '/api/status') return json(200, service.status());
        if (request.method === 'GET' && pathname === '/api/preview') return json(200, service.getPreview());
        if (request.method !== 'POST') return json(404, { error: '接口不存在' });
        const body = await readBody(request);
        if (pathname === '/api/oa/scan') return json(200, await service.scan(body));
        if (pathname === '/api/config') return json(200, service.saveConfig(body));
        if (pathname === '/api/browser/open') return json(200, await service.openBrowser());
        if (pathname === '/api/run') return json(200, service.start(body));
        if (pathname === '/api/run/stop') return json(200, service.stop());
        return json(404, { error: '接口不存在' });
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/contract-rules.js': ['contract-rules.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (request.method !== 'GET' || !assets[pathname]) return json(404, { error: '页面不存在' });
      const [filename, type] = assets[pathname];
      let content = fs.readFileSync(path.join(root, 'public', filename), 'utf8');
      if (pathname === '/') content = content.replaceAll('__APP_TOKEN__', token);
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      response.end(content);
    } catch (error) { json(400, { error: error.message, ...(error.sheetNames ? { sheetNames: error.sheetNames } : {}) }); }
  });
  return { server, service };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, service } = createApp();
  const openHome = () => {
    if (!process.argv.includes('--open') || process.platform !== 'win32') return;
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:17326'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log('请手动打开 http://127.0.0.1:17326'));
    child.unref();
  };
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '工具已经运行，请打开 http://127.0.0.1:17326' : error.message);
    if (error.code === 'EADDRINUSE') openHome();
    process.exitCode = 1;
  });
  server.listen(17326, '127.0.0.1', () => {
    console.log('预算转合同工具：http://127.0.0.1:17326\n按 Ctrl+C 停止服务。');
    openHome();
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    service.stop();
    if (service.runPromise) await service.runPromise;
    await service.driver.close();
    server.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
