import './scratch-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRunner } from '../agent-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/t743-acp-exit.mjs', import.meta.url));
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('T-743: real AgentRunner, child exits during handshake', { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 't743-'));
  const requests = join(dir, 'requests.jsonl');
  const command = join(dir, 'dsh');
  writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} initialize ${quote(requests)}\n`, { mode: 0o755 });
  const errors: string[] = [], logs: string[] = [], exits: Array<number | null> = [];
  const runner = new AgentRunner({
    id: `agent_t743_${process.pid}`, ownerUserId: 'u', name: 't743', role: 'backend',
    systemPrompt: '', color: '#fff', state: 'idle', running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never, {
    bridgeCommand: 'node', bridgeArgs: [], orchestratorUrl: 'http://127.0.0.1:0',
    agentToken: 't', cliRunner: 'dsh', workspaceRoot: dir,
    cliCommands: { dsh: { command, available: true, source: 'override' } },
    log: (_level: string, message: string) => logs.push(message), cliLog: () => {},
    onState: () => {}, onAssistantText: () => true, onToolUse: () => {},
    onError: (message: string) => errors.push(message), onHung: () => {},
    onExit: (code: number | null) => exits.push(code),
  } as never);
  const state = runner as unknown as { dshHandshakeFails?: number; dshRestartTimer?: NodeJS.Timeout };
  try {
    await runner.start();
    const deadline = Date.now() + 45_000;
    while (!exits.length && Date.now() < deadline) await sleep(25);
    const attempts = readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { time: number });
    t.diagnostic(JSON.stringify({ attempts: attempts.length, fails: state.dshHandshakeFails ?? 0, errors, logs: logs.filter(l => l.includes('dsh]')), exits }));
    await t.test('(a) counts five handshake failures', () => assert.equal(state.dshHandshakeFails, 5));
    await t.test('(b) exponential backoff 1s, 2s, 4s, 8s in logs and elapsed time', () => {
      const delays = logs.flatMap(l => /restart com resume em (\d+)ms/.exec(l)?.slice(1).map(Number) ?? []);
      assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
      for (let i = 1; i < attempts.length; i++) assert.ok(attempts[i]!.time - attempts[i - 1]!.time >= delays[i - 1]! - 50);
    });
    await t.test('(c) emits and locally logs the actual handshake error', () => {
      assert.equal(errors.filter(e => e.includes('handshake: dsh saiu (code=0)')).length, 5);
      assert.equal(logs.filter(e => e.includes('handshake: dsh saiu (code=0)')).length, 5);
    });
    await t.test('(d) stops after five attempts and emits exit once', async () => {
      assert.equal(attempts.length, 5);
      assert.equal(exits.length, 1);
      assert.ok(errors.some(e => e.includes('agente PARADO')));
      await sleep(1100);
      assert.equal(readFileSync(requests, 'utf8').trim().split('\n').length, 5);
    });
  } finally { runner.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// Deterministic wire/exit ordering, including error frame + exit in one turn.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { DshClient, startDsh, dshStop } from '../runners/turns/dsh.js';

for (const stage of ['initialize', 'session/new', 'session/set_config_option', 'session/resume']) {
  test(`T-743: exit at ${stage}, same-turn rejection and orphan protection`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const errors: string[] = [];
    const logs: string[] = [];
    const originalStart = DshClient.prototype.start;
    let afterExit: (() => void) | undefined;
    let die: () => void = () => { throw new Error('child not started'); };
    t.mock.method(DshClient.prototype, 'start', function (this: DshClient) {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
        exitCode: null as number | null, killed: false,
        kill: () => { if (child.exitCode === null) die(); return true; },
      });
      die = () => { child.exitCode = 0; child.emit('exit', 0); afterExit?.(); };
      child.stdin.on('data', (chunk: Buffer) => {
        const req = JSON.parse(chunk.toString());
        queueMicrotask(() => {
          if (req.method === stage) {
            if (stage === 'session/resume') child.stdout.write(JSON.stringify({ id: req.id, error: { code: -32603, message: 'session is not resumable' } }) + '\n');
            die();
          } else child.stdout.write(JSON.stringify({ id: req.id, result: { protocolVersion: 1, sessionId: '57eb3eca-0a64-411f-890d-8478bef47e71', configOptions: [] } }) + '\n');
        });
      });
      originalStart.call(this, 'fake', [], { cwd: tmpdir(), env: {} }, () => child as unknown as ChildProcess);
    });
    const self: any = {
      opts: { workspaceRoot: tmpdir(), bridgeCommand: 'node', bridgeArgs: [],
        resumeSessionId: stage === 'session/resume' ? '57eb3eca-0a64-411f-890d-8478bef47e71' : undefined,
        onError: (m: string) => errors.push(m), log: (_l: string, m: string) => logs.push(m) },
      info: { id: 'unit', sessionId: stage === 'session/resume' ? '57eb3eca-0a64-411f-890d-8478bef47e71' : undefined },
      messageSession: {}, runnerCommand: () => 'fake', buildEnv: () => ({}), bridgeEnv: () => ({}),
      setState: () => {}, emitExit: t.mock.fn(),
    };
    const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    startDsh(self);
    await flush();
    assert.equal(self.dshHandshakeFails, 1);
    assert.match(errors[0]!, stage === 'session/resume' ? /session is not resumable/ : /dsh saiu/);
    assert.ok(logs.some(l => l.includes('1000ms')));
    if (stage === 'session/resume') {
      assert.equal(self.opts.resumeSessionId, undefined);
      assert.equal(self.info.sessionId, undefined);
    }
    dshStop(self);
    // Supersede a live client before its queued response/exit and catch execute.
    startDsh(self);
    const replacement = {};
    self.dsh = replacement;
    const before = { fails: self.dshHandshakeFails, errors: errors.length, logs: logs.length };
    await flush();
    assert.equal(self.dsh, replacement);
    assert.equal(self.dshHandshakeFails, before.fails);
    assert.equal(errors.length, before.errors);
    assert.equal(logs.length, before.logs);
    assert.equal(self.dshRestartTimer, null);
    // More subtle: the current child dies, onExit runs, then it is superseded
    // before the rejection microtask. The deferred finalizer must be inert too.
    self.opts.resumeSessionId = stage === 'session/resume' ? '57eb3eca-0a64-411f-890d-8478bef47e71' : undefined;
    let snapshot: { fails: number; errors: number; logs: number } | undefined;
    afterExit = () => {
      self.dsh = replacement;
      snapshot = { fails: self.dshHandshakeFails, errors: errors.length, logs: logs.length };
    };
    startDsh(self);
    await flush();
    assert.ok(snapshot);
    assert.equal(self.dsh, replacement);
    assert.equal(self.dshHandshakeFails, snapshot.fails);
    assert.equal(errors.length, snapshot.errors);
    assert.equal(logs.length, snapshot.logs);
    assert.equal(self.dshRestartTimer, null);
    if (stage === 'session/resume') assert.ok(self.opts.resumeSessionId, 'orphan cannot clear current resume id');
  });
}
