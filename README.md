# RÊVE — la vie en français

Game web de ensino de francês para brasileiros. The Sims + francês: você mora num estúdio em Paris com a Camille (professora movida por IA, com memória) e o gato Minou. Quanto mais francês você aprende, mais o mundo ganha cor.

MVP: uma cena, sem login, save em localStorage.

## Arquivos
- `index.html` — o game inteiro (Three.js via CDN, arte procedural, HUD, chat, TTS/STT)
- `worker.js` — backend `/api/chat` (formato Cloudflare Worker; chama Anthropic Claude Haiku 4.5)
- `server.mjs` — adapter pra rodar o worker em Node na VPS (porta 8790)
- `PROMPTS.md` — contrato da API e prompts da Camille e do Minou
- `deploy/` — bloco nginx e passos de publicação

## Rodar na VPS
```
docker run -d --name reve --restart unless-stopped \
  --env-file /root/reve/.env -v /root/reve:/app -w /app \
  -p 172.17.0.1:8790:8790 node:20-alpine node server.mjs
```
`.env`: `ANTHROPIC_API_KEY=...`

Endereço: https://frances.academiaapps.app
