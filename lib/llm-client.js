const Anthropic = require('@anthropic-ai/sdk');
const Fuse = require('fuse.js');
const { resolveNamedMatch } = require('../item-matching');
const { validateClassifyResult } = require('../llm-schema');
const config = require('./config');

// Sends a single-turn request to Claude with a single tool forced via tool_choice and
// strict: true, which makes the API itself reject/regenerate anything that doesn't match
// `schema` — guarantees a schema-valid JS object back, no free-text JSON parsing needed.
async function callClaudeForJSON({ userContent, toolName, toolDescription, schema, maxTokens = 1024 }) {
  // Explicit limits (see lib/config.js): the SDK's own defaults are 10 minutes and 2 retries.
  const client = new Anthropic({ timeout: config.getAnthropicTimeoutMs(), maxRetries: config.getAnthropicMaxRetries() });
  const response = await client.messages.create({
    model: config.getAnthropicModel(),
    max_tokens: maxTokens,
    tool_choice: { type: 'tool', name: toolName },
    tools: [
      {
        name: toolName,
        description: toolDescription,
        strict: true,
        input_schema: schema,
      },
    ],
    messages: [{ role: 'user', content: userContent }],
  });
  const toolUse = response.content.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new Error('Anthropic response contained no tool_use block');
  return toolUse.input;
}

// Lines classified per Anthropic call, and calls in flight at once (#55). Batching sends the
// category/location lists once per chunk instead of once per line and turns an N-line invoice
// into ceil(N / CLASSIFY_BATCH_SIZE) calls; the small pool keeps a large invoice from opening
// them all at the same moment.
const CLASSIFY_BATCH_SIZE = 25;
const CLASSIFY_CONCURRENCY = 3;

// Runs `fn` over `items` with at most `limit` in flight, preserving result order.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Text-only classification of invoice lines with no deterministic item match, suggesting a
// category and storage location for each. Returns one `{ category_id, location_id }` per input
// name, in order, plus `failed`: how many lines got no answer (call failed, or the model
// omitted the line). It never throws and never blocks the import — a failed line just has null
// suggestions for the user to fill in — but the caller is told, so the failure is not silent.
async function classifyLinesWithLLM(rawNames, cats, locs) {
  const catNames = cats.map((c) => c.name).join(', ');
  const locNames = locs.map((l) => l.name).join(', ');
  const catFuse = new Fuse(cats, { keys: ['name'], threshold: 0.3 });
  const locFuse = new Fuse(locs, { keys: ['name'], threshold: 0.3 });
  const unclassified = { category_id: null, location_id: null };

  const chunks = [];
  for (let start = 0; start < rawNames.length; start += CLASSIFY_BATCH_SIZE) {
    chunks.push({ start, names: rawNames.slice(start, start + CLASSIFY_BATCH_SIZE) });
  }

  const chunkResults = await mapWithConcurrency(chunks, CLASSIFY_CONCURRENCY, async ({ names }) => {
    const lineList = names.map((name, i) => `${i}: ${name}`).join('\n');
    const promptText = `Supermarket invoice line items are listed below as "line_index: description". For each line:
"category_name": Select the most appropriate category strictly from this list: [${catNames}]. If no category is a good fit, leave it empty.
"location_name": Select the most logical physical storage location for this product strictly from this list: [${locNames}].
Return one entry per line, keyed by its line_index.

Invoice lines:
${lineList}`;
    try {
      const input = await callClaudeForJSON({
        userContent: promptText,
        toolName: 'classify_results',
        toolDescription: 'Record the selected category and storage location for each invoice line item.',
        schema: {
          type: 'object',
          properties: {
            classifications: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  line_index: { type: 'integer' },
                  category_name: { type: 'string' },
                  location_name: { type: 'string' },
                },
                required: ['line_index', 'category_name', 'location_name'],
                additionalProperties: false,
              },
            },
          },
          required: ['classifications'],
          additionalProperties: false,
        },
        maxTokens: Math.max(256, names.length * 64),
      });
      const byIndex = new Map();
      for (const c of input.classifications || []) {
        if (Number.isInteger(c.line_index) && c.line_index >= 0 && c.line_index < names.length && !byIndex.has(c.line_index)) {
          byIndex.set(c.line_index, c);
        }
      }
      return names.map((_, i) => {
        const c = byIndex.get(i);
        if (!c) return { ...unclassified, failed: true };
        const validated = validateClassifyResult(c);
        if (validated.errors.length) console.warn('[Invoice Import Classify] LLM response failed schema validation:', validated.errors);
        return {
          category_id: resolveNamedMatch(cats, validated.category_name, catFuse).id,
          location_id: resolveNamedMatch(locs, validated.location_name, locFuse).id,
          failed: false,
        };
      });
    } catch (err) {
      console.error(`[Invoice Import Classify] LLM classification failed for ${names.length} line(s):`, err.message);
      return names.map(() => ({ ...unclassified, failed: true }));
    }
  });

  const results = chunkResults.flat();
  return {
    results: results.map(({ category_id, location_id }) => ({ category_id, location_id })),
    failed: results.filter((r) => r.failed).length,
  };
}

// Semantic matching for lines the deterministic pass (item-matching.js) couldn't resolve —
// invoice descriptions are branded/verbose ("Coles No Sugar Soft Drink Pineapple 1.25L")
// while existing items use broad, non-branded names ("Pineapple soft drink"), a gap string
// similarity alone can't bridge. One batched call per invoice rather than per line. Returns
// an array parallel to `lines`, each entry the matched item's id or null. Never blocks the
// import: any failure just leaves every entry null for the user to fill in via the review
// screen's existing merge-target override, and is reported through `onFailure` so the caller
// can tell the user.
async function matchLinesWithLLM(existingItems, lines, { onFailure } = {}) {
  if (!lines.length || !existingItems.length) return lines.map(() => null);
  const itemList = existingItems.map((it) => `${it.id}: ${it.name}`).join('\n');
  const lineList = lines.map((l, i) => `${i}: ${l.raw_name}`).join('\n');
  const promptText = `Existing inventory items use broad, usually non-branded descriptions — brand doesn't matter. Supermarket invoice line items are often branded and more specific. For each invoice line below, decide whether it is the same product as one of the existing items, and if so return that item's id in "item_id"; otherwise return 0.

Existing items (id: name):
${itemList}

Invoice lines (line_index: description):
${lineList}`;
  try {
    const input = await callClaudeForJSON({
      userContent: promptText,
      toolName: 'invoice_line_matches',
      toolDescription: "Record which existing item, if any, each invoice line item matches.",
      schema: {
        type: 'object',
        properties: {
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                line_index: { type: 'integer' },
                item_id: { type: 'integer' },
              },
              required: ['line_index', 'item_id'],
              additionalProperties: false,
            },
          },
        },
        required: ['matches'],
        additionalProperties: false,
      },
      maxTokens: 2048,
    });
    const validIds = new Set(existingItems.map((it) => it.id));
    const result = lines.map(() => null);
    for (const m of input.matches || []) {
      if (Number.isInteger(m.line_index) && m.line_index >= 0 && m.line_index < lines.length && validIds.has(m.item_id)) {
        result[m.line_index] = m.item_id;
      }
    }
    return result;
  } catch (err) {
    console.error('[Invoice Import Match] LLM matching failed:', err.message);
    if (onFailure) onFailure(err);
    return lines.map(() => null);
  }
}

module.exports = {
  callClaudeForJSON,
  classifyLinesWithLLM,
  CLASSIFY_BATCH_SIZE,
  CLASSIFY_CONCURRENCY,
  matchLinesWithLLM,
};
