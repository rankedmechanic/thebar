#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// TheBar — Production Server (Railway / any Node host)
// Zero npm dependencies — uses only Node built-ins.
// Serves static files from ./public and proxies AI calls.
// Supports: Anthropic Claude | OpenAI GPT-4o | Google Gemini
// ════════════════════════════════════════════════════════════════

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── MIME types ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
};

// ── Security headers ────────────────────────────────────────────
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// ── Allowed origin check ────────────────────────────────────────
const ALLOWED = [
  /\.vercel\.app$/,
  /\.railway\.app$/,
  /^https:\/\/thebar\./,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];
const originOK = o => !o || ALLOWED.some(r => r.test(o));

// ── Per-IP rate limiter ─────────────────────────────────────────
const RL = new Map();
function rlOK(ip) {
  const now = Date.now(), win = 60_000, max = 25;
  const r = RL.get(ip) || { c: [] };
  r.c = r.c.filter(t => now - t < win);
  if (r.c.length >= max) return false;
  r.c.push(now); RL.set(ip, r); return true;
}

// ── HTTPS request helper ────────────────────────────────────────
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── JSON response helper ────────────────────────────────────────
function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SEC,
    ...extraHeaders,
  });
  res.end(body);
}

// ════════════════════════════════════════════════════════════════
// AI PROXY  (/api/claude)
// Supports anthropic | openai | gemini via X-Provider header
// Key priority: env var → user-supplied X-User-Key header
// ════════════════════════════════════════════════════════════════
async function handleProxy(req, res) {
  const origin = req.headers['origin'] || '';
  const corsO = originOK(origin) ? (origin || '*') : 'null';
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsO,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Provider, X-User-Key',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method not allowed.' }, corsHeaders);
  }

  // Rate limit by IP
  const ip = (req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || req.socket.remoteAddress || 'anon';
  if (!rlOK(ip)) {
    return sendJSON(res, 429, { error: 'Too many requests — please wait a moment.' }, corsHeaders);
  }

  // Read and parse body
  const raw = await new Promise((ok, fail) => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > 200_000) fail(new Error('Body too large'));
    });
    req.on('end', () => ok(d));
    req.on('error', fail);
  }).catch(() => null);

  if (!raw) return sendJSON(res, 400, { error: 'Bad request body.' }, corsHeaders);

  let body;
  try { body = JSON.parse(raw); }
  catch { return sendJSON(res, 400, { error: 'Invalid JSON.' }, corsHeaders); }

  const provider = (req.headers['x-provider'] || body._provider || 'gemini').toLowerCase();
  delete body._provider;
  const userKey = (req.headers['x-user-key'] || '').trim();
  const clamp = (v, d, mx) => Math.min(v || d, mx);

  // ── ANTHROPIC ──────────────────────────────────────────────────
  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY || userKey;
    if (!key) return sendJSON(res, 401, {
      error: 'No Anthropic API key. Set ANTHROPIC_API_KEY env var or enter one in Settings.',
    }, corsHeaders);

    const payload = JSON.stringify({
      model: body.model || 'claude-sonnet-4-6',
      max_tokens: clamp(body.max_tokens, 4096, 8192),
      messages: body.messages || [],
      ...(body.system ? { system: body.system } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    });

    let up;
    try {
      up = await httpsPost(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        payload
      );
    } catch {
      return sendJSON(res, 502, { error: 'Could not reach Anthropic API.' }, corsHeaders);
    }

    let d;
    try { d = JSON.parse(up.body); } catch { d = {}; }
    if (up.status !== 200) {
      return sendJSON(res, up.status, { error: d?.error?.message || `Anthropic error ${up.status}` }, corsHeaders);
    }
    return sendJSON(res, 200, d, corsHeaders);
  }

  // ── OPENAI ─────────────────────────────────────────────────────
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY || userKey;
    if (!key) return sendJSON(res, 401, {
      error: 'No OpenAI API key. Set OPENAI_API_KEY env var or enter one in Settings.',
    }, corsHeaders);

    const msgs = [];
    if (body.system) msgs.push({ role: 'system', content: body.system });
    (body.messages || []).forEach(m => msgs.push(m));

    const payload = JSON.stringify({
      model: body.model || 'gpt-4o',
      max_tokens: clamp(body.max_tokens, 4096, 8192),
      messages: msgs,
    });

    let up;
    try {
      up = await httpsPost(
        'https://api.openai.com/v1/chat/completions',
        { Authorization: `Bearer ${key}` },
        payload
      );
    } catch {
      return sendJSON(res, 502, { error: 'Could not reach OpenAI API.' }, corsHeaders);
    }

    let d;
    try { d = JSON.parse(up.body); } catch { d = {}; }
    if (up.status !== 200) {
      return sendJSON(res, up.status, { error: d?.error?.message || `OpenAI error ${up.status}` }, corsHeaders);
    }
    return sendJSON(res, 200, {
      content: [{ type: 'text', text: d.choices?.[0]?.message?.content || '' }],
    }, corsHeaders);
  }

  // ── GEMINI ─────────────────────────────────────────────────────
  if (provider === 'gemini') {
    const key = process.env.GEMINI_API_KEY || userKey;
    if (!key) return sendJSON(res, 401, {
      error: 'No Gemini API key. Set GEMINI_API_KEY env var or enter one in Settings.',
    }, corsHeaders);

    const parts = [];
    if (body.system) parts.push({ text: body.system + '\n\n' });
    (body.messages || []).forEach(m =>
      parts.push({ text: (m.role === 'user' ? '' : 'Assistant: ') + m.content })
    );

    const model = body.model || 'gemini-2.0-flash';
    const payload = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: clamp(body.max_tokens, 4096, 8192) },
    });

    let up;
    try {
      up = await httpsPost(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {},
        payload
      );
    } catch {
      return sendJSON(res, 502, { error: 'Could not reach Gemini API.' }, corsHeaders);
    }

    let d;
    try { d = JSON.parse(up.body); } catch { d = {}; }
    if (up.status !== 200) {
      return sendJSON(res, up.status, { error: d?.error?.message || `Gemini error ${up.status}` }, corsHeaders);
    }
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return sendJSON(res, 200, { content: [{ type: 'text', text }] }, corsHeaders);
  }

  return sendJSON(res, 400, { error: `Unknown provider: ${provider}` }, corsHeaders);
}

