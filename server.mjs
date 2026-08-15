// RÊVE — adapter Node para rodar o Cloudflare Worker (worker.js) na VPS.
// Uso: node server.mjs  (exige ANTHROPIC_API_KEY no ambiente; porta 8790)
//
// v4: a rota POST /api/tts (voz da Camille) vive AQUI, não no worker:
// chama a OpenAI TTS e guarda o mp3 em ./tts-cache/<sha1(text+voice)>.mp3
// (no container, /app/tts-cache). Cada frase é paga UMA vez; depois é disco.
// Exige OPENAI_API_KEY no ambiente (o deploy usa --env-file /root/reve/.env).
//
// v5: save na nuvem por código (/api/save/new, /api/save) e Ligue RÊVE
// semanal (/api/league/score, /api/league/top). Tudo em disco: ./saves e
// ./league (no container, /app/saves e /app/league — volume /root/reve).
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import worker from './worker.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8790;
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const env = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  MODEL: process.env.MODEL,
  MODEL_CHAT: process.env.MODEL_CHAT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ASSETS: {
    fetch: async () => new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
    })
  }
};

/* ------------------------------------------------------------------ */
/* /api/tts — voz da Camille (OpenAI TTS) com cache em disco           */
/* ------------------------------------------------------------------ */

const TTS_URL = 'https://api.openai.com/v1/audio/speech';
const TTS_MODEL = process.env.TTS_MODEL || 'gpt-4o-mini-tts';
const TTS_OPENAI_VOICE = 'nova';
const TTS_INSTRUCTIONS =
  'Fale em francês nativo parisiense, tom caloroso e vivo de uma amiga de 28 anos';
const TTS_MAX_TEXT = 300;
const TTS_TIMEOUT_MS = 30000;
const TTS_DIR = fileURLToPath(new URL('./tts-cache/', import.meta.url));

const TTS_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
  'access-control-max-age': '86400'
};

function ttsJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...TTS_CORS
  });
  res.end(body);
}

function ttsAudio(res, mp3, cacheState) {
  res.writeHead(200, {
    'content-type': 'audio/mpeg',
    'content-length': String(mp3.length),
    'cache-control': 'public, max-age=31536000, immutable',
    'x-tts-cache': cacheState,
    ...TTS_CORS
  });
  res.end(mp3);
}

