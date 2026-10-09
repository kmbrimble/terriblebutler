// Every Anthropic call goes through one process-wide gate (LLM_MAX_CONCURRENT / LLM_QUEUE_MAX).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import request from 'supertest';
import './setup.js';
import { TEST_TOKEN, clearInvoiceImports, tmpUploadScratchDir } from './setup.js';
import { loadFreshApp } from './fresh-app.js';

vi.setConfig({ testTimeout: 30000 });
const nodeRequire = createRequire(import.meta.url);
const WOOLWORTHS_PDF = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
const LABEL_JPEG = path.join(process.cwd(), 'test/fixtures/product1.jpg');
const authed = (test) => test.set('Authorization', `Bearer ${TEST_TOKEN}`);
const scratchEmptied = () => vi.waitFor(() => expect(fs.readdirSync(tmpUploadScratchDir)).toEqual([]), { timeout: 5000 });

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1';
});
beforeEach(() => clearInvoiceImports());
afterEach(() => vi.restoreAllMocks());

const toolResponse = (name, input) => new Response(JSON.stringify({
  id: 'msg', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'tool_use', id: 't', name, input }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

// Holds the gate's only slot (queue 0), so any further Anthropic call finds it full.
function holdGate() {
  const { llmGate } = nodeRequire('../lib/llm-client');
  let release;
  const held = llmGate.run(() => new Promise((resolve) => { release = resolve; }));
  return async () => { release(); await held; };
}

describe('the LLM gate', () => {
  it('is configured from LLM_MAX_CONCURRENT / LLM_QUEUE_MAX', () => {
    loadFreshApp({ LLM_MAX_CONCURRENT: '3', LLM_QUEUE_MAX: '5' });
    expect(nodeRequire('../lib/config')).toMatchObject({ LLM_MAX_CONCURRENT: 3, LLM_QUEUE_MAX: 5 });
    loadFreshApp({ LLM_MAX_CONCURRENT: undefined, LLM_QUEUE_MAX: undefined });
    expect(nodeRequire('../lib/config')).toMatchObject({ LLM_MAX_CONCURRENT: 4, LLM_QUEUE_MAX: 8 });
  });

  it('never runs more Anthropic calls at once than LLM_MAX_CONCURRENT, queueing the rest', async () => {
    loadFreshApp({ LLM_MAX_CONCURRENT: '2', LLM_QUEUE_MAX: '10' });
    const { callClaudeForJSON } = nodeRequire('../lib/llm-client');
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return toolResponse('t', { ok: true });
    });
    const call = () => callClaudeForJSON({ userContent: 'x', toolName: 't', toolDescription: 'd', schema: { type: 'object', properties: {}, additionalProperties: false } });
    await Promise.all(Array.from({ length: 8 }, call));
    expect(peak).toBe(2);
  });
});

describe('when the gate is full', () => {
  it('the label scan answers 503 + Retry-After without calling Anthropic, and discards the upload', async () => {
    const { app } = loadFreshApp({ LLM_MAX_CONCURRENT: '1', LLM_QUEUE_MAX: '0' });
    const fetchSpy = vi.spyOn(global, 'fetch');
    const release = await holdGate();
    try {
      const res = await authed(request(app).post('/api/parse-label-llm')).attach('image', LABEL_JPEG);
      expect(res.status).toBe(503);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.body.correlation_id).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      await scratchEmptied();
    } finally {
      await release();
    }
    // and it works again once there is room
    vi.spyOn(global, 'fetch').mockResolvedValue(toolResponse('label_result', { name: 'n', category_name: '', location_name: '', container_details: '' }));
    expect((await authed(request(app).post('/api/parse-label-llm')).attach('image', LABEL_JPEG)).status).toBe(200);
  });

  it('an invoice import still succeeds: classification and matching degrade to warnings, never a 500', async () => {
    const { app } = loadFreshApp({ LLM_MAX_CONCURRENT: '1', LLM_QUEUE_MAX: '0' });
    const fetchSpy = vi.spyOn(global, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = await holdGate();
    try {
      const res = await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF);
      expect(res.status).toBe(200);
      expect(res.body.import.id).toBeTruthy();
      expect(res.body.lines).toHaveLength(32);
      expect(res.body.warnings.join(' ')).toMatch(/could not be generated/);
      expect(fetchSpy).not.toHaveBeenCalled();
      await scratchEmptied();
    } finally {
      await release();
    }
  });

  it('classification and matching report failure instead of throwing', async () => {
    loadFreshApp({ LLM_MAX_CONCURRENT: '1', LLM_QUEUE_MAX: '0' });
    const { classifyLinesWithLLM, matchLinesWithLLM } = nodeRequire('../lib/llm-client');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const release = await holdGate();
    try {
      expect(await classifyLinesWithLLM(['A', 'B'], [{ id: 1, name: 'Pantry' }], [{ id: 2, name: 'Fridge' }])).toEqual({ results: [{ category_id: null, location_id: null }, { category_id: null, location_id: null }], failed: 2 });
      const onFailure = vi.fn();
      expect(await matchLinesWithLLM([{ id: 1, name: 'Milk' }], [{ raw_name: 'Milk' }], { onFailure })).toEqual([null]);
      expect(onFailure).toHaveBeenCalledTimes(1);
    } finally {
      await release();
    }
  });
});

describe('uploads leave no per-request size telemetry in the log', () => {
  it('a label scan and an invoice import print no "Received file", byte counts or base64 lengths', async () => {
    const { app } = loadFreshApp({ LLM_MAX_CONCURRENT: undefined, LLM_QUEUE_MAX: undefined });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      const body = JSON.parse(options.body);
      const name = body.tools[0].name;
      if (name === 'label_result') return toolResponse(name, { name: 'n', category_name: '', location_name: '', container_details: '' });
      if (name === 'classify_results') {
        const indexes = [...body.messages[0].content.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
        return toolResponse(name, { classifications: indexes.map((line_index) => ({ line_index, category_name: '', location_name: '' })) });
      }
      return toolResponse(name, { matches: [] });
    });
    expect((await authed(request(app).post('/api/parse-label-llm')).attach('image', LABEL_JPEG)).status).toBe(200);
    expect((await authed(request(app).post('/api/invoices/import')).attach('invoice', WOOLWORTHS_PDF)).status).toBe(200);
    const printed = [...log.mock.calls, ...info.mock.calls].map((call) => call.join(' ')).join('\n');
    expect(printed).not.toMatch(/Received file|bytes|base64|characters|Sending request/i);
  });
});
