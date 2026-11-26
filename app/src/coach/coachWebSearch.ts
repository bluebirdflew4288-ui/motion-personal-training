/* 电子教练通用联网搜索服务（支持免 Key 内置搜索：DuckDuckGo / 360 / 必应国内多源兜底，以及 Tavily / 博查 Bocha / Brave）。
   在 Android 原生环境下优先走原生 fetch（CoachStream.fetchText），避免 WebView CORS 拦截。 */

import type { CoachWebSearchProvider } from './coachStorage';

export interface CoachWebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface CoachWebSearchResult {
  provider: Exclude<CoachWebSearchProvider, 'none' | 'off'>;
  source?: 'duckduckgo' | 'so360' | 'bing' | 'bing-rss';
  query: string;
  hits: CoachWebSearchHit[];
}

const BROWSER_SEARCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '));
}

function clampSnippet(raw: unknown, maxLen = 240): string {
  const clean = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

function safeHttpUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : '';
}

function unwrapDuckDuckGoUrl(rawHref: string): string {
  const decoded = decodeHtmlEntities(rawHref.trim());
  const normalized = decoded.startsWith('//') ? `https:${decoded}` : decoded;
  try {
    const parsed = new URL(normalized, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg && safeHttpUrl(uddg)) return uddg;
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/y.js')) return '';
    return safeHttpUrl(parsed.toString());
  } catch {
    return safeHttpUrl(normalized);
  }
}

