/* 教练识图压缩与计划草稿提取（阶段 2）。
   硬约束：
   · 长边 <= 1536px；
   · 经 Canvas 重编码（及 JPEG APP1 EXIF 段清理）剥离 EXIF 等隐私元数据；
   · 多档质量递减 + 二次降采样保证最终体积 <= 1MB（1_048_576 字节），仍超限则显式阻断；
   · 识图结果先生成可自由修改的 CoachPlanDraft，经用户确认后再落盘。 */

import type { CoachPlanDraft, CoachPlanDraftDay, CoachPlanDraftExercise, CoachStoredAttachment } from './coachStorage';

export const COACH_MAX_IMAGE_EDGE = 1536;
export const COACH_MAX_IMAGE_BYTES = 1_048_576;
export const COACH_MAX_VIDEO_BYTES = 15 * 1024 * 1024;

const QUALITY_STEPS = [0.84, 0.72, 0.6, 0.48, 0.36] as const;
const SCALE_STEPS = [1, 0.8, 0.65, 0.5] as const;

export function estimateBase64Bytes(base64OrDataUrl: string): number {
  const comma = base64OrDataUrl.indexOf(',');
  const b64 = (comma >= 0 ? base64OrDataUrl.slice(comma + 1) : base64OrDataUrl).trim();
  if (!b64) return 0;
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

export function decodeBase64ToBytes(base64OrDataUrl: string): Uint8Array {
  const b64 = stripDataUrlPrefix(base64OrDataUrl);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

/**
 * 剥离 JPEG 字节流中的 APP1（0xFF 0xE1，包含 EXIF / XMP）及 COM（0xFF 0xFE）段。
 */
export function stripExifFromJpegBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return bytes;
  }
  const out: number[] = [0xff, 0xd8];
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      for (let k = offset; k < bytes.length; k += 1) out.push(bytes[k]);
      break;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      for (let k = offset; k < bytes.length; k += 1) out.push(bytes[k]);
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(bytes[offset], marker);
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) break;
    const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segLen < 2 || offset + 2 + segLen > bytes.length) {
      for (let k = offset; k < bytes.length; k += 1) out.push(bytes[k]);
      break;
    }
    // 跳过 APP1 (0xE1 EXIF/XMP)、APP2 (0xE2 ICC/FlashPix) 与 COM (0xFE)
    if (marker === 0xe1 || marker === 0xe2 || marker === 0xfe) {
      offset += 2 + segLen;
      continue;
    }
    for (let k = 0; k < 2 + segLen; k += 1) {
      out.push(bytes[offset + k]);
    }
    offset += 2 + segLen;
  }
  return new Uint8Array(out);
}