async function handleTts(req, res, rawBody) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, TTS_CORS);
    return res.end();
  }
  if (req.method !== 'POST') {
    return ttsJson(res, 405, { error: 'Use POST em /api/tts.' });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    return ttsJson(res, 400, { error: 'Corpo inválido: envie JSON.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ttsJson(res, 400, { error: 'Corpo inválido: envie JSON.' });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return ttsJson(res, 400, { error: 'text vazio.' });
  if (text.length > TTS_MAX_TEXT) {
    return ttsJson(res, 400, { error: 'text longo demais (máx. 300 caracteres).' });
  }
  const voice = body.voice == null || body.voice === '' ? 'camille' : String(body.voice);
  if (voice !== 'camille') {
    return ttsJson(res, 400, { error: 'voice inválida: use "camille".' });
  }

  // Cache primeiro: a mesma frase nunca é paga duas vezes.
  const hash = createHash('sha1').update(text + '\n' + voice, 'utf8').digest('hex');
  const file = TTS_DIR + hash + '.mp3';
  if (existsSync(file)) {
    try {
      return ttsAudio(res, readFileSync(file), 'hit');
    } catch (_) {
      // arquivo sumiu/corrompeu entre o exists e o read: regenera abaixo
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    return ttsJson(res, 500, { error: 'Servidor sem OPENAI_API_KEY configurada.' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  let upstream;
  try {
    // tts-1 (fallback de conta sem gpt-4o-mini-tts) não aceita "instructions".
    const payload = {
      model: TTS_MODEL,
      voice: TTS_OPENAI_VOICE,
      input: text,
      response_format: 'mp3',
      ...(TTS_MODEL.startsWith('tts-1') ? {} : { instructions: TTS_INSTRUCTIONS })
    };
    upstream = await fetch(TTS_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: 'Bearer ' + process.env.OPENAI_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      return ttsJson(res, 504, { error: 'A voz demorou demais para responder. Tente de novo.' });
    }
    return ttsJson(res, 502, { error: 'Falha de rede ao gerar a voz.' });
  }
  clearTimeout(timer);

  if (upstream.status === 401 || upstream.status === 403) {
    return ttsJson(res, 502, { error: 'Chave da OpenAI recusada no servidor.' });
  }
  if (upstream.status === 429) {
    return ttsJson(res, 429, { error: 'Muitas vozes agora. Aguarde alguns segundos.' });
  }
  if (upstream.status !== 200) {
    return ttsJson(res, 502, { error: 'Serviço de voz instável agora (' + upstream.status + ').' });
  }

  const mp3 = Buffer.from(await upstream.arrayBuffer());
  if (!mp3.length) {
    return ttsJson(res, 502, { error: 'A voz veio vazia. Tente de novo.' });
  }

  // Grava no cache (tmp + rename = nunca serve arquivo pela metade).
  try {
    mkdirSync(TTS_DIR, { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    writeFileSync(tmp, mp3);
    renameSync(tmp, file);
  } catch (_) {
    // disco falhou: ainda assim entrega o áudio desta chamada
  }

  return ttsAudio(res, mp3, 'miss');
}

/* ------------------------------------------------------------------ */
/* Nuvem: save por código + Ligue RÊVE (v5, tudo em disco)             */
/* ------------------------------------------------------------------ */

const SAVES_DIR = fileURLToPath(new URL('./saves/', import.meta.url));
const LEAGUE_DIR = fileURLToPath(new URL('./league/', import.meta.url));
const SAVE_MAX_BYTES = 200 * 1024;
// Código legível: A-Z e 2-9 sem os ambíguos O/0/I/1.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^REVE-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const LEAGUE_XP_MAX = 5000;
const LEAGUE_TZ_MS = 3 * 3600 * 1000; // semana ISO no fuso UTC-3
const SAVE_WRITES_PER_MIN = 30; // por IP
const LEAGUE_UPSERT_MS = 60000; // 1 envio por minuto por código

const API_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
  'access-control-max-age': '86400'
};

function apiJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...API_CORS
  });
  res.end(body);
}

function parseJsonBody(rawBody) {
  try {
    const v = JSON.parse(rawBody.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function codeHash(code) {
  return createHash('sha1').update(code, 'utf8').digest('hex');
}

function savePath(code) {
  return SAVES_DIR + codeHash(code) + '.json';
}

// tmp + rename = nunca fica arquivo pela metade no disco.
function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function newSaveCode() {
  let s = 'REVE-';
  for (let i = 0; i < 8; i++) {
    if (i === 4) s += '-';
    s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return s;
}

/* rate limit simples em memória */

const saveWriteHits = new Map(); // ip -> [timestamps]
const leagueUpsertAt = new Map(); // sha1(code) -> timestamp

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '?';
}

function overSaveWriteLimit(ip) {
  if (saveWriteHits.size > 5000) saveWriteHits.clear(); // teto de memória
  const now = Date.now();
  const hits = (saveWriteHits.get(ip) || []).filter((t) => now - t < 60000);
  if (hits.length >= SAVE_WRITES_PER_MIN) {
    saveWriteHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  saveWriteHits.set(ip, hits);
  return false;
}

/* semana ISO (segunda a domingo) no fuso do jogo, UTC-3 */

function isoWeekKey(nowMs = Date.now()) {
  const d = new Date(nowMs - LEAGUE_TZ_MS);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)); // quinta da semana
  const week1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

function weekClosesInH(nowMs = Date.now()) {
  const local = nowMs - LEAGUE_TZ_MS;
  const d = new Date(local);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const monday = dayStart - ((d.getUTCDay() + 6) % 7) * 86400000;
  return Math.max(0, Math.ceil((monday + 7 * 86400000 - local) / 3600000));
}

function leaguePath(week) {
  return LEAGUE_DIR + week + '.json';
}

function readLeague(week) {
  const file = leaguePath(week);
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data && typeof data.players === 'object') return data;
    } catch (_) {
      // arquivo corrompido: recomeça a semana vazio
    }
  }
  return { week, players: {} };
}

// Ordena por xp; empate vai pra quem chegou primeiro naquele xp.
function rankLeague(players) {
  return Object.entries(players)
    .map(([id, p]) => ({ id, name: p.name, xp_week: p.xp_week, updated_at: p.updated_at }))
    .sort((a, b) => b.xp_week - a.xp_week || String(a.updated_at).localeCompare(String(b.updated_at)))
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function sanitizePlayerName(raw) {
  const name = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16)
    .trim();
  return name || 'Anônimo';
}

/* rotas de save */

function handleSaveNew(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, API_CORS);
    return res.end();
  }
  if (req.method !== 'POST') {
    return apiJson(res, 405, { error: 'Use POST em /api/save/new.' });
  }
  if (overSaveWriteLimit(clientIp(req))) {
    return apiJson(res, 429, { error: 'Muitas gravações agora. Aguarde um minuto.' });
  }
  mkdirSync(SAVES_DIR, { recursive: true });
  let code = '';
  for (let i = 0; i < 50; i++) {
    const candidate = newSaveCode();
    if (!existsSync(savePath(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return apiJson(res, 500, { error: 'Não consegui gerar um código novo. Tente de novo.' });
  }
  atomicWrite(savePath(code), JSON.stringify({ save: null, updated_at: null }));
  return apiJson(res, 200, { code });
}

function handleSave(req, res, rawBody, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, API_CORS);
    return res.end();
  }

  if (req.method === 'GET') {
    const code = new URL(url).searchParams.get('code') || '';
    if (!CODE_RE.test(code)) {
      return apiJson(res, 400, { error: 'Código inválido. O formato é REVE-XXXX-XXXX.' });
    }
    const file = savePath(code);
    if (!existsSync(file)) {
      return apiJson(res, 404, { error: 'código não encontrado' });
    }
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (_) {
      return apiJson(res, 500, { error: 'O save está ilegível no disco.' });
    }
    return apiJson(res, 200, { save: data.save ?? null, updated_at: data.updated_at ?? null });
  }

  if (req.method !== 'PUT') {
    return apiJson(res, 405, { error: 'Use GET ou PUT em /api/save.' });
  }

  const body = parseJsonBody(rawBody);
  if (!body) {
    return apiJson(res, 400, { error: 'Corpo inválido: envie JSON.' });
  }
  const code = typeof body.code === 'string' ? body.code : '';
  if (!CODE_RE.test(code)) {
    return apiJson(res, 400, { error: 'Código inválido. O formato é REVE-XXXX-XXXX.' });
  }
  if (!body.save || typeof body.save !== 'object' || Array.isArray(body.save)) {
    return apiJson(res, 400, { error: 'save inválido: envie um objeto JSON.' });
  }
  const saveJson = JSON.stringify(body.save);
  if (Buffer.byteLength(saveJson) > SAVE_MAX_BYTES) {
    return apiJson(res, 413, { error: 'save grande demais (máx. 200 KB).' });
  }
  if (overSaveWriteLimit(clientIp(req))) {
    return apiJson(res, 429, { error: 'Muitas gravações agora. Aguarde um minuto.' });
  }
  const file = savePath(code);
  if (!existsSync(file)) {
    return apiJson(res, 404, { error: 'código não encontrado' });
  }

  // History dos últimos 3: atual + .1.json + .2.json (rotação simples).
  const h1 = file.slice(0, -5) + '.1.json';
  const h2 = file.slice(0, -5) + '.2.json';
  try {
    if (existsSync(h1)) {
      rmSync(h2, { force: true });
      renameSync(h1, h2);
    }
    const prev = readFileSync(file, 'utf8');
    if (JSON.parse(prev).updated_at) atomicWrite(h1, prev); // save vazio não vira history
  } catch (_) {
    // history é acessório: falhou, segue e grava o atual mesmo assim
  }

  const updated_at = new Date().toISOString();
  atomicWrite(file, JSON.stringify({ save: body.save, updated_at }));
  return apiJson(res, 200, { ok: true, updated_at });
}

/* rotas da Ligue RÊVE */

function handleLeagueScore(req, res, rawBody) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, API_CORS);
    return res.end();
  }
  if (req.method !== 'POST') {
    return apiJson(res, 405, { error: 'Use POST em /api/league/score.' });
  }
  const body = parseJsonBody(rawBody);
  if (!body) {
    return apiJson(res, 400, { error: 'Corpo inválido: envie JSON.' });
  }
  const code = typeof body.code === 'string' ? body.code : '';
  if (!CODE_RE.test(code)) {
    return apiJson(res, 400, { error: 'Código inválido. O formato é REVE-XXXX-XXXX.' });
  }
  if (!existsSync(savePath(code))) {
    return apiJson(res, 404, { error: 'código não encontrado' });
  }
  const xpRaw = Number(body.xp_week);
  if (!Number.isFinite(xpRaw)) {
    return apiJson(res, 400, { error: 'xp_week inválido: envie um número.' });
  }
  const xp = Math.min(LEAGUE_XP_MAX, Math.max(0, Math.floor(xpRaw))); // anti-fraude leve
  const id = codeHash(code);
  const last = leagueUpsertAt.get(id) || 0;
  const now = Date.now();
  if (now - last < LEAGUE_UPSERT_MS) {
    return apiJson(res, 429, { error: 'Calma: um envio por minuto na liga.' });
  }
  if (leagueUpsertAt.size > 5000) leagueUpsertAt.clear();
  leagueUpsertAt.set(id, now);

  const week = isoWeekKey(now);
  const league = readLeague(week);
  const prev = league.players[id];
  const best = prev ? Math.max(prev.xp_week, xp) : xp; // nunca regride
  league.players[id] = {
    name: sanitizePlayerName(body.name),
    xp_week: best,
    updated_at: prev && best === prev.xp_week ? prev.updated_at : new Date(now).toISOString()
  };
  mkdirSync(LEAGUE_DIR, { recursive: true });
  atomicWrite(leaguePath(week), JSON.stringify(league));

  const ranked = rankLeague(league.players);
  const mine = ranked.find((p) => p.id === id);
  return apiJson(res, 200, { ok: true, rank: mine ? mine.rank : ranked.length, total: ranked.length });
}

