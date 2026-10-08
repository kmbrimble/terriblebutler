import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import request from 'supertest';
import './setup.js';
import { api } from './setup.js';
import pkg from '../server.js';

const { app } = pkg;

const PRODUCT_IMAGE = path.join(process.cwd(), 'test/fixtures/product1.jpg');

// Builds a Response shaped like the real Anthropic Messages API, carrying a single
// forced tool_use block — this is what callClaudeForJSON expects to unwrap.
function mockToolUseResponse(toolName, input) {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'tool_use', id: 'toolu_test', name: toolName, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockHttpErrorResponse(status, body = {}) {
  return new Response(JSON.stringify({ type: 'error', error: body }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lib/llm-client.js callClaudeForJSON (via classifyLinesWithLLM)', () => {
  it('sends a strict forced tool call and resolves the returned names to category/location ids', async () => {
    const { classifyLinesWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(
      mockToolUseResponse('classify_results', {
        classifications: [{ line_index: 0, category_name: 'Pantry Staples', location_name: 'Pantry' }],
      }),
    );
    const cats = [{ id: 1, name: 'Pantry Staples' }];
    const locs = [{ id: 2, name: 'Pantry' }];
    const result = await classifyLinesWithLLM(['Tinned Tomatoes 400g'], cats, locs);
    expect(result).toEqual({ results: [{ category_id: 1, location_id: 2 }], failed: 0 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'classify_results' });
    expect(body.tools[0].strict).toBe(true);
  });

  it('never throws, returns null ids and reports the failure when the Anthropic call fails', async () => {
    const { classifyLinesWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(mockHttpErrorResponse(429, { message: 'rate limited' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await classifyLinesWithLLM(['Anything'], [], []);
    expect(result).toEqual({ results: [{ category_id: null, location_id: null }], failed: 1 });
  });
});

describe('lib/llm-client.js matchLinesWithLLM', () => {
  it('returns the matched item id per line, and null for lines the model finds no match for', async () => {
    const { matchLinesWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(
      mockToolUseResponse('invoice_line_matches', {
        matches: [
          { line_index: 0, item_id: 7 },
          { line_index: 1, item_id: 0 },
        ],
      }),
    );
    const existingItems = [{ id: 7, name: 'Pineapple soft drink', category_id: 3, location_id: 4 }];
    const lines = [{ raw_name: 'Coles No Sugar Soft Drink Pineapple 1.25L' }, { raw_name: 'Something unrelated' }];
    const result = await matchLinesWithLLM(existingItems, lines);
    expect(result).toEqual([7, null]);
  });

  it('ignores an item_id the model invents that is not in the existing item list', async () => {
    const { matchLinesWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(
      mockToolUseResponse('invoice_line_matches', { matches: [{ line_index: 0, item_id: 999999 }] }),
    );
    const result = await matchLinesWithLLM([{ id: 1, name: 'Real Item' }], [{ raw_name: 'Anything' }]);
    expect(result).toEqual([null]);
  });

  it('never throws and returns all-null when the Anthropic call fails', async () => {
    const { matchLinesWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(mockHttpErrorResponse(429, { message: 'rate limited' }));
    const result = await matchLinesWithLLM([{ id: 1, name: 'Real Item' }], [{ raw_name: 'A' }, { raw_name: 'B' }]);
    expect(result).toEqual([null, null]);
  });

  it('returns an empty result with no call when there are no unmatched lines or no existing items', async () => {
    const { matchLinesWithLLM } = await import('../lib/llm-client.js');
    const fetchSpy = vi.spyOn(global, 'fetch');
    expect(await matchLinesWithLLM([{ id: 1, name: 'X' }], [])).toEqual([]);
    expect(await matchLinesWithLLM([], [{ raw_name: 'A' }])).toEqual([null]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/parse-label-llm', () => {
  it('sends the image to Anthropic with a forced tool call and returns the resolved label', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      mockToolUseResponse('label_result', {
        name: 'Heinz Baked Beans',
        container_details: '420g',
        category_name: 'Tinned',
        location_name: 'Pantry',
      }),
    );
    const res = await api(app).post('/api/parse-label-llm').attach('image', PRODUCT_IMAGE);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Heinz Baked Beans');
    expect(res.body.container_details).toBe('420g');

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'label_result' });
    const userContent = body.messages[0].content;
    expect(userContent.some((b) => b.type === 'image')).toBe(true);
    expect(userContent.some((b) => b.type === 'text')).toBe(true);
  });

  it('falls back to a safe empty object and logs when the Anthropic call fails', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(mockHttpErrorResponse(401, { message: 'invalid x-api-key' }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await api(app).post('/api/parse-label-llm').attach('image', PRODUCT_IMAGE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: '', container_details: '', category_id: null, location_id: null });
    expect(consoleSpy).toHaveBeenCalled();
  });
});
describe('Anthropic client limits', () => {
  // A fetch that never answers until the SDK aborts it, like a hung connection.
  const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const callArgs = { userContent: 'x', toolName: 't', toolDescription: 'd', schema: { type: 'object', properties: {}, additionalProperties: false } };

  afterEach(() => {
    delete process.env.ANTHROPIC_TIMEOUT_MS;
    delete process.env.ANTHROPIC_MAX_RETRIES;
  });

  it('documents defaults: 45 s timeout, 1 retry; invalid values fall back', async () => {
    const config = (await import('../lib/config.js')).default;
    expect([config.getAnthropicTimeoutMs(), config.getAnthropicMaxRetries()]).toEqual([45_000, 1]);
    process.env.ANTHROPIC_TIMEOUT_MS = 'soon';
    process.env.ANTHROPIC_MAX_RETRIES = '-3';
    expect([config.getAnthropicTimeoutMs(), config.getAnthropicMaxRetries()]).toEqual([45_000, 1]);
    process.env.ANTHROPIC_TIMEOUT_MS = '2000';
    process.env.ANTHROPIC_MAX_RETRIES = '0';
    expect([config.getAnthropicTimeoutMs(), config.getAnthropicMaxRetries()]).toEqual([2000, 0]);
  });

  it('abandons a hung call at the configured timeout instead of waiting 10 minutes', async () => {
    const { callClaudeForJSON } = await import('../lib/llm-client.js');
    process.env.ANTHROPIC_TIMEOUT_MS = '60';
    process.env.ANTHROPIC_MAX_RETRIES = '0';
    vi.spyOn(global, 'fetch').mockImplementation(hangingFetch);
    const started = Date.now();
    await expect(callClaudeForJSON(callArgs)).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('retries a transient failure the configured number of times, no more', async () => {
    const { callClaudeForJSON } = await import('../lib/llm-client.js');
    process.env.ANTHROPIC_MAX_RETRIES = '1';
    vi.spyOn(global, 'fetch').mockImplementation(async () => mockHttpErrorResponse(529, { message: 'overloaded' }));
    await expect(callClaudeForJSON(callArgs)).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('a timeout surfaces through the graceful paths: classification reports failed, matching returns nulls', async () => {
    const { classifyLinesWithLLM, matchLinesWithLLM } = await import('../lib/llm-client.js');
    process.env.ANTHROPIC_TIMEOUT_MS = '40';
    process.env.ANTHROPIC_MAX_RETRIES = '0';
    vi.spyOn(global, 'fetch').mockImplementation(hangingFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await classifyLinesWithLLM(['A'], [], [])).toEqual({ results: [{ category_id: null, location_id: null }], failed: 1 });
    expect(await matchLinesWithLLM([{ id: 1, name: 'N' }], [{ raw_name: 'A' }])).toEqual([null]);
  });

  it('a timed-out label scan falls back to the empty result with a 200', async () => {
    process.env.ANTHROPIC_TIMEOUT_MS = '40';
    process.env.ANTHROPIC_MAX_RETRIES = '0';
    vi.spyOn(global, 'fetch').mockImplementation(hangingFetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await api(app).post('/api/parse-label-llm').attach('image', PRODUCT_IMAGE);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('');
  });
});

describe('matchLinesWithLLM output budget', () => {
  it('scales max_tokens with the number of lines so a 250-line import is not truncated', async () => {
    const { matchLinesWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(mockToolUseResponse('invoice_line_matches', { matches: [] }));
    await matchLinesWithLLM([{ id: 1, name: 'X' }], Array.from({ length: 250 }, (_, i) => ({ raw_name: `L${i}` })));
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_tokens).toBeGreaterThanOrEqual(250 * 12 * 2);
  });
});
