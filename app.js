// ─────────────────────────────────────────────────────────────────
// Movie Poster Generator + Zernio Batch Scheduler — single-file version
// Title in -> TMDB fetch -> branded image -> upload to Zernio -> scheduled post
//
// Setup:
//   npm install express node-fetch@2 sharp dotenv
//   Install ffmpeg on your system (brew install ffmpeg / apt install ffmpeg)
//     — required only for the /generate-video (TikTok) route
//   Create a .env file with:
//     TMDB_API_KEY=your_tmdb_key
//     ZERNIO_API_KEY=your_zernio_key
//     ZERNIO_DEFAULT_ACCOUNT_ID=your_zernio_account_id   (optional default)
//     ZERNIO_DEFAULT_PLATFORM=twitter                     (optional default)
//   node app.js
//   Open http://localhost:3000
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const ZERNIO_BASE = 'https://zernio.com/api/v1';
const ZERNIO_DEFAULT_ACCOUNT_ID = process.env.ZERNIO_DEFAULT_ACCOUNT_ID || '';
const ZERNIO_DEFAULT_PLATFORM = process.env.ZERNIO_DEFAULT_PLATFORM || 'twitter';

// Where the batch job queue is persisted, so pending jobs survive a restart.
// NOTE: on platforms with an ephemeral filesystem (e.g. Render free/starter
// tier), this file resets on redeploy — fine for jobs that'll fire within a
// day or two, but not a substitute for a real DB if you need long-lived queues.
const DATA_DIR = path.join(__dirname, 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'batch-queue.json');

const TMDB_BASE = 'https://api.themoviedb.org/3';
// w500 instead of w780 -> smaller download from TMDB, faster generation
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// Horizontal/portrait layout — used for X posts (image)
const LAYOUT_POST = { width: 1080, height: 1350, posterHeight: 950 };
// Vertical layout — used for TikTok (9:16, feeds into the video step)
const LAYOUT_VIDEO = { width: 1080, height: 1920, posterHeight: 1500 };

const JPEG_QUALITY = 82; // 0-100, lower = smaller file / faster upload, less sharp

// TMDB genre IDs -> names (static list from TMDB, movies only)
const GENRE_MAP = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie',
  53: 'Thriller', 10752: 'War', 37: 'Western'
};

// Caption templates. Add your own — each just needs a label + accent color.
const TEMPLATES = {
  tonights_pick: { label: "TONIGHT'S PICK 🎬", accent: '#E63946' },
  hidden_gem: { label: 'HIDDEN GEM 💎', accent: '#457B9D' },
  if_you_liked: { label: 'IF YOU LIKED...', accent: '#2A9D8F' },
  mood_pick: { label: 'NEED THIS TONIGHT', accent: '#F4A261' },
  rating_check: { label: 'IS THIS ACTUALLY GOOD?', accent: '#8338EC' }
};

