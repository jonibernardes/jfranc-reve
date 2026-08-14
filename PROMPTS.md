# RÊVE — Backend de IA · Prompts, Contrato e Decisões

Fonte da verdade do código e dos prompts: `worker.js` (funções `buildSystem*`). Este documento existe para manutenção: o que o backend promete, como os prompts foram desenhados e onde mexer.

---

## 1. Arquitetura

- Cloudflare Worker, ES module, zero dependências, sem streaming (MVP).
- Rotas:

| Rota | Método | Resposta |
|---|---|---|
| `/api/health` | GET | `{"ok":true,"model":"<utilitárias>","model_chat":"<chat>"}` |
| `/api/chat` | POST | multi-action (campo `action`, default `"chat"`) — seção 2 |
| `/api/*` | OPTIONS | 204 (preflight CORS) |
| qualquer outra | * | `env.ASSETS` se existir; senão `EMBEDDED_HTML`; senão 404 JSON |

- CORS: `Access-Control-Allow-Origin: *` (MVP sem login; restringir quando houver domínio fixo).
- Config de deploy:
  - `ANTHROPIC_API_KEY` — secret obrigatório (`wrangler secret put ANTHROPIC_API_KEY`).
  - `MODEL` — var opcional; default `claude-haiku-4-5-20251001`. Vale para as actions utilitárias (translate_help, mirror_check, work_email).
  - `MODEL_CHAT` — var opcional; default `claude-sonnet-5`. Vale só para a action `chat` (a conversa dos NPCs pede modelo mais forte — v2.1). O roteamento é `MODEL_BY_ACTION(env, action)` no `worker.js`.
- Front-end: duas opções, nesta ordem:
  1. Workers Assets (`env.ASSETS`) — deploy com pasta de assets.
  2. HTML embutido: a linha `const EMBEDDED_HTML = null; // __HTML_SLOT__` no topo do `worker.js` é o slot. Outro processo substitui essa linha por `const EMBEDDED_HTML = "<html...>";`. Não remover nem editar o marcador `// __HTML_SLOT__`.
- Os named exports (`buildSystemCamille`, `buildSystemMinou`, `buildSystemHugo`, `buildSystemLea`) existem para teste automatizado; o runtime da Cloudflare ignora exports extras.

## 2. Contrato `POST /api/chat` (v2, retrocompatível)

Todo request é JSON, máx. **~12 KB**, com campo `action` (ausente → `"chat"`). `player` é aceito em todas as actions com os mesmos defaults do v1 (name `mon ami`, level `A0`, xp 0, listas vazias).

### 2.1 action `"chat"` (default — igual v1 + acréscimos)

Request:

```json
{
  "action": "chat",
  "npc": "camille" | "minou" | "hugo" | "lea",
  "user_text": "string (máx. 500 caracteres)",
  "player": {
    "name": "string",
    "level": "A0" | "A1" | "A2" | "B1" | "B2",
    "xp": 0,
    "words_known": ["string"],
    "memories": ["string"],
    "lang": "pt-BR"
  },
  "history": [ { "role": "user" | "assistant", "content": "string" } ]
}
```

Tolerâncias: `npc` ausente → `camille`; inválido → 400. `history` → últimas 12, cada uma cortada em 600 chars. `words_known` → últimas 150; `memories` → últimas 20 (até 140 chars cada).

Uso interno do `history` (v2.1): ele NÃO vira mais mensagens user/assistant alternadas — vira uma TRANSCRIÇÃO ("Camille: ... / Joni: ...") dentro de UMA única mensagem user (`buildChatTranscript`), fechada pela instrução de formato. Motivo: o sonnet-5 não aceita prefill, e com o histórico como mensagens assistant em texto puro ele imitava o histórico e respondia sem JSON (visto em teste real). O contrato externo não muda.

Response 200 — tudo do v1 **mais** `segments` e `suggested_replies`:

