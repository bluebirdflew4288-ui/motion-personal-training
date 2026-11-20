#!/usr/bin/env node
/* 阶段 1 技术探针：
   1. 对比薄窄适配接口与 @earendil-works/pi-ai（若 scratch 探针目录存在）的产物体积、gzip 大小与模块解析冷启动耗时；
   2. 在本地受控 HTTP SSE 服务端上实测「单张合成计划图 PNG → tool_call → 本地工具回传 → 中文流式答复 → 自定义 fetch 注入鉴权 → AbortController 中途取消」全链路。 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(APP_DIR, 'verify-self/stage1-probe');
mkdirSync(OUT_DIR, { recursive: true });

// 生成一张合法的 1x1 合成计划图 PNG（仅用于验证多模态请求载荷与字节保真）
const SYNTHETIC_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function main() {
  // 1. 构建并测量当前 adapter（esbuild 单文件打包尺寸与 parse 耗时）
  const esbuildMod = await import(join(APP_DIR, 'node_modules/esbuild/lib/main.js'));
  const adapterEntry = join(APP_DIR, 'src/coach/providerAdapter.ts');
  const bundled = await esbuildMod.build({
    entryPoints: [adapterEntry],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2020',
    write: false,
  });
  const adapterBytes = bundled.outputFiles[0].contents;
  const adapterGzip = gzipSync(adapterBytes);

  const parseStart = performance.now();
  const modUrl = `data:text/javascript;base64,${Buffer.from(adapterBytes).toString('base64')}`;
  const adapterMod = await import(modUrl);
  const adapterImportMs = Number((performance.now() - parseStart).toFixed(2));

  // 读取可选环境变量指定目录中的 @earendil-works/pi-ai 对比产物（避免硬编码个人会话路径）
  const scratchProbeDir = process.env.MOTION_PI_AI_PROBE_DIR || '';
  const piAiStats = {};
  if (scratchProbeDir) {
    for (const [label, rel] of [
      ['pi_ai_deepseek_provider', 'dist-deepseek/openai-completions---Y83Ka2.mjs'],
      ['pi_ai_google_generative_ai', 'dist-google/out.mjs'],
    ]) {
      const p = join(scratchProbeDir, rel);
      if (existsSync(p)) {
        const buf = readFileSync(p);
        piAiStats[label] = {
          rawBytes: buf.length,
          gzipBytes: gzipSync(buf).length,
        };
      }
    }
  }

  // 2. 启动本地受控 SSE 服务（模拟 OpenAI-compatible 多模态 + 工具调用 + 中文流式）
  const requestLogs = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(rawBody || '{}');
      requestLogs.push({
        url: req.url,
        hasAuthHeader: Boolean(req.headers.authorization),
        hasImage: JSON.stringify(body.messages || []).includes('image_url'),
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
      });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });

      const lastMsg = body.messages?.[body.messages.length - 1];
      if (req.url?.includes('slow-abort')) {
        res.write('data: {"choices":[{"delta":{"content":"正在分析你的训练"}}]}\n\n');
        setTimeout(() => {
          if (!res.writableEnded) {
            res.write('data: {"choices":[{"delta":{"content":"计划（不应到达）"}}]}\n\n');
            res.end();
          }
        }, 500);
        return;
      }

      if (lastMsg?.role === 'user') {
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_plan_1","function":{"name":"extract_plan_draft","arguments":"{\\"planName\\":\\"推胸日\\","}}]}}]}\n\n',
        );
        res.write(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"exercises\\":[\\"杠铃卧推 4×8\\",\\"哑铃飞鸟 3×12\\"]}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // 第二轮：本地执行工具回传结果后，模型输出中文总结
      res.write('data: {"choices":[{"delta":{"content":"已识别训练图「推胸日」："}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"包含杠铃卧推 4×8 与哑铃飞鸟 3×12，可确认后新建计划。"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    // 模拟受限原生网络层自定义 fetch：JS 侧不传 apiKey，由底层自定义 fetch 统一附加鉴权头
    const restrictedNativeFetch = (url, init) => {
      const headers = new Headers(init?.headers || {});
      headers.set('Authorization', 'Bearer native-keystore-injected-token');
      return globalThis.fetch(url, { ...init, headers });
    };

    const tools = [
      {
        name: 'extract_plan_draft',
        description: '提取训练计划草稿',
        parameters: {
          type: 'object',
          properties: {
            planName: { type: 'string' },
            exercises: { type: 'array', items: { type: 'string' } },
          },
          required: ['planName', 'exercises'],
        },
      },
    ];

    const messages = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: '请识别这张合成计划图并生成草稿' },
          { type: 'image', mimeType: 'image/png', dataBase64: SYNTHETIC_PNG_BASE64 },
        ],
      },
    ];

    // Turn 1: 合成计划图 -> tool_call
    let turn1Calls = [];
    for await (const ev of adapterMod.streamCoachTurn(
      { kind: 'openai-compatible', baseUrl, model: 'probe-vision', fetch: restrictedNativeFetch },
      messages,
      tools,
    )) {
      if (ev.type === 'tool_call') turn1Calls.push(ev.call);
    }

    // Turn 2: 本地执行工具回传 -> 中文流式回复
    const localToolOutput = JSON.stringify({
      ok: true,
      draftId: 'draft-1',
      planName: turn1Calls[0]?.arguments?.planName,
      exerciseCount: turn1Calls[0]?.arguments?.exercises?.length ?? 0,
    });
    const messagesTurn2 = [
      ...messages,
      { role: 'assistant', text: '', toolCalls: turn1Calls },
      { role: 'tool', toolCallId: turn1Calls[0].id, name: turn1Calls[0].name, content: localToolOutput },
    ];

    let turn2Text = '';
    for await (const ev of adapterMod.streamCoachTurn(
      { kind: 'openai-compatible', baseUrl, model: 'probe-vision', fetch: restrictedNativeFetch },
      messagesTurn2,
      tools,
    )) {
      if (ev.type === 'text_delta') turn2Text += ev.delta;
    }

    // Turn 3: AbortController 中途取消
    const ac = new AbortController();
    let cancelledText = '';
    let abortObserved = false;
    try {
      for await (const ev of adapterMod.streamCoachTurn(
        { kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/slow-abort/v1`, model: 'probe-vision', fetch: restrictedNativeFetch },
        [{ role: 'user', parts: [{ type: 'text', text: '测试中途取消' }] }],
        [],
        { signal: ac.signal },
      )) {
        if (ev.type === 'text_delta') {
          cancelledText += ev.delta;
          ac.abort();
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError') abortObserved = true;
    }

    const report = {
      timestamp: new Date().toISOString(),
      adapterBundle: {
        rawBytes: adapterBytes.length,
        gzipBytes: adapterGzip.length,
        sha256: createHash('sha256').update(adapterBytes).digest('hex').slice(0, 12),
        coldImportMs: adapterImportMs,
      },
      piAiModularComparison: piAiStats,
      localProtocolProbe: {
        turn1ImageSent: requestLogs[0]?.hasImage === true,
        turn1NativeAuthInjected: requestLogs[0]?.hasAuthHeader === true,
        turn1ToolCall: turn1Calls[0]?.name === 'extract_plan_draft' ? turn1Calls[0].arguments : null,
        turn2ChineseReply: turn2Text,
        turn3MidStreamCancelOk: abortObserved && cancelledText === '正在分析你的训练',
        turn3PartialText: cancelledText,
      },
      liveExternalApiStatus: 'UNVERIFIED (当前环境未配置外部模型 API Key，仅完成受控本地 SSE 协议与包体探针)',
    };

    const reportPath = join(OUT_DIR, 'probe-report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));

    if (
      !report.localProtocolProbe.turn1ImageSent ||
      !report.localProtocolProbe.turn1NativeAuthInjected ||
      !report.localProtocolProbe.turn1ToolCall ||
      !report.localProtocolProbe.turn2ChineseReply.includes('推胸日') ||
      !report.localProtocolProbe.turn3MidStreamCancelOk
    ) {
      process.exitCode = 1;
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
