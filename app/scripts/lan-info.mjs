#!/usr/bin/env node
/* 输出当前局域网测试地址 + 生成二维码，供 README / 手机测试使用。
   用法：node scripts/lan-info.mjs [port] */

import { networkInterfaces } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const port = Number(process.argv[2] || 5199);
const ips = [];
for (const [iface, list] of Object.entries(networkInterfaces())) {
  for (const ni of list ?? []) {
    if (ni.family === 'IPv4' && !ni.internal) ips.push({ iface, address: ni.address });
  }
}

// 排除常见的虚拟网卡地址段（Clash / VPN 等）
const real = ips.filter((i) => !/^198\.(18|19)\./.test(i.address) && !i.address.startsWith('100.'));
const target = real[0] ?? ips[0];

if (!target) {
  console.error('找不到局域网 IPv4 地址；请确认电脑已连接 Wi-Fi。');
  process.exit(1);
}

const url = `http://${target.address}:${port}/`;
const qrPath = fileURLToPath(new URL('../public/qr-lan.png', import.meta.url));
await QRCode.toFile(qrPath, url, { width: 512, margin: 2, color: { dark: '#16130e', light: '#f4efe2' } });

writeFileSync(
  fileURLToPath(new URL('../LAN-INFO.txt', import.meta.url)),
  `MOTION 手机测试地址\n端口: ${port}\n地址: ${url}\n接口: ${target.iface}\n生成时间: ${new Date().toLocaleString('zh-CN')}\n`,
  'utf8',
);

console.log(`\n  局域网测试地址：${url}`);
console.log(`  网卡           ：${target.iface}`);
console.log(`  二维码         ：public/qr-lan.png\n`);
if (real.length > 1) {
  console.log('  其它可用地址：');
  for (const i of real.slice(1)) console.log(`    http://${i.address}:${port}/  (${i.iface})`);
  console.log('');
}
