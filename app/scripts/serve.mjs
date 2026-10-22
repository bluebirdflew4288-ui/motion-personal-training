#!/usr/bin/env node
/* MOTION 局域网预览服务。
   只暴露本项目的 dist 目录，不把 Workspace 当作网站根目录。
   用法：
     node scripts/serve.mjs [--port 5199] [--dist dist]
   停止：Ctrl+C（或 kill 该进程） */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(getArg('port', process.env.PORT || 5199));
const APP_DIR = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '');
const DIST = resolve(APP_DIR, getArg('dist', 'dist'));
const APP_ROOT = APP_DIR;
const INDEX = join(DIST, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

if (!existsSync(INDEX)) {
  console.error(`\n[serve] 找不到 ${INDEX}\n请先运行：npm run build\n`);
  process.exit(1);
}

/** 只允许访问 DIST 内的文件 */
function safeResolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = normalize(join(DIST, decoded));
  if (!target.startsWith(DIST + sep) && target !== DIST) return null;
  return target;
}

const server = createServer((req, res) => {
  const urlPath = (req.url ?? '/').split('?')[0];

  if (urlPath === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, root: DIST, appRoot: APP_ROOT, port: PORT }));
    return;
  }

  let filePath = safeResolve(urlPath);
  if (!filePath) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html');
  }

  if (!existsSync(filePath)) {
    // SPA 回退：仅对无扩展名的导航请求返回 index.html
    if (!extname(urlPath)) {
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'cache-control': 'no-cache',
      });
      createReadStream(INDEX).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const isHashed = /-[a-z0-9]{8,}\./i.test(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    // 允许 SW 在局域网 HTTP 下也工作？——不设置任何降低安全性的头
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
});

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  const lan = addrs[0]?.address;
  console.log('\n  MOTION 预览服务已启动');
  console.log(`  静态根目录 : ${DIST}`);
  console.log(`  本机       : http://localhost:${PORT}/`);
  if (lan) console.log(`  局域网     : http://${lan}:${PORT}/`);
  console.log(`  健康检查   : http://${lan ? lan + ':' + PORT : 'localhost:' + PORT}/__health`);
  console.log('\n  Ctrl+C 停止服务\n');
});

process.on('SIGINT', () => {
  console.log('\n[serve] 正在停止…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