// ════════════════════════════════════════════════════════════════
// STATIC FILE SERVER
// ════════════════════════════════════════════════════════════════
function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback — always serve index.html for unknown routes
      const idx = path.join(PUBLIC, 'index.html');
      fs.readFile(idx, (e2, data) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-cache',
          ...SEC,
        });
        res.end(data);
      });
      return;
    }

    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': cache,
      ...SEC,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ════════════════════════════════════════════════════════════════
// HTTP SERVER
// ════════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  // Redirect HTTP → HTTPS in production
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto !== 'https' && process.env.NODE_ENV === 'production') {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
    return;
  }

  const url = req.url.split('?')[0].replace(/\/+$/, '') || '/';

  // Health check endpoint
  if (url === '/health' || url === '/api/health') {
    sendJSON(res, 200, {
      status: 'ok',
      version: '6.1.0',
      ts: new Date().toISOString(),
    });
    return;
  }

  // AI proxy endpoint
  if (url === '/api/claude') {
    try {
      await handleProxy(req, res);
    } catch (e) {
      console.error('[proxy error]', e.message);
      sendJSON(res, 500, { error: 'Internal server error.' });
    }
    return;
  }

  // Static file serving
  const safePath = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC, safePath === '/' ? 'index.html' : safePath);

  // Prevent path traversal attacks
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  serveFile(filePath, res);
});

server.listen(PORT, () => {
  console.log(`\n🏛️  TheBar running on http://localhost:${PORT}`);
  console.log(`   Gemini:  ${process.env.GEMINI_API_KEY ? '✓ GEMINI_API_KEY set (primary)' : '⚠ No GEMINI_API_KEY — add it in Railway Variables'}`);
  console.log(`   Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓ ANTHROPIC_API_KEY set' : '○ Not set (optional)'}`);
  console.log(`   OpenAI:  ${process.env.OPENAI_API_KEY ? '✓ OPENAI_API_KEY set' : '○ Not set (optional)'}`);
  console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}\n`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
