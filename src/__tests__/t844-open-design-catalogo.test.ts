/**
 * T-844 — o cliente do Open Design contra as respostas REAIS do 0.22.2.
 *
 * Fixtures sanitizadas de `daemon/src/__tests__/fixtures/open-design-0.22/`
 * (colhidas do app do dono: 0.22.2 stable em 127.0.0.1:7456). O que o card
 * supunha e o que a sonda mostrou:
 *
 *  - `GET /api/agents` testa cada CLI: 15,9s medidos (117 KB) — o teto único de
 *    8s abortava sempre. Agora é 30s e a 2ª chamada vem do cache.
 *  - `GET .../files/<html>/versions` RESPONDE (200 com `versions[]` e o arquivo
 *    junto); para `.md`/`.ts` devolve 400 `versions are only available for HTML
 *    files`; o restore com id inválido devolve 404 `VERSION_NOT_FOUND`. A versão
 *    do OD NÃO é o critério: a resposta é.
 *  - uma falha de seção do catálogo não esconde as outras;
 *  - todo pedido deixa uma linha de log (operação, duração, status/erro).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  listarAgentsOd, listarSkillsCatalogoOd, listarPluginsOd, listarProjetosOd, buscarArquivosOd,
  listarVersoesOd, restaurarVersaoOd, versaoOd, setLogOd, _resetOdCacheForTest,
  MSG_SO_HTML, MSG_VERSAO_NAO_ENCONTRADA, TTL_CATALOGO_MS, _expirarCacheOdForTest,
} = await import("../open-design-client.js");

const FIX = new URL("./fixtures/open-design-0.22/", import.meta.url);
const fixture = (nome: string): string => readFileSync(new URL(nome, FIX), "utf8");

const PROJ = "a5471b78-77fe-4288-b50c-e1d1324e92e2";

type Chamada = { url: string; atrasoMs: number };
let chamadas: Chamada[] = [];
let logs: string[] = [];
let resposta: (url: string) => { status: number; corpo: string; atrasoMs?: number };

/** `fetch` falso: casa por sufixo de URL e respeita o atraso pedido. */
function armarFetch() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const r = resposta(u);
    chamadas.push({ url: u, atrasoMs: r.atrasoMs ?? 0 });
    if (r.atrasoMs) {
      // O signal do pedido precisa poder abortar (AbortSignal.timeout).
      await new Promise<void>((res, rej) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
          return;
        }
        const t = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          res();
        }, r.atrasoMs);
        const abort = () => {
          clearTimeout(t);
          signal?.removeEventListener("abort", abort);
          rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const corpo = Buffer.from(r.corpo, "utf8");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => JSON.parse(r.corpo),
      text: async () => r.corpo,
      arrayBuffer: async () => corpo.buffer.slice(corpo.byteOffset, corpo.byteOffset + corpo.byteLength),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  chamadas = [];
  logs = [];
  _resetOdCacheForTest();
  setLogOd((nivel, msg) => { logs.push(`${nivel}:${msg}`); });
  resposta = () => ({ status: 404, corpo: "{}" });
  armarFetch();
});

test("T-844: catálogo de agents lento termina e a 2ª chamada vem do cache", async () => {
  resposta = (u) => u.endsWith("/api/agents")
    ? { status: 200, corpo: fixture("agents.json"), atrasoMs: 350 }
    : { status: 404, corpo: "{}" };
  const t0 = Date.now();
  const agentes = await listarAgentsOd();
  const levou = Date.now() - t0;
  assert.ok(agentes.length >= 4, `parser leu o catálogo real (${agentes.length})`);
  assert.ok(agentes.every((a) => a.id && a.name), "id e nome vindos do payload real");
  assert.ok(levou >= 280, `esperou a resposta lenta (${levou}ms)`);

  const t1 = Date.now();
  const deNovo = await listarAgentsOd();
  const cacheMs = Date.now() - t1;
  assert.equal(chamadas.filter((c) => c.url.endsWith("/api/agents")).length, 1, "2ª chamada não vai na rede");
  assert.deepEqual(deNovo, agentes);
  assert.ok(cacheMs < 50, `cache serve rápido (${cacheMs}ms)`);

  // Uma seção lenta NÃO pode esconder as outras (cada uma tem seu cache/timeout).
  resposta = (u) => u.endsWith("/api/plugins")
    ? { status: 200, corpo: fixture("plugins.json") }
    : u.endsWith("/api/skills")
      ? { status: 200, corpo: fixture("skills.json") }
      : { status: 404, corpo: "{}" };
  const [plugins, skills] = await Promise.all([listarPluginsOd(), listarSkillsCatalogoOd()]);
  assert.ok(plugins.length >= 3, "plugins seguem carregando");
  assert.equal(skills.length, 0, "skills.json real é lista vazia");
  assert.ok(logs.some((l) => l.includes("[open_design] plugins ok")), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("origem=rede")), "log diz de onde veio");
});

