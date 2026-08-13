// One-off probe: enumerate the sidebar session rows' DOM shape.
import fs from 'node:fs';
import WebSocket from 'ws';

const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const deadline = Date.now() + 60_000;
  let page;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson('/json/list');
      page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
      if (page) break;
    } catch {}
    await sleep(1000);
  }
  if (!page) throw new Error('page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.value;
  };
  await sleep(5000);
  const report = await evalJs(`JSON.stringify(
    [...document.querySelectorAll('*')]
      .filter((e) => e.offsetParent !== null && e.children.length === 0 && /分钟|小时|昨天/.test(e.textContent) && e.textContent.length < 60)
      .map((e) => ({ tag: e.tagName, cls: (e.className && typeof e.className === 'string') ? e.className.slice(0, 80) : '', role: e.getAttribute('role'), text: e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 50) }))
      .slice(0, 40)
  )`);
  fs.writeFileSync('.verify-session-rows.json', report);
  console.log(report);
  ws.close();
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