function handleLeagueTop(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, API_CORS);
    return res.end();
  }
  if (req.method !== 'GET') {
    return apiJson(res, 405, { error: 'Use GET em /api/league/top.' });
  }
  const limitRaw = Number(new URL(url).searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 20;
  const now = Date.now();
  const week = isoWeekKey(now);
  const league = readLeague(week);
  const players = rankLeague(league.players)
    .slice(0, limit)
    .map((p) => ({ name: p.name, xp_week: p.xp_week, rank: p.rank })); // o código nunca sai daqui
  return apiJson(res, 200, { week, players, closes_in_h: weekClosesInH(now) });
}

/* ------------------------------------------------------------------ */
/* Servidor                                                             */
/* ------------------------------------------------------------------ */

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;

    // /api/tts, saves e liga são resolvidas aqui (disco), sem passar
    // pelo worker — que mantém um 501 amigável para o deploy CF puro.
    const pathname = new URL(url).pathname;
    if (pathname === '/api/tts') {
      return await handleTts(req, res, body);
    }
    if (pathname === '/api/save/new') {
      return handleSaveNew(req, res);
    }
    if (pathname === '/api/save') {
      return handleSave(req, res, body, url);
    }
    if (pathname === '/api/league/score') {
      return handleLeagueScore(req, res, body);
    }
    if (pathname === '/api/league/top') {
      return handleLeagueTop(req, res, url);
    }

    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
    });
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const out = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers.entries());
    delete headers['content-encoding'];
    headers['content-length'] = String(out.length);
    res.writeHead(response.status, headers);
    res.end(out);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'server: ' + (e && e.message ? e.message : String(e)) }));
  }
}).listen(PORT, () => console.log('RÊVE no ar na porta ' + PORT));
