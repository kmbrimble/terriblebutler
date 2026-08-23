const Fuse = require('fuse.js');
const { resolveNamedMatch } = require('../item-matching');
const { validateClassifyResult } = require('../llm-schema');
const config = require('./config');

// Helper for safe JSON extraction from LLM output
function extractJsonFromText(text) {
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = text.match(codeBlockRegex);
  if (match && match[1]) {
    try { return JSON.parse(match[1]); } catch (e) { }
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.substring(firstBrace, lastBrace + 1)); } catch (e) { }
  }
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(text.substring(firstBracket, lastBracket + 1)); } catch (e) { }
  }
  return JSON.parse(text);
}

const nativeFetch = global.fetch;
async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await nativeFetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Helper for LLM API fetching with fallback
async function fetchWithOllamaFallback(llmApiUrl, payload) {
  let response = await fetchWithTimeout(llmApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (response.status === 500 && payload.response_format) {
    delete payload.response_format;
    response = await fetchWithTimeout(llmApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }
  if (!response.ok) {
    throw new Error(`HTTP error status: ${response.status}`);
  }
  return response;
}

// Text-only classification for a line with no deterministic item match. Reuses the same
// granite vision model in text mode (non-negotiable #6) and the same response_format /
// validation pattern as /api/parse-label-llm. Never blocks the import: any failure (network,
// timeout, malformed response) just leaves the suggestion null for the user to fill in.
async function classifyLineWithLLM(rawName, cats, locs) {
  const catNames = cats.map((c) => c.name).join(', ');
  const locNames = locs.map((l) => l.name).join(', ');
  const promptText = `A supermarket invoice line item is named "${rawName}".
"category_name": Select the most appropriate category strictly from this list: [${catNames}]. If no category is a good fit, leave it empty.
"location_name": Select the most logical physical storage location for this product strictly from this list: [${locNames}].`;
  try {
    const response = await fetchWithTimeout(config.getLlmApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.getLlmModel(),
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.1,
        max_tokens: 256,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'classify_result',
            schema: {
              type: 'object',
              properties: {
                category_name: { type: 'string' },
                location_name: { type: 'string' },
              },
              required: ['category_name', 'location_name'],
            },
          },
        },
      }),
    }, 15000);
    if (!response.ok) throw new Error(`LLM API returned HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const validated = validateClassifyResult(extractJsonFromText(content));
    if (validated.errors.length) console.warn('[Invoice Import Classify] LLM response failed schema validation:', validated.errors);
    const categoryMatch = resolveNamedMatch(cats, validated.category_name, new Fuse(cats, { keys: ['name'], threshold: 0.3 }));
    const locationMatch = resolveNamedMatch(locs, validated.location_name, new Fuse(locs, { keys: ['name'], threshold: 0.3 }));
    return { category_id: categoryMatch.id, location_id: locationMatch.id };
  } catch (err) {
    console.warn(`[Invoice Import Classify] LLM classification failed for "${rawName}":`, err.message);
    return { category_id: null, location_id: null };
  }
}

module.exports = {
  extractJsonFromText,
  fetchWithTimeout,
  fetchWithOllamaFallback,
  classifyLineWithLLM,
};