// ── TMDB lookup ─────────────────────────────────────────────────
async function searchMovie(title, apiKey) {
  const searchUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}`;
  const res = await fetch(searchUrl);
  if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);

  const data = await res.json();
  const movie = data.results && data.results[0];
  if (!movie) throw new Error(`No TMDB results for "${title}"`);
  return movie;
}

// Calls TMDB's dedicated images endpoint, which is the only place
// backdrops, logos, and every language variant actually live.
// include_image_language lets you ask for e.g. "en,null" so you get
// English-tagged images plus language-neutral ones (most logos/backdrops
// have no dialogue baked in, so they're tagged null).
async function fetchMovieImages(movieId, apiKey, language) {
  const langParam = language ? `&include_image_language=${language},null` : '';
  const url = `${TMDB_BASE}/movie/${movieId}/images?api_key=${apiKey}${langParam}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB images fetch failed: ${res.status}`);

  const data = await res.json();
  return {
    posters: data.posters || [],   // portrait, ~2:3 ratio
    backdrops: data.backdrops || [], // landscape, ~16:9 ratio
    logos: data.logos || []        // transparent PNGs, title treatments
  };
}

// Picks the best image of a given type from the images array:
// prefers the requested language, falls back to the highest-voted one.
function pickBestImage(images, language) {
  if (!images.length) return null;
  const inLanguage = language ? images.filter(img => img.iso_639_1 === language) : [];
  const pool = inLanguage.length ? inLanguage : images;
  return pool.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))[0];
}

/**
 * imageType: 'poster' (default), 'backdrop', or 'logo'
 * language: ISO 639-1 code e.g. 'en' — omit to just take TMDB's top pick
 */
async function fetchMovie(title, apiKey, { imageType = 'poster', language } = {}) {
  if (!apiKey) throw new Error('Missing TMDB_API_KEY');
  if (!title) throw new Error('Missing movie title');

  const movie = await searchMovie(title, apiKey);

  let filePath;
  if (imageType === 'poster' && !language) {
    // fast path: search results already include a default poster_path,
    // no need for the extra /images call
    filePath = movie.poster_path;
  } else {
    const images = await fetchMovieImages(movie.id, apiKey, language);
    const chosen = pickBestImage(images[`${imageType}s`] || [], language);
    filePath = chosen ? chosen.file_path : movie.poster_path;
  }

  if (!filePath) throw new Error(`"${movie.title}" has no ${imageType} available`);

  return {
    id: movie.id,
    title: movie.title,
    overview: movie.overview,
    releaseYear: (movie.release_date || '').slice(0, 4),
    rating: movie.vote_average ? movie.vote_average.toFixed(1) : null,
    genres: (movie.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean),
    imageType,
    posterUrl: `${IMAGE_BASE}${filePath}`
  };
}

// ── Image generation helpers ────────────────────────────────────
function escapeXml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxCharsPerLine) {
      lines.push(current.trim());
      current = word;
    } else {
      current += ' ' + word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function buildOverlaySvg({ title, hook, rating, genres, templateKey, layout }) {
  const { width, height, posterHeight } = layout;
  const textHeight = height - posterHeight;
  const template = TEMPLATES[templateKey] || TEMPLATES.tonights_pick;
  const hookLines = wrapText(hook || '', 42).slice(0, 3);
  const genreText = escapeXml((genres || []).slice(0, 2).join(' / '));

  const hookTspans = hookLines
    .map((line, i) => `<tspan x="50%" dy="${i === 0 ? 0 : 44}">${escapeXml(line)}</tspan>`)
    .join('');

  return `
  <svg width="${width}" height="${height}">
    <defs>
      <style>
        .label { font: 700 34px sans-serif; fill: ${template.accent}; letter-spacing: 2px; }
        .title { font: 800 56px sans-serif; fill: #ffffff; }
        .hook { font: 400 34px sans-serif; fill: #e6e6e6; }
        .meta { font: 600 30px sans-serif; fill: #ffffff; }
      </style>
    </defs>

    <rect x="0" y="${posterHeight}" width="${width}" height="${textHeight}" fill="#0d0d0d"/>
    <rect x="0" y="${posterHeight}" width="${width}" height="6" fill="${template.accent}"/>

    <text x="50%" y="${posterHeight + 65}" text-anchor="middle" class="label">${escapeXml(template.label)}</text>
    <text x="50%" y="${posterHeight + 125}" text-anchor="middle" class="title">${escapeXml(title)}</text>
    <text x="50%" y="${posterHeight + 190}" text-anchor="middle" class="hook">${hookTspans}</text>

    <text x="50%" y="${height - 40}" text-anchor="middle" class="meta">
      ${rating ? `⭐ ${escapeXml(String(rating))}/10` : ''}${rating && genreText ? '   •   ' : ''}${genreText}
    </text>
  </svg>`;
}

async function generatePosterImage({ posterUrl, title, hook, rating, genres, templateKey, layout = LAYOUT_POST }) {
  const posterRes = await fetch(posterUrl);
  if (!posterRes.ok) throw new Error(`Failed to download poster: ${posterRes.status}`);
  const posterBuffer = Buffer.from(await posterRes.arrayBuffer());

  const posterResized = await sharp(posterBuffer)
    .resize(layout.width, layout.posterHeight, { fit: 'cover' })
    .toBuffer();

  const overlaySvg = buildOverlaySvg({ title, hook, rating, genres, templateKey, layout });

  return sharp({
    create: {
      width: layout.width,
      height: layout.height,
      channels: 3,
      background: '#0d0d0d'
    }
  })
    .composite([
      { input: posterResized, top: 0, left: 0 },
      { input: Buffer.from(overlaySvg), top: 0, left: 0 }
    ])
    // JPEG instead of PNG: photographic content compresses far smaller
    // (usually 5-10x less data) with barely any visible quality loss
    // at this quality level, which is what actually cuts load time.
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

// ── Video generation (ffmpeg Ken Burns zoom, for TikTok) ──────────
// Takes a still JPEG buffer and turns it into a short vertical MP4:
// slow zoom-in over `seconds`, silent (no audio track — add music
// after upload inside TikTok to stay in their sound library and
// avoid copyright flags on unlicensed tracks).
async function imageToVideo(imageBuffer, { width, height }, seconds = 3) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inputPath = path.join(tmpDir, `${id}.jpg`);
  const outputPath = path.join(tmpDir, `${id}.mp4`);

  await fs.writeFile(inputPath, imageBuffer);

  const outWidth = 360;
  const outHeight = 640; // 9:16, smaller than the X image (1080x1350) — low memory footprint
  const fps = 20;
  const frames = seconds * fps;
  const zoomExpr = `if(eq(on,0),1.06,max(zoom-0.0006,1.0))`;
  const filter = `zoompan=z='${zoomExpr}':d=${frames}:s=${outWidth}x${outHeight}:fps=${fps},format=yuv420p`;

  const args = [
    '-y',
    '-loop', '1',
    '-i', inputPath,
    '-vf', filter,
    '-t', String(seconds),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '30',
    '-threads', '1',
    '-pix_fmt', 'yuv420p',
    outputPath
  ];

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'ffmpeg', args,
        { timeout: 25000, maxBuffer: 1024 * 1024 * 10 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`ffmpeg failed: ${stderr || err.message}`));
          resolve();
        }
      );
    });
    return await fs.readFile(outputPath);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

// ── Zernio helpers ──────────────────────────────────────────────
// 1) ask Zernio for a presigned upload URL + the public URL it'll live at
// 2) PUT the buffer straight to that presigned URL
// 3) return the public URL so it can go into a post's mediaItems
async function uploadToZernio(buffer, filename, contentType) {
  if (!ZERNIO_API_KEY) throw new Error('Missing ZERNIO_API_KEY');

  const presignRes = await fetch(`${ZERNIO_BASE}/media/presign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ filename, contentType })
  });
  if (!presignRes.ok) {
    throw new Error(`Zernio presign failed: ${presignRes.status} ${await presignRes.text()}`);
  }
  const { uploadUrl, publicUrl } = await presignRes.json();
  if (!uploadUrl || !publicUrl) throw new Error('Zernio presign response missing uploadUrl/publicUrl');

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buffer
  });
  if (!putRes.ok) throw new Error(`Zernio media PUT failed: ${putRes.status}`);

  return publicUrl;
}

