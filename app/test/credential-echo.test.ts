import { describe, expect, it } from 'vitest';
import { runCoachWebSearch } from '../src/coach/coachWebSearch';
import { fetchProviderModels, streamCoachTurn } from '../src/coach/providerAdapter';

const canary = ['fixture', 'audit', 'reflected', 'dummy'].join('-');
const rejectedFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: `provider problem: ${canary}` }), { status: 401 });

describe('credential echoes from provider error responses', () => {
  const config = {
    kind: 'openai-compatible' as const,
    baseUrl: 'https://example.invalid/v1',
    model: 'test',
    apiKey: canary,
    fetch: rejectedFetch,
  };

  it('redacts a reflected model-list key', async () => {
    await expect(fetchProviderModels(config)).rejects.toThrow('provider problem: [REDACTED]');
  });

  it('redacts a reflected streaming request key', async () => {
    const readStream = async () => {
      for await (const event of streamCoachTurn(config, [], [])) {
        expect(event).toBeDefined();
      }
    };
    await expect(readStream()).rejects.toThrow('provider problem: [REDACTED]');
  });

  it.each(['tavily', 'bocha', 'brave'] as const)('redacts a reflected %s search key', async (provider) => {
    await expect(runCoachWebSearch({ provider, apiKey: canary, query: 'fixture', fetchFn: rejectedFetch }))
      .rejects.toThrow('provider problem: [REDACTED]');
  });
});
