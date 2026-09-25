/**
 * T-758 — sombra TypeSafe no delegate. Fetch injetado, zero rede.
 * O relay é checado no fonte: a chamada fica no delegate, antes da cifra, sem await.
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TYPESAFE_SYSTEMONE_URL,
  definirEmissorSombra,
  registrarJevDoProjeto,
  scheduleDelegateShadow,
  setDelegateShadowFetch,
  setDelegateShadowSafeFetch,
  settleDelegateShadowForTests,
  type DelegateShadowFetch,
  type DelegateShadowRequestInit,
} from "../typesafe-delegate-shadow.js";
import { TYPESAFE_MODEL, TYPESAFE_TIMEOUT_MS } from "../typesafe-client.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RELAY = readFileSync(join(AQUI, "../bridge-relay.ts"), "utf8");
const MODULO = readFileSync(join(AQUI, "../typesafe-delegate-shadow.ts"), "utf8");
const CLIENTE = readFileSync(join(AQUI, "../typesafe-client.ts"), "utf8");
const PREFIXO = "[typesafe-delegate-shadow] ";
const FLAG_ORIGINAL = process.env.TYPESAFE_DELEGATE_SHADOW;
const CHAVE_ORIGINAL = process.env.TYPESAFE_API_KEY;

let chamadasRede = 0;

function restaurarEnvOriginal(): void {
  if (FLAG_ORIGINAL === undefined) delete process.env.TYPESAFE_DELEGATE_SHADOW;
  else process.env.TYPESAFE_DELEGATE_SHADOW = FLAG_ORIGINAL;
  if (CHAVE_ORIGINAL === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = CHAVE_ORIGINAL;
}

function definirEnv(flag: string | undefined, chave: string | undefined): void {
  if (flag === undefined) delete process.env.TYPESAFE_DELEGATE_SHADOW;
  else process.env.TYPESAFE_DELEGATE_SHADOW = flag;
  if (chave === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = chave;
}

function instalarLog(): { linhas: () => string[]; parar: () => void } {
  const linhas: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    linhas.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return {
    linhas: () => linhas.filter((l) => l.startsWith(PREFIXO)),
    parar: () => { console.error = orig; },
  };
}

function choice(escolha: string, opcoes: string[]) {
  return {
    type: "choice",
    choice: escolha,
    probabilities: Object.fromEntries(opcoes.map((o) => [o, o === escolha ? 0.91 : 0.015])),
    confidence: 0.8,
  };
}

function resposta(parcial?: { task?: string; complexity?: string; domain?: string; noul?: number }): string {
  const task = parcial?.task ?? "coding";
  const complexity = parcial?.complexity ?? "simple";
  const domain = parcial?.domain ?? "DAEMON";
  return JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      task_type: choice(task, ["coding", "research", "analysis", "review", "testing", "documentation", "general"]),
      complexity: choice(complexity, ["simple", "moderate", "complex", "critical"]),
      destructive: { type: "noul", noul: parcial?.noul ?? 0.07 },
      domain: choice(domain, ["DAEMON", "SERVER", "WEB", "DEVOPS", "QA_A", "QA_B", "SECURITY", "THREEJS", "PM", "NONE"]),
    },
    usage: { input_tokens: 10, output_tokens: 4 },
  });
}

function mockFetch(fn: DelegateShadowFetch): void {
  setDelegateShadowFetch(async (url, init) => {
    chamadasRede += 1;
    return fn(url, init);
  });
}

const PROJETO = "projeto-jev";

/** Os testes que esperam POST ligam a feature e passam o projectId. */
function disparar(json: unknown): void {
  registrarJevDoProjeto(PROJETO, true);
  scheduleDelegateShadow(json, PROJETO);
}

