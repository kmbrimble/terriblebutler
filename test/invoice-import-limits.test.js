import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'path';
import './setup.js';
import { TEST_TOKEN } from './setup.js';
import request from 'supertest';
import { loadFreshApp } from './fresh-app.js';

// Each test loads a fresh copy of the app (DB open, schema, Socket.IO), which can exceed the
// 5s default when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30000 });

const WOOLWORTHS_PDF = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf'); // 32 lines

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
});

afterEach(() => {
  vi.restoreAllMocks();
});

const authed = (test) => test.set('Authorization', `Bearer ${TEST_TOKEN}`);

function classifyResponse(body) {
  const prompt = body.messages[0].content;
  const indexes = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
  return new Response(
    JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'classify_results', input: {
        classifications: indexes.map((line_index) => ({ line_index, category_name: '', location_name: '' })),
      } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('invoice import LLM rate limit (#55)', () => {
  it('throttles POST /api/invoices/import under the LLM limiter but not the review endpoints', async () => {
    const { app } = loadFreshApp({ LLM_RATE_LIMIT_MAX: '2', INVOICE_IMPORT_MAX_LINES: undefined });
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options) => classifyResponse(JSON.parse(options.body)));

    for (let i = 0; i < 2; i++) {
      expect((await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF)).status).toBe(200);
    }
    expect((await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF)).status).toBe(429);

    // Same prefix, different endpoints: the review screen must stay usable.
    expect((await authed(request(app).get('/api/invoices/import/999999'))).status).toBe(404);
    expect((await authed(request(app).patch('/api/invoices/import/999999/lines/1')).send({ line_status: 'reviewed' })).status).toBe(404);
    expect((await authed(request(app).delete('/api/invoices/import/999999'))).status).toBe(404);
  });
});

describe('invoice import line cap (#55)', () => {
  it('rejects an invoice with more parsed lines than the cap before staging anything or calling the LLM', async () => {
    const { app, db } = loadFreshApp({ INVOICE_IMPORT_MAX_LINES: '10', LLM_RATE_LIMIT_MAX: '100' });
    const fetchSpy = vi.spyOn(global, 'fetch');
    const before = db.prepare('SELECT COUNT(*) AS n FROM invoice_imports').get().n;

    const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/32 lines.*10/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM invoice_imports').get().n).toBe(before);
  });
});

describe('invoice import classification (#55)', () => {
  it('classifies unmatched lines in batched calls, not one call per line', async () => {
    const { app } = loadFreshApp({ INVOICE_IMPORT_MAX_LINES: undefined, LLM_RATE_LIMIT_MAX: '100' });
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, options) => classifyResponse(JSON.parse(options.body)));

    const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(32);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2); // ceil(32 / 25)
    expect(res.body.warnings).toEqual([]);
  });

  it('reports a failed classification in the response instead of failing silently', async () => {
    const { app } = loadFreshApp({ INVOICE_IMPORT_MAX_LINES: undefined, LLM_RATE_LIMIT_MAX: '100' });
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(32);
    expect(res.body.warnings.some((w) => /could not be generated for 32 of 32/.test(w))).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('classifyLinesWithLLM batching and concurrency', () => {
  it('splits into chunks, keeps in-flight calls within the pool size, and preserves order', async () => {
    const { classifyLinesWithLLM, CLASSIFY_BATCH_SIZE, CLASSIFY_CONCURRENCY } = await import('../lib/llm-client.js');
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      const body = JSON.parse(options.body);
      const names = [...body.messages[0].content.matchAll(/^\d+: (.*)$/gm)].map((m) => m[1]);
      return new Response(JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 't', name: 'classify_results', input: {
          classifications: names.map((name, line_index) => ({ line_index, category_name: 'Pantry', location_name: name.endsWith('7') ? 'Fridge' : 'Pantry' })),
        } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const names = Array.from({ length: CLASSIFY_BATCH_SIZE * 4 + 3 }, (_, i) => `Item ${i}`);
    const cats = [{ id: 1, name: 'Pantry' }];
    const locs = [{ id: 10, name: 'Pantry' }, { id: 11, name: 'Fridge' }];

    const { results, failed } = await classifyLinesWithLLM(names, cats, locs);

    expect(global.fetch).toHaveBeenCalledTimes(5);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(CLASSIFY_CONCURRENCY);
    expect(failed).toBe(0);
    expect(results).toHaveLength(names.length);
    expect(results[7].location_id).toBe(11);
    expect(results[8].location_id).toBe(10);
    expect(results[CLASSIFY_BATCH_SIZE * 4 + 2].category_id).toBe(1);
  });

  it('counts lines the model omitted as failed', async () => {
    const { classifyLinesWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', id: 't', name: 'classify_results', input: { classifications: [{ line_index: 0, category_name: 'Pantry', location_name: 'Pantry' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { results, failed } = await classifyLinesWithLLM(['A', 'B'], [{ id: 1, name: 'Pantry' }], [{ id: 2, name: 'Pantry' }]);
    expect(failed).toBe(1);
    expect(results[0]).toEqual({ category_id: 1, location_id: 2 });
    expect(results[1]).toEqual({ category_id: null, location_id: null });
  });
});
