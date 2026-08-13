// Recent-workspaces verification driver: connects to the app's LOCAL shell
// page (file://) over CDP and drives the recents list.
// Modes: dump | click-open | remove
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 9333;
const mode = process.argv[2] ?? 'dump';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function waitForShellPage(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson('/json/list');
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  throw new Error('shell page not found via CDP');
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

async function main() {
  const page = await waitForShellPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  const cdp = new CDP(ws);

  // Wait for the recents list to be rendered.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await cdp.eval(`Boolean(document.querySelector('#recents-list') && document.querySelector('#view-choose'))`);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('choose view never rendered');

  if (mode === 'dump') {
    const text = await cdp.eval('document.body.innerText');
    const inventory = await cdp.eval(`JSON.stringify({
      recents: [...document.querySelectorAll('#recents-list .recent-path')].map((e) => e.textContent.trim()),
      times: [...document.querySelectorAll('#recents-list .recent-time')].map((e) => e.textContent.trim()),
      removes: document.querySelectorAll('#recents-list .recent-remove').length,
    })`);
    fs.writeFileSync('.verify-recents-dump.txt', text);
    console.log(inventory);
    console.log('--- page text ---');
    console.log(text);
  } else if (mode === 'click-open') {
    const clicked = await cdp.eval(`(() => {
      const el = document.querySelector('#recents-list .recent-path');
      if (!el) return 'NO_ELEMENT';
      el.click(); return 'OK';
    })()`);
    console.log(`click-open: ${clicked}`);
  } else if (mode === 'remove') {
    const clicked = await cdp.eval(`(() => {
      const el = document.querySelector('#recents-list .recent-remove');
      if (!el) return 'NO_ELEMENT';
      el.click(); return 'OK';
    })()`);
    console.log(`remove: ${clicked}`);
    await sleep(1000);
    const after = await cdp.eval('document.body.innerText');
    fs.writeFileSync('.verify-recents-after-remove.txt', after);
    console.log(after);
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  ws.close();
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
