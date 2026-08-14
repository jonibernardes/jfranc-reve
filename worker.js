/**
 * RÊVE — backend de IA do game de francês (Cloudflare Worker, ES module).
 *
 * Rotas:
 *   GET     /api/health  -> {"ok":true,"model":"..."}
 *   POST    /api/chat    -> conversa com a Camille ou o Minou (JSON, sem streaming)
 *   OPTIONS /api/*       -> preflight CORS (204)
 *   demais rotas         -> env.ASSETS; senão EMBEDDED_HTML; senão 404 JSON
 *
 * Config no deploy:
 *   ANTHROPIC_API_KEY  (secret, obrigatório)  -> wrangler secret put ANTHROPIC_API_KEY
 *   MODEL              (var opcional; default claude-haiku-4-5-20251001)
 *
 * Contrato da API e decisões de prompt: ver PROMPTS.md (mesma pasta).
 */

const EMBEDDED_HTML = null; // __HTML_SLOT__

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const MAX_BODY_BYTES = 8192; // ~8 KB por request
const MAX_USER_TEXT = 500; // caracteres por turno
const MAX_HISTORY = 12; // últimas N mensagens do histórico
const MAX_HISTORY_ITEM = 600; // corte por mensagem do histórico
const MAX_TOKENS = 900;
const TIMEOUT_MS = 20000;

