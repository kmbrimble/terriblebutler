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

describe('lib/llm-client.js callClaudeForJSON (via classifyLineWithLLM)', () => {
  it('returns the tool_use input parsed as the resolved category/location ids', async () => {
    const { classifyLineWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(
      mockToolUseResponse('classify_result', {
        category_name: 'Pantry Staples',
        location_name: 'Pantry',
      }),
    );
    const cats = [{ id: 1, name: 'Pantry Staples' }];
    const locs = [{ id: 2, name: 'Pantry' }];
    const result = await classifyLineWithLLM('Tinned Tomatoes 400g', cats, locs);
    expect(result).toEqual({ category_id: 1, location_id: 2 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'classify_result' });
    expect(body.tools[0].strict).toBe(true);
  });

  it('never throws and returns null ids when the Anthropic call fails', async () => {
    const { classifyLineWithLLM } = await import('../lib/llm-client.js');
    vi.spyOn(global, 'fetch').mockResolvedValue(mockHttpErrorResponse(429, { message: 'rate limited' }));
    const result = await classifyLineWithLLM('Anything', [], []);
    expect(result).toEqual({ category_id: null, location_id: null });
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
    expect(res.body).toEqual({ name: '', container_details: '', category_id: null, location_id: null });
    expect(consoleSpy).toHaveBeenCalled();
  });
});

describe('POST /api/invoices/parse', () => {
  it('sends the PDF text to Anthropic and returns validated line items', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      mockToolUseResponse('invoice_items', {
        items: [
          { name: 'Milk 2L', container_details: '2L', quantity: 1, price: 4.5, vendor: 'Woolworths' },
        ],
      }),
    );
    const pdfPath = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
    const res = await request(app)
      .post('/api/invoices/parse')
      .set('Authorization', `Bearer ${(await import('./setup.js')).TEST_TOKEN}`)
      .attach('invoice', pdfPath);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { name: 'Milk 2L', container_details: '2L', quantity: 1, price: 4.5, vendor: 'Woolworths', barcode: null },
    ]);
  });

  it('returns a clear 500 error when the Anthropic call fails, rather than swallowing it', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
    const pdfPath = path.join(process.cwd(), 'test/fixtures/invoices/woolworths-example.pdf');
    const res = await api(app).post('/api/invoices/parse').attach('invoice', pdfPath);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to parse invoice/);
  });
});
