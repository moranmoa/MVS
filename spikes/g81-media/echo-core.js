// Stands in for mvs-core on the stdio channel: JSON lines in, JSON lines out.
// voiceFrame -> a voice.frame event back at once (as if from a peer);
// big -> a ~1 MB reply line (like a getMessages page) on the same pipe.
const readline = require('node:readline');

const BIG = 'x'.repeat(1_000_000);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.cmd === 'voiceFrame') {
    process.stdout.write(JSON.stringify({ event: 'voice.frame', callId: m.callId, from: m.peer, seq: m.seq, ts: m.ts, data: m.data }) + '\n');
  } else if (m.cmd === 'big') {
    process.stdout.write(JSON.stringify({ id: m.id, ok: true, page: BIG }) + '\n');
  }
});