export function parseDuckDuckGoHtml(html: string): CoachWebSearchHit[] {
  const links = [
    ...html.matchAll(/class=["']result__a["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  ];
  const snippets = [
    ...html.matchAll(/class=["']result__snippet["'][^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/gi),
  ];
  const hits: CoachWebSearchHit[] = [];
  for (let i = 0; i < links.length; i += 1) {
    const url = unwrapDuckDuckGoUrl(links[i][1]);
    if (!url) continue;
    const title = clampSnippet(stripTags(links[i][2]), 80) || url;
    const snippet = clampSnippet(stripTags(snippets[i]?.[1] ?? ''));
    hits.push({ title, url, snippet });
    if (hits.length >= 5) break;
  }
  return hits;
}

export function parseSo360Html(html: string): CoachWebSearchHit[] {
  const blocks = html.split(/<li\b[^>]*class=["'][^"']*\bres-list\b/i).slice(1);
  const hits: CoachWebSearchHit[] = [];
  for (const block of blocks) {
    const titleLinkMatch = block.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    if (!titleLinkMatch) continue;
    const anchorHtml = titleLinkMatch[1];
    const mdurl = anchorHtml.match(/data-mdurl=["']([^"']+)["']/i)?.[1];
    const href = anchorHtml.match(/href=["']([^"']+)["']/i)?.[1];
    const url = safeHttpUrl(decodeHtmlEntities(mdurl ?? '')) || safeHttpUrl(decodeHtmlEntities(href ?? ''));
    if (!url) continue;
    const title = clampSnippet(stripTags(anchorHtml), 80) || url;
    const descMatch =
      block.match(/class=["'][^"']*\bres-desc\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:p|div|span)>/i) ??
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = clampSnippet(stripTags(descMatch?.[1] ?? ''));
    hits.push({ title, url, snippet });
    if (hits.length >= 5) break;
  }
  return hits;
}

export function parseBingHtml(html: string): CoachWebSearchHit[] {
  const blocks = html.split(/<li\b[^>]*class=["'][^"']*\bb_algo\b/i).slice(1);
  const hits: CoachWebSearchHit[] = [];
  for (const block of blocks) {
    const cleanBlock = block.replace(/<link[^>]*>/gi, '');
    const linkMatch =
      cleanBlock.match(/<h2[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ??
      cleanBlock.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (!linkMatch) continue;
    const url = safeHttpUrl(decodeHtmlEntities(linkMatch[1]));
    if (!url) continue;
    const title = clampSnippet(stripTags(linkMatch[2]), 80) || url;
    const pMatch =
      cleanBlock.match(/class=["'][^"']*\bb_caption\b[^"']*["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ??
      cleanBlock.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = clampSnippet(stripTags(pMatch?.[1] ?? ''));
    hits.push({ title, url, snippet });
    if (hits.length >= 5) break;
  }
  return hits;
}

function unwrapCdata(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

export function parseBingRss(xml: string): CoachWebSearchHit[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const hits: CoachWebSearchHit[] = [];
  for (const item of items) {
    const body = item[1];
    const titleRaw = body.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '';
    const linkRaw = body.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? '';
    const descRaw = body.match(/<description>([\s\S]*?)<\/description>/i)?.[1] ?? '';
    const url = safeHttpUrl(decodeHtmlEntities(unwrapCdata(linkRaw).trim()));
    if (!url) continue;
    const title = clampSnippet(stripTags(unwrapCdata(titleRaw)), 80) || url;
    const snippet = clampSnippet(stripTags(unwrapCdata(descRaw)));
    hits.push({ title, url, snippet });
    if (hits.length >= 5) break;
  }
  return hits;
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  if (parentSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('搜索超时')), timeoutMs);
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export async function runCoachWebSearch(params: {
  provider: CoachWebSearchProvider;
  apiKey?: string;
  query: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CoachWebSearchResult> {
  const provider = params.provider;
  const apiKey = (params.apiKey ?? '').trim();
  const query = params.query.trim();
  if (provider === 'none' || provider === 'off') {
    throw new Error('尚未启用联网搜索服务');
  }
  if (provider !== 'builtin' && !apiKey) {
    throw new Error('请先在模型设置里填写搜索 API Key');
  }
  if (!query) {
    throw new Error('搜索关键词不能为空');
  }

  const fetchFn = params.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('当前环境缺少网络请求能力');
  }

  return await executeSearchRequest(provider, apiKey, query, fetchFn, params.signal);
}

async function executeSearchRequest(
  provider: Exclude<CoachWebSearchProvider, 'none' | 'off'>,
  apiKey: string,
  query: string,
  fetchFn: typeof fetch,
  parentSignal: AbortSignal | undefined,
): Promise<CoachWebSearchResult> {
  if (provider === 'builtin') {
    const q = encodeURIComponent(query);
    const sources: Array<{
      name: 'duckduckgo' | 'so360' | 'bing' | 'bing-rss';
      url: string;
      timeoutMs: number;
      parse: (html: string) => CoachWebSearchHit[];
    }> = [
      { name: 'duckduckgo', url: `https://html.duckduckgo.com/html/?q=${q}`, timeoutMs: 3500, parse: parseDuckDuckGoHtml },
      { name: 'so360', url: `https://www.so.com/s?q=${q}`, timeoutMs: 5500, parse: parseSo360Html },
      { name: 'bing', url: `https://cn.bing.com/search?q=${q}&setlang=zh-Hans`, timeoutMs: 5500, parse: parseBingHtml },
      { name: 'bing-rss', url: `https://cn.bing.com/search?format=rss&q=${q}`, timeoutMs: 5000, parse: parseBingRss },
    ];
    const failures: string[] = [];
    for (const src of sources) {
      if (parentSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const res = await fetchWithTimeout(
          fetchFn,
          src.url,
          { method: 'GET', headers: BROWSER_SEARCH_HEADERS },
          parentSignal,
          src.timeoutMs,
        );
        if (res.status !== 200) {
          failures.push(`${src.name}:${res.status}`);
          continue;
        }
        const html = await res.text();
        const hits = src.parse(html);
        if (hits.length > 0) {
          return { provider: 'builtin', source: src.name, query, hits };
        }
        failures.push(`${src.name}:empty`);
      } catch (err) {
        if (parentSignal?.aborted || (err instanceof Error && err.name === 'AbortError' && parentSignal?.aborted)) {
          throw err;
        }
        failures.push(`${src.name}:${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    throw new Error(`内置免 Key 搜索暂不可用（${failures.join(', ')}），可在设置里切换 Tavily 或博查 Key。`);
  }

  if (provider === 'tavily') {
    const res = await fetchWithTimeout(
      fetchFn,
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: 5,
          search_depth: 'basic',
          include_answer: false,
        }),
      },
      parentSignal,
      18_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Tavily 搜索失败 (${res.status}): ${txt.slice(0, 160) || res.statusText}`);
    }
    const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const hits: CoachWebSearchHit[] = [];
    for (const r of json.results ?? []) {
      const url = safeHttpUrl(r.url);
      if (!url) continue;
      hits.push({
        title: clampSnippet(r.title, 80) || url,
        url,
        snippet: clampSnippet(r.content ?? r.snippet),
      });
      if (hits.length >= 5) break;
    }
    return { provider, query, hits };
  }

  if (provider === 'bocha') {
    const res = await fetchWithTimeout(
      fetchFn,
      'https://api.bochaai.com/v1/web-search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          count: 5,
          summary: true,
        }),
      },
      parentSignal,
      18_000,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`博查搜索失败 (${res.status}): ${txt.slice(0, 160) || res.statusText}`);
    }
    const json = (await res.json()) as {
      data?: { webPages?: { value?: Array<Record<string, unknown>> } };
      webPages?: { value?: Array<Record<string, unknown>> };
    };
    const rawList = json.data?.webPages?.value ?? json.webPages?.value ?? [];
    const hits: CoachWebSearchHit[] = [];
    for (const r of rawList) {
      const url = safeHttpUrl(r.url);
      if (!url) continue;
      hits.push({
        title: clampSnippet(r.name ?? r.title, 80) || url,
        url,
        snippet: clampSnippet(r.summary ?? r.snippet),
      });
      if (hits.length >= 5) break;
    }
    return { provider, query, hits };
  }

  // brave
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetchWithTimeout(
    fetchFn,
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
    parentSignal,
    18_000,
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Brave 搜索失败 (${res.status}): ${txt.slice(0, 160) || res.statusText}`);
  }
  const json = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
  const hits: CoachWebSearchHit[] = [];
  for (const r of json.web?.results ?? []) {
    const hitUrl = safeHttpUrl(r.url);
    if (!hitUrl) continue;
    hits.push({
      title: clampSnippet(r.title, 80) || hitUrl,
      url: hitUrl,
      snippet: clampSnippet(r.description),
    });
    if (hits.length >= 5) break;
  }
  return { provider, query, hits };
}