/** 检查字节流或 dataUrl 是否仍残留 APP1/EXIF 段或 Exif ASCII 标记 */
export function containsExifMetadata(input: Uint8Array | string): boolean {
  const bytes = typeof input === 'string' ? decodeBase64ToBytes(input) : input;
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (marker === 0xe1) return true;
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  }
  const needle = [0x45, 0x78, 0x69, 0x66, 0x00]; // "Exif\0"
  for (let i = 0; i <= bytes.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export interface ImageEncodeParams {
  width: number;
  height: number;
  quality: number;
}

export type CoachImageEncoder = (params: ImageEncodeParams) => Promise<{
  mimeType: string;
  bytes: Uint8Array;
}>;

export interface CompressCoachImageOptions {
  maxEdge?: number;
  maxBytes?: number;
  name?: string;
  encoder?: CoachImageEncoder;
  naturalWidth?: number;
  naturalHeight?: number;
}

function fitDimensions(
  naturalWidth: number,
  naturalHeight: number,
  maxEdge: number,
  factor = 1,
): { width: number; height: number } {
  const safeW = Math.max(1, naturalWidth);
  const safeH = Math.max(1, naturalHeight);
  const baseScale = Math.min(1, maxEdge / Math.max(safeW, safeH)) * factor;
  return {
    width: Math.max(1, Math.round(safeW * baseScale)),
    height: Math.max(1, Math.round(safeH * baseScale)),
  };
}

/**
 * 统一编码迭代：保证长边 <= maxEdge、剥离 EXIF、体积 <= maxBytes；无法满足时显式抛错。
 */
export async function compressWithEncoder(
  naturalWidth: number,
  naturalHeight: number,
  encoder: CoachImageEncoder,
  opts?: { maxEdge?: number; maxBytes?: number; name?: string },
): Promise<CoachStoredAttachment> {
  const maxEdge = opts?.maxEdge ?? COACH_MAX_IMAGE_EDGE;
  const maxBytes = opts?.maxBytes ?? COACH_MAX_IMAGE_BYTES;

  for (const scaleFactor of SCALE_STEPS) {
    const { width, height } = fitDimensions(naturalWidth, naturalHeight, maxEdge, scaleFactor);
    for (const quality of QUALITY_STEPS) {
      const encoded = await encoder({ width, height, quality });
      const cleaned = encoded.mimeType.includes('jpeg') || encoded.mimeType.includes('jpg')
        ? stripExifFromJpegBytes(encoded.bytes)
        : encoded.bytes;
      if (cleaned.byteLength <= maxBytes && Math.max(width, height) <= maxEdge) {
        const b64 = encodeBytesToBase64(cleaned);
        return {
          id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: opts?.name || '已选图片.jpg',
          mimeType: encoded.mimeType || 'image/jpeg',
          dataBase64: b64,
          width,
          height,
          sizeBytes: cleaned.byteLength,
          exifStripped: true,
        };
      }
    }
  }

  throw new Error(`图片压缩后仍超过 ${Math.round(maxBytes / 1024)}KB 限制，请裁剪后重试`);
}

export async function compressCoachImage(
  file: File,
  opts?: CompressCoachImageOptions,
): Promise<CoachStoredAttachment> {
  const maxEdge = opts?.maxEdge ?? COACH_MAX_IMAGE_EDGE;
  const maxBytes = opts?.maxBytes ?? COACH_MAX_IMAGE_BYTES;

  if (opts?.encoder && opts.naturalWidth && opts.naturalHeight) {
    return compressWithEncoder(opts.naturalWidth, opts.naturalHeight, opts.encoder, {
      maxEdge,
      maxBytes,
      name: opts.name ?? file.name,
    });
  }

  const rawUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解码失败，请确认图片格式完整'));
      el.src = rawUrl;
    });
    const natW = Math.max(1, img.naturalWidth || opts?.naturalWidth || 1);
    const natH = Math.max(1, img.naturalHeight || opts?.naturalHeight || 1);

    const canvasEncoder: CoachImageEncoder = async ({ width, height, quality }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D 上下文不可用，无法重编码压缩图片');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      return {
        mimeType: 'image/jpeg',
        bytes: decodeBase64ToBytes(dataUrl),
      };
    };

    return await compressWithEncoder(natW, natH, opts?.encoder ?? canvasEncoder, {
      maxEdge,
      maxBytes,
      name: opts?.name ?? file.name,
    });
  } finally {
    URL.revokeObjectURL(rawUrl);
  }
}

export function attachmentToDataUrl(att: Pick<CoachStoredAttachment, 'mimeType' | 'dataBase64'>): string {
  if (att.dataBase64.startsWith('data:')) return att.dataBase64;
  return `data:${att.mimeType || 'image/jpeg'};base64,${att.dataBase64}`;
}

function parseExerciseLine(line: string): CoachPlanDraftExercise | null {
  const clean = line.replace(/^[\s*\-•\d.、]+/, '').trim();
  if (!clean) return null;
  // 示例：杠铃卧推 4组 8-12次 60kg / Dumbbell Fly 3x12 12.5kg / 引体向上 4x10
  const m = clean.match(
    /^([A-Za-z0-9\u4e00-\u9fa5（）()+\s/-]{2,28}?)\s+(\d+)\s*[组xX×*]\s*(\d+)(?:\s*[-~至]\s*(\d+))?\s*次?(?:\s+([0-9.]+)\s*kg)?/i,
  );
  if (!m) return null;
  const name = m[1].trim();
  const sets = Math.min(20, Math.max(1, Number(m[2])));
  const repsMin = Math.min(100, Math.max(1, Number(m[3])));
  const repsMax = Math.min(100, Math.max(repsMin, Number(m[4] ?? m[3])));
  const weightKg = m[5] !== undefined ? Number(m[5]) : null;
  const isBodyweight = /引体|俯卧撑|双杠|悬垂举腿|徒手|自重/.test(name) && weightKg === null;
  return {
    name,
    kind: 'straight',
    sets,
    repsMin,
    repsMax,
    weightMode: isBodyweight ? 'bodyweight' : 'external',
    suggestedWeightKg: Number.isFinite(weightKg as number) ? (weightKg as number) : null,
  };
}

/**
 * 离线兜底/确定性识图草稿解析：根据图片附言（或默认示例模板）生成全字段可编辑草稿，
 * 在线模型模式下会优先使用真实视觉模型提取并映射到同一 CoachPlanDraft 结构。
 */
