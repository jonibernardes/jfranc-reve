// RÊVE — adapter Node para rodar o Cloudflare Worker (worker.js) na VPS.
// Uso: node server.mjs  (exige ANTHROPIC_API_KEY no ambiente; porta 8790)
//
// v4: a rota POST /api/tts (voz da Camille) vive AQUI, não no worker:
// chama a OpenAI TTS e guarda o mp3 em ./tts-cache/<sha1(text+voice)>.mp3
// (no container, /app/tts-cache). Cada frase é paga UMA vez; depois é disco.
// Exige OPENAI_API_KEY no ambiente (o deploy usa --env-file /root/reve/.env).
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
/* Servidor                                                             */
/* ------------------------------------------------------------------ */

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;

    // /api/tts é resolvida aqui (cache em disco + OpenAI), sem passar
    // pelo worker — que mantém um 501 amigável para o deploy CF puro.
    if (new URL(url).pathname === '/api/tts') {
      return await handleTts(req, res, body);
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
