// ─────────────────────────────────────────────────────────────────
// Movie Poster Generator — single-file version
// Title in -> TMDB fetch -> branded 1080x1350 PNG out
//
// Setup:
//   npm install express node-fetch@2 sharp dotenv
//   Create a .env file with: TMDB_API_KEY=your_key_here
//   node app.js
//   Open http://localhost:3000
// ─────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

const TMDB_BASE = 'https://api.themoviedb.org/3';
// w500 instead of w780 -> smaller download from TMDB, faster generation
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1350;
const POSTER_HEIGHT = 950;
const TEXT_HEIGHT = CANVAS_HEIGHT - POSTER_HEIGHT;
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

function buildOverlaySvg({ title, hook, rating, genres, templateKey }) {
  const template = TEMPLATES[templateKey] || TEMPLATES.tonights_pick;
  const hookLines = wrapText(hook || '', 42).slice(0, 3);
  const genreText = escapeXml((genres || []).slice(0, 2).join(' / '));

  const hookTspans = hookLines
    .map((line, i) => `<tspan x="50%" dy="${i === 0 ? 0 : 44}">${escapeXml(line)}</tspan>`)
    .join('');

  return `
  <svg width="${CANVAS_WIDTH}" height="${CANVAS_HEIGHT}">
    <defs>
      <style>
        .label { font: 700 34px sans-serif; fill: ${template.accent}; letter-spacing: 2px; }
        .title { font: 800 56px sans-serif; fill: #ffffff; }
        .hook { font: 400 34px sans-serif; fill: #e6e6e6; }
        .meta { font: 600 30px sans-serif; fill: #ffffff; }
      </style>
    </defs>

    <rect x="0" y="${POSTER_HEIGHT}" width="${CANVAS_WIDTH}" height="${TEXT_HEIGHT}" fill="#0d0d0d"/>
    <rect x="0" y="${POSTER_HEIGHT}" width="${CANVAS_WIDTH}" height="6" fill="${template.accent}"/>

    <text x="50%" y="${POSTER_HEIGHT + 65}" text-anchor="middle" class="label">${escapeXml(template.label)}</text>
    <text x="50%" y="${POSTER_HEIGHT + 125}" text-anchor="middle" class="title">${escapeXml(title)}</text>
    <text x="50%" y="${POSTER_HEIGHT + 190}" text-anchor="middle" class="hook">${hookTspans}</text>

    <text x="50%" y="${CANVAS_HEIGHT - 40}" text-anchor="middle" class="meta">
      ${rating ? `⭐ ${escapeXml(String(rating))}/10` : ''}${rating && genreText ? '   •   ' : ''}${genreText}
    </text>
  </svg>`;
}

async function generatePosterImage({ posterUrl, title, hook, rating, genres, templateKey }) {
  const posterRes = await fetch(posterUrl);
  if (!posterRes.ok) throw new Error(`Failed to download poster: ${posterRes.status}`);
  const posterBuffer = Buffer.from(await posterRes.arrayBuffer());

  const posterResized = await sharp(posterBuffer)
    .resize(CANVAS_WIDTH, POSTER_HEIGHT, { fit: 'cover' })
    .toBuffer();

  const overlaySvg = buildOverlaySvg({ title, hook, rating, genres, templateKey });

  return sharp({
    create: {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
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
            max-width: 480px;
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
          input::placeholder, textarea::placeholder {
            color: #6b84ab;
          }
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
          button:hover {
            background: #1d4ed8;
          }
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

          <button type="submit">Generate</button>
        </form>
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
      templateKey: template
    });

    res.set('Content-Type', 'image/jpeg');
    res.set('Content-Disposition', `inline; filename="${movie.title.replace(/\s+/g, '_')}.jpg"`);
    res.send(imageBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Poster generator running at http://localhost:${PORT}`);
});
