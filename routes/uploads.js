const fs = require('fs');
const Fuse = require('fuse.js');
const sharp = require('sharp');
const { resolveNamedMatch } = require('../item-matching');
const { validateLabelResult } = require('../llm-schema');
const { fetchWithTimeout, extractJsonFromText } = require('../lib/llm-client');
const config = require('../lib/config');

function registerUploadRoutes(app, { db, imageUpload }) {
  app.post('/api/upload-image', imageUpload.single('image'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    const imagePath = `/uploads/${req.file.filename}`;
    res.json({ image_path: imagePath });
  });

  app.post('/api/parse-label-llm', imageUpload.single('image'), async (req, res) => {
    const fallbackObject = { name: "", container_details: "", category_id: null, location_id: null };
    if (!req.file) {
      console.error("[Label Parser] No image file received in upload request.");
      return res.status(400).json({ error: 'No image uploaded' });
    }
    const llmApiUrl = config.getLlmApiUrl();
    const llmModel = config.getLlmModel();
    console.log(`[Label Parser] Received file: ${req.file.originalname} (${req.file.size} bytes)`);
    try {
      const locs = db.prepare('SELECT id, name FROM locations').all();
      const cats = db.prepare('SELECT id, name FROM categories').all();
      const locNames = locs.map(l => l.name).join(', ');
      const catNames = cats.map(c => c.name).join(', ');
      const resizedBuffer = await sharp(req.file.path)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const base64Image = resizedBuffer.toString('base64');
      console.log(`[Label Parser] Resized image base64 length: ${base64Image.length} characters`);
      const promptText = `Read the text on this product label. Extract the information into a JSON object.
"name": Combine the product brand and product name into a single string.
"container_details": ONLY the strict measurement of weight, volume, or size (e.g., '180g', '2L'). Exclude all other descriptive text.
"category_name": Select the most appropriate category strictly from this list: [${catNames}]. If no category is a good fit, leave it empty.
"location_name": Select the most logical physical storage location for this product strictly from this list: [${locNames}].`;
      const payload = {
        model: llmModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptText },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 1024,
        stream: false,
        // Ollama's OpenAI-compatible /v1/chat/completions endpoint does not honour a raw
        // top-level `format` field (that's the native /api/chat structured-output
        // mechanism) — it's silently ignored, letting the model return free-form,
        // off-schema JSON. `response_format` with an attached json_schema is the field
        // this endpoint actually enforces. Verified against ibm/granite3.3-vision:2b.
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "label_result",
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                category_name: { type: "string" },
                location_name: { type: "string" },
                container_details: { type: "string" }
              },
              required: ["name", "category_name", "location_name", "container_details"]
            }
          }
        }
      };
      console.log(`[Label Parser] Sending request to LLM URL: ${llmApiUrl} (Model: ${llmModel})`);
      const response = await fetchWithTimeout(llmApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Label Parser Error] Ollama responded with HTTP ${response.status}:`, errorText);
        throw new Error(`LLM API returned HTTP ${response.status}: ${errorText}`);
      }
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '{}';
      console.log("[Label Parser] Raw LLM Response:", content);
      let parsedData;
      try {
        parsedData = extractJsonFromText(content);
      } catch (parseErr) {
        console.error("[Label Parser Error] JSON parse failed on response:", parseErr.message);
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
      console.error("[Label Parser Exception]", err);
      return res.json(fallbackObject);
    } finally {
      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }
    }
  });
}

module.exports = { registerUploadRoutes };
