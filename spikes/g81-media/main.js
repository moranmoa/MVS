// G-81 spike (docs/design/g81-p2p-calls.md §5): measures, in Electron on this
// machine, what the go/no-go needs. Scratch code, never shipped.
//
//   electron spikes/g81-media/main.js [codec|ipc|aec] [--out results.json]
//
// - codec: WebCodecs Opus encode+decode latency per 40 ms frame, real time.
// - ipc:   frame round trip renderer -> main -> a JSON-lines stdio child (the
//          core's channel shape) -> main -> renderer, 4 peers x 25 frames/s,
//          alone and with ~1 MB responses on the same channel every 2 s.
// - aec:   plays test noise OUT LOUD and records the mic (needs the owner's OK).
//
// Uses a throwaway profile (never the owner's MVS data).

const { app, BrowserWindow, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv.find((a) => ['codec', 'ipc', 'aec'].includes(a)) || 'codec';
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : path.join(__dirname, `results-${mode}.json`);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mvs-g81-spike-')));

let child = null;
let win = null;

function startChild() {
  child = spawn(process.execPath.includes('electron') ? process.execPath : 'node', [path.join(__dirname, 'echo-core.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      // Like the real sidecar: parse every line, then hand it to the renderer.
      const msg = JSON.parse(line);
      if (msg.event === 'voice.frame') win?.webContents.send('voice.frame', msg);
      else win?.webContents.send('reply', { id: msg.id, size: line.length });
    }
  });
}

ipcMain.on('voiceFrame', (_e, frame) => child.stdin.write(JSON.stringify({ cmd: 'voiceFrame', ...frame }) + '\n'));
ipcMain.on('big', (_e, id) => child.stdin.write(JSON.stringify({ cmd: 'big', id }) + '\n'));
ipcMain.on('done', (_e, results) => {
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.summary ?? results, null, 2));
  child?.kill();
  app.quit();
});
ipcMain.on('log', (_e, m) => console.log('[page]', m));

app.whenReady().then(() => {
  // Microphone for the aec mode only; nothing else.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(mode === 'aec' && perm === 'media'));
  if (mode === 'ipc') startChild();
  win = new BrowserWindow({
    show: mode === 'aec',
    width: 600,
    height: 300,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'page.html'), { query: { mode } });
});
