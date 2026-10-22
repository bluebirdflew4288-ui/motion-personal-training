#!/usr/bin/env node
/* 一次性启动 v1 / v2 / v3 三个测试服务（脱离终端运行，关掉终端也不退出）。
   用法：node scripts/start-all.mjs
         node scripts/start-all.mjs --status    只看状态
         node scripts/start-all.mjs --stop      全部停止 */

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openSync, existsSync } from 'node:fs';

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVES = [
  { name: 'v1', dist: 'dist', port: 5199 },
  { name: 'v2', dist: 'dist-v2', port: 5299 },
  { name: 'v3', dist: 'dist-v3', port: 5399 },
];

const args = process.argv.slice(2);
const isStatus = args.includes('--status');
const isStop = args.includes('--stop');

function pidOnPort(port) {
  try {
    const out = execSync(`lsof -ti:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out ? Number(out.split('\n')[0]) : null;
  } catch {
    return null;
  }
}

function lanIp() {
  try {
    return execSync('ipconfig getifaddr en0', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '127.0.0.1';
  }
}

if (isStop) {
  for (const s of SERVES) {
    const pid = pidOnPort(s.port);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`已停止 ${s.name}（端口 ${s.port}，PID ${pid}）`);
      } catch (e) {
        console.log(`停止 ${s.name} 失败：${e.message}`);
      }
    } else {
      console.log(`${s.name}（端口 ${s.port}）本来就没在运行`);
    }
  }
  process.exit(0);
}

if (isStatus) {
  for (const s of SERVES) {
    const pid = pidOnPort(s.port);
    console.log(`${s.name.padEnd(3)} 端口 ${String(s.port).padEnd(5)} ${pid ? `运行中 PID ${pid}` : '未运行'}`);
  }
  process.exit(0);
}

const ip = lanIp();
let started = 0;

for (const s of SERVES) {
  if (pidOnPort(s.port)) {
    console.log(`${s.name} 已在运行（端口 ${s.port}），跳过`);
    continue;
  }
  const distPath = join(APP_DIR, s.dist);
  if (!existsSync(join(distPath, 'index.html'))) {
    console.log(`${s.name} 缺少构建产物 ${s.dist}/index.html，跳过`);
    continue;
  }
  const logPath = `/tmp/motion-${s.name}.log`;
  // 用 openSync 拿到真实 fd：createWriteStream 在 spawn 时 fd 可能还是 null
  const fd = openSync(logPath, 'a');
  const child = spawn(
    process.execPath,
    [join(APP_DIR, 'scripts/serve.mjs'), '--dist', s.dist, '--port', String(s.port)],
    { cwd: APP_DIR, detached: true, stdio: ['ignore', fd, fd] },
  );
  child.unref();
  console.log(`${s.name} 已启动（端口 ${s.port}，PID ${child.pid}，日志 ${logPath}）`);
  started++;
}

console.log('');
console.log(`局域网地址（手机连同一个 Wi-Fi）：`);
for (const s of SERVES) {
  if (existsSync(join(APP_DIR, s.dist, 'index.html'))) {
    console.log(`  ${s.name}:  http://${ip}:${s.port}/`);
  }
}
console.log('');
console.log(`停止全部：node scripts/start-all.mjs --stop`);
process.exit(0);
