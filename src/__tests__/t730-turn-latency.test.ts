import './scratch-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnLatency, TurnTiming } from '../runners/turn-latency.js';
import { AgentRunner } from '../agent-runner.js';
import { handleStreamEvent } from '../runners/turns/claude.js';

test('T-730: queue/gate/first-event/end are distinct, boot recorded once, one final line', () => {
  let now = 0;
  const lines: any[] = [];
  const t = new TurnTiming(0, e => lines.push(e), () => now);
  now = 10; t.gateStart();
  now = 40; t.gateEnd(); t.start();
  now = 50; t.bootStart();
  now = 80; t.bootReady();
  now = 100; t.semantic('thinking');
  now = 120; t.bootReady(); t.semantic('text');
  assert.equal(lines.length, 0, 'no per-phase logging');
  now = 150; t.finish('completed'); t.finish('process-exit');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].queueMs, 40);
  assert.equal(lines[0].gateWaitMs, 30);
  assert.equal(lines[0].bootMs, 30);
  assert.equal(lines[0].firstEventMs, 60);
  assert.equal(lines[0].durationMs, 110);
  assert.equal(lines[0].firstEventKind, 'thinking');
});

test('T-755: accept marca write→CLI começou a mensagem; uma vez, só depois do start', () => {
  let now = 0; const lines: any[] = [];
  const t = new TurnTiming(0, e => lines.push(e), () => now);
  t.accept(); now = 10; t.start();
  now = 4_000; t.accept();          // init do CLI: espera na fila do stdin
  now = 9_000; t.accept();          // init tardio não sobrescreve
  now = 10_000; t.semantic('tool'); // 1º evento (1s após o accept tardio)
  now = 30_000; t.finish('completed');
  assert.equal(lines[0].acceptMs, 3_990, 'write→init mede a espera na fila do CLI');
  assert.equal(lines[0].firstEventMs, 9_990, 'firstEvent segue do write, como antes');
  // Sem start (ex.: init antes de qualquer mensagem), accept fica null.
  const semStart = new TurnTiming(0, e => lines.push(e), () => now);
  semStart.accept(); semStart.finish('completed');
  assert.equal(lines[1].acceptMs, null);
});

