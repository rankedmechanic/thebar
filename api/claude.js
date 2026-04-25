// ════════════════════════════════════════════════════════════════
// TheBar — Secure AI Proxy  (Vercel Serverless Function)
// Supports: Anthropic Claude | OpenAI GPT-4o | Google Gemini
// Key priority: env var → user-supplied key (header X-User-Key)
// ════════════════════════════════════════════════════════════════

export const config = { maxDuration: 60 };

// ── Allowed origins ─────────────────────────────────────────────
const ALLOWED = [
  /\.vercel\.app$/,
  /\.railway\.app$/,
  /^https:\/\/thebar\./,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];
const originOK = o => !o || ALLOWED.some(r => r.test(o));

const corsH = o => ({
  'Access-Control-Allow-Origin': originOK(o) ? (o || '*') : 'null',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Provider, X-User-Key',
  'Access-Control-Max-Age': '86400',
});

// ── Per-instance rate limiter ───────────────────────────────────
const RL = new Map();
function rlOK(ip) {
  const now = Date.now(), win = 60_000, max = 25;
  const r = RL.get(ip) || { c: [] };
  r.c = r.c.filter(t => now - t < win);
  if (r.c.length >= max) return false;
  r.c.push(now); RL.set(ip, r); return true;
}

// ── Helpers ─────────────────────────────────────────────────────
const J = (s, b, h = {}) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { 'Content-Type': 'application/json', ...h },
  });

const clamp = (v, d, mx) => Math.min(v || d, mx);

// ════════════════════════════════════════════════════════════════
export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const ch = corsH(origin);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
  if (req.method !== 'POST') return J(405, { error: 'Method not allowed.' }, ch);

  // Rate limit by IP
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip') || 'anon';
  if (!rlOK(ip)) return J(429, { error: 'Too many requests — please wait a moment.' }, ch);

  // Parse body
  let body;
  try { body = await req.json(); }
  catch { return J(400, { error: 'Invalid JSON body.' }, ch); }

  const provider = (
    req.headers.get('x-provider') || body._provider || 'gemini'
  ).toLowerCase();
  delete body._provider;

  const userKey = (req.headers.get('x-user-key') || '').trim();

  // ── ANTHROPIC ─────────────────────────────────────────────────
  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY || userKey;
    if (!key) return J(401, {
      error: 'No Anthropic API key. Add ANTHROPIC_API_KEY to env vars or supply one in Settings.',
    }, ch);

    const payload = {
      model: body.model || 'claude-sonnet-4-6',
      max_tokens: clamp(body.max_tokens, 4096, 8192),
      messages: body.messages || [],
      ...(body.system ? { system: body.system } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    };

    let up;
    try {
      up = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
    } catch { return J(502, { error: 'Could not reach Anthropic API.' }, ch); }

    const d = await up.json();
    if (!up.ok) return J(up.status, { error: d?.error?.message || `Anthropic error ${up.status}` }, ch);
    return J(200, d, ch);
  }

  // ── OPENAI ────────────────────────────────────────────────────
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY || userKey;
    if (!key) return J(401, {
      error: 'No OpenAI API key. Add OPENAI_API_KEY to env vars or supply one in Settings.',
    }, ch);

    const msgs = [];
    if (body.system) msgs.push({ role: 'system', content: body.system });
    (body.messages || []).forEach(m => msgs.push(m));

    let up;
    try {
      up = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: body.model || 'gpt-4o',
          max_tokens: clamp(body.max_tokens, 4096, 8192),
          messages: msgs,
        }),
      });
    } catch { return J(502, { error: 'Could not reach OpenAI API.' }, ch); }

    const d = await up.json();
    if (!up.ok) return J(up.status, { error: d?.error?.message || `OpenAI error ${up.status}` }, ch);
    return J(200, { content: [{ type: 'text', text: d.choices?.[0]?.message?.content || '' }] }, ch);
  }

  // ── GEMINI ────────────────────────────────────────────────────
  if (provider === 'gemini') {
    const key = process.env.GEMINI_API_KEY || userKey;
    if (!key) return J(401, {
      error: 'No Gemini API key. Add GEMINI_API_KEY to env vars or supply one in Settings.',
    }, ch);

    const parts = [];
    if (body.system) parts.push({ text: body.system + '\n\n' });
    (body.messages || []).forEach(m =>
      parts.push({ text: (m.role === 'user' ? '' : 'Assistant: ') + m.content })
    );

    const model = body.model || 'gemini-2.0-flash';
    let up;
    try {
      up = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { maxOutputTokens: clamp(body.max_tokens, 4096, 8192) },
          }),
        }
      );
    } catch { return J(502, { error: 'Could not reach Gemini API.' }, ch); }

    const d = await up.json();
    if (!up.ok) return J(up.status, { error: d?.error?.message || `Gemini error ${up.status}` }, ch);
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return J(200, { content: [{ type: 'text', text }] }, ch);
  }

  return J(400, { error: `Unknown provider: ${provider}` }, ch);
}