// Creates a post (immediate or scheduled) once media is already uploaded.
async function createZernioPost({ content, mediaUrl, mediaType, platform, accountId, scheduledFor, timezone }) {
  if (!ZERNIO_API_KEY) throw new Error('Missing ZERNIO_API_KEY');
  if (!accountId) throw new Error('Missing Zernio accountId');

  const body = {
    content,
    mediaItems: mediaUrl ? [{ url: mediaUrl, type: mediaType }] : [],
    platforms: [{ platform, accountId }]
  };
  if (scheduledFor) {
    body.scheduledFor = scheduledFor;
    body.timezone = timezone || 'UTC';
  } else {
    body.publishNow = true;
  }

  const res = await fetch(`${ZERNIO_BASE}/posts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Zernio post creation failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return data.post || data;
}

// Generates the poster (image or short video), uploads it to Zernio, and
// schedules the post at `scheduledFor` (ISO string, paired with `timezone`).
// mediaKind: 'image' (default, X/portrait layout) or 'video' (TikTok, 9:16 Ken Burns clip)
async function generateAndSchedule({
  title, hook, template, imageType = 'poster', lang,
  platform, accountId, scheduledFor, timezone,
  mediaKind = 'image', videoSeconds = 3
}) {
  const movie = await fetchMovie(title, TMDB_API_KEY, { imageType, language: lang });
  const layout = mediaKind === 'video' ? LAYOUT_VIDEO : LAYOUT_POST;

  const imageBuffer = await generatePosterImage({
    posterUrl: movie.posterUrl,
    title: movie.title,
    hook,
    rating: movie.rating,
    genres: movie.genres,
    templateKey: template,
    layout
  });

  const safeTitle = movie.title.replace(/\s+/g, '_');
  let publicUrl, zernioMediaType, contentType, buffer;

  if (mediaKind === 'video') {
    const duration = Math.min(Math.max(parseInt(videoSeconds, 10) || 3, 2), 4); // clamp 2-4s
    buffer = await imageToVideo(imageBuffer, layout, duration);
    contentType = 'video/mp4';
    zernioMediaType = 'video';
    publicUrl = await uploadToZernio(buffer, `${safeTitle}_${Date.now()}.mp4`, contentType);
  } else {
    buffer = imageBuffer;
    contentType = 'image/jpeg';
    zernioMediaType = 'image';
    publicUrl = await uploadToZernio(buffer, `${safeTitle}_${Date.now()}.jpg`, contentType);
  }

  const post = await createZernioPost({
    content: hook,
    mediaUrl: publicUrl,
    mediaType: zernioMediaType,
    platform,
    accountId,
    scheduledFor,
    timezone
  });

  return {
    title: movie.title,
    mediaKind,
    publicUrl,
    scheduledFor,
    postId: post._id || post.id || null,
    status: post.status || null
  };
}

// ── Batch job queue ──────────────────────────────────────────────
// Jobs are enqueued instantly by /schedule-batch (no generation happens
// yet). A background ticker wakes up every 30s and generates+uploads+
// schedules only the jobs whose `generateAt` time has arrived — so a
// 20-item batch spreads its ffmpeg/TMDB/Zernio work across the whole
// window instead of doing it all in one blocking request.
let queue = [];
let isProcessingQueue = false;

async function loadQueue() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(QUEUE_FILE, 'utf8');
    queue = JSON.parse(raw);
  } catch {
    queue = [];
  }
}

async function saveQueue() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

async function processDueJobs() {
  if (isProcessingQueue) return; // avoid overlapping ticks
  isProcessingQueue = true;
  try {
    const now = Date.now();
    const due = queue.filter(j => j.status === 'pending' && new Date(j.generateAt).getTime() <= now);

    // Sequential on purpose: one job's ffmpeg render at a time keeps
    // memory/CPU predictable on small hosting tiers.
    for (const job of due) {
      job.status = 'processing';
      await saveQueue();

      try {
        const result = await generateAndSchedule({
          title: job.title,
          hook: job.hook,
          template: job.template,
          imageType: job.imageType,
          lang: job.lang,
          platform: job.platform,
          accountId: job.accountId,
          scheduledFor: job.scheduledFor,
          timezone: job.timezone,
          mediaKind: job.mediaKind,
          videoSeconds: job.videoSeconds
        });
        job.status = 'done';
        job.result = result;
      } catch (err) {
        job.status = 'failed';
        job.error = err.message;
      }
      await saveQueue();
    }
  } finally {
    isProcessingQueue = false;
  }
}

// ── Routes ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const templateOptions = Object.keys(TEMPLATES)
    .map(key => `<option value="${key}">${TEMPLATES[key].label}</option>`)
    .join('');

  res.send(`
    <html>
      <head>
        <style>
          body {
            font-family: 'Segoe UI', sans-serif;
            max-width: 560px;
            margin: 40px auto;
            padding: 0 20px;
            background: linear-gradient(160deg, #0b1220 0%, #142033 100%);
            color: #e6edf7;
            min-height: 100vh;
          }
          h2 {
            color: #ffffff;
            border-bottom: 2px solid #2563eb;
            padding-bottom: 10px;
          }
          h3 { color: #93c5fd; margin-top: 40px; }
          label {
            display: block;
            margin-top: 16px;
            margin-bottom: 6px;
            font-size: 14px;
            font-weight: 600;
            color: #93c5fd;
          }
          input, textarea, select {
            width: 100%;
            padding: 10px 12px;
            box-sizing: border-box;
            background: #1a2740;
            border: 1px solid #2d4066;
            border-radius: 8px;
            color: #e6edf7;
            font-size: 15px;
          }
          input::placeholder, textarea::placeholder { color: #6b84ab; }
          input:focus, textarea:focus, select:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
          }
          button {
            margin-top: 24px;
            width: 100%;
            padding: 12px 20px;
            background: #2563eb;
            color: #ffffff;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.15s ease;
          }
          button:hover { background: #1d4ed8; }
          .row { display: flex; gap: 12px; }
          .row > div { flex: 1; }
          #batchResults {
            margin-top: 16px;
            font-size: 13px;
            background: #0d1626;
            border: 1px solid #2d4066;
            border-radius: 8px;
            padding: 10px 12px;
            white-space: pre-wrap;
            max-height: 300px;
            overflow-y: auto;
          }
          .hint { font-size: 12px; color: #6b84ab; margin-top: 4px; }
        </style>
      </head>
      <body>
        <h2>Movie Poster Generator</h2>
        <form action="/generate" method="GET" target="_blank">
          <label>Movie title</label>
          <input name="title" placeholder="Inception" required/>

          <label>Hook / caption</label>
          <textarea name="hook" rows="3" placeholder="A movie that will make you question reality." required></textarea>

          <label>Template</label>
          <select name="template">${templateOptions}</select>

          <label>Image type</label>
          <select name="image">
            <option value="poster">Poster (portrait)</option>
            <option value="backdrop">Backdrop (landscape)</option>
          </select>

          <label>Language (optional, e.g. en, fr, ja)</label>
          <input name="lang" placeholder="en"/>

          <button type="submit" formaction="/generate">Generate Image (X)</button>
          <button type="submit" formaction="/generate-video" style="margin-top:10px; background:#1e3a8a;">Generate Video (TikTok)</button>
        </form>

        <h3>Batch Schedule to Zernio</h3>
        <p class="hint">One movie per line, format: <strong>Title | Hook</strong></p>
        <textarea id="batchList" rows="8" placeholder="Inception | A movie that will make you question reality.
The Prestige | Two magicians, one obsession, no mercy."></textarea>

        <div class="row">
          <div>
            <label>Template</label>
            <select id="batchTemplate">${templateOptions}</select>
          </div>
          <div>
            <label>Media type</label>
            <select id="batchMediaKind">
              <option value="image">Image (X)</option>
              <option value="video">Video (TikTok)</option>
            </select>
          </div>
        </div>

        <div class="row">
          <div>
            <label>Interval (minutes apart)</label>
            <input id="batchInterval" type="number" min="1" value="10"/>
          </div>
          <div id="batchVideoSecondsWrap" style="display:none;">
            <label>Video length (sec, 2-4)</label>
            <input id="batchVideoSeconds" type="number" min="2" max="4" value="3"/>
          </div>
        </div>

        <label>Start time</label>
        <input id="batchStart" type="datetime-local"/>

        <label>Generate each post this many minutes before its slot</label>
        <input id="batchLeadMinutes" type="number" min="1" value="5"/>
        <p class="hint">Media isn't rendered upfront — each item is generated and uploaded shortly before it's due, spreading the work out over the whole run.</p>

        <div class="row">
          <div>
            <label>Platform</label>
            <input id="batchPlatform" placeholder="tiktok" value="${ZERNIO_DEFAULT_PLATFORM}"/>
          </div>
          <div>
            <label>Zernio account ID</label>
            <input id="batchAccountId" placeholder="acc_xyz789" value="${ZERNIO_DEFAULT_ACCOUNT_ID}"/>
          </div>
        </div>

        <button id="batchSubmit">Schedule Batch</button>
        <p class="hint" id="batchProgress"></p>
        <div id="batchResults"></div>
        <div id="batchSummary" style="margin-top:10px; font-size:13px; color:#93c5fd;"></div>

        <script>
          const btn = document.getElementById('batchSubmit');
          const resultsEl = document.getElementById('batchResults');
          const summaryEl = document.getElementById('batchSummary');
          const progressEl = document.getElementById('batchProgress');
          const mediaKindSel = document.getElementById('batchMediaKind');
          const videoSecondsWrap = document.getElementById('batchVideoSecondsWrap');

          let pollTimer = null;

          mediaKindSel.addEventListener('change', () => {
            videoSecondsWrap.style.display = mediaKindSel.value === 'video' ? 'block' : 'none';
          });

          function renderStatus(data) {
            summaryEl.textContent =
              data.total + ' total — ' +
              data.done + ' done, ' +
              data.processing + ' processing, ' +
              data.pending + ' waiting, ' +
              data.failed + ' failed';

            resultsEl.textContent = data.jobs.map(j => {
              const when = j.status === 'done' || j.status === 'processing'
                ? 'slot ' + j.scheduledFor
                : 'generates at ' + j.generateAt + ', slot ' + j.scheduledFor;
              const extra = j.status === 'failed' ? ' — ' + j.error : '';
              return '[' + j.status.toUpperCase() + '] ' + j.title + ' (' + j.mediaKind + ') — ' + when + extra;
            }).join('\\n');
          }

          async function pollBatch(batchId) {
            try {
              const res = await fetch('/batch-status/' + batchId);
              const data = await res.json();
              renderStatus(data);

              if (data.pending === 0 && data.processing === 0) {
                progressEl.textContent = 'Batch complete.';
                clearInterval(pollTimer);
                pollTimer = null;
              }
            } catch (err) {
              progressEl.textContent = 'Status check failed: ' + err.message;
            }
          }

          btn.addEventListener('click', async () => {
            const lines = document.getElementById('batchList').value
              .split('\\n')
              .map(l => l.trim())
              .filter(Boolean);

            const items = lines.map(line => {
              const [title, ...hookParts] = line.split('|');
              return { title: (title || '').trim(), hook: hookParts.join('|').trim() };
            }).filter(i => i.title && i.hook);

            if (!items.length) {
              resultsEl.textContent = 'No valid lines found. Use: Title | Hook';
              return;
            }

            const startVal = document.getElementById('batchStart').value;
            if (!startVal) {
              resultsEl.textContent = 'Pick a start time.';
              return;
            }

            const mediaKind = mediaKindSel.value;

            const payload = {
              items,
              template: document.getElementById('batchTemplate').value,
              mediaKind,
              videoSeconds: parseInt(document.getElementById('batchVideoSeconds').value, 10) || 3,
              intervalMinutes: parseInt(document.getElementById('batchInterval').value, 10) || 10,
              leadMinutes: parseInt(document.getElementById('batchLeadMinutes').value, 10) || 5,
              startTime: new Date(startVal).toISOString(),
              platform: document.getElementById('batchPlatform').value.trim(),
              accountId: document.getElementById('batchAccountId').value.trim()
            };

            btn.disabled = true;
            btn.textContent = 'Queuing ' + items.length + ' posts...';
            resultsEl.textContent = '';
            summaryEl.textContent = '';
            progressEl.textContent = 'Queuing...';
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

            try {
              const res = await fetch('/schedule-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });
              const data = await res.json();

              if (!res.ok) {
                progressEl.textContent = '';
                resultsEl.textContent = 'Error: ' + (data.error || 'unknown error');
                return;
              }

              progressEl.textContent = 'Queued. Generating each post shortly before its slot — checking progress every 5s...';
              pollBatch(data.batchId);
              pollTimer = setInterval(() => pollBatch(data.batchId), 5000);
            } catch (err) {
              progressEl.textContent = '';
              resultsEl.textContent = 'Error: ' + err.message;
            } finally {
              btn.disabled = false;
              btn.textContent = 'Schedule Batch';
            }
          });
        </script>
      </body>
    </html>
  `);
});

app.get('/generate', async (req, res) => {
  try {
    const { title, hook, template, image, lang } = req.query;
    if (!title) return res.status(400).json({ error: 'title query param is required' });
    if (!hook) return res.status(400).json({ error: 'hook query param is required — write your own caption' });

    const imageType = ['poster', 'backdrop', 'logo'].includes(image) ? image : 'poster';
    const movie = await fetchMovie(title, TMDB_API_KEY, { imageType, language: lang });

    const imageBuffer = await generatePosterImage({
      posterUrl: movie.posterUrl,
      title: movie.title,
      hook,
      rating: movie.rating,
      genres: movie.genres,
      templateKey: template,
      layout: LAYOUT_POST
    });

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', `inline; filename="${movie.title.replace(/\s+/g, '_')}.jpg"`);
    res.send(imageBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// TikTok-ready short video: same pipeline, vertical 9:16 layout,
// then a Ken Burns zoom turns the still into a few seconds of motion.
app.get('/generate-video', async (req, res) => {
  try {
    const { title, hook, template, image, lang, seconds } = req.query;
    if (!title) return res.status(400).json({ error: 'title query param is required' });
    if (!hook) return res.status(400).json({ error: 'hook query param is required — write your own caption' });

    const imageType = ['poster', 'backdrop', 'logo'].includes(image) ? image : 'poster';
    const movie = await fetchMovie(title, TMDB_API_KEY, { imageType, language: lang });

    const imageBuffer = await generatePosterImage({
      posterUrl: movie.posterUrl,
      title: movie.title,
      hook,
      rating: movie.rating,
      genres: movie.genres,
      templateKey: template,
      layout: LAYOUT_VIDEO
    });

    const duration = Math.min(Math.max(parseInt(seconds, 10) || 3, 2), 4);
    const videoBuffer = await imageToVideo(imageBuffer, LAYOUT_VIDEO, duration);

    res.set('Content-Type', 'video/mp4');
    res.set('Content-Disposition', `inline; filename="${movie.title.replace(/\s+/g, '_')}.mp4"`);
    res.send(videoBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Batch schedule: takes a list of { title, hook } items and enqueues one
// job per item. Each job only generates its poster/video, uploads it to
// Zernio, and creates the scheduled post once `generateAt` arrives — by
// default `leadMinutes` before its `scheduledFor` slot — instead of doing
// all the heavy work upfront. Returns immediately with a batchId to poll.
//
// Body:
// {
//   items: [{ title, hook, template?, image?, lang?, mediaKind? }, ...],
//   template: "tonights_pick",        // default template if item doesn't override
//   mediaKind: "image" | "video",     // default media kind, "image" if omitted
//   videoSeconds: 3,                  // Ken Burns clip length, 2-4s, video only
//   intervalMinutes: 10,              // spacing between each post's scheduledFor
//   leadMinutes: 5,                   // how long before scheduledFor to generate+upload
//   startTime: "2026-08-14T18:00:00.000Z",
//   platform: "tiktok",
//   accountId: "acc_xyz789",
//   timezone: "America/New_York"      // optional, defaults to UTC
// }
app.post('/schedule-batch', async (req, res) => {
  try {
    const {
      items, template, intervalMinutes, startTime,
      platform, accountId, timezone,
      mediaKind, videoSeconds, leadMinutes
    } = req.body || {};

    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items must be a non-empty array of { title, hook }' });
    }
    if (!startTime) return res.status(400).json({ error: 'startTime is required (ISO datetime)' });
    if (!platform) return res.status(400).json({ error: 'platform is required (e.g. "tiktok")' });
    if (!accountId) return res.status(400).json({ error: 'accountId is required (your Zernio account ID)' });

    const defaultMediaKind = mediaKind === 'video' ? 'video' : 'image';
    const spacingMs = Math.max(parseInt(intervalMinutes, 10) || 10, 1) * 60 * 1000;
    const leadMs = Math.max(parseInt(leadMinutes, 10) || 5, 1) * 60 * 1000;
    const startMs = new Date(startTime).getTime();
    if (Number.isNaN(startMs)) return res.status(400).json({ error: 'startTime is not a valid date' });

    const batchId = crypto.randomUUID();
    const now = Date.now();

    const newJobs = items.map(item => {
      const idx = items.indexOf(item);
      const scheduledForMs = startMs + idx * spacingMs;
      const scheduledForIso = new Date(scheduledForMs).toISOString().slice(0, 19);

      // If the slot is sooner than the requested lead time, generate right away
      // instead of computing a generateAt time in the past.
      const generateAtMs = Math.max(scheduledForMs - leadMs, now);
      const itemMediaKind = item.mediaKind === 'video' || item.mediaKind === 'image'
        ? item.mediaKind
        : defaultMediaKind;

      const hasRequiredFields = Boolean(item.title && item.hook);

      return {
        id: crypto.randomUUID(),
        batchId,
        title: item.title || '',
        hook: item.hook || '',
        template: item.template || template,
        imageType: ['poster', 'backdrop', 'logo'].includes(item.image) ? item.image : 'poster',
        lang: item.lang,
        mediaKind: itemMediaKind,
        videoSeconds,
        platform,
        accountId,
        timezone,
        scheduledFor: scheduledForIso,
        generateAt: new Date(generateAtMs).toISOString(),
        status: hasRequiredFields ? 'pending' : 'failed',
        error: hasRequiredFields ? null : 'Each item needs a title and hook',
        result: null
      };
    });

    queue.push(...newJobs);
    await saveQueue();

    // Kick off a check right away in case some jobs are already due
    // (e.g. leadMinutes longer than the gap to the first slot).
    processDueJobs();

    res.json({
      batchId,
      queued: newJobs.length,
      jobs: newJobs.map(j => ({
        id: j.id, title: j.title, mediaKind: j.mediaKind,
        scheduledFor: j.scheduledFor, generateAt: j.generateAt, status: j.status
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Poll this to see progress on a batch: how many jobs are pending
// (waiting for their generateAt time), processing, done, or failed.
app.get('/batch-status/:batchId', (req, res) => {
  const jobs = queue.filter(j => j.batchId === req.params.batchId);
  if (!jobs.length) return res.status(404).json({ error: 'Batch not found' });

  res.json({
    batchId: req.params.batchId,
    total: jobs.length,
    pending: jobs.filter(j => j.status === 'pending').length,
    processing: jobs.filter(j => j.status === 'processing').length,
    done: jobs.filter(j => j.status === 'done').length,
    failed: jobs.filter(j => j.status === 'failed').length,
    jobs: jobs.map(j => ({
      id: j.id, title: j.title, mediaKind: j.mediaKind,
      scheduledFor: j.scheduledFor, generateAt: j.generateAt,
      status: j.status, error: j.error, result: j.result
    }))
  });
});

loadQueue()
  .then(() => processDueJobs()) // in case any persisted jobs were already due at boot
  .then(() => {
    setInterval(processDueJobs, 30 * 1000); // check for due jobs every 30s
    app.listen(PORT, () => {
      console.log(`Poster generator running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
