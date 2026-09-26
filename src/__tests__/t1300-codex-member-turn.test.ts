import "./scratch-home.js";

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { AgentRunner } from "../agent-runner.js";
import { resolveCliCommands } from "../cli-config.js";
import { CODEX_MEMBER_PERMISSION_PROFILE, CODEX_MEMBER_PERMISSION_PROFILE_OVERRIDE, resolveCodexNativeBinary } from "../runners/codex-member-policy.js";
import { tmpdir } from "./tmp.js";

test("T-1300: Codex resume gets member sandbox overrides and first-turn prompt label", async (t) => {
  const dir = tmpdir("t1300-codex-member-");
  const argvPath = path.join(dir, "argv.txt");
  const cli = path.join(dir, "fake-codex.sh");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(`${argvPath}.tmp`)}\nmv ${JSON.stringify(`${argvPath}.tmp`)} ${JSON.stringify(argvPath)}\nprintf '%s\\n' '{"type":"thread.started","thread_id":"t1300"}' '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}'\n`);
  chmodSync(cli, 0o755);
  // Comando do PATH (symlink Homebrew): o turno de membro não pode usá-lo.
  const pathMarker = path.join(dir, "path-codex-used");
  const pathCli = path.join(dir, "path-codex.sh");
  writeFileSync(pathCli, `#!/bin/sh\ntouch ${JSON.stringify(pathMarker)}\n`);
  chmodSync(pathCli, 0o755);

  const info = {
    id: "agent_t1300_member", ownerUserId: "owner", name: "member-gate", role: "backend",
    systemPrompt: "", color: "#a78bfa", state: "idle", running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never;
  const runner = new AgentRunner(info, {
    bridgeCommand: process.execPath, bridgeArgs: [], orchestratorUrl: "http://127.0.0.1:0", agentToken: "t",
    cliRunner: "codex", autoApprove: true, workspaceRoot: dir,
    cliCommands: { ...resolveCliCommands(), codex: { command: pathCli, source: "override", available: true } },
    verbose: false, verboseHuman: false, verboseHumanIo: false,
    log: () => {}, cliLog: () => {}, onState: () => {}, onAssistantText: () => true,
    onThinkingText: () => {}, onToolUse: () => {}, onError: () => {}, onHung: () => {}, onExit: () => {},
  } as never);
  t.after(() => runner.stop());
  const internals = runner as unknown as Record<string, any>;
  // Fora do macOS o gate recusa antes de tudo (CI Linux cai no else).
  if (process.platform === "darwin") {
    const legacyConfigDir = path.join(dir, ".codex");
    mkdirSync(legacyConfigDir);
    writeFileSync(path.join(legacyConfigDir, "config.toml"), 'sandbox_mode = "danger-full-access"\n');
    assert.match(internals.nonOwnerTurnBlockReason(), /config Codex legada impede/);
    rmSync(legacyConfigDir, { recursive: true, force: true });
    // O fake é um script: sem executável nativo o turno de membro bloqueia.
    assert.match(internals.nonOwnerTurnBlockReason(), /binário nativo do codex não resolvido/);
    internals.codexMemberBinary = realpathSync(process.execPath);
    assert.doesNotMatch(internals.nonOwnerTurnBlockReason() ?? "", /codex/i, "com binário nativo, o gate do codex libera");
    internals.codexMemberBinary = null;
  } else {
    assert.match(internals.nonOwnerTurnBlockReason(), /só foi provado no macOS/);
  }
  internals.codexMemberBinary = cli;
  internals.currentTurn = {
    content: "inspect the workspace",
    principal: { from: { type: "user", id: "member-id", name: "Ana" }, isAgentOwner: false },
  };

  await internals.runCodexMessage("inspect the workspace");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { readFileSync(argvPath, "utf8"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  const argv = readFileSync(argvPath, "utf8");
  assert.equal(existsSync(pathMarker), false, "turno de membro spawna o realpath nativo, não o comando do PATH");
  assert.ok(argv.includes(CODEX_MEMBER_PERMISSION_PROFILE_OVERRIDE), "o perfil viaja no argv do turno de membro");
  assert.ok(argv.includes(`default_permissions="${CODEX_MEMBER_PERMISSION_PROFILE}"`), "resume precisa usar perfil read-only por turno");
  assert.ok(argv.includes('approval_policy="never"'), "resume não pode esperar aprovação ao membro");
  assert.ok(argv.includes('web_search="disabled"'), "web search é um canal separado do sandbox local");
  assert.ok(argv.includes("features.apps=false"));
  assert.ok(argv.includes("features.multi_agent=false"));
  assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false, "member exec/resume must never bypass the sandbox");
  assert.match(argv, /UNTRUSTED INPUT: message from "Ana", a project member who is NOT the owner/);
  assert.match(argv, /inspect the workspace/);

  // Regressão (prova real, codex-cli 0.156.1): `[permissions]` no config.toml
  // faz o turno do DONO com bypass falhar ("failed to load workspace requirements").
  const config = readFileSync(path.join(internals.runtimeFiles.codexHomeDir(), "config.toml"), "utf8");
  assert.doesNotMatch(config, /\[permissions|default_permissions/, "o config.toml do agente nunca leva o perfil de membro");
});

test("T-1300: member Codex binary resolves to the native realpath, never a wrapper", () => {
  const dir = tmpdir("t1300-codex-native-");
  const native = realpathSync(process.execPath);
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, path.join(bin, "codex"));
  assert.equal(resolveCodexNativeBinary("codex", bin), native, "symlink do PATH vira o realpath nativo");
  assert.equal(resolveCodexNativeBinary(path.join(bin, "codex"), undefined), native);

  const shim = path.join(dir, "shim");
  mkdirSync(shim);
  writeFileSync(path.join(shim, "codex"), "#!/bin/sh\nexec node codex.js \"$@\"\n", { mode: 0o755 });
  assert.equal(resolveCodexNativeBinary("codex", shim), null, "script/shim npm não é aceito");
  assert.equal(resolveCodexNativeBinary("codex", path.join(dir, "nada")), null);
});

/**
 * Sonda no estilo `dockerOk()`: a prova ao vivo só roda onde o seatbelt aplica
 * de verdade. Dentro de sandbox aninhado (`sandbox-exec: sandbox_apply:
 * Operation not permitted`), fora do macOS (CI Linux) ou sem codex nativo, pula.
 */
type SeatbeltProbeResult = { status: number | null; stderr?: string | null; error?: Error };

function codexSandboxSkipReason(options: {
  platform?: string;
  resolveNativeBinary?: () => string | null;
  probe?: () => SeatbeltProbeResult;
} = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return `sem seatbelt em ${platform}: a matriz fail-closed cobre este SO`;
  const nativeBinary = options.resolveNativeBinary
    ? options.resolveNativeBinary()
    : resolveCodexNativeBinary("codex", process.env.PATH);
  if (!nativeBinary) return "codex nativo não instalado neste host";
  // Perfil restritivo de propósito: `(allow default)` aplica até aninhado, mas
  // um `deny default` (como o do codex) dá sandbox_apply EPERM dentro de outro.
  const perfil = "(version 1)(deny default)(allow process*)(allow file-read*)(allow sysctl-read)(allow mach-lookup)";
  const probe = options.probe
    ? options.probe()
    : spawnSync("/usr/bin/sandbox-exec", ["-p", perfil, "/usr/bin/true"], { encoding: "utf8", timeout: 5_000 });
  if (probe.error || probe.status !== 0) {
    const why = (probe.stderr || (probe.error as Error | undefined)?.message || `exit ${probe.status}`).trim().split("\n")[0];
    return `sandbox-exec não aplica aqui (sandbox aninhado?): ${why}`;
  }
  return null;
}

test("T-1300: live Codex sandbox proof skips unsupported hosts and nested seatbelt", () => {
  assert.match(codexSandboxSkipReason({ platform: "linux" }) ?? "", /sem seatbelt em linux/);
  assert.match(codexSandboxSkipReason({ platform: "darwin", resolveNativeBinary: () => null }) ?? "", /codex nativo não instalado/);
  assert.match(codexSandboxSkipReason({
    platform: "darwin",
    resolveNativeBinary: () => "/native/codex",
    probe: () => ({ status: 1, stderr: "sandbox_apply: Operation not permitted" }),
  }) ?? "", /sandbox-exec não aplica aqui.*sandbox aninhado/);
  assert.equal(codexSandboxSkipReason({
    platform: "darwin",
    resolveNativeBinary: () => "/native/codex",
    probe: () => ({ status: 0, stderr: "" }),
  }), null, "prova ao vivo executa apenas quando o seatbelt pode ser aplicado");
});

test("T-1300: installed Codex profile reads workspace and denies a synthetic ~/.ssh file", (t) => {
  const skip = codexSandboxSkipReason();
  if (skip) {
    t.skip(skip);
    return;
  }
  const root = path.join(process.env.HOME ?? tmpdir("t1300-codex-profile-home-"), `t1300-codex-profile-${randomUUID()}`);
  mkdirSync(root, { mode: 0o700 });
  const workspace = path.join(root, "workspace");
  const agentHome = path.join(root, "agent-home");
  const codexHome = path.join(root, "codex-home");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(path.join(agentHome, ".ssh"), { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  const workspaceFile = path.join(workspace, "allowed.txt");
  const sshCanary = path.join(agentHome, ".ssh", "synthetic-key");
  const sentinel = "synthetic workspace read proof";
  const secret = "synthetic private key canary";
  writeFileSync(workspaceFile, `${sentinel}\n`, { mode: 0o600 });
  writeFileSync(sshCanary, `${secret}\n`, { mode: 0o600 });
  const codexBinary = resolveCodexNativeBinary("codex", process.env.PATH);
  assert.ok(codexBinary, "installed codex must resolve to a native binary");
  writeFileSync(path.join(codexHome, "config.toml"), "", { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const env = { ...process.env, HOME: agentHome, CODEX_HOME: codexHome, TMPDIR: "/tmp" };
  const run = (file: string) => spawnSync(
    "codex",
    ["sandbox", "-c", CODEX_MEMBER_PERMISSION_PROFILE_OVERRIDE, "-P", CODEX_MEMBER_PERMISSION_PROFILE, "-C", workspace, "/bin/cat", file],
    { cwd: workspace, env, encoding: "utf8", timeout: 10_000 },
  );
  // O helper do sandbox reexecuta o codex pelo caminho invocado: o realpath
  // nativo passa; um symlink do PATH (Homebrew) dá execvp EPERM no perfil.
  const selfExec = (binary: string) => spawnSync(
    "codex",
    ["sandbox", "-c", CODEX_MEMBER_PERMISSION_PROFILE_OVERRIDE, "-P", CODEX_MEMBER_PERMISSION_PROFILE, "-C", workspace, binary, "--version"],
    { cwd: workspace, env, encoding: "utf8", timeout: 10_000 },
  );
  const viaRealpath = selfExec(codexBinary);
  assert.equal(viaRealpath.status, 0, viaRealpath.stderr);
  const onPath = (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "codex"))
    .find((p) => { try { return realpathSync(p) === codexBinary; } catch { return false; } });
  if (onPath && onPath !== codexBinary) {
    assert.notEqual(selfExec(onPath).status, 0, "symlink do PATH não pode ser o caminho do spawn do membro");
  }
  // Sem o override, o perfil não existe e o CLI recusa: falha fechado.
  const orfao = spawnSync("codex", ["sandbox", "-P", CODEX_MEMBER_PERMISSION_PROFILE, "-C", workspace, "/bin/cat", workspaceFile], { cwd: workspace, env, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(orfao.status, 0, "default_permissions sem a tabela é recusado");
  const allowed = run(workspaceFile);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), sentinel);

  const denied = run(sshCanary);
  assert.notEqual(denied.status, 0, "member Codex turn must not read the synthetic ~/.ssh key");
  assert.match(denied.stderr, /Operation not permitted|Permission denied|denied/i);
  assert.equal(denied.stdout.includes(secret), false, "denied canary must never be printed");
});