const LEVELS = ["A0", "A1", "A2", "B1", "B2"];
const MOODS = ["happy", "amused", "proud", "curious", "neutral"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

/* ------------------------------------------------------------------ */
/* Helpers HTTP                                                         */
/* ------------------------------------------------------------------ */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function fail(msg, status) {
  return json({ error: msg }, status);
}

/* ------------------------------------------------------------------ */
/* Entrada: limpeza e defaults                                          */
/* ------------------------------------------------------------------ */

function cleanName(name) {
  const n = String(name || "")
    .replace(/["\\\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return n || "mon ami";
}

function cleanPlayer(p) {
  const src = p && typeof p === "object" ? p : {};
  return {
    name: cleanName(src.name),
    level: LEVELS.includes(src.level) ? src.level : "A0",
    xp: Number.isFinite(Number(src.xp)) ? Math.max(0, Math.round(Number(src.xp))) : 0,
    words_known: Array.isArray(src.words_known)
      ? src.words_known
          .filter((w) => typeof w === "string" && w.trim())
          .map((w) => w.trim().slice(0, 60))
          .slice(-150)
      : [],
    memories: Array.isArray(src.memories)
      ? src.memories
          .filter((m) => typeof m === "string" && m.trim())
          .map((m) => m.trim().slice(0, 140))
          .slice(-20)
      : [],
    lang: typeof src.lang === "string" && src.lang ? src.lang : "pt-BR",
  };
}

// A API da Anthropic exige papéis alternados começando por "user":
// junta mensagens consecutivas do mesmo papel e corta nas últimas MAX_HISTORY.
function cleanHistory(h) {
  if (!Array.isArray(h)) return [];
  const out = [];
  for (const m of h) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = String(m.content ?? "").slice(0, MAX_HISTORY_ITEM).trim();
    if (!content) continue;
    if (out.length && out[out.length - 1].role === m.role) {
      out[out.length - 1].content += "\n" + content;
    } else {
      out.push({ role: m.role, content });
    }
  }
  const trimmed = out.slice(-MAX_HISTORY);
  while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
  return trimmed;
}

function buildMessages(history, userText) {
  const msgs = cleanHistory(history);
  if (msgs.length && msgs[msgs.length - 1].role === "user") {
    msgs[msgs.length - 1].content += "\n" + userText;
  } else {
    msgs.push({ role: "user", content: userText });
  }
  return msgs;
}

/* ------------------------------------------------------------------ */
/* System prompts (o produto pedagógico)                                */
/* ------------------------------------------------------------------ */

function levelRules(level, name) {
  switch (level) {
    case "A0":
      return `- ${name} é iniciante absoluto: reply_fr com 1 ou 2 frases MUITO curtas (3 a 8 palavras cada), nunca mais que isso.
- Vocabulário concreto do dia a dia: bonjour, merci, café, chat, musique, fenêtre, oui, non.
- Abuse de cognatos português-francês (café, musique, moment, restaurant, télévision): dão confiança instantânea.
- SEMPRE termine com UMA pergunta bem simples (Ça va ? · Tu veux un café ? · Tu aimes la musique ?).
- ${name} vai escrever muito em português — é esperado nesse nível; aplique a regra 2 sem bronca.
- Comemore toda tentativa de francês, por menor que seja (Super ! · Très bien ! · Bravo !).
- reply_fr é 100% em francês; o apoio em português vai em reply_pt e nas dica_pt.`;
    case "A1":
      return `- reply_fr com 2 ou 3 frases curtas, base no presente; introduza aos poucos o futur proche (je vais + infinitivo) e o passé composé dos verbos mais comuns.
- Reformule com naturalidade o que ${name} disser errado (a forma certa aparece dentro da sua resposta) e registre em corrections só o principal.
- Puxe assuntos do cotidiano: o estúdio, comida, trabalho, música, Brasil e França.
- Termine com uma pergunta simples na maioria dos turnos.`;
    case "A2":
      return `- reply_fr com 2 ou 3 frases; passé composé e futur proche à vontade, e comece a semear o imparfait em frases bem claras.
- Amplie o vocabulário por temas (casa, cidade, comida, viagens) a partir do que ${name} traz.
- Reformulação natural sempre; corrections só para o que mais importa.
- Alterne perguntas e desafios leves ("raconte-moi...") para ${name} produzir frases maiores.`;
    case "B1":
      return `- Conversa fluida, 2 a 4 frases; todos os tempos correntes e conectores (donc, pourtant, du coup).
- Expressões idiomáticas com moderação — explique as melhores em new_words.
- Converse de verdade: opiniões, histórias, cultura francesa e brasileira, humor.
- Corrija só o que trava a comunicação ou soa realmente estranho.`;
    default: // B2
      return `- Conversa natural de amiga parisiense: ritmo real, humor, nuance e registro coloquial na medida.
- Idiomatismos e referências culturais bem-vindos; os que valem ouro entram em new_words.
- Correções raras e cirúrgicas: preposição, gênero, registro, colocação — o que separa o bom do excelente.
- Desafie ${name}: peça opinião, conte histórias de Paris, proponha jogos de palavras.`;
  }
}

export function buildSystemCamille(player) {
  const name = player.name;
  const words = player.words_known.length
    ? player.words_known.join(", ")
    : "(nenhuma ainda — está começando do zero)";
  const memories = player.memories.length
    ? player.memories.map((m) => "- " + m).join("\n")
    : "- (nenhuma ainda — vocês estão se conhecendo)";

  return `Você é CAMILLE, 28 anos, parisiense do 11e arrondissement. Você divide um pequeno estúdio em Paris com ${name}, que veio do Brasil e está aprendendo francês, e com Minou, o gato da casa. No estúdio há uma cafeteira italiana, uma vitrola com discos antigos e uma janela com vista da Tour Eiffel — use esses objetos e o cotidiano de vocês como material vivo de ensino (le café, la musique, le disque, la fenêtre, la Tour Eiffel, le chat...).

QUEM É VOCÊ
- Calorosa, espirituosa, ri fácil; provoca só de carinho, nunca de deboche.
- Professora nata: ensina o tempo todo SEM parecer aula. Proibido tom robótico, professoral ou de apostila.
- Genuinamente curiosa sobre o Brasil: pergunta, compara com a França, se encanta com as diferenças.
- Usa o nome ${name} com naturalidade (não em toda frase).
- Tem memória de verdade: quando fizer sentido, retome fatos da lista MEMÓRIAS ("tu m'as dit que..."). Nunca invente lembrança que não está lá.

FICHA DE ${name}
- Nível atual: ${player.level} | XP: ${player.xp} | Língua materna: português do Brasil
- Palavras que já conhece: ${words}
- MEMÓRIAS (o que já te contou):
${memories}

COMO FALAR NO NÍVEL ${player.level}
${levelRules(player.level, name)}

REGRAS DE OURO (valem sempre)
1. corrections: 0 a 3 por turno, SÓ as que mais destravam a comunicação — as outras deixe passar. Nunca humilhe: errar faz parte do jogo.
2. Se ${name} escreveu em português: entenda a intenção, responda a ela em francês do nível dele e ensine em corrections como dizer aquilo (de = a frase em português que ele escreveu, para = a frase em francês, dica_pt = explicação curta e amiga).
3. Se ${name} tentou francês com erros: responda incorporando a forma correta com naturalidade (reformulação) e registre em corrections só o essencial.
4. new_words: 0 a 3 itens REALMENTE novos — nunca repita a lista "já conhece". Prefira palavras que apareceram na sua reply_fr.
5. reply_pt: tradução natural da sua reply_fr para o português do Brasil (como um brasileiro diria, nada robótico).
6. xp_gain (inteiro de 5 a 25), proporcional ao esforço: tentou francês, mesmo com erros, 15-25 · misturou português e francês, 10-15 · escreveu só em português, 5-10.
7. level_estimate: honesto e ESTÁVEL. Mantenha ${player.level}, a não ser que vários turnos seguidos mostrem outro nível com clareza — e nunca pule degraus.
8. memory_notes: 0 a 2 fatos NOVOS e duráveis sobre ${name}, em português curto ("gosta de café forte", "trabalha com vendas"). Nada passageiro ("está com sono") e nada que já esteja nas MEMÓRIAS.
9. mood do turno: happy | amused | proud | curious | neutral — proud quando ${name} manda bem, curious quando você quer saber mais da vida dele.
10. Sempre acolhedora e apropriada para todas as idades. Se ${name} desanimar, encoraje com leveza e simplifique o próximo passo.
11. Termine quase sempre com um gancho ou uma pergunta no nível dele, para a conversa continuar.

FORMATO DA RESPOSTA — CRÍTICO
Responda SOMENTE com o objeto JSON válido, sem NADA antes ou depois: sem markdown, sem cerca de código, sem comentário. Aspas duplas em todas as chaves e strings; sem quebra de linha real dentro das strings.
Todas as chaves sempre presentes (use [] quando não houver itens):
{"reply_fr":"sua fala em francês (obrigatória)","reply_pt":"tradução natural em pt-BR","corrections":[{"de":"o que ${name} escreveu","para":"a forma correta em francês","dica_pt":"explicação curta em pt-BR"}],"new_words":[{"fr":"palavra em francês","pt":"tradução"}],"mood":"um de: happy, amused, proud, curious, neutral","xp_gain":12,"level_estimate":"um de: A0, A1, A2, B1, B2","memory_notes":["fato curto em pt-BR"]}

Exemplo de um turno A0 (aluno escreveu "bom dia! eu quero cafe"):
{"reply_fr":"Bonjour ! Du café ? Moi aussi !","reply_pt":"Bom dia! Café? Eu também!","corrections":[{"de":"eu quero cafe","para":"je veux un café","dica_pt":"quase igual ao português: je veux (eu quero) + un café (um café)"}],"new_words":[{"fr":"le café","pt":"o café"}],"mood":"happy","xp_gain":10,"level_estimate":"A0","memory_notes":["gosta de café"]}`;
}

export function buildSystemMinou(player) {
  const name = player.name;
  const words = player.words_known.length
    ? player.words_known.slice(-60).join(", ")
    : "(nenhuma)";
  return `Você é MINOU, o gato do estúdio parisiense onde vivem Camille e ${name}. Um gato filósofo, levemente surreal: parece guardar os segredos do universo, mas só se expressa por miados... e, misteriosamente, deixa escapar UMA palavra ou mini-frase em francês por turno.

REGRAS
- reply_fr: miados estilizados + UMA única palavra ou mini-frase francesa simples. Exemplos: "Miaou... miaou. Le lait !" · "Prrrr... la fenêtre..." · "Miaou ? Le soleil !"
- A palavra é concreta e simples (comida, objetos da casa, natureza, carinho), de preferência ligada ao que ${name} acabou de dizer. Evite as que ${name} já conhece: ${words}.
- reply_pt: tradução lúdica em pt-BR, mantendo os miados ("Miau... miau. O leite!").
- new_words: 0 ou 1 item — a palavra do turno, se for nova para ${name}. corrections: sempre []. xp_gain: sempre 5. level_estimate: sempre "${player.level}". memory_notes: sempre [] (gatos guardam segredos). mood: curious, amused, happy ou neutral.
- Nunca fale frases humanas completas, nunca explique gramática, nunca saia do personagem.

SAÍDA — responda SOMENTE com o objeto JSON válido, nada antes nem depois, aspas duplas em tudo:
{"reply_fr":"Miaou... le lait !","reply_pt":"Miau... o leite!","corrections":[],"new_words":[{"fr":"le lait","pt":"o leite"}],"mood":"curious","xp_gain":5,"level_estimate":"${player.level}","memory_notes":[]}`;
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                            */
/* ------------------------------------------------------------------ */

async function callAnthropic(env, system, messages, temperature) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.MODEL || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        temperature,
        system,
        // PREFILL: a última mensagem assistant com "{" obriga o modelo a
        // continuar de dentro do objeto JSON (sem preâmbulo possível).
        messages: [...messages, { role: "assistant", content: "{" }],
      }),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function extractText(data) {
  if (!data || !Array.isArray(data.content)) return "";
  return data.content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// O prefill "{" não volta na resposta: o chamador o recoloca antes de parsear.
function tryParseJson(text) {
  const candidates = [text];
  const cut = text.lastIndexOf("}");
  if (cut > -1 && cut < text.length - 1) candidates.push(text.slice(0, cut + 1)); // lixo depois do JSON
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch (_) {
      // tenta o próximo candidato
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Saída: contrato garantido                                            */
/* ------------------------------------------------------------------ */

function sanitizeReply(parsed, player) {
  const reply_fr = typeof parsed.reply_fr === "string" ? parsed.reply_fr.trim() : "";
  if (!reply_fr) return null; // sem fala em francês não há turno válido

  const corrections = Array.isArray(parsed.corrections)
    ? parsed.corrections
        .filter((c) => c && typeof c === "object")
        .map((c) => ({
          de: String(c.de ?? "").trim(),
          para: String(c.para ?? "").trim(),
          dica_pt: String(c.dica_pt ?? "").trim(),
        }))
        .filter((c) => c.de || c.para)
        .slice(0, 3)
    : [];

  const new_words = Array.isArray(parsed.new_words)
    ? parsed.new_words
        .filter((w) => w && typeof w === "object" && typeof w.fr === "string" && w.fr.trim())
        .map((w) => ({ fr: w.fr.trim(), pt: String(w.pt ?? "").trim() }))
        .slice(0, 3)
    : [];

  let xp = Math.round(Number(parsed.xp_gain));
  if (!Number.isFinite(xp)) xp = 10;
  xp = Math.min(25, Math.max(5, xp));

  const memory_notes = Array.isArray(parsed.memory_notes)
    ? parsed.memory_notes
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => s.trim().slice(0, 140))
        .slice(0, 2)
    : [];

  return {
    reply_fr,
    reply_pt: typeof parsed.reply_pt === "string" ? parsed.reply_pt.trim() : "",
    corrections,
    new_words,
    mood: MOODS.includes(parsed.mood) ? parsed.mood : "neutral",
    xp_gain: xp,
    level_estimate: LEVELS.includes(parsed.level_estimate) ? parsed.level_estimate : player.level,
    memory_notes,
  };
}

/* ------------------------------------------------------------------ */
/* POST /api/chat                                                       */
/* ------------------------------------------------------------------ */

async function handleChat(request, env) {
  if (!env.ANTHROPIC_API_KEY) return fail("Servidor sem chave de IA configurada.", 500);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return fail("Requisição grande demais (máx. 8 KB).", 413);

  let raw;
  try {
    raw = await request.text();
  } catch (_) {
    return fail("Não consegui ler o corpo da requisição.", 400);
  }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return fail("Requisição grande demais (máx. 8 KB).", 413);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    return fail("Corpo inválido: envie JSON.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail("Corpo inválido: envie JSON.", 400);
  }

  const npc = body.npc == null ? "camille" : String(body.npc);
  if (npc !== "camille" && npc !== "minou") {
    return fail('npc inválido: use "camille" ou "minou".', 400);
  }

  const userText = typeof body.user_text === "string" ? body.user_text.trim() : "";
  if (!userText) return fail("user_text vazio.", 400);
  if (userText.length > MAX_USER_TEXT) {
    return fail("Mensagem longa demais (máx. 500 caracteres).", 400);
  }

  const player = cleanPlayer(body.player);
  const messages = buildMessages(body.history, userText);
  const system = npc === "minou" ? buildSystemMinou(player) : buildSystemCamille(player);
  const temperature = npc === "minou" ? 1.0 : 0.8;

  let reply = null;
  let jsonProblem = false;
  let apiProblem = 0;

  for (let attempt = 0; attempt < 2 && !reply; attempt++) {
    const sys =
      attempt > 0 && jsonProblem
        ? system + "\n\nATENÇÃO: a resposta anterior veio fora do formato. Responda com APENAS o JSON válido, nada antes ou depois."
        : system;

    let result;
    try {
      result = await callAnthropic(env, sys, messages, temperature);
    } catch (e) {
      if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
        return fail("A IA demorou demais para responder. Tente de novo.", 504);
      }
      return fail("Falha de rede ao falar com a IA.", 502);
    }

    if (result.status === 401 || result.status === 403) {
      return fail("Chave da IA recusada no servidor.", 502);
    }
    if (result.status === 429) {
      return fail("Muitas conversas agora. Aguarde alguns segundos e tente de novo.", 429);
    }
    if (result.status !== 200) {
      apiProblem = result.status;
      continue; // instabilidade (5xx/529): vale uma segunda tentativa
    }

    const parsed = tryParseJson("{" + extractText(result.data));
    reply = parsed ? sanitizeReply(parsed, player) : null;
    if (!reply) {
      jsonProblem = true;
      apiProblem = 0;
    }
  }

  if (!reply) {
    return apiProblem
      ? fail("Serviço de IA instável agora (" + apiProblem + "). Tente de novo.", 502)
      : fail("A IA respondeu num formato inesperado. Tente de novo.", 502);
  }
  return json(reply);
}

/* ------------------------------------------------------------------ */
/* Router                                                               */
/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }
      if (pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, model: env.MODEL || DEFAULT_MODEL });
      }
      if (pathname === "/api/chat") {
        if (request.method !== "POST") return fail("Use POST em /api/chat.", 405);
        try {
          return await handleChat(request, env);
        } catch (_) {
          return fail("Erro interno do servidor.", 500);
        }
      }
      return fail("Rota de API não encontrada.", 404);
    }

    // Front-end: assets do deploy, ou HTML embutido (injetado no __HTML_SLOT__), ou nada.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    if (typeof EMBEDDED_HTML === "string" && EMBEDDED_HTML.length) {
      return new Response(EMBEDDED_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return fail("Nada por aqui ainda: o front não foi publicado.", 404);
  },
};
