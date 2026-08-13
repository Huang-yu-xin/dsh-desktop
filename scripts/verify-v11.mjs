// V1.1 reliability verification driver. Connects to the DESKTOP APP over CDP.
// Modes operate on the LOCAL shell page (file://) except probe-harness-ipc,
// which drives the official harness page to prove the IPC gates reject it.
//
//   dump <file>              save body text of the local shell page
//   lost-assert <file>       save lost-view facts (visible, workspace, reason)
//   click-<restart|back|show-logs|copy-logs|close-logs|retry>
//   logs-dump <file>         save the logs panel text
//   window-info              print {outerWidth, outerHeight, screenX, screenY}
//   probe-harness-ipc <file> from the HARNESS page, call the IPC surface
//   send-accel <restart|back>  send the menu accelerator keys to the page
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 9333;
const mode = process.argv[2] ?? 'dump';
const target = process.argv[3] ?? '.verify-v11-dump.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function findPage(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson('/json/list');
      const page = list.find((t) => t.type === 'page' && predicate(t.url));
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error('target page not found via CDP');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

async function connectLocal() {
  const page = await findPage((url) => url.startsWith('file://'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  return { cdp: new CDP(ws), ws };
}

async function connectHarness() {
  const page = await findPage((url) => url.startsWith('http://127.0.0.1:'));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  return { cdp: new CDP(ws), ws };
}

async function waitForSelector(cdp, selector, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (ok) return;
    await sleep(500);
  }
  throw new Error(`selector never appeared: ${selector}`);
}

async function clickById(cdp, id) {
  await waitForSelector(cdp, `#${id}`);
  const result = await cdp.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (!el) return 'NO_ELEMENT'; el.click(); return 'OK'; })()`);
  console.log(`click ${id}: ${result}`);
}

async function main() {
  if (mode === 'probe-harness-ipc') {
    const { cdp, ws } = await connectHarness();
    await sleep(2000);
    const results = await cdp.eval(`(async () => {
      const out = {};
      for (const name of ['restart', 'backToWorkspaces', 'getLogs', 'copyLogs']) {
        try {
          const value = await window.dshDesktop[name]();
          out[name] = 'ALLOWED:' + JSON.stringify(value).slice(0, 120);
        } catch (err) {
          out[name] = 'REJECTED:' + String((err && err.message) || err).slice(0, 160);
        }
      }
      return out;
    })()`);
    fs.writeFileSync(target, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    ws.close();
    return;
  }

  if (mode === 'send-accel') {
    // The app window must be focused for menu accelerators to land; the
    // orchestrator focuses it first. These events reach the renderer and are
    // also processed as native keyboard input when dispatched to a focused
    // Electron window via CDP Input.
    const page = await findPage((url) => url.startsWith('http://127.0.0.1:') || url.startsWith('file://'));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.once('open', r));
    const cdp = new CDP(ws);
    const key = target === 'back' ? 'b' : 'r';
    const code = target === 'back' ? 'KeyB' : 'KeyR';
    const vk = target === 'back' ? 66 : 82;
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 10,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 10,
    });
    console.log(`sent accelerator: ${target}`);
    ws.close();
    return;
  }

  const { cdp, ws } = await connectLocal();
  await waitForSelector(cdp, '#view-choose, #view-error, #view-lost, #view-starting');

  if (mode === 'dump') {
    const text = await cdp.eval('document.body.innerText');
    fs.writeFileSync(target, text);
    console.log(`dump saved (${text.length} chars)`);
  } else if (mode === 'lost-assert') {
    const facts = await cdp.eval(`JSON.stringify({
      lostVisible: !document.getElementById('view-lost').classList.contains('hidden'),
      errorVisible: !document.getElementById('view-error').classList.contains('hidden'),
      chooseVisible: !document.getElementById('view-choose').classList.contains('hidden'),
      lostWorkspace: document.getElementById('lost-workspace').textContent,
      lostReason: document.getElementById('lost-reason').textContent,
      hasRestart: Boolean(document.getElementById('btn-restart')),
      hasBack: Boolean(document.getElementById('btn-back')),
      bodyHasConnectionLost: document.body.innerText.includes('connection lost'),
    })`);
    fs.writeFileSync(target, facts);
    console.log(facts);
  } else if (mode === 'logs-dump') {
    const text = await cdp.eval(`JSON.stringify({
      panelVisible: !document.getElementById('logs-panel').classList.contains('hidden'),
      stdout: document.getElementById('logs-stdout').textContent.slice(0, 4000),
      stderr: document.getElementById('logs-stderr').textContent.slice(0, 4000),
      hasStdoutLabel: document.body.innerText.includes('stdout'),
      hasStderrLabel: document.body.innerText.includes('stderr'),
    })`);
    fs.writeFileSync(target, text);
    console.log(`logs dump saved`);
  } else if (mode === 'window-info') {
    const info = await cdp.eval(`JSON.stringify({ outerWidth: window.outerWidth, outerHeight: window.outerHeight, screenX: window.screenX, screenY: window.screenY })`);
    fs.writeFileSync(target, info);
    console.log(info);
  } else if (mode === 'click-recent') {
    const result = await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('.recent-path')].find((e) => e.textContent.includes(${JSON.stringify(target)}));
      if (!el) return 'NO_ELEMENT';
      el.click(); return 'OK';
    })()`);
    console.log(`click-recent(${target}): ${result}`);
  } else if (mode.startsWith('click-')) {
    await clickById(cdp, mode.replace('click-', 'btn-'));
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  ws.close();
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
