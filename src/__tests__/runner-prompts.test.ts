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
    goals: false, credentials: false, webhooks: false,
  });
  assert.ok(header.startsWith("You are an agent running locally."));
  for (const absent of ["send_message", "list_agents", "list_tasks", "lock_file", "list_goals", "recall", "get_credential", "send_webhook", "task board"]) {
    assert.ok(!header.includes(absent), `leaked disabled capability: ${absent}`);
  }
  assert.ok(header.includes("Check actual files on disk"));
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
