const Anthropic = require('@anthropic-ai/sdk');
const Fuse = require('fuse.js');
const { resolveNamedMatch } = require('../item-matching');
const { validateClassifyResult } = require('../llm-schema');
const config = require('./config');

// Sends a single-turn request to Claude with a single tool forced via tool_choice and
// strict: true, which makes the API itself reject/regenerate anything that doesn't match
// `schema` — guarantees a schema-valid JS object back, no free-text JSON parsing needed.
async function callClaudeForJSON({ userContent, toolName, toolDescription, schema, maxTokens = 1024 }) {
  const client = new Anthropic();
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

// Text-only classification for a line with no deterministic item match. Never blocks the
// import: any failure (network, timeout, malformed response) just leaves the suggestion
// null for the user to fill in.
async function classifyLineWithLLM(rawName, cats, locs) {
  const catNames = cats.map((c) => c.name).join(', ');
  const locNames = locs.map((l) => l.name).join(', ');
  const promptText = `A supermarket invoice line item is named "${rawName}".
"category_name": Select the most appropriate category strictly from this list: [${catNames}]. If no category is a good fit, leave it empty.
"location_name": Select the most logical physical storage location for this product strictly from this list: [${locNames}].`;
  try {
    const input = await callClaudeForJSON({
      userContent: promptText,
      toolName: 'classify_result',
      toolDescription: 'Record the selected category and storage location for the invoice line item.',
      schema: {
        type: 'object',
        properties: {
          category_name: { type: 'string' },
          location_name: { type: 'string' },
        },
        required: ['category_name', 'location_name'],
        additionalProperties: false,
      },
      maxTokens: 256,
    });
    const validated = validateClassifyResult(input);
    if (validated.errors.length) console.warn('[Invoice Import Classify] LLM response failed schema validation:', validated.errors);
    const categoryMatch = resolveNamedMatch(cats, validated.category_name, new Fuse(cats, { keys: ['name'], threshold: 0.3 }));
    const locationMatch = resolveNamedMatch(locs, validated.location_name, new Fuse(locs, { keys: ['name'], threshold: 0.3 }));
    return { category_id: categoryMatch.id, location_id: locationMatch.id };
  } catch (err) {
    console.warn(`[Invoice Import Classify] LLM classification failed for "${rawName}":`, err.message);
    return { category_id: null, location_id: null };
  }
}

// Semantic matching for lines the deterministic pass (item-matching.js) couldn't resolve —
// invoice descriptions are branded/verbose ("Coles No Sugar Soft Drink Pineapple 1.25L")
// while existing items use broad, non-branded names ("Pineapple soft drink"), a gap string
// similarity alone can't bridge. One batched call per invoice rather than per line. Returns
// an array parallel to `lines`, each entry the matched item's id or null. Never blocks the
// import: any failure just leaves every entry null for the user to fill in via the review
// screen's existing merge-target override.
async function matchLinesWithLLM(existingItems, lines) {
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
    console.warn('[Invoice Import Match] LLM matching failed:', err.message);
    return lines.map(() => null);
  }
}

module.exports = {
  callClaudeForJSON,
  classifyLineWithLLM,
  matchLinesWithLLM,
};