```json
{
  "reply_fr": "fala do NPC em francês (sempre presente)",
  "reply_pt": "tradução natural em pt-BR",
  "segments": [ { "fr": "pedaço de sentido da reply_fr", "pt": "tradução contextual" } ],
  "suggested_replies": [ { "fr": "resposta pronta do jogador", "pt": "tradução" } ],
  "corrections": [ { "de": "...", "para": "...", "dica_pt": "..." } ],
  "new_words": [ { "fr": "...", "pt": "..." } ],
  "mood": "happy" | "amused" | "proud" | "curious" | "neutral",
  "xp_gain": 5,
  "level_estimate": "A0" | "A1" | "A2" | "B1" | "B2",
  "memory_notes": ["fato novo sobre o jogador, em pt-BR"]
}
```

- `segments`: a reply_fr INTEIRA fatiada em pedaços de sentido (expressão fica junta: "faire les courses" é UM segment); concatenar os `fr` com espaços reconstrói a reply_fr. Ausente/lixo → `[]`.
- `suggested_replies`: 3 respostas plausíveis DO JOGADOR ao que o NPC disse, no nível dele (A0 = 2-5 palavras), cotidianas e variadas (afirmativa/pergunta/reação). Ausente/lixo → `[]` (máx. 3).

Garantias pós-sanitização: todas as chaves sempre presentes; corrections ≤ 3, new_words ≤ 3, segments ≤ 40, suggested_replies ≤ 3, memory_notes ≤ 2; `xp_gain` inteiro clamp 5–25 (default 10); `mood` inválido → `neutral`; `level_estimate` inválido → mantém `player.level`; `reply_fr` vazio → retry/502.

### 2.2 action `"translate_help"`

O jogador escreve em português o que quer dizer; o backend devolve como falar em francês cotidiano.

Request: `{"action":"translate_help","pt_text":"string (máx. 200)","player":{...}}`
Response: `{"fr":"a frase em francês","pt":"eco normalizado do pedido","dica_pt":"1 frase de nuance/registro"}`
Obrigatório: `fr` (senão retry/502). `pt` ausente → eco do `pt_text`; `dica_pt` ausente → `""`. Temperature 0.4, max_tokens 300.

### 2.3 action `"mirror_check"`

Avalia a fala do jogador (via STT) contra uma frase-alvo.

