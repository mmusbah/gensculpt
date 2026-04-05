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
  log(`Resolving: ${url}`);
  const html = await fetchPageHtml(url);
  const ogMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogMatch?.[1]) { log(`Resolved: ${ogMatch[1]}`); return ogMatch[1]; }
  throw new Error('Could not find image URL on page');
}

async function fetchPageMeta(url) {
  try {
    const html = await fetchPageHtml(url);
    let creator = '';
    const userMatch = html.match(/"username"\s*:\s*"([^"]+)"/i) || html.match(/"displayName"\s*:\s*"([^"]+)"/i);
    if (userMatch?.[1]) creator = userMatch[1];
    if (!creator) { const m = html.match(/Created by (\S+)/i); if (m?.[1]) creator = m[1]; }

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

    const profileUrl = creator ? `https://www.gentube.app/profile/${creator}` : '';
    return { title: escapeHtml(title), creator: escapeHtml(creator), profile_url: profileUrl };
  } catch (e) {
    log(`Meta scrape failed: ${e.message}`);
    return { title: '', creator: '', profile_url: '' };
  }
}

async function falProxy(url) {
  const r = await fetch(url, { headers: { 'Authorization': `Key ${FAL_KEY}` } });
  if (!r.ok) throw new Error(`fal.ai proxy error: ${r.status}`);
  return r.json();
}

// === Server-side job tracking ===
// Jobs run entirely on the server. Browser can close — job still completes.
const jobs = new Map(); // jobId -> { status, error, source_url, ... }

async function runJob(jobId, sourceUrl, imageUrl) {
  const job = jobs.get(jobId);
  const startedAt = Date.now();
  try {
    // Step 1: Submit to fal.ai
    job.status = 'submitting';
    log(`[job ${jobId}] Submitting: ${imageUrl}`);
    const r = await fetch(FAL_QUEUE, {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_image_url: imageUrl, generate_type: 'Normal', face_count: 500000, enable_pbr: true }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.detail || `fal.ai error: ${r.status}`);
    }
    const data = await r.json();
    const statusUrl = data.status_url || `${FAL_QUEUE}/requests/${data.request_id}/status`;
    const responseUrl = data.response_url || `${FAL_QUEUE}/requests/${data.request_id}`;
    log(`[job ${jobId}] Queued — request_id: ${data.request_id}`);

    // Step 2: Poll until done (up to 10 min)
    job.status = 'generating';
    const deadline = Date.now() + 600000;
    let glbUrl = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 4000));
      const statusData = await falProxy(statusUrl);
      job.fal_status = statusData.status;
      if (statusData.status === 'COMPLETED') {
        const result = await falProxy(responseUrl);
        glbUrl = result.model_glb?.url || result.model_urls?.glb?.url;
        break;
      }
      if (statusData.status === 'FAILED') throw new Error('fal.ai generation failed');
    }
    if (!glbUrl) throw new Error('Generation timed out');

    // Step 3: Fetch metadata
    const meta = await fetchPageMeta(sourceUrl);

    // Step 4: Download GLB + source image in parallel
    job.status = 'saving';
    const id = jobId;
    const glbPromise = fetch(glbUrl).then(async r => {
      if (!r.ok) throw new Error(`GLB download failed: ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    });

    let imgExt = 'webp';
    let savedImage = false;
    const imgPromise = (async () => {
      try {
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) return null;
        const ct = imgRes.headers.get('content-type') || '';
        if (ct.includes('png')) imgExt = 'png';
        else if (ct.includes('jpeg') || ct.includes('jpg')) imgExt = 'jpg';
        return Buffer.from(await imgRes.arrayBuffer());
      } catch (e) { log(`[job ${id}] Image download failed: ${e.message}`); return null; }
    })();

    const [glbBuf, imgBuf] = await Promise.all([glbPromise, imgPromise]);
    const writes = [fs.promises.writeFile(path.join(FILES_DIR, `${id}.glb`), glbBuf)];
    if (imgBuf) { writes.push(fs.promises.writeFile(path.join(FILES_DIR, `${id}.${imgExt}`), imgBuf)); savedImage = true; }
    await Promise.all(writes);

    const durationS = Math.round((Date.now() - startedAt) / 1000);
    log(`[job ${id}] Done — ${durationS}s, GLB ${(glbBuf.length / 1024 / 1024).toFixed(1)}MB`);

    // Step 5: Save to models
    const models = getModels();
    models.unshift({
      id, title: meta.title, creator: meta.creator,
      source_url: sourceUrl, profile_url: meta.profile_url,
      source_image: savedImage ? `/files/${id}.${imgExt}` : imageUrl,
      glb_url: `/files/${id}.glb`,
      duration_s: durationS, cost_usd: COST_PER_MODEL,
      created_at: new Date().toISOString(),
    });
    saveModels(models);

    job.status = 'done';
    job.duration_s = durationS;
    log(`[job ${id}] Saved — total models: ${models.length}`);

  } catch (e) {
    log(`[job ${jobId}] FAILED: ${e.message}`);
    job.status = 'error';
    job.error = e.message;
  }
}

// === Routes ===

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(__dirname + '/index.html');
});
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

// Submit a new job — server handles everything from here
app.post('/api/jobs', async (req, res) => {
  try {
    if (!req.body.url) return res.status(400).json({ error: 'url is required' });

    const sourceUrl = req.body.url;

    // Always log every submission so nothing is lost
    const logLine = `${new Date().toISOString()} | ${sourceUrl}\n`;
    fs.promises.appendFile(path.join(__dirname, 'submissions.log'), logLine).catch(() => {});

    const imageUrl = await resolveImageUrl(sourceUrl);

    // Check if this image was already created
    const models = getModels();
    const existing = models.find(m =>
      m.source_url === sourceUrl ||
      (m.source_image && imageUrl.includes(path.basename(m.source_image).replace(/\.\w+$/, '')))
    );
    if (existing) {
      log(`Duplicate detected — model ${existing.id} already exists for ${sourceUrl}`);
      return res.json({ job_id: existing.id, duplicate: true, existing_model: existing });
    }

    // Check if there's already an active job for this image
    for (const [id, job] of jobs) {
      if (job.image_url === imageUrl && job.status !== 'done' && job.status !== 'error') {
        log(`Job already in progress for ${sourceUrl}`);
        return res.json({ job_id: id, in_progress: true });
      }
    }

    const jobId = Date.now().toString();
    jobs.set(jobId, { status: 'queued', source_url: sourceUrl, image_url: imageUrl });
    runJob(jobId, sourceUrl, imageUrl);

    log(`Job ${jobId} created for ${sourceUrl}`);
    res.json({ job_id: jobId, resolved_image_url: imageUrl });
  } catch (e) {
    log(`Job create error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Check job status
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job_id: req.params.id, ...job });
});

// List active jobs
app.get('/api/jobs', (req, res) => {
  const active = [];
  for (const [id, job] of jobs) {
    if (job.status !== 'done' && job.status !== 'error') active.push({ job_id: id, ...job });
  }
  res.json(active);
});

// Clean up finished jobs after 10 min
setInterval(() => {
  for (const [id, job] of jobs) {
    if ((job.status === 'done' || job.status === 'error') && Date.now() - parseInt(id) > 600000) jobs.delete(id);
  }
}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`GenSculpt running on port ${PORT}`));