test("T-844: falha de uma seção não esconde as outras", async () => {
  resposta = (u) => u.endsWith("/api/agents")
    ? { status: 500, corpo: "{}" }
    : u.endsWith("/api/plugins")
      ? { status: 200, corpo: fixture("plugins.json") }
      : { status: 200, corpo: fixture("projects.json") };
  const [agentes, plugins, projetos] = await Promise.allSettled([listarAgentsOd(), listarPluginsOd(), listarProjetosOd()]);
  assert.equal(agentes.status, "rejected", "agents falhou");
  assert.equal(plugins.status, "fulfilled", "plugins apesar da falha do agents");
  assert.equal(projetos.status, "fulfilled", "projects idem");
  assert.ok(logs.some((l) => l.includes("agents erro") && l.includes("HTTP 500")), logs.join("\n"));

  // Cache vencido serve o valor antigo quando o refresh falha (mesma sessão).
  _resetOdCacheForTest();
  resposta = (u) => (u.endsWith("/api/agents") ? { status: 200, corpo: fixture("agents.json") } : { status: 404, corpo: "{}" });
  const bom = await listarAgentsOd();
  resposta = () => ({ status: 500, corpo: "{}" });
  // Vence o TTL sem esperar 10min.
  _expirarCacheOdForTest();
  const servido = await listarAgentsOd();
  assert.deepEqual(servido, bom, "serviu o cache vencido em vez de estourar");
  assert.ok(logs.some((l) => l.includes("servindo cache de")), "o fallback é declarado no log");
});

test("T-844: versions responde por resposta da API — HTML funciona, não-HTML explica", async () => {
  resposta = (u) => u.includes("/files/index.html/versions")
    ? { status: 200, corpo: fixture("versions-bogus.json") }
    : u.includes("/files/MIGRATION.md/versions")
      ? { status: 400, corpo: fixture("versions-md-erro.json") }
      : { status: 404, corpo: "{}" };

  const versoes = await listarVersoesOd(PROJ, "index.html");
  assert.equal(versoes.length, 1, "a resposta real do HTML traz histórico");
  assert.equal(versoes[0]!.id, "e378aa2c-6b4e-46ce-ab32-75ef909b16b8");
  assert.equal(versoes[0]!.label, "Version 1");
  assert.ok(versoes[0]!.createdAt, "createdAt numérico vira ISO");

  await assert.rejects(() => listarVersoesOd(PROJ, "MIGRATION.md"), (e: Error) => e.message === MSG_SO_HTML);
  assert.ok(logs.some((l) => l.includes("versions erro")), "o erro também é logado");
});

test("T-844: restore — 404 vira mensagem clara e o arquivo é relido", async () => {
  resposta = (u) => u.includes("/versions/eu-nao-existo/restore")
    ? { status: 404, corpo: fixture("restore-404.json") }
    : u.includes("/versions/") && u.endsWith("/restore")
      ? { status: 200, corpo: "{}" }
      : u.endsWith("/api/projects/" + PROJ + "/files/index.html")
        ? { status: 200, corpo: "<html>ok</html>" }
        : { status: 404, corpo: "{}" };

  await assert.rejects(
    () => restaurarVersaoOd(PROJ, "index.html", "eu-nao-existo"),
    (e: Error) => e.message.startsWith(MSG_VERSAO_NAO_ENCONTRADA) && e.message.includes("VERSION_NOT_FOUND"),
  );

  const conteudo = await restaurarVersaoOd(PROJ, "index.html", "e378aa2c-6b4e-46ce-ab32-75ef909b16b8");
  assert.equal(conteudo, "<html>ok</html>", "relê o arquivo depois do restore");
  assert.ok(logs.some((l) => l.includes("restore_version ok")), logs.join("\n"));
});

test("T-844: projeto e busca reais passam pelo parser; versão é logada", async () => {
  resposta = (u) => u.endsWith("/api/version")
    ? { status: 200, corpo: fixture("version.json") }
    : u.endsWith("/api/projects")
      ? { status: 200, corpo: fixture("projects.json") }
      : u.includes("/search?")
        ? { status: 200, corpo: fixture("search.json") }
        : { status: 404, corpo: "{}" };

  assert.equal(await versaoOd(), "0.22.2");
  const projetos = await listarProjetosOd();
  assert.equal(projetos.length, 2);
  assert.equal(projetos[0]!.id, PROJ);
  const hits = await buscarArquivosOd(PROJ, "design");
  assert.ok(hits.length >= 3, "hits do payload real");
  assert.ok(hits.every((h) => h.path && h.name), "path e name dos matches");
  assert.ok(hits[0]!.snippet!.length <= 180, "snippet truncado");
  assert.ok(logs.some((l) => l.includes("version ok em")), "versão logada");
});

test("T-844: catálogo recebe teto de 30s e aborta após o prazo configurado", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const pedidos: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    pedidos.push(ms);
    // Mantém o caminho real de abort, mas acelera o prazo para este teste.
    return timeout(25);
  };
  try {
    resposta = (u) => u.endsWith("/api/agents")
      ? { status: 200, corpo: fixture("agents.json"), atrasoMs: 1 }
      : { status: 404, corpo: "{}" };
    const agentes = await listarAgentsOd();
    assert.ok(agentes.length > 0, "a resposta abaixo do prazo foi aceita");
    assert.deepEqual(pedidos, [30_000], "a operação configurou os 30s completos");

    _resetOdCacheForTest();
    pedidos.length = 0;
    resposta = () => ({ status: 200, corpo: "{}", atrasoMs: 500 });
    await assert.rejects(() => listarAgentsOd(), /não respondeu em 30000ms/);
    assert.deepEqual(pedidos, [30_000], "o abort veio do signal criado com 30s");
  } finally {
    AbortSignal.timeout = timeout;
  }
  assert.equal(TTL_CATALOGO_MS, 10 * 60_000, "TTL do cache");
});