test('T-755: system/init do claude marca accept no timing FIFO mais antigo', () => {
  const marks: number[] = [];
  const timing: any = { accept: () => marks.push(1), setBootMs: () => marks.push(2) };
  const self: any = {
    claudeTimings: [timing], claudeBootStartedAt: performance.now(),
    claudeSawInit: false, toolsInFlight: 0, toolsInFlightSince: Date.now(),
    info: { id: 't755' }, buffer: '',
    touchActivity: () => {}, setState: () => {}, opts: {},
    contextTracker: { setResolvedModel: () => {} },
  };
  handleStreamEvent(self, { type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
  assert.deepEqual(marks, [1, 2], 'init marca accept e boot');
  handleStreamEvent(self, { type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
  assert.deepEqual(marks, [1, 2, 1], 'init repetido chama accept de novo (once-only é do TurnTiming, c/ boot já setado)');
});

test('T-730: no semantic event is null; hard recover retains cause despite late close', () => {
  let now = 0; const lines: any[] = [];
  const t = new TurnTiming(2, e => lines.push(e), () => now);
  t.start(); now = 1_804_000;
  t.finish('hard-recover', 'watchdog', 'lifetime');
  t.semantic('text'); t.finish('completed');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].firstEventMs, null);
  assert.equal(lines[0].firstEventKind, null);
  assert.equal(lines[0].gateWaitMs, null);
  assert.equal(lines[0].durationMs, 1_804_000);
  assert.equal(lines[0].killedBy, 'watchdog');
  assert.equal(lines[0].recoverKind, 'lifetime');
});

test('T-730: equal messages have distinct identities, retry attempt and stale finalizer stay isolated', () => {
  const lines: any[] = [];
  const tracker = new TurnLatency('agent-id', 'qwen', (_l, s) => lines.push(JSON.parse(s.slice(15))));
  const a = { content: 'PRIVATE_PROMPT' }, b = { content: 'PRIVATE_PROMPT' };
  tracker.enqueue(a); tracker.enqueue(b);
  const first = tracker.activate(a, 'cold'); first.start(); first.finish('hard-recover', 'watchdog', 'hang');
  const retry = {}; tracker.enqueue(retry, true);
  const second = tracker.activate(retry, 'resume'); second.start();
  first.finish('completed');
  second.semantic('tool'); second.finish('completed');
  tracker.discard(b, 'queue-cleared');
  assert.equal(lines.length, 3);
  assert.notEqual(lines[0].turnId, lines[1].turnId);
  assert.equal(lines[1].attempt, 1);
  assert.equal(lines[1].endReason, 'completed');
  assert.equal(lines[2].queueMs, null);
  assert.equal(lines[2].durationMs, null);
  assert.ok(!JSON.stringify(lines).includes('PRIVATE_PROMPT'));
  assert.ok(lines.every(row => !('agentName' in row) && !('sessionId' in row)));
});

test('T-730: logging exceptions cannot interrupt the runner', () => {
  const tracker = new TurnLatency('agent-id', 'qwen', () => { throw new Error('logger failed'); });
  assert.doesNotThrow(() => tracker.create().finish('error'));
});

test('T-730: real qwen driver observes hidden thinking before buffered text; two turns, two lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't730-test-'));
  const command = join(dir, 'qwen.mjs');
  writeFileSync(command, `#!/usr/bin/env node
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
 send({type:'system',subtype:'init',session_id:'s'});
 setTimeout(() => send({type:'assistant',session_id:'s',message:{content:[{type:'thinking',thinking:'HIDDEN_THOUGHT'}]}}), 50);
 setTimeout(() => send({type:'assistant',session_id:'s',message:{content:[{type:'text',text:'answer'}]}}), 100);
 setTimeout(() => { send({type:'result',subtype:'success',session_id:'s',result:'answer'}); }, 150);
});
`, { mode: 0o755 });
  const lines: any[] = []; let thoughts = 0;
  const runner = new AgentRunner({ id: 't730-test-' + process.pid, name: 'PRIVATE_NAME', role: 'backend',
    ownerUserId: 'u', systemPrompt: 'PRIVATE_PROMPT', collectThinking: false, state: 'idle', running: true,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }, ephemeral: false,
  } as never, { cliRunner: 'qwen', cliCommands: { qwen: { command, available: true, source: 'override' } },
    workspaceRoot: dir, bridgeCommand: 'node', bridgeArgs: [], agentToken: 'PRIVATE_CREDENTIAL', orchestratorUrl: 'http://127.0.0.1:1',
    log: (_l: string, s: string) => { if (s.startsWith('[turn-latency] ')) lines.push(JSON.parse(s.slice(15))); },
    cliLog: () => {}, onState: () => {}, onAssistantText: () => true, onThinkingText: () => thoughts++,
    onToolUse: () => {}, onError: () => {}, onExit: () => {}, onHung: () => {},
  } as never);
  try {
    await runner.start();
    runner.pushUserMessage('PRIVATE_PROMPT'); runner.pushUserMessage('PRIVATE_PROMPT');
    const deadline = Date.now() + 10_000;
    while (lines.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(lines.length, 2);
    assert.equal(thoughts, 0);
    assert.ok(lines.every(row => row.firstEventKind === 'thinking' && row.endReason === 'completed'));
    assert.ok(lines.every(row => row.firstEventMs > row.bootMs && row.durationMs > row.firstEventMs));
    assert.ok(lines[1].queueMs > lines[0].queueMs);
    assert.deepEqual(lines.map(row => row.sessionMode), ['cold', 'resume']);
    assert.ok(!/PRIVATE_|HIDDEN_THOUGHT/.test(JSON.stringify(lines)));
  } finally { runner.stop(); }
});

test('T-730: real watchdog recovery emits lifetime cause before late process close', () => {
  const lines: any[] = [];
  const runner = new AgentRunner({ id: 't730-watchdog-' + process.pid, name: 'PRIVATE_NAME', role: 'backend',
    ownerUserId: 'u', state: 'idle', running: true, ephemeral: false,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
  } as never, { cliRunner: 'qwen', workspaceRoot: tmpdir(),
    log: (_l: string, line: string) => { if (line.startsWith('[turn-latency] ')) lines.push(JSON.parse(line.slice(15))); },
    onState: () => {}, onHung: () => {}, onError: () => {}, onExit: () => {},
  } as never);
  const self = runner as any;
  try {
    const timing = self.turnLatency.activate({}, 'resume'); timing.start();
    self.recoverHungTurn('turn lifetime 1804s ≥ 1800s', 50_567, 'lifetime');
    timing.finish('completed');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].endReason, 'hard-recover');
    assert.equal(lines[0].killedBy, 'watchdog');
    assert.equal(lines[0].recoverKind, 'lifetime');
    assert.equal(lines[0].firstEventMs, null);
  } finally { runner.stop(); }
});
