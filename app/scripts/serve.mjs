#!/usr/bin/env node
/* MOTION 局域网预览服务。
   只暴露本项目的 dist 目录，不把 Workspace 当作网站根目录。
   用法：
     node scripts/serve.mjs [--port 5199] [--dist dist]
   停止：Ctrl+C（或 kill 该进程） */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(getArg('port', process.env.PORT || 5199));
const APP_DIR = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '');
const rawDist = getArg('dist', process.env.MOTION_OUT_DIR || 'dist-web');
const DIST = isAbsolute(rawDist) ? resolve(rawDist) : resolve(APP_DIR, rawDist);
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

/** 畸形百分号编码（如 /%ZZ）的哨兵。decodeURIComponent 会抛 URIError */
const BAD_PATH = Symbol('bad-url-path');

/** 只允许访问 DIST 内的文件 */
function safeResolve(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    // 单个畸形 URL 绝不能抛出未捕获 URIError 让整个预览服务退出（item 6）
    return BAD_PATH;
  }
  // 拒绝 NUL 等控制字符，避免底层文件 API 抛错
  if (decoded.includes('\0')) return BAD_PATH;
  const target = normalize(join(DIST, decoded));
  if (!target.startsWith(DIST + sep) && target !== DIST) return null;
  return target;
}

/**
 * 把文件流接到响应：**读取流错误不得终止进程**（item 6）。
 *
 * 关键：等文件真正 open 成功后才写 200 头。这样「打开失败」（如无读权限）
 * 能在头发送前返回干净的 500；已开始传输后出错才只能销毁该响应，
 * 两者都只影响这一个请求，进程与健康检查不受影响。
 */
function streamFile(res, filePath, headers) {
  const stream = createReadStream(filePath);
  let opened = false;
  stream.once('open', () => {
    opened = true;
    if (!res.headersSent) res.writeHead(200, headers);
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!opened && !res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('读取文件失败');
    } else {
      res.destroy();
    }
  });
}

function handleRequest(req, res) {
  const urlPath = (req.url ?? '/').split('?')[0];

  if (urlPath === '/__health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, root: DIST, appRoot: APP_ROOT, port: PORT }));
    return;
  }

  let filePath = safeResolve(urlPath);
  if (filePath === BAD_PATH) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (!filePath) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  let isDir = false;
  try {
    isDir = existsSync(filePath) && statSync(filePath).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    filePath = join(filePath, 'index.html');
  }

  if (!existsSync(filePath)) {
    // SPA 回退：仅对无扩展名的导航请求返回 index.html
    if (!extname(urlPath)) {
      streamFile(res, INDEX, {
        'content-type': MIME['.html'],
        'cache-control': 'no-cache',
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const isHashed = /-[a-z0-9]{8,}\./i.test(filePath);
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    // 允许 SW 在局域网 HTTP 下也工作？——不设置任何降低安全性的头
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  streamFile(res, filePath, headers);
}

const server = createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch {
    // 兜底：任何同步异常只让当前请求失败，进程继续服务健康检查
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    } else {
      res.destroy();
    }
  }
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
