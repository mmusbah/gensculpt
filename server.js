const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const FAL_KEY = process.env.FAL_API_KEY;
const FAL_QUEUE = 'https://queue.fal.run/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d';
const DB_FILE = path.join(__dirname, 'models.json');
const FILES_DIR = path.join(__dirname, 'files');
const COST_PER_MODEL = 0.10;

if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR);
if (!FAL_KEY) { console.error('[ERROR] FAL_API_KEY required'); process.exit(1); }

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// In-memory model cache with write-through
let modelsCache = null;
function getModels() {
  if (!modelsCache) {
    try { modelsCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { modelsCache = []; }
  }
  return modelsCache;
}
function saveModels(models) {
  modelsCache = models;
  fs.promises.writeFile(DB_FILE, JSON.stringify(models, null, 2)).catch(e => log(`Write error: ${e.message}`));
}

// Shared HTML page fetcher with brief cache
const htmlCache = new Map();
async function fetchPageHtml(url) {
  const cached = htmlCache.get(url);
  if (cached && Date.now() - cached.ts < 60000) return cached.html;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch page: ${r.status}`);
  const html = await r.text();
  htmlCache.set(url, { html, ts: Date.now() });
  return html;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function resolveImageUrl(url) {
  if (/\.(png|jpg|jpeg|webp|gif)(\?|$)/i.test(url)) return url;
  if (url.includes('cloudfront.net')) return url;
  log(`Resolving page URL: ${url}`);
  const html = await fetchPageHtml(url);
  const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogMatch?.[1]) { log(`Resolved to: ${ogMatch[1]}`); return ogMatch[1]; }
  throw new Error('Could not find image URL on page');
}

async function fetchPageMeta(url) {
  try {
    const html = await fetchPageHtml(url);

    let creator = '';
    const userMatch = html.match(/"username"\s*:\s*"([^"]+)"/i) || html.match(/"displayName"\s*:\s*"([^"]+)"/i);
    if (userMatch?.[1]) creator = userMatch[1];
    if (!creator) {
      const createdBy = html.match(/Created by (\S+)/i);
      if (createdBy?.[1]) creator = createdBy[1];
    }

    const promptMatch = html.match(/"prompt"\s*:\s*"([^"]{1,200})"/i);
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    const titleTag = html.match(/<title>([^<]+)<\/title>/i);
    let title = '';
    if (promptMatch?.[1]) {
      title = promptMatch[1];
    } else {
      title = (ogTitle?.[1] || titleTag?.[1] || '').trim();
      if (/^Created by .+ on GenTube$/i.test(title)) title = '';
      title = title.replace(/\s*[-|]\s*GenTube$/i, '').trim();
    }

    // Build profile URL from creator name
    const profileUrl = creator ? `https://www.gentube.app/profile/${creator}` : '';

    log(`Meta: title="${title}", creator="${creator}"`);
    return { title: escapeHtml(title), creator: escapeHtml(creator), profile_url: profileUrl };
  } catch (e) {
    log(`Meta scrape failed: ${e.message}`);
    return { title: '', creator: '' };
  }
}

// Rate limit: 1 generation per IP per 2 minutes
const recentGens = new Map();
function rateLimited(ip) {
  const last = recentGens.get(ip);
  if (last && Date.now() - last < 120000) return true;
  recentGens.set(ip, Date.now());
  return false;
}
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [ip, ts] of recentGens) if (ts < cutoff) recentGens.delete(ip);
}, 120000);

