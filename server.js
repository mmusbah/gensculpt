const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const FAL_KEY = process.env.FAL_API_KEY;
const FAL_QUEUE = 'https://queue.fal.run/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d';
const DB_FILE = path.join(__dirname, 'models.json');

// Simple persistence
function loadModels() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function saveModels(models) {
  fs.writeFileSync(DB_FILE, JSON.stringify(models, null, 2));
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// Get all models for the feed
app.get('/api/models', (req, res) => res.json(loadModels()));

// Submit image for 3D generation
app.post('/api/generate', async (req, res) => {
  try {
    const r = await fetch(FAL_QUEUE, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input_image_url: req.body.image_url,
        generate_type: 'Normal',
        face_count: 500000,
        enable_pbr: true,
      }),
    });
    if (!r.ok) throw new Error(`fal.ai error: ${r.status}`);
    const data = await r.json();
    res.json({
      request_id: data.request_id,
      status_url: data.status_url || `${FAL_QUEUE}/requests/${data.request_id}/status`,
      response_url: data.response_url || `${FAL_QUEUE}/requests/${data.request_id}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const r = await fetch(req.query.url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/result', async (req, res) => {
  try {
    const r = await fetch(req.query.url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save a completed model to the feed
app.post('/api/models', (req, res) => {
  const models = loadModels();
  models.unshift({
    id: Date.now().toString(),
    source_image: req.body.source_image,
    glb_url: req.body.glb_url,
    created_at: new Date().toISOString(),
  });
  saveModels(models);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
