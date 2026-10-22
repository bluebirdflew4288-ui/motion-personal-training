/* 构建后生成 Service Worker：把 dist 里的全部静态资源写进预缓存清单。
   不使用 Workbox，缓存范围完全可控，且离线逻辑可审查。
   · 导航请求：network-first，失败回退 index.html
   · 静态资源：cache-first（文件名带 hash，可长期缓存）
   · 数据库升级不在 SW 里做，避免打断进行中的训练 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 路径里含中文/空格时必须先解码 file URL，否则 readdir 会拿到百分号编码路径
const OUT_DIR = process.env.MOTION_OUT_DIR || 'dist-v3';
const DIST = fileURLToPath(new URL(`../${OUT_DIR}/`, import.meta.url));
const VERSION = process.env.SW_VERSION || String(Date.now());

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || name === '.DS_Store') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(relative(DIST, full).split(sep).join('/'));
  }
  return out;
}

const files = walk(DIST).filter((f) => f !== 'sw.js');
const precache = ['.', ...files.map((f) => `./${f}`)];

const sw = `/* MOTION service worker — 由 scripts/build-sw.mjs 生成，请勿手改 */
const CACHE = 'motion-v${VERSION}';
const PRECACHE = ${JSON.stringify(precache, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个添加：单个资源失败不会让整个安装失败
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined),
        ),
      );
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put('./index.html', fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => undefined);
        return res;
      } catch {
        return (await cache.match('./index.html')) || Response.error();
      }
    })(),
  );
});
`;

writeFileSync(join(DIST, 'sw.js'), sw, 'utf8');
console.log(`sw.js written · ${precache.length} 个预缓存条目 · cache=motion-v${VERSION}`);