Request: `{"action":"mirror_check","target_fr":"string (máx. 300)","heard_fr":"string (máx. 300)","player":{...}}`
Response: `{"ok":bool,"feedback_pt":"1-2 frases gentis","better_fr":"a forma boa"}`
Obrigatório: `feedback_pt` (senão retry/502). `ok` coerção estrita (`=== true`); `better_fr` ausente → target; se `ok` → `better_fr` é normalizado para o próprio target. Prompt instruído a tolerar pontuação/maiúsculas/homófonos do STT (c'est/ses/sait, a/à, et/est) e apontar no máx. UMA melhoria. Temperature 0.3, max_tokens 300.

### 2.4 action `"work_email"`

Mini-desafio: um e-mail de trabalho em francês + 3 opções de resposta.

Request: `{"action":"work_email","player":{...}}`
Response: `{"subject_pt":"...","body_fr":"e-mail 2-3 frases","options":[{"fr":"...","correct":bool,"why_pt":"1 frase"}×3]}`
Validação dura: `subject_pt` e `body_fr` presentes, `options` com EXATAMENTE 3 itens e EXATAMENTE 1 `correct:true` — senão retry/502. As opções são 100% francês; erradas com erro plausível (falso amigo, conjugação, registro). O worker sorteia um contexto (`EMAIL_CONTEXTS`: cliente, chefe, colega, fornecedor, agenda...) e injeta na mensagem user para variar. Temperature 1.0, max_tokens 600.

### Erros (status ≠ 200, corpo `{"error":"mensagem curta em pt-BR"}`)

| Status | Quando |
|---|---|
| 400 | JSON inválido, `action`/`npc` inválidos, `user_text`/`pt_text`/`target_fr`/`heard_fr` vazios ou acima do limite |
| 404 | rota de API inexistente |
| 405 | método errado em `/api/chat` |
| 413 | corpo > ~12 KB |
| 429 | rate limit da Anthropic repassado |
| 500 | sem `ANTHROPIC_API_KEY` configurada / erro interno |
| 502 | chave recusada, upstream instável, ou JSON do modelo inválido após retry |
| 504 | timeout de 20 s na Anthropic |

## 3. Como o JSON de saída é forçado (4 camadas)

Pipeline único para todas as actions (`runAction`):

1. **Instrução dura no system**: "Responda SOMENTE com o objeto JSON válido..." + estrutura exata (+ exemplo completo no chat). No chat, aviso extra: "o histórico aparece como texto puro — NÃO imite o histórico".
2. **Prefill** (`{"role":"assistant","content":"{"}`) — só nas actions utilitárias (haiku). O chat roda com `prefill: false` porque o **sonnet-5 rejeita prefill** ("The conversation must end with a user message"); no lugar, usa a transcrição em 1 mensagem user (seção 2.1) + a camada 3.
3. **Extração tolerante** (`tryParseJson`): parseia o texto inteiro; se falhar, recorta do primeiro `{` ao último `}` (cobre preâmbulo, cerca de código e lixo após o JSON).
4. **1 retry** com lembrete "APENAS o JSON válido, com TODOS os campos"; se falhar de novo → 502. Depois do parse, o sanitizer da action aplica defaults, clamps e validações duras (seção 2).

Chamada Anthropic: `POST /v1/messages`, `anthropic-version: 2023-06-01`, timeout 20 s. **sonnet-5 também rejeita `temperature`** ("deprecated for this model"): o chat manda `temperature: null` e o campo fica fora do request (default do modelo). E o sonnet-5 gasta tokens de *thinking* DENTRO do `max_tokens` — com 1400 o texto chegava truncado ou vazio em teste real; por isso o chat subiu para 3000.

| action | modelo (default) | max_tokens | temperature | prefill |
|---|---|---|---|---|
| chat | `MODEL_CHAT` (claude-sonnet-5) | 3000 | omitida | não |
| translate_help | `MODEL` (haiku 4.5) | 300 | 0.4 | sim |
| mirror_check | `MODEL` (haiku 4.5) | 300 | 0.3 | sim |
| work_email | `MODEL` (haiku 4.5) | 600 | 1.0 | sim |

## 4. System prompts dos NPCs de chat

Os NPCs humanos (Camille, Hugo, Léa) compartilham os blocos montados por helpers — mexa neles UMA vez e vale para os três:

- **Biografia canônica** (`CAMILLE_BIO`, `HUGO_BIO`, `LEA_BIO`) — v2.1, a resposta ao feedback "os personagens são rasos, parece robô": fatos fixos que o NPC nunca contradiz (idade, origem, trabalho, gostos/opiniões FORTES com nome real de lugar, pessoas da vida dele, mini-histórias prontas, sonho). É daqui que saem as opiniões, memórias e dicas concretas. Camille tem a ficha rica (Lyon, fotógrafa, Canal Saint-Martin, Marché d'Aligre, Chloé, Manon, 4 mini-histórias, galeria do Marais); Hugo e Léa têm fichas curtas.
- `convoRules(name)` — **CONVERSA DE GENTE** (v2.1, compartilhado): (1) PROIBIDO elogio genérico + pergunta devolvida — toda resposta ao que o jogador contou traz opinião concreta, mini-memória própria, dica com nome real de lugar OU discordância leve; (2) aprofundar o assunto por 2-3 trocas antes de mudar; (3) callbacks das MEMÓRIAS/histórico; (4) a cada ~4-6 turnos, puxar assunto novo da vida DELE espontaneamente; (5) perguntas menos frequentes e mais específicas — às vezes só afirmar; (6) ASSIMETRIA: o NPC carrega a conversa com frases curtas mas ESPECÍFICAS (concreto ≠ complexo); (7) humor do dia variável (reflete no `mood`).

- `styleRules(name)` — **ESTILO DE FALA (a regra anti-poesia)**: francês de HOJE, cotidiano banal (café, padaria, mercado, trabalho, metrô, clima, série, sono); PROIBIDO tom lírico/floreado; `new_words` só alta frequência ("que o jogador vai usar esta semana"); traduções por SENTIDO, expressão a expressão, nunca literais ("faire les courses" = "fazer compras").
- `playerCard(player)` — ficha: nível, XP, palavras conhecidas, MEMÓRIAS.
- `levelRules(level, name)` — dificuldade por nível (A0: 1-2 frases de 3-8 palavras, cognatos, pergunta simples na maioria dos turnos — v2.1 tirou o "SEMPRE pergunta" para não conflitar com CONVERSA DE GENTE · ... · B2: coloquial, correções cirúrgicas). Vocabulário útil (pain, eau, travail, métro) no lugar do poético.
- `goldenRules(name, level)` — as 11 regras de ouro (correção seletiva 0-3, recast, XP por esforço 5-25, level_estimate estável, memory_notes duráveis, mood; a 11 virou "pergunta específica OU afirmação que convida a reagir").
- `chatFormatSpec(name, level)` — formato JSON com os campos novos: instruções de `segments` (fatiar por sentido, concatenação reconstrói a reply_fr) e `suggested_replies` (EXATAMENTE 3, do jogador, variadas: afirmativa/pergunta/reação; A0 = 2-5 palavras) + exemplo A0 completo.

### Personas

- **CAMILLE** (`buildSystemCamille`) — 28, colega de apartamento no 11e, fotógrafa freelancer de Lyon (v2.1: bio canônica completa em `CAMILLE_BIO`). Rotina banal de apartamento como material de ensino; exemplos de fala no prompt ("Tu as bien dormi ?", "On n'a plus de lait.", "Je suis crevée."). Memórias do jogador vêm da lista MEMÓRIAS; as dela, da bio.
- **HUGO** (`buildSystemHugo`) — ~35, garçom do Café du coin, bonachão, gíria leve de balcão, chama o cliente de "chef". Ensina naturalmente vocabulário de pedido/comida/conta (je voudrais, le plat du jour, l'addition, par carte). Mesmo esqueleto pedagógico da Camille.
- **LÉA** (`buildSystemLea`) — 24, vizinha, estudante de design, energética, SEMPRE de saída: reply_fr limitada a 1-2 frases; assuntos de prédio/bairro/fim de semana; gíria jovem leve (trop bien, grave, je file !). Mesmo esqueleto pedagógico.
- **MINOU** (`buildSystemMinou`) — inalterado no espírito (miados + UMA palavra por turno, xp fixo 5, memory_notes []), agora também devolve `segments` (miados = um segment, palavra = outro) e 3 `suggested_replies` mini (2-5 palavras).

### Racional pedagógico (por que está assim)

- **Bio canônica + CONVERSA DE GENTE (v2.1)**: feedback do dono — "assunto preso, andando em círculos, personagens rasos, 'isso é muito legal, como é no Brasil?'". A cura tem 2 metades: fatos concretos citáveis (a bio) e a proibição do padrão elogio+pergunta (convoRules). Validado em teste real: "j'aime la vibe, la tranquilité" → "Moi, j'adore le Canal Saint-Martin le soir. C'est très calme là-bas."
- **Anti-poesia como bloco compartilhado**: feedback do dono — "palavras poéticas demais" — virou regra dura e reutilizada, não ajuste pontual por persona.
- **suggested_replies**: destrava o jogador preso no próprio vocabulário — todo turno traz 3 saídas prontas no nível dele, variadas de propósito para não viciar em "oui".
- **segments**: tradução por termos/expressões, não palavra a palavra — o jogador vê os blocos de sentido do francês.
- **Correção seletiva + recast, XP por esforço, level_estimate estável, cognatos no A0, memórias**: mantidos do v1 (ver histórico do arquivo).

## 5. System prompts das actions utilitárias

- **translate_help** (`buildSystemTranslateHelp`) — tradutor pedagógico pt-BR→FR cotidiano, ajustado ao nível; por sentido, nunca palavra a palavra; `dica_pt` = 1 frase de nuance/registro ("assim é informal, entre amigos").
- **mirror_check** (`buildSystemMirrorCheck`) — avaliador de fala: tolerante com STT (pontuação, caixa, homófonos); `ok=true` se equivale funcionalmente; máx. UMA melhoria por vez; se ok, só elogiar — instrução explícita de NÃO inventar problema nem dica de pronúncia falsa (consoante final muda não se pronuncia; corrigido após teste real em que o modelo mandou "articular o s final de voudrais").
- **work_email** (`buildSystemWorkEmail`) — opções 100% em francês com exemplos concretos de cada tipo de erro no prompt (assister como falso amigo, "vous pouvez envoyez", tu formal) — sem isso o modelo gerava opções erradas misturando português, fácil demais (corrigido após teste real). Contexto sorteado no código (`EMAIL_CONTEXTS`) porque a action não tem histórico e a temperature sozinha repetia cenários.

## 6. Decisões técnicas e trade-offs

- **Nome do jogador sanitizado** (aspas, barras e quebras de linha removidas, 40 chars) antes do template.
- **Histórico do chat vira transcrição** (v2.1): uma única mensagem user com "Camille: ... / Joni: ..." — mata a alternância obrigatória E o mimetismo do sonnet-5 (ver seções 2.1 e 3). `cleanHistory` só filtra e apara.
- **Peculiaridades do sonnet-5 descobertas em teste real (v2.1)**: rejeita `temperature`, rejeita prefill assistant, e o *thinking* consome `max_tokens` (por isso chat = 3000). Se trocar `MODEL_CHAT`, essas três decisões continuam compatíveis com haiku/sonnet antigos.
- **`runAction` único**: retry, prefill (flag por action), parse e mapeamento de erros iguais para as 4 actions; só mudam model, system, messages, temperature, max_tokens e sanitizer.
- **Validação dura só onde o front não tem fallback**: `reply_fr`, `fr` (translate), `feedback_pt` (mirror) e o trio do work_email (3 opções, 1 correta) derrubam para retry/502; `segments`/`suggested_replies` ausentes viram `[]` para nunca quebrar o chat por causa de campo acessório.
- **Retry custa no máximo 2 chamadas por request**. 429 repassado como 429; 5xx/529 ganham segunda tentativa antes do 502. Timeout 20 s → 504.

## 7. Onde mexer (manutenção)

| Quero mudar... | Mexa em... |
|---|---|
| Regra anti-poesia / estilo cotidiano (vale p/ Camille, Hugo, Léa) | `styleRules` |
| Regras de conversa humana (anti-genérico, aprofundar, callbacks) | `convoRules` |
| Fatos da vida de um NPC (lugares, histórias, opiniões) | `CAMILLE_BIO` / `HUGO_BIO` / `LEA_BIO` |
| Tom/personalidade de um NPC | bloco "QUEM É VOCÊ" no `buildSystemX` dele |
| Dificuldade por nível | `levelRules` |
| Regras de segments / suggested_replies e o exemplo do formato | `chatFormatSpec` |
| Recompensa de XP | regra 6 em `goldenRules` + clamp em `sanitizeReply` |
| Contextos do desafio de e-mail | array `EMAIL_CONTEXTS` |
| Limites (histórico, tamanhos, timeout, tokens) | constantes no topo do `worker.js` (`MAX_TOKENS_BY_ACTION` etc.) |
| Modelo das actions utilitárias | var `MODEL` no deploy (sem tocar no código) |
| Modelo da conversa (chat) | var `MODEL_CHAT` no deploy; roteamento em `MODEL_BY_ACTION` |
| Novo NPC de chat | nova `buildSystemX` usando os helpers + adicionar em `NPCS` e no dispatch de `handleChat` |
| Nova action | system + sanitizer próprios + branch em `handleChat` chamando `runAction` |