// Shared fal.ai proxy
async function falProxy(url) {
  const r = await fetch(url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
  if (!r.ok) throw new Error(`fal.ai proxy error: ${r.status}`);
  return r.json();
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.use('/files', express.static(FILES_DIR));

app.get('/api/models', (req, res) => {
  const models = getModels();
  log(`GET /api/models — ${models.length} models`);
  res.json(models);
});

app.get('/api/stats', (req, res) => {
  const models = getModels();
  const withDuration = models.filter(m => m.duration_s);
  const avgTime = withDuration.length ? withDuration.reduce((a, m) => a + m.duration_s, 0) / withDuration.length : 0;
  res.json({
    total_models: models.length,
    total_cost_usd: (models.length * COST_PER_MODEL).toFixed(2),
    avg_duration_s: Math.round(avgTime),
    cost_per_model: COST_PER_MODEL,
  });
});

app.get('/api/meta', async (req, res) => {
  if (!req.query.url) return res.json({ title: '', creator: '' });
  log(`GET /api/meta — ${req.query.url}`);
  res.json(await fetchPageMeta(req.query.url));
});

app.post('/api/generate', async (req, res) => {
  try {
    if (!req.body.image_url) return res.status(400).json({ error: 'image_url is required' });

    log(`POST /api/generate — ${req.body.image_url}`);
    const imageUrl = await resolveImageUrl(req.body.image_url);

    log(`Submitting to fal.ai: ${imageUrl}`);
    const r = await fetch(FAL_QUEUE, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_image_url: imageUrl, generate_type: 'Normal', face_count: 500000, enable_pbr: true }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      log(`fal.ai error: ${r.status} — ${JSON.stringify(err)}`);
      throw new Error(err.detail || `fal.ai error: ${r.status}`);
    }

    const data = await r.json();
    log(`fal.ai queued — ${data.request_id}`);
    res.json({
      request_id: data.request_id,
      resolved_image_url: imageUrl,
      started_at: Date.now(),
      status_url: data.status_url || `${FAL_QUEUE}/requests/${data.request_id}/status`,
      response_url: data.response_url || `${FAL_QUEUE}/requests/${data.request_id}`,
    });
  } catch (e) {
    log(`Generate error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/fal-proxy', async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: 'url param required' });
    const data = await falProxy(req.query.url);
    res.json(data);
  } catch (e) {
    log(`Proxy error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/models', async (req, res) => {
  try {
    if (!req.body.glb_url) return res.status(400).json({ error: 'glb_url is required' });

    const id = Date.now().toString();
    log(`Saving model ${id}...`);

    // Download GLB and source image in parallel
    const glbPromise = fetch(req.body.glb_url).then(async r => {
      if (!r.ok) throw new Error(`GLB download failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    });

    let imgExt = 'webp';
    let savedImage = false;
    const imgPromise = req.body.source_image ? (async () => {
      try {
        const imgUrl = await resolveImageUrl(req.body.source_image).catch(() => req.body.source_image);
        const imgRes = await fetch(imgUrl);
        if (!imgRes.ok) return null;
        const ct = imgRes.headers.get('content-type') || '';
        if (ct.includes('png')) imgExt = 'png';
        else if (ct.includes('jpeg') || ct.includes('jpg')) imgExt = 'jpg';
        return Buffer.from(await imgRes.arrayBuffer());
      } catch (e) {
        log(`Image download failed: ${e.message}`);
        return null;
      }
    })() : Promise.resolve(null);

    const [glbBuf, imgBuf] = await Promise.all([glbPromise, imgPromise]);

    // Write files in parallel
    const writes = [fs.promises.writeFile(path.join(FILES_DIR, `${id}.glb`), glbBuf)];
    if (imgBuf) {
      writes.push(fs.promises.writeFile(path.join(FILES_DIR, `${id}.${imgExt}`), imgBuf));
      savedImage = true;
    }
    await Promise.all(writes);

    log(`Saved: GLB ${(glbBuf.length / 1024 / 1024).toFixed(1)}MB${imgBuf ? `, img ${(imgBuf.length / 1024).toFixed(0)}KB` : ''}`);

    const models = getModels();
    models.unshift({
      id,
      title: req.body.title || '',
      creator: req.body.creator || '',
      source_url: req.body.source_url || '',
      profile_url: req.body.profile_url || '',
      source_image: savedImage ? `/files/${id}.${imgExt}` : req.body.source_image,
      glb_url: `/files/${id}.glb`,
      duration_s: req.body.duration_s || 0,
      cost_usd: COST_PER_MODEL,
      created_at: new Date().toISOString(),
    });
    saveModels(models);
    log(`Model ${id} saved — total: ${models.length}`);
    res.json({ ok: true, cost_per_model: COST_PER_MODEL });
  } catch (e) {
    log(`Save error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`GenSculpt running on port ${PORT}`));