describe("typesafe-delegate-shadow", { concurrency: 1 }, () => {
  beforeEach(() => {
    chamadasRede = 0;
    setDelegateShadowFetch(async () => {
      chamadasRede += 1;
      throw new Error("rede bloqueada no teste");
    });
  });

  afterEach(async () => {
    await settleDelegateShadowForTests();
    setDelegateShadowFetch(null);
    setDelegateShadowSafeFetch(null);
    registrarJevDoProjeto(PROJETO, false);
    definirEmissorSombra(null);
    restaurarEnvOriginal();
  });

  test("desligado sem flag: não chama fetch", async () => {
    const log = instalarLog();
    try {
      definirEnv(undefined, "chave-que-nao-sai");
      const json = { goal: "faz um teste", taskType: "coding", complexity: "simple" };
      const antes = { ...json };
      const ret = disparar(json);
      await settleDelegateShadowForTests();
      assert.equal(ret, undefined);
      assert.deepEqual(json, antes);
      assert.equal(chamadasRede, 0);
      assert.deepEqual(log.linhas(), []);
    } finally {
      log.parar();
    }
  });

  test("desligado com flag e sem chave: não chama fetch", async () => {
    const log = instalarLog();
    try {
      for (const flag of ["1", "true", " TRUE "]) {
        definirEnv(flag, undefined);
        disparar({ goal: "faz um teste", taskType: "coding", complexity: "simple" });
        definirEnv(flag, "   ");
        disparar({ goal: "faz um teste", taskType: "coding", complexity: "simple" });
      }
      definirEnv("yes", "chave-presente");
      disparar({ goal: "faz um teste", taskType: "coding", complexity: "simple" });
      await settleDelegateShadowForTests();
      assert.equal(chamadasRede, 0);
      assert.deepEqual(log.linhas(), []);
    } finally {
      log.parar();
    }
  });

  test("ligado com flag e chave: chama fetch", async () => {
    const log = instalarLog();
    try {
      let vistos = 0;
      mockFetch(async () => ({ status: 200, text: async () => resposta() }));
      for (const flag of ["1", "true", " TRUE "]) {
        definirEnv(flag, "k");
        const ret = disparar({ goal: "faz um teste", taskType: "coding", complexity: "simple" });
        assert.equal(ret, undefined);
        vistos += 1;
      }
      await settleDelegateShadowForTests();
      assert.equal(chamadasRede, vistos);
      assert.equal(log.linhas().length, vistos);
    } finally {
      log.parar();
    }
  });

  test("request pinada: estado allowlisted, goal até 2 KiB UTF-8 e sem context", async () => {
    const log = instalarLog();
    try {
      const goal = "a".repeat(2500);
      const context = "b".repeat(2500);
      let initVisto: DelegateShadowRequestInit | undefined;
      let urlVista = "";
      mockFetch(async (url, init) => {
        urlVista = url;
        initVisto = init;
        return { status: 200, text: async () => resposta() };
      });
      definirEnv("1", "chave-teste-nao-logar");
      const json = {
        goal,
        context,
        taskType: "coding",
        complexity: "moderate",
        preferredRunner: "grok",
        repo: "REPO_SENTINELA",
        diff: "DIFF_SENTINELA",
      };
      disparar(json);
      await settleDelegateShadowForTests();
      assert.ok(initVisto);
      assert.equal(urlVista, "https://api.typesafe.ai/v1/systemone");
      assert.equal(urlVista, TYPESAFE_SYSTEMONE_URL);
      assert.equal(initVisto.method, "POST");
      assert.equal(initVisto.headers["Content-Type"], "application/json");
      assert.equal(initVisto.headers.Authorization, "Bearer chave-teste-nao-logar");
      assert.ok(initVisto.signal instanceof AbortSignal);
      const corpo = JSON.parse(initVisto.body) as {
        model: string;
        state: Record<string, string>;
        questions: {
          task_type: { type: string };
          complexity: { type: string };
          destructive: { type: string };
          domain: { type: string };
        };
      };
      assert.equal(corpo.model, "jev-1.13.0");
      assert.deepEqual(Object.keys(corpo.state).sort(), ["declaredComplexity", "declaredTaskType", "goal"]);
      assert.ok(Buffer.byteLength(corpo.state.goal!, "utf8") <= 2048);
      assert.ok(String(corpo.state.goal).endsWith("…"));
      assert.equal(corpo.state.declaredTaskType, "coding");
      assert.equal(corpo.state.declaredComplexity, "moderate");
      assert.equal(corpo.questions.task_type.type, "choice");
      assert.equal(corpo.questions.complexity.type, "choice");
      assert.equal(corpo.questions.destructive.type, "noul");
      assert.equal(corpo.questions.domain.type, "choice");
      assert.equal(initVisto.body.includes("a".repeat(2046)), false);
      assert.equal(initVisto.body.includes("REPO_SENTINELA"), false);
      assert.equal(initVisto.body.includes("DIFF_SENTINELA"), false);
      assert.equal(initVisto.body.includes("preferredRunner"), false);
      assert.equal("context" in corpo.state, false);
      assert.equal(initVisto.body.includes("chave-teste-nao-logar"), false);
      const linha = log.linhas();
      assert.equal(linha.length, 1);
      assert.equal(linha[0]!.includes(goal), false);
    } finally {
      log.parar();
    }
  });

  test("discordância quando o choice difere do declarado", async () => {
    const log = instalarLog();
    try {
      const fila = [
        resposta({ task: "research", complexity: "critical", domain: "SERVER", noul: 0.07 }),
        resposta({ task: "coding", complexity: "simple", domain: "DAEMON", noul: 0.02 }),
      ];
      mockFetch(async () => ({ status: 200, text: async () => fila.shift()! }));
      definirEnv("true", "k");
      const pedido = { goal: "explica o relay", context: "só leitura", taskType: "coding", complexity: "simple" };
      disparar(pedido);
      disparar(pedido);
      await settleDelegateShadowForTests();
      const eventos = log.linhas().map((l) => JSON.parse(l.slice(PREFIXO.length)) as {
        choices: { task_type: string; complexity: string; domain: string };
        disagreeTaskType: boolean;
        disagreeComplexity: boolean;
        destructiveNoul: number;
        declaredTaskType: string;
        declaredComplexity: string;
        ok: boolean;
        error: null;
      });
      assert.equal(eventos.length, 2);
      assert.equal(eventos[0]!.choices.task_type, "research");
      assert.equal(eventos[0]!.choices.complexity, "critical");
      assert.equal(eventos[0]!.choices.domain, "SERVER");
      assert.equal(eventos[0]!.disagreeTaskType, true);
      assert.equal(eventos[0]!.disagreeComplexity, true);
      assert.equal(eventos[0]!.destructiveNoul, 0.07);
      assert.equal(eventos[0]!.declaredTaskType, "coding");
      assert.equal(eventos[0]!.declaredComplexity, "simple");
      assert.equal(eventos[0]!.ok, true);
      assert.equal(eventos[0]!.error, null);
      assert.equal(eventos[1]!.disagreeTaskType, false);
      assert.equal(eventos[1]!.disagreeComplexity, false);
      assert.equal(eventos[1]!.choices.task_type, "coding");
      assert.equal(eventos[1]!.choices.complexity, "simple");
    } finally {
      log.parar();
    }
  });

  test("linha de log não contém um sentinela posto no goal", async () => {
    const log = instalarLog();
    try {
      const sentinelaGoal = "SENTINELA_GOAL_7f3a9c";
      const sentinelaCtx = "SENTINELA_CTX_91ab";
      const chave = "CHAVE_SENTINELA_zz";
      const corpoCru = "CORPO_CRU_SENTINELA_que_nao_pode_no_log";
      let body = "";
      mockFetch(async (_url, init) => {
        body = init.body;
        return {
          status: 200,
          text: async () => JSON.stringify({ ...JSON.parse(resposta()), eco: corpoCru }),
        };
      });
      definirEnv("1", chave);
      disparar({
        goal: `altera o daemon ${sentinelaGoal}`,
        context: `notas ${sentinelaCtx}`,
        taskType: "coding",
        complexity: "simple",
      });
      await settleDelegateShadowForTests();
      assert.ok(body.includes(sentinelaGoal));
      assert.equal(body.includes(sentinelaCtx), false);
      const linhas = log.linhas();
      assert.equal(linhas.length, 1);
      const linha = linhas[0]!;
      assert.equal(linha.includes("\n"), false);
      assert.equal(linha.includes(sentinelaGoal), false);
      assert.equal(linha.includes(sentinelaCtx), false);
      assert.equal(linha.includes(chave), false);
      assert.equal(linha.includes(corpoCru), false);
      const evento = JSON.parse(linha.slice(PREFIXO.length)) as { ok: boolean; error: null };
      // Resposta 200 com um eco do goal fora do veredito: o log fica ok e não copia esse campo.
      assert.equal(evento.ok, true);
      assert.equal(evento.error, null);
    } finally {
      log.parar();
    }
  });

  test("fetch que rejeita não lança", async () => {
    const log = instalarLog();
    const rejeicoes: unknown[] = [];
    const onRej = (e: unknown) => { rejeicoes.push(e); };
    process.on("unhandledRejection", onRej);
    try {
      const sentinela = "SENTINELA_THROW_nao_sai";
      mockFetch(async () => { throw new Error(sentinela); });
      definirEnv("1", "k");
      assert.doesNotThrow(() => disparar({ goal: "faz X", taskType: "coding", complexity: "simple" }));
      await settleDelegateShadowForTests();
      await new Promise((r) => setImmediate(r));
      assert.equal(rejeicoes.length, 0);
      const linhas = log.linhas();
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0]!.includes(sentinela), false);
      const evento = JSON.parse(linhas[0]!.slice(PREFIXO.length)) as { ok: boolean; error: string };
      assert.equal(evento.ok, false);
      assert.equal(evento.error, "fetch");
    } finally {
      process.off("unhandledRejection", onRej);
      log.parar();
    }
  });

  test("scheduleDelegateShadow não muta o objeto e não chama fetch se desligado", async () => {
    const log = instalarLog();
    try {
    const json = {
      goal: "objetivo-original",
      context: "ctx",
      taskType: "coding",
      complexity: "simple",
      extra: "fica",
    };
    const antes = { ...json };
    definirEnv(undefined, "k");
    const ret = disparar(json);
    json.goal = "mudou-depois";
    await settleDelegateShadowForTests();
    assert.equal(ret, undefined);
    assert.equal(chamadasRede, 0);
    assert.deepEqual(json, { ...antes, goal: "mudou-depois" });
    assert.equal("choices" in json, false);

    let body = "";
    mockFetch(async (_url, init) => {
      body = init.body;
      return { status: 200, text: async () => resposta() };
    });
    const vivo = { goal: "objetivo-original", context: "ctx", taskType: "coding", complexity: "simple" };
    const foto = { ...vivo };
    definirEnv("1", "k");
    disparar(vivo);
    assert.deepEqual(vivo, foto);
    vivo.goal = "MUTADO_DEPOIS";
    await settleDelegateShadowForTests();
    assert.equal(JSON.parse(body).state.goal, "objetivo-original");
    assert.equal(vivo.goal, "MUTADO_DEPOIS");
    assert.equal(Object.keys(vivo).length, Object.keys(foto).length);
    assert.equal(log.linhas().some((l) => l.includes("objetivo-original")), false);
    } finally {
      log.parar();
    }
  });

  test("URL é exatamente o endpoint pinado", async () => {
    const log = instalarLog();
    try {
      let urlVista = "";
      mockFetch(async (url) => {
        urlVista = url;
        return { status: 200, text: async () => resposta() };
      });
      definirEnv("1", "k");
      disparar({ goal: "mede a url", taskType: "general", complexity: "simple" });
      await settleDelegateShadowForTests();
      assert.equal(urlVista, "https://api.typesafe.ai/v1/systemone");
      assert.equal(log.linhas().some((l) => l.includes("mede a url")), false);
      assert.equal(TYPESAFE_MODEL, "jev-1.13.0");
      assert.equal(TYPESAFE_TIMEOUT_MS, 2500);
      assert.match(CLIENTE, /https:\/\/api\.typesafe\.ai\/v1\/systemone/);
      assert.match(CLIENTE, /AbortSignal\.timeout\(TYPESAFE_TIMEOUT_MS\)/);
      assert.match(CLIENTE, /maxRedirects: 0/);
      assert.match(CLIENTE, /from "\.\/ssrf-guard\.js"/);
      assert.match(CLIENTE, /safeFetch\(/);
      assert.equal(CLIENTE.includes("jev-latest"), false);
      assert.equal(MODULO.includes("selectBrainRoute"), false);
      assert.equal(MODULO.includes("buildBridgeEnv"), false);
    } finally {
      log.parar();
    }
  });

  test("pula goal vazio ou já cifrado; contexto cifrado não sai no state", async () => {
    const log = instalarLog();
    try {
      let body = "";
      mockFetch(async (_url, init) => {
        body = init.body;
        return { status: 200, text: async () => resposta() };
      });
      definirEnv("1", "k");
      for (const goal of ["", "   ", "e2e:v2:blob", "e2e:legado", "  e2e:v2:blob", "e2e:v1:xx"]) {
        disparar({ goal, context: "ainda em claro", taskType: "coding", complexity: "simple" });
      }
      disparar({ goal: "plaintext ok", context: "e2e:v2:ctx", taskType: "coding", complexity: "simple" });
      await settleDelegateShadowForTests();
      assert.equal(chamadasRede, 1);
      assert.equal(log.linhas().length, 1);
      const state = JSON.parse(body).state as { goal: string; context?: string };
      assert.equal(state.goal, "plaintext ok");
      assert.equal("context" in state, false);
      assert.equal(body.includes("e2e:v2:ctx"), false);
    } finally {
      log.parar();
    }
  });

  test("erro curto: timeout, http_429 e parse", async () => {
    const log = instalarLog();
    try {
      const passos: DelegateShadowFetch[] = [
        async () => { throw Object.assign(new Error("demorou demais e o goal nao entra"), { name: "TimeoutError" }); },
        async () => ({ status: 429, text: async () => "BODY_429_SENTINELA" }),
        async () => ({ status: 200, text: async () => "nao-e-json BODY_PARSE_SENTINELA" }),
      ];
      // Um por vez: o 429 drena o body num await extra e terminaria fora de ordem.
      definirEnv("1", "k");
      const erros: string[] = [];
      for (const passo of passos) {
        mockFetch(passo);
        disparar({ goal: "um", taskType: "coding", complexity: "simple" });
        await settleDelegateShadowForTests();
        const linha = log.linhas().at(-1);
        assert.ok(linha);
        erros.push((JSON.parse(linha.slice(PREFIXO.length)) as { error: string }).error);
      }
      assert.deepEqual(erros, ["timeout", "http_429", "parse"]);
      const tudo = log.linhas().join("\n");
      assert.equal(tudo.includes("BODY_429_SENTINELA"), false);
      assert.equal(tudo.includes("BODY_PARSE_SENTINELA"), false);
      assert.equal(tudo.includes("demorou demais"), false);
      assert.ok(log.linhas().every((l) => (JSON.parse(l.slice(PREFIXO.length)) as { ok: boolean }).ok === false));
    } finally {
      log.parar();
    }
  });

  test("produção passa maxRedirects 0 e um 302 no primeiro hop não dispara o segundo POST", async () => {
    const log = instalarLog();
    try {
      const chave = "CHAVE_REDIRECT_NAO_SEGUE";
      const location = "https://evil.example/coletor";
      const corpoRedirect = "LOCATION_BODY_SENTINELA";
      const segundo = "SEGUNDO_POST_NAO_PODE";
      const hops: string[] = [];
      // Sem o atalho do fetch: o post tem de chegar no seam do safeFetch.
      setDelegateShadowFetch(null);
      setDelegateShadowSafeFetch(async (url, init, opts) => {
        assert.equal(opts.maxRedirects, 0);
        assert.equal(opts.timeoutMs, 2500);
        assert.equal(init.headers.Authorization, `Bearer ${chave}`);
        let current = url;
        const tabela = new Map([
          [TYPESAFE_SYSTEMONE_URL, { status: 302, location, body: corpoRedirect }],
          [location, { status: 200, location: "", body: segundo }],
        ]);
        // Mesmo limite do safeFetch: hop <= maxRedirects. 0 não chega no segundo POST.
        for (let hop = 0; hop <= opts.maxRedirects; hop++) {
          hops.push(current);
          const resp = tabela.get(current);
          assert.ok(resp, current);
          if (resp.status >= 300 && resp.status < 400 && resp.location) {
            current = resp.location;
            continue;
          }
          return { status: resp.status, text: async () => resp.body };
        }
        throw new Error(`SSRF bloqueado: redirects demais (> ${opts.maxRedirects})`);
      });
      definirEnv("1", chave);
      disparar({ goal: "nao seguir redirect", taskType: "coding", complexity: "simple" });
      await settleDelegateShadowForTests();
      assert.deepEqual(hops, [TYPESAFE_SYSTEMONE_URL]);
      assert.equal(chamadasRede, 0, "o atalho do fetch não pode mascarar o seam");
      const linhas = log.linhas();
      assert.equal(linhas.length, 1);
      const linha = linhas[0]!;
      assert.equal(linha.includes(location), false);
      assert.equal(linha.includes(corpoRedirect), false);
      assert.equal(linha.includes(segundo), false);
      assert.equal(linha.includes(chave), false);
      const evento = JSON.parse(linha.slice(PREFIXO.length)) as { ok: boolean; error: string };
      assert.equal(evento.ok, false);
      assert.equal(evento.error, "fetch");
    } finally {
      log.parar();
    }
  });

  test("feature ausente não posta", async () => {
    const log = instalarLog();
    try {
      registrarJevDoProjeto(PROJETO, false);
      definirEnv("1", "chave-presente");
      scheduleDelegateShadow({ goal: "faz um teste", taskType: "coding", complexity: "simple" }, PROJETO);
      scheduleDelegateShadow({ goal: "faz um teste", taskType: "coding", complexity: "simple" });
      await settleDelegateShadowForTests();
      assert.equal(chamadasRede, 0);
      assert.deepEqual(log.linhas(), []);
    } finally {
      log.parar();
    }
  });

  test("veredito emitido não contém goal nem context", async () => {
    const log = instalarLog();
    try {
      const sentinela = "SENTINELA_VEREDITO_9c1e";
      const enviados: unknown[] = [];
      definirEmissorSombra((msg) => { enviados.push(msg); });
      mockFetch(async () => ({ status: 200, text: async () => resposta() }));
      definirEnv("1", "chave-que-nao-sobe");
      registrarJevDoProjeto(PROJETO, true);
      scheduleDelegateShadow({
        goal: `altera ${sentinela}`,
        context: sentinela,
        taskType: "coding",
        complexity: "simple",
      }, PROJETO);
      await settleDelegateShadowForTests();
      assert.equal(enviados.length, 1);
      const msg = enviados[0] as Record<string, unknown>;
      const cru = JSON.stringify(msg);
      assert.equal(cru.includes(sentinela), false);
      assert.equal(cru.includes("chave-que-nao-sobe"), false);
      assert.equal("goal" in msg, false);
      assert.equal("context" in msg, false);
      assert.equal("probabilities" in msg, false);
      assert.equal("prompt" in msg, false);
      assert.equal(msg.type, "typesafe:shadow");
      assert.equal(msg.projectId, PROJETO);
      assert.equal(msg.ok, true);
      assert.equal(msg.taskType, "coding");
      assert.equal(msg.error, null);
      const conf = msg.confidence as { task_type: number } | null;
      assert.equal(conf?.task_type, 0.8);
    } finally {
      log.parar();
    }
  });

  test("relay chama scheduleDelegateShadow no delegate, antes de encryptBridgePayload, sem await", () => {
    const i0 = RELAY.indexOf("const encryptOr409");
    const i1 = RELAY.indexOf("if (body && body.length > 0", i0);
    assert.ok(i0 !== -1 && i1 > i0);
    const trecho = RELAY.slice(i0, i1);
    assert.match(trecho, /if \(kind === "delegate" && !Array\.isArray\(json\)\) \{\s*try \{ scheduleDelegateShadow\(json, projectId\); \} catch \{/);
    assert.equal(trecho.includes("await scheduleDelegateShadow"), false);
    assert.equal(/await\s+scheduleDelegateShadow/.test(trecho), false);
    const posSombra = trecho.indexOf("scheduleDelegateShadow(json, projectId)");
    const posCifra = trecho.indexOf("encryptBridgePayload(");
    assert.ok(posSombra !== -1 && posCifra !== -1 && posSombra < posCifra);
    assert.match(RELAY, /import \{ scheduleDelegateShadow \} from "\.\/typesafe-delegate-shadow\.js"/);
    assert.equal(RELAY.includes("selectBrainRoute"), false);
  });
});
