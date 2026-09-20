// Controlled ACP child: exits while a handshake request is outstanding.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [mode, log] = process.argv.slice(2);
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(log, JSON.stringify({ method: request.method, time: Date.now(), pid: process.pid }) + '\n');
  if (request.method === mode) process.exit(0);
  const result = request.method === 'initialize'
    ? { protocolVersion: 1 }
    : { sessionId: '57eb3eca-0a64-411f-890d-8478bef47e71', configOptions: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
