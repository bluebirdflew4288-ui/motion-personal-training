#!/usr/bin/env node
/* F11：删除成功音效的**源码生成依据**（原创、离线、无第三方素材）。
   ── 为什么用脚本合成而不是放一个来路不明的音频文件 ─────────────
   1. 版权可追溯：波形完全由本文件的公式算出，不采样苹果/第三方系统音效；
   2. 可复现：同一份源码在任何机器上生成**逐字节相同**的 WAV（无随机数、
      无时间戳、无元数据块），因此"文件哈希"本身就能证明产物来源；
   3. 权威同源：一次生成写入两个目标（Web 构建资产 + Android res/raw），
      两份字节完全一致，用 SHA256 即可核验，不需要人工比对；
   4. 离线：产物是普通 PCM WAV，运行时不联网、不新增依赖。

   生成规则（全部显式、可读、可改）：
     · 采样率 44100Hz，单声道，16-bit 有符号 PCM；
     · 两段短音，音高下行（B5 → F#5），听感上表示"已移除"而不是"已完成"；
     · 每段 = 基频 + 一个快速衰减的二次谐波（轻微木质质感，不是纯正弦蜂鸣）；
     · 3ms 线性起音避免咔哒，指数衰减，末段 20ms 余弦淡出到 0；
     · 峰值归一到 0.42，短、轻、不抢注意力。

   用法：node scripts/gen-delete-sound.mjs [--check]
     --check 只比较现有产物是否与源码公式一致，不写文件（供测试与审查用）。
*/

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Web 构建资产：放在 public/ 下，Vite 会**原样复制**到 dist-web 与 dist-android。
 * 刻意不用 `import x from '*.wav'`：DOM 回归等测试工具用 esbuild 直接 bundle 源码，
 * 没有 wav loader，引入后者会把测试链路一起炸掉。运行时用 document.baseURI 拼绝对 URL
 * （应用是 hash 路由，pathname 不会变化，所以 baseURI 恒为应用根）。
 */
export const WEB_ASSET = join(APP_DIR, 'public/audio/delete-success.wav');
/** Android 原生播放资产（SoundPool 从 res/raw 读取同一份字节） */
export const NATIVE_ASSET = join(APP_DIR, 'android/app/src/main/res/raw/delete_success.wav');

export const SAMPLE_RATE = 44100;
export const DURATION_MS = 120;
/** 峰值（相对满刻度）；小音量是有意的产品选择：轻短反馈，不喧宾夺主 */
export const PEAK = 0.42;
const ATTACK_MS = 3;
const FADE_OUT_MS = 20;

/** 两段短音：起始毫秒 / 时长 / 频率 / 谐波强度 / 衰减时间常数 */
const NOTES = [
  { startMs: 0, durMs: 70, freq: 987.77, harmonic: 0.22, tauMs: 42 },
  { startMs: 52, durMs: 68, freq: 739.99, harmonic: 0.18, tauMs: 38 },
];

const SAMPLE_COUNT = Math.round((SAMPLE_RATE * DURATION_MS) / 1000);

function noteSample(note, tMs) {
  const local = tMs - note.startMs;
  if (local < 0 || local > note.durMs) return 0;
  const t = local / 1000;
  const attack = Math.min(1, local / ATTACK_MS);
  const tail = local > note.durMs - FADE_OUT_MS
    ? 0.5 * (1 + Math.cos(Math.PI * ((local - (note.durMs - FADE_OUT_MS)) / FADE_OUT_MS)))
    : 1;
  const decay = Math.exp(-local / note.tauMs);
  const fundamental = Math.sin(2 * Math.PI * note.freq * t);
  const second = Math.sin(2 * Math.PI * note.freq * 2 * t);
  return (fundamental + note.harmonic * second) * attack * tail * decay;
}

/** 计算整段波形（浮点，未归一） */
export function renderSamples() {
  const raw = new Array(SAMPLE_COUNT).fill(0);
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const tMs = (i * 1000) / SAMPLE_RATE;
    let v = 0;
    for (const note of NOTES) v += noteSample(note, tMs);
    raw[i] = v;
  }
  let max = 0;
  for (const v of raw) max = Math.max(max, Math.abs(v));
  const gain = max > 0 ? PEAK / max : 0;
  return raw.map((v) => v * gain);
}

/** 由浮点波形构造 44 字节头 + PCM 的 WAV 字节（无任何附加元数据块） */
export function renderWav() {
  const samples = renderSamples();
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function main() {
  const check = process.argv.includes('--check');
  const bytes = renderWav();
  const hash = sha256(bytes);
  const targets = [WEB_ASSET, NATIVE_ASSET];
  let mismatch = false;
  for (const target of targets) {
    const exists = existsSync(target);
    const same = exists && sha256(readFileSync(target)) === hash;
    if (!check) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    if (!same) mismatch = true;
    console.log(`${check ? (same ? 'OK  ' : 'DIFF') : 'WROTE'} ${target}`);
    console.log(`      bytes=${bytes.length} sha256=${hash}`);
  }
  console.log(`\nsampleRate=${SAMPLE_RATE} durationMs=${DURATION_MS} peak=${PEAK} sourceSha256=${hash}`);
  if (check && mismatch) {
    console.error('\n产物与源码公式不一致：请运行 node scripts/gen-delete-sound.mjs 重新生成（不要手改 wav 字节）');
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
