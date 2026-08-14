// RÊVE — adapter Node para rodar o Cloudflare Worker (worker.js) na VPS.
// Uso: node server.mjs  (exige ANTHROPIC_API_KEY no ambiente; porta 8790)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import worker from './worker.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8790;
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const env = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  MODEL: process.env.MODEL,
  ASSETS: {
    fetch: async () => new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
    })
  }
};

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
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