export function extractPlanDraftFromImage(
  attachment: CoachStoredAttachment,
  hintText = '',
): CoachPlanDraft {
  const id = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const lines = hintText
    .split(/\r?\n|；|;/)
    .map((l) => l.trim())
    .filter(Boolean);

  const parsedExercises = lines.map(parseExerciseLine).filter((e): e is CoachPlanDraftExercise => Boolean(e));
  const warnings: string[] = [];

  if (parsedExercises.length > 0) {
    return {
      id,
      planName: `识图导入计划（${attachment.name.replace(/\.[^.]+$/, '').slice(0, 12) || '未命名'}）`,
      days: [
        {
          dayName: 'Day 1 · 识图导入训练日',
          exercises: parsedExercises,
        },
      ],
      warnings: ['请核对动作名称、组数、次数区间与参考重量后再确认新建计划。'],
    };
  }

  warnings.push('离线模式已生成可编辑识别草稿，创建前可自由修改计划名、动作、组数、次数与重量。');
  const days: CoachPlanDraftDay[] = [
    {
      dayName: '推力日 · 上肢（识图草稿）',
      exercises: [
        {
          name: '平板杠铃卧推',
          kind: 'straight',
          sets: 4,
          repsMin: 8,
          repsMax: 10,
          weightMode: 'external',
          suggestedWeightKg: 60,
        },
        {
          name: '上斜哑铃卧推',
          kind: 'straight',
          sets: 3,
          repsMin: 10,
          repsMax: 12,
          weightMode: 'external',
          suggestedWeightKg: 20,
        },
        {
          name: '绳索面拉',
          kind: 'straight',
          sets: 3,
          repsMin: 12,
          repsMax: 15,
          weightMode: 'external',
          suggestedWeightKg: 15,
        },
      ],
    },
  ];

  return {
    id,
    planName: '照片识别训练计划',
    days,
    warnings,
  };
}

function fileToBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  return new Response(file).arrayBuffer().then((buf) => new Uint8Array(buf));
}

async function extractVideoMetadataBestEffort(
  file: File,
): Promise<{ width: number; height: number; durationSec?: number; posterDataUrl?: string }> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { width: 0, height: 0 };
  }
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';

  try {
    return await new Promise((resolve) => {
      let settled = false;
      const done = (meta: { width: number; height: number; durationSec?: number; posterDataUrl?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
        resolve(meta);
      };
      const timer = setTimeout(() => {
        done({ width: video.videoWidth || 0, height: video.videoHeight || 0 });
      }, 2000);

      video.onloadeddata = () => {
        const w = video.videoWidth || 0;
        const h = video.videoHeight || 0;
        const durationSec =
          Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 10) / 10 : undefined;
        let posterDataUrl: string | undefined;
        if (w > 0 && h > 0) {
          try {
            const scale = Math.min(1, 320 / Math.max(w, h));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              posterDataUrl = canvas.toDataURL('image/jpeg', 0.7);
            }
          } catch {
            /* ignore canvas taint/codec frame errors */
          }
        }
        done({ width: w, height: h, durationSec, posterDataUrl });
      };

      video.onerror = () => done({ width: 0, height: 0 });
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 读取并校验待发视频：限制体积上限（默认 15MB），转为 base64 并尽力提取首帧缩略图与时长。
 */
export async function prepareCoachVideo(
  file: File,
  opts?: { maxBytes?: number },
): Promise<CoachStoredAttachment> {
  const maxBytes = opts?.maxBytes ?? COACH_MAX_VIDEO_BYTES;
  if (file.size <= 0) {
    throw new Error('所选视频文件为空，请重新选择');
  }
  if (file.size > maxBytes) {
    const limitMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    const actualMb = Math.round((file.size / (1024 * 1024)) * 10) / 10;
    throw new Error(`视频体积为 ${actualMb}MB，超过 ${limitMb}MB 上限，请裁剪或压缩后再发送`);
  }
  const bytes = await fileToBytes(file);
  const dataBase64 = encodeBytesToBase64(bytes);
  const meta = await extractVideoMetadataBestEffort(file);
  return {
    id: `vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'video',
    name: file.name || '训练视频.mp4',
    mimeType: file.type || 'video/mp4',
    dataBase64,
    width: meta.width,
    height: meta.height,
    sizeBytes: file.size,
    ...(meta.durationSec !== undefined ? { durationSec: meta.durationSec } : {}),
    ...(meta.posterDataUrl ? { posterDataUrl: meta.posterDataUrl } : {}),
  };
}
