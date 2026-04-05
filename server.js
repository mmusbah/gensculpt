const express = require('express');
const app = express();
app.use(express.json());

const FAL_KEY = process.env.FAL_API_KEY;
const FAL_QUEUE = 'https://queue.fal.run/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d';

// Serve static page
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

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

// Poll status
app.get('/api/status', async (req, res) => {
  try {
    const r = await fetch(req.query.url, {
      headers: { 'Authorization': `Key ${FAL_KEY}` },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get result
app.get('/api/result', async (req, res) => {
  try {
    const r = await fetch(req.query.url, {
      headers: { 'Authorization': `Key ${FAL_KEY}` },
    });
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
