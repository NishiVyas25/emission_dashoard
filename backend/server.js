require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Simple memory cache for search results (keep small)
const searchCache = new Map(); // key -> { ts, data }
const SEARCH_CACHE_TTL = 1000 * 60 * 2; // 2 minutes

// --- Sample in-memory emissions data (kept simple for demo)
const emissionsData = [
  { year: 2010, sector: 'Energy', value: 20.5 },
  { year: 2010, sector: 'Transport', value: 7.3 },
  { year: 2010, sector: 'Industry', value: 6.1 },
  { year: 2010, sector: 'Buildings', value: 4.2 },
  { year: 2010, sector: 'Agriculture', value: 5.0 },
  { year: 2010, sector: 'Waste', value: 1.4 },

  { year: 2015, sector: 'Energy', value: 22.0 },
  { year: 2015, sector: 'Transport', value: 8.0 },
  { year: 2015, sector: 'Industry', value: 6.8 },
  { year: 2015, sector: 'Buildings', value: 4.5 },
  { year: 2015, sector: 'Agriculture', value: 5.3 },
  { year: 2015, sector: 'Waste', value: 1.6 },

  { year: 2020, sector: 'Energy', value: 21.0 },
  { year: 2020, sector: 'Transport', value: 7.8 },
  { year: 2020, sector: 'Industry', value: 7.2 },
  { year: 2020, sector: 'Buildings', value: 4.8 },
  { year: 2020, sector: 'Agriculture', value: 5.5 },
  { year: 2020, sector: 'Waste', value: 1.7 },
];

const rateLimitMap = {}; // { ip: lastTimestamp }
const MIN_INTERVAL_MS = 800; // minimal ms between requests per IP

// Get all years and sectors available
app.get('/api/meta', (req, res) => {
  const years = Array.from(new Set(emissionsData.map(d => d.year))).sort((a, b) => a - b);
  const sectors = Array.from(new Set(emissionsData.map(d => d.sector))).sort();
  res.json({ years, sectors });
});

app.get('/api/emissions', (req, res) => {
  const { year, sector } = req.query;
  let filtered = emissionsData;

  if (year) filtered = filtered.filter(d => d.year === Number(year));
  if (sector && sector !== 'All') filtered = filtered.filter(d => d.sector === sector);

  res.json(filtered);
});

app.get('/api/summary', (req, res) => {
  const year = Number(req.query.year) || 2020;
  const dataForYear = emissionsData.filter(d => d.year === year);

  const summary = {};
  dataForYear.forEach(d => {
    summary[d.sector] = (summary[d.sector] || 0) + d.value;
  });

  res.json({ year, summary });
});

// GET /api/search?q=your+query
app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q param required' });

    // simple cache key
    const cacheKey = `cse:${q}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < SEARCH_CACHE_TTL) {
      return res.json({ cached: true, ...cached.data });
    }

    // require env keys
    const API_KEY = process.env.GOOGLE_API_KEY;
    const CX = process.env.GOOGLE_CX;
    if (!API_KEY || !CX) {
      return res.status(500).json({ error: 'Server missing GOOGLE_API_KEY or GOOGLE_CX in .env' });
    }

    const url = 'https://www.googleapis.com/customsearch/v1';
    const params = {
      key: API_KEY,
      cx: CX,
      q,
      num: 5, // limit to 5 results to stay within quota (change if needed)
    };

    const r = await axios.get(url, { params, timeout: 8000 });

    // store limited payload in cache
    const payload = { results: r.data.items || [], raw: r.data };
    searchCache.set(cacheKey, { ts: Date.now(), data: payload });

    res.json(payload);
  } catch (err) {
    console.error('CSE error', err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    const details = err?.response?.data || err?.message;
    res.status(status).json({ error: 'customsearch failed', details });
  }
});

// --- Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const last = rateLimitMap[ip] || 0;
    if (now - last < MIN_INTERVAL_MS) {
      return res.status(429).json({ answer: 'Too many requests — slow down a bit.', source: 'rate-limit' });
    }
    rateLimitMap[ip] = now;

    // --- IMPORTANT: read both message and internet flag from request
    const { message } = req.body;
    const lower = (message || '').toLowerCase().trim();
    
    // --- Local data-intent detection and answers
    const isDataQuestion =
      lower.includes('year') ||
      lower.includes('sector') ||
      lower.includes('dashboard') ||
      lower.includes('highest') ||
      lower.includes('top');

    if (isDataQuestion) {
      const yearMatch = lower.match(/20\d{2}/);
      const year = yearMatch ? Number(yearMatch[0]) : 2020;
      const dataForYear = emissionsData.filter(d => d.year === year);
      if (dataForYear.length === 0) {
        return res.json({ answer: `In this dashboard, there is no data available for year ${year}.`, source: 'local' });
      }
      const sorted = [...dataForYear].sort((a, b) => b.value - a.value);
      const top = sorted[0];
      const listText = sorted.map(d => `${d.sector}: ${d.value} MtCO₂e`).join('; ');
      return res.json({
        answer: `In ${year}, the highest emitting sector in this dashboard is ${top.sector} with ${top.value} MtCO₂e. Full breakdown: ${listText}.`,
        source: 'local',
      });
    }
    
    // General fallback answers
    let answer;
    if (lower.includes('transport')) {
      answer = 'Transport emissions mainly come from road vehicles, aviation and shipping. Solutions: EVs, public transport, fuel efficiency.';
    } else if (lower.includes('energy')) {
      answer = 'The energy sector (electricity & heat) is usually the largest source of global emissions. Renewables and efficiency help reduce it.';
    } else if (lower.includes('agriculture')) {
      answer = 'Agriculture emits methane and nitrous oxide from livestock and fertilisers. Improved practices and dietary shifts help.';
    } else {
      answer = 'This dashboard compares sectors over time. Ask e.g. "Which sector is highest in 2020?" for local data, or "India latest emissions" to demo internet queries.';
    }
    return res.json({ answer, source: 'general-info' });
  } catch (err) {
    console.error('[CHAT] Unexpected error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ answer: 'Server error in chat handler.', source: 'server-error', error: err.message || 'unknown' });
  }
});

// --- Serve React build in production (optional)
if (process.env.NODE_ENV === 'production') {
  const buildPath = path.join(__dirname, '..', 'frontend', 'emissions-frontend', 'build');
  app.use(express.static(buildPath));
  app.get('/*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
