import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentContext, buildInitialMessage, buildSystemPromptHeader, buildWorkspacePrompt } from "../runners/prompts.js";

test("capability header defaults every feature on", () => {
  const header = buildSystemPromptHeader();
  for (const section of ["CRITICAL ROUTING RULE", "Shared task board", "Webhooks", "File locking", "Goal alignment", "Agent memory", "Credentials", "Conversation discipline"]) {
    assert.ok(header.includes(section), `missing ${section}`);
  }
});

test("disabled capabilities remove their prose and cross-references", () => {
  const header = buildSystemPromptHeader({
    teammates: false, tasks: false, filelock: false, memory: false,
    goals: false, credentials: false, webhooks: false, graph: false,
  });
  assert.ok(header.startsWith("You are an agent running locally."));
  for (const absent of ["send_message", "list_agents", "list_tasks", "lock_file", "list_goals", "recall", "get_credential", "send_webhook", "task board", "graphify", "query_graph"]) {
    assert.ok(!header.includes(absent), `leaked disabled capability: ${absent}`);
  }
  assert.ok(header.includes("Check actual files on disk"));
});

test("graph capability is opt-in and only present when graph:true", () => {
  const off = buildSystemPromptHeader({ graph: false });
  assert.ok(!off.includes("Knowledge graph"), "graph prose must be absent when off");
  assert.ok(!off.includes("query_graph"), "graph tools must be absent when off");
  const on = buildSystemPromptHeader({ graph: true });
  assert.ok(on.includes("Knowledge graph"), "missing GRAPH section");
  assert.ok(on.includes("query_graph"));
  assert.ok(on.includes("god_nodes"));
  // default (undefined) also omits graph — opt-in only
  const def = buildSystemPromptHeader();
  assert.ok(!def.includes("Knowledge graph"));
});

test("tasks without teammates keep the board but omit teammate routing", () => {
  const header = buildSystemPromptHeader({ teammates: false, tasks: true });
  assert.ok(header.includes("Shared task board"));
  assert.ok(header.includes("Every task can link to a goal"));
  assert.ok(!header.includes("send_message"));
  assert.ok(!header.includes("list_agents"));
  assert.ok(!header.includes("When you discover work for someone else"));
});

test("workspace prompt includes repository defaults when configured", () => {
  assert.equal(buildWorkspacePrompt({ workspaceRoot: "/work", repo: { gitUrl: "git@example/repo.git" } }), [
    "Your working directory is `/work`.",
    "All project files and the git repository are located in this directory.",
    "Repository: git@example/repo.git (branch: main)",
    "Use this directory as the root for all file operations, git commands, and tool executions.",
  ].join("\n"));
});

test("agent context composes capabilities, role, workspace, summary and addon", () => {
  const context = buildAgentContext({
    capabilityHeader: "# Capabilities", role: "Reviewer", systemPrompt: "Be precise.",
    workspace: "Workspace details", summary: "Previous work", addon: "\n\nPlan only.",
  });
  assert.equal(context, "# Capabilities\n\n# Your role\nReviewer\n\nBe precise.\n\n# Workspace\nWorkspace details\n\n# Previous conversation summary\nPrevious work\n\nPlan only.");
});

test("initial message adds exactly one user-content separator and omits empty summary", () => {
  const message = buildInitialMessage({
    capabilityHeader: "Header", role: "Builder", systemPrompt: "Build.", workspace: "Work", summary: "", content: "Do it",
  });
  assert.equal(message, "Header\n\n# Your role\nBuilder\n\nBuild.\n\n# Workspace\nWork\n\n---\n\nDo it");
});

test("board prose commits to ONE mode: blocks with a single diagram language, or HTML", () => {
  const mermaid = buildSystemPromptHeader({ board: true });
  assert.ok(mermaid.includes("Diagram language: MERMAID"));
  assert.ok(mermaid.includes('`kind: "d2"` does not exist here'));
  assert.ok(!mermaid.includes("This board is HTML"), "modo blocks não pode citar HTML");

  const d2 = buildSystemPromptHeader({ board: true, diagramLanguage: "d2" });
  assert.ok(d2.includes("Diagram language: D2"));
  assert.ok(d2.includes("d2lang.com"));
  assert.ok(d2.includes('`kind: "mermaid"` does not exist here'));
  // A cerca de markdown quebrava o compilador — o prompt precisa dizer.
  assert.ok(d2.includes("no ```"));

  const html = buildSystemPromptHeader({ board: true, boardMode: "html" });
  assert.ok(html.includes("This board is ONE HTML page"));
  assert.ok(html.includes("REPLACES the page"), "precisa dizer que é página única");
  assert.ok(html.includes("shown whole"), "precisa dizer que aparece inteira");
  // Sem isto o agente escreve uma coluna estreita centralizada e sobra
  // faixa vazia dos dois lados.
  assert.ok(html.includes("Use the full width"), "precisa mandar usar a largura");
  assert.ok(html.includes("auto-fit"), "precisa dar a receita de grid responsivo");
  assert.ok(html.includes("stable id"));
  // Modo exclusivo: nada de markdown/diagrama competindo com a página.
  assert.ok(!html.includes("Diagram language:"), "modo html não pode citar diagrama");

  assert.ok(!buildSystemPromptHeader({ board: false, boardMode: "html" }).includes("This board is ONE HTML page"));
});

test("html level decides what the page may use, and the palette is always given", () => {
  const basic = buildSystemPromptHeader({ board: true, boardMode: "html", boardHtmlLevel: "basic" });
  assert.ok(basic.includes("Level: BASIC"));
  assert.ok(basic.includes("No <script>"), "básico não autoriza script");
  assert.ok(!basic.includes("three.js"), "básico não pode citar three");

  const normal = buildSystemPromptHeader({ board: true, boardMode: "html" });
  assert.ok(normal.includes("Level: NORMAL"));
  assert.ok(normal.includes("JavaScript"));
  assert.ok(!normal.includes("three.js"), "normal para no JS");

  const quality = buildSystemPromptHeader({ board: true, boardMode: "html", boardHtmlLevel: "quality" });
  assert.ok(quality.includes("Level: QUALITY"));
  assert.ok(quality.includes("three.js"));
  // O 3D é meio, não fim — o prompt precisa segurar isso.
  assert.ok(quality.includes("still a LESSON"));

  // Paleta em todos: sem ela cada página inventa um esquema de cor.
  for (const h of [basic, normal, quality]) {
    assert.ok(h.includes("var(--accent)"), "faltou a paleta");
    assert.ok(h.includes("Palette"));
  }
});
