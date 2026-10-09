import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import './setup.js';

const nodeRequire = createRequire(import.meta.url);
const { selectMatchCandidates, nameTokens } = nodeRequire('../item-matching.js');
const { matchLinesWithLLM } = nodeRequire('../lib/llm-client.js');
afterEach(() => vi.restoreAllMocks());

const items = (n, name = (i) => `Filler product ${i}`) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: name(i) }));
const toolResponse = (input) => new Response(JSON.stringify({
  id: 'msg', type: 'message', role: 'assistant', model: 'm', stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'tool_use', id: 't', name: 'invoice_line_matches', input }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('nameTokens', () => {
  it('keeps product words, drops sizes and short words, folds plurals', () => {
    expect(nameTokens('Coles No Sugar Soft Drinks Pineapple 1.25L')).toEqual(['cole', 'sugar', 'soft', 'drink', 'pineapple']);
    expect(nameTokens('Roma Tomatoes 500g')).toEqual(['roma', 'tomato']);
  });
});

describe('selectMatchCandidates', () => {
  it('offers a small inventory whole (the matcher bridges names no word overlap could)', () => {
    const all = items(50);
    expect(selectMatchCandidates(all, [{ raw_name: 'Zero Lemonade' }], 400)).toBe(all);
  });

  it('over the cap, keeps every line\'s best candidates and respects the cap', () => {
    const all = items(2000);
    all[1500] = { id: 9001, name: 'Pineapple soft drink' };
    all[1700] = { id: 9002, name: 'Basmati rice' };
    all[1900] = { id: 9003, name: 'Dishwasher tablets' };
    const lines = [
      { raw_name: 'Coles No Sugar Soft Drink Pineapple 1.25L' },
      { raw_name: 'SunRice Basmati Rice 5kg' },
      { raw_name: 'Finish Quantum Dishwasher Tablets 60 pack' },
    ];
    const chosen = selectMatchCandidates(all, lines, 10);
    expect(chosen.length).toBeLessThanOrEqual(10);
    const ids = chosen.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([9001, 9002, 9003]));
    expect(ids).not.toContain(1); // unrelated filler is not offered
  });

  it('ranks the rarer shared word higher, and no single line crowds out the others', () => {
    const all = [
      ...items(30, (i) => `Soft drink ${i}`),
      { id: 500, name: 'Tahini' },
    ];
    const lines = [{ raw_name: 'Soft drink cola' }, { raw_name: 'Hulled Tahini 400g' }];
    const chosen = selectMatchCandidates(all, lines, 5).map((c) => c.id);
    expect(chosen).toContain(500);
    expect(chosen).toHaveLength(5);
  });

  it('offers nothing when no item shares a word with any line', () => {
    expect(selectMatchCandidates(items(20), [{ raw_name: 'Zzzz qqqq' }], 5)).toEqual([]);
  });
});

describe('matchLinesWithLLM prompt bounds', () => {
  const sentPrompt = () => JSON.parse(global.fetch.mock.calls[0][1].body).messages[0].content;

  it('sends a bounded prompt for a huge inventory and 250 lines (<= INVOICE_MATCH_MAX_ITEMS items, clipped text)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const { INVOICE_MATCH_MAX_ITEMS } = nodeRequire('../lib/config');
    const long = 'wordy '.repeat(100);
    const all = items(5000, (i) => `${long}product${i} cola`);
    const lines = Array.from({ length: 250 }, (_, i) => ({ raw_name: `${long}cola line${i}` }));
    vi.spyOn(global, 'fetch').mockResolvedValue(toolResponse({ matches: [] }));
    await matchLinesWithLLM(all, lines);
    const prompt = sentPrompt();
    const offered = prompt.match(/^\d+: /gm).length - lines.length;
    expect(offered).toBeLessThanOrEqual(INVOICE_MATCH_MAX_ITEMS);
    expect(prompt.length).toBeLessThan(150_000);
    // for contrast: the unbounded prompt would have been >3 MB
    expect(all.map((it) => `${it.id}: ${it.name}`).join('\n').length).toBeGreaterThan(3_000_000);
  });

  it('only accepts an item id that was actually offered to the model', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const all = [...items(1000), { id: 7777, name: 'Pineapple soft drink' }];
    // the model answers with a real inventory id that was NOT in the narrowed candidate set
    vi.spyOn(global, 'fetch').mockResolvedValue(toolResponse({ matches: [{ line_index: 0, item_id: 3 }, { line_index: 1, item_id: 7777 }] }));
    const result = await matchLinesWithLLM(all, [{ raw_name: 'Zero Cola' }, { raw_name: 'Coles Pineapple Soft Drink 1.25L' }]);
    expect(result).toEqual([null, 7777]);
  });

  it('makes no call when nothing is related to any line (over the cap)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    expect(await matchLinesWithLLM(items(1000), [{ raw_name: 'Qzx Wvu' }])).toEqual([null]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
