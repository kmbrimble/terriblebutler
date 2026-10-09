const Fuse = require('fuse.js');
const { resolveNamedMatch } = require('../item-matching');
const { validateLabelResult } = require('../llm-schema');
const { callClaudeForJSON, buildPrompt } = require('../lib/llm-client');
const { openValidatedImage, discardUpload, sendUploadError, heavyWork } = require('../lib/uploads');
const { GateFullError } = require('../lib/work-gate');

function registerUploadRoutes(app, { db, imageUpload }) {
  app.post('/api/parse-label-llm', imageUpload.single('image'), async (req, res) => {
    const fallbackObject = { name: "", container_details: "", category_id: null, location_id: null };
    if (!req.file) {
      console.error("[Label Parser] No image file received in upload request.");
      return res.status(400).json({ error: 'No image uploaded' });
    }
    try {
      // Validate first: a non-image is a 400, not an LLM call or a silent empty result.
      // Decoding and resizing run through the process-wide gate (503 + Retry-After when full);
      // The LLM call below has its own process-wide gate (lib/llm-client.js, LLM_MAX_CONCURRENT), on top of the
      // per-client LLM rate limiter; a full gate is a 503 like the one above.
      const resizedBuffer = await heavyWork.run(async () => {
        const image = await openValidatedImage(req.file.path);
        return image
          .rotate()
          .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
      });
      const locs = db.prepare('SELECT id, name FROM locations').all();
      const cats = db.prepare('SELECT id, name FROM categories').all();
      const base64Image = resizedBuffer.toString('base64');
      const promptText = buildPrompt(`Read the text on this product label. Extract the information into a JSON object.
"name": Combine the product brand and product name into a single string.
"container_details": ONLY the strict measurement of weight, volume, or size (e.g., '180g', '2L'). Exclude all other descriptive text.
"category_name": Select the most appropriate category strictly from the categories data block (a JSON list of names). If no category is a good fit, leave it empty.
"location_name": Select the most logical physical storage location for this product strictly from the locations data block (a JSON list of names).`,
        { categories: cats.map((c) => c.name), locations: locs.map((l) => l.name) },
        { image: true });
      let parsedData;
      try {
        parsedData = await callClaudeForJSON({
          userContent: [
            { type: 'text', text: promptText },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          ],
          toolName: 'label_result',
          toolDescription: 'Record the extracted product label information.',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              category_name: { type: 'string' },
              location_name: { type: 'string' },
              container_details: { type: 'string' },
            },
            required: ['name', 'category_name', 'location_name', 'container_details'],
            additionalProperties: false,
          },
        });
      } catch (llmErr) {
        if (llmErr instanceof GateFullError) throw llmErr;
        console.error('[Label Parser Error] Anthropic API call failed:', llmErr.message);
        parsedData = fallbackObject;
      }
      const validated = validateLabelResult(parsedData);
      if (validated.errors.length) console.warn('[Label Parser] LLM response failed schema validation:', validated.errors);
      const categoryMatch = resolveNamedMatch(cats, validated.category_name, new Fuse(cats, { keys: ['name'], threshold: 0.3 }));
      const locationMatch = resolveNamedMatch(locs, validated.location_name, new Fuse(locs, { keys: ['name'], threshold: 0.3 }));
      return res.json({
        name: validated.name,
        container_details: validated.container_details,
        category_id: categoryMatch.id,
        location_id: locationMatch.id,
        suggested_category_name: categoryMatch.suggested_name,
        similar_category: categoryMatch.similar,
        suggested_location_name: locationMatch.suggested_name,
        similar_location: locationMatch.similar
      });
    } catch (err) {
      if (sendUploadError(res, err)) return;
      console.error("[Label Parser Exception]", err);
      return res.json(fallbackObject);
    } finally {
      await discardUpload(req.file);
    }
  });
}

module.exports = { registerUploadRoutes };
