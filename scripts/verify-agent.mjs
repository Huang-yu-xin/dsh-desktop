// Verification driver for the real-agent check. Connects to the DESKTOP APP's
// own window over the Chrome DevTools Protocol (the app is launched with
// --remote-debugging-port) and drives the official Harness UI without any
// product code changes.
//
// Modes:
//   probe   dump page text + interactive element inventory (learn the UI)
//   agent   connect workspace, create a session, run the read-only task,
//           wait for turn completion (verified against the session log),
//           and write .verify-agent-result.json
//   persist verify the session survived an app restart (UI list + log)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { readSessionEvents } from './analyze-session.mjs';

const PORT = 9333;
const mode = process.argv[2] ?? 'probe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT =
  '这是一个只读探查任务：请只使用只读工具完成，不要修改、创建或删除任何文件。' +
  '1) 列出 D:\\software\\dsh-desktop 项目的顶层目录结构和 src 下的文件清单；' +
  '2) 阅读该项目的 README.md 和 package.json 的内容；' +
  '3) 最后用三句话总结这个项目是做什么的。' +
  '完成后直接给出总结，全程不要执行任何写入操作。';
const PROMPT_MARKER = '只读探查任务';

const RESULT_FILE = '.verify-agent-result.json';

async function httpJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
  return res.json();
}

async function waitForHarnessPage(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await httpJson('/json/list');
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
      if (page) return page;
    } catch {
      // CDP not up yet
    }
    await sleep(1000);
  }
  throw new Error('harness page not found via CDP');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
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
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

async function connect() {
  const page = await waitForHarnessPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { cdp: new CDP(ws), ws };
}

async function waitForUi(cdp, minChars = 80, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let len = 0;
  while (Date.now() < deadline) {
    try {
      len = await cdp.eval('document.body ? document.body.innerText.length : 0');
      if (len >= minChars) return len;
    } catch {
      // page still loading
    }
    await sleep(1000);
  }
  throw new Error(`UI never booted (last text length ${len})`);
}

const textOf = async (cdp) => cdp.eval('document.body.innerText');
const dialogsOf = async (cdp) =>
  cdp.eval(`[...document.querySelectorAll('[role="dialog"]')].map(d => d.innerText)`);

const composerInfo = async (cdp) =>
  cdp.eval(
    `[...document.querySelectorAll('textarea')].map(t => ({placeholder: t.placeholder, disabled: t.disabled, visible: t.offsetParent !== null}))`,
  );

async function clickAria(cdp, label) {
  return cdp.eval(
    `(() => {
      const el = document.querySelector('[aria-label=${JSON.stringify(label)}]');
      if (!el) return 'NO_ELEMENT';
      el.click(); return 'OK';
    })()`,
  );
}

async function clickExactText(cdp, text, tag = 'button') {
  return cdp.eval(
    `(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const el = els.find((e) => e.textContent.trim() === ${JSON.stringify(text)} && e.offsetParent !== null);
      if (!el) return 'NO_ELEMENT';
      el.click(); return 'OK';
    })()`,
  );
}

async function fillByAria(cdp, label, value) {
  return cdp.eval(
    `(() => {
      const el = document.querySelector('input[aria-label=${JSON.stringify(label)}], textarea[aria-label=${JSON.stringify(label)}]');
      if (!el) return 'NO_ELEMENT';
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`,
  );
}

async function fillComposer(cdp, value) {
  return cdp.eval(
    `(() => {
      const el = [...document.querySelectorAll('textarea')].find((t) => !t.disabled && t.offsetParent !== null);
      if (!el) return 'NO_ELEMENT';
      const proto = HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`,
  );
}

async function pressEnterByAria(cdp, label) {
  return cdp.eval(
    `(() => {
      const el = document.querySelector('input[aria-label=${JSON.stringify(label)}], textarea[aria-label=${JSON.stringify(label)}]');
      if (!el) return 'NO_ELEMENT';
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'OK';
    })()`,
  );
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function sessionFileOf(dir) {
  const name = fs.readdirSync(dir).find((n) => n.endsWith('.jsonl.zstd'));
  return name ? path.join(dir, name) : null;
}

function analyze(events) {
  const toolNames = [];
  const isErrors = [];
  const titleEvent = events.find((e) => e.type === 'session/title');
  for (const e of events) {
    if (e.type === 'tool/call' && typeof e.data?.name === 'string') toolNames.push(e.data.name);
    if (e.type === 'tool/result' && e.data?.message?.content) {
      for (const block of e.data.message.content) {
        if (block.type === 'tool-result' && block.isError) isErrors.push(block);
      }
    }
  }
  const lastTurnEnd = [...events].reverse().find((e) => e.type === 'turn/end');
  const lastTurn = lastTurnEnd?.data?.turn ?? null;
  const assistantParts = [];
  for (const e of events) {
    if (e.type === 'assistant/message' && e.data?.turn === lastTurn) {
      for (const block of e.data.message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') assistantParts.push(block.text);
      }
    }
  }
  const promptFound = events.some((e) => e.type === 'user/message' && JSON.stringify(e).includes(PROMPT_MARKER));
  return {
    toolNames,
    isErrorCount: isErrors.length,
    title: titleEvent?.data?.title ?? titleEvent?.data ?? null,
    assistantText: assistantParts.join(''),
    promptFound,
  };
}

async function waitForTurnComplete(t0, timeoutMs = 420_000) {
  const root = path.join(dshHome(), 'sessions', '--D-software--');
  const deadline = t0 + timeoutMs;
  let stablePolls = 0;
  let lastSize = -1;
  let lastMtime = 0;
  while (Date.now() < deadline) {
    let newest = null;
    try {
      const dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ p: path.join(root, d.name), m: fs.statSync(path.join(root, d.name)).mtimeMs }));
      newest = dirs.sort((a, b) => b.m - a.m)[0] ?? null;
    } catch {
      // sessions root not ready yet
    }
    if (newest && newest.m >= t0) {
      const file = sessionFileOf(newest.p);
      if (file) {
        try {
          const { events } = readSessionEvents(file);
          const hasPrompt = events.some((e) => e.type === 'user/message' && JSON.stringify(e).includes(PROMPT_MARKER));
          const turnEnds = events.filter((e) => e.type === 'turn/end').length;
          if (hasPrompt && turnEnds >= 1) {
            // Wait until the artifact stops growing so the final durable
            // batch (including turn/end) is fully flushed before we return.
            const stat = fs.statSync(file);
            if (stat.size === lastSize && stat.mtimeMs === lastMtime) stablePolls += 1;
            else {
              stablePolls = 0;
              lastSize = stat.size;
              lastMtime = stat.mtimeMs;
            }
            if (stablePolls >= 2) {
              return { sessionDir: newest.p, sessionFile: file, events };
            }
          }
        } catch {
          // torn final frame while a batch is being written — retry
        }
      }
    }
    await sleep(3000);
  }
  throw new Error('agent turn did not complete within the time budget');
}

async function probe() {
  const { cdp, ws } = await connect();
  const len = await waitForUi(cdp);
  const text = await textOf(cdp);
  fs.writeFileSync('.verify-ui-dump.txt', text);
  const inventory = await cdp.eval(`JSON.stringify({
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang,
    textareas: [...document.querySelectorAll('textarea')].map(t => ({placeholder: t.placeholder, disabled: t.disabled, visible: t.offsetParent !== null})),
    inputs: [...document.querySelectorAll('input')].map(i => ({type: i.type, placeholder: i.placeholder, aria: i.getAttribute('aria-label'), value: i.value ? 'HAS_VALUE' : ''})),
    buttons: [...document.querySelectorAll('button')].map(b => ({text: b.textContent.trim().slice(0,60), aria: b.getAttribute('aria-label'), visible: b.offsetParent !== null})).filter(b => b.visible),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map(d => d.innerText.slice(0, 400)),
  })`);
  fs.writeFileSync('.verify-ui-inventory.json', inventory);
  console.log(`probe: text length ${len}, dump saved`);
  ws.close();
}

async function agent() {
  const t0 = Date.now();
  const { cdp, ws } = await connect();
  await waitForUi(cdp);

  // 0. The API-key onboarding dialog must NOT appear: the credential was
  //    inherited through the harness's own env-based mechanism.
  const dialogs0 = await dialogsOf(cdp);
  if (dialogs0.join('|').includes('API 密钥')) {
    throw new Error('API key onboarding dialog appeared — credential env was not inherited by the harness');
  }

  // 1. Connect the workspace (the composer placeholder drives the picker).
  const composer0 = await composerInfo(cdp);
  console.log('composer before workspace:', JSON.stringify(composer0));
  if (composer0.some((c) => c.placeholder === '选择一个工作区开始')) {
    await clickAria(cdp, '选择工作区');
    await sleep(800);
    const dialogs = await dialogsOf(cdp);
    console.log('workspace dialogs:', JSON.stringify(dialogs).slice(0, 600));
    const edit = await clickExactText(cdp, '编辑路径');
    console.log('click 编辑路径:', edit);
    await sleep(400);
    const fill = await fillByAria(cdp, '编辑路径', 'D:\\software');
    console.log('fill path:', fill);
    await pressEnterByAria(cdp, '编辑路径');
    await sleep(400);
    const open = await clickExactText(cdp, '打开');
    console.log('click 打开:', open);
    await sleep(800);
  }

  // 2. Create a NEW session (never type into an existing one).
  const created = await clickAria(cdp, '新建会话');
  console.log('click 新建会话:', created);
  await sleep(1200);
  const composer1 = await composerInfo(cdp);
  console.log('composer after new session:', JSON.stringify(composer1));

  // 3. Fill the read-only task and send.
  const filled = await fillComposer(cdp, PROMPT);
  console.log('fill composer:', filled);
  await sleep(400);
  const sent = await clickAria(cdp, '发送消息');
  console.log('click 发送消息:', sent);

  // 4. Authoritative completion: the session log gains our prompt and a turn/end.
  const { sessionDir, sessionFile, events } = await waitForTurnComplete(t0);
  await sleep(4000); // let the UI settle and the final batch flush

  const uiText = await textOf(cdp);
  fs.writeFileSync('.verify-ui-final-dump.txt', uiText);
  const result = {
    sessionDir,
    sessionFile,
    uiShowsPrompt: uiText.includes('dsh-desktop'),
    ...analyze(events),
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  console.log('AGENT RESULT:');
  console.log(JSON.stringify(result, null, 2));
  ws.close();
}

async function persist() {
  const { cdp, ws } = await connect();
  await waitForUi(cdp);
  const previous = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));

  // The session log must still be intact after the app restart.
  let events = null;
  if (fs.existsSync(previous.sessionFile)) {
    try {
      events = readSessionEvents(previous.sessionFile).events;
    } catch {
      events = null;
    }
  }
  const logIntact =
    events !== null &&
    events.some((e) => e.type === 'user/message' && JSON.stringify(e).includes(PROMPT_MARKER)) &&
    events.filter((e) => e.type === 'turn/end').length >= 1;

  // The UI must list sessions (rows carry a relative-time leaf span) and
  // reloading our persisted session must render its conversation content.
  const sidebarBefore = await textOf(cdp);
  fs.writeFileSync('.verify-persist-sidebar.txt', sidebarBefore);
  let conversationInUi = false;
  let clickedRows = 0;
  const rowCount = await cdp.eval(`document.querySelectorAll('.YDXeBa_time').length`);
  for (let i = 0; i < Math.min(rowCount, 8); i += 1) {
    const clicked = await cdp.eval(
      `(() => {
        const spans = document.querySelectorAll('.YDXeBa_time');
        const el = spans[${i}];
        if (!el) return 'NO_ELEMENT';
        el.click();
        return 'OK';
      })()`,
    );
    if (clicked !== 'OK') break;
    clickedRows += 1;
    await sleep(2000);
    const text = await textOf(cdp);
    if (text.includes(PROMPT_MARKER)) {
      conversationInUi = true;
      fs.writeFileSync('.verify-persist-dump.txt', text);
      break;
    }
  }
  const result = {
    logIntact,
    rowCount,
    clickedRows,
    conversationInUi,
    sessionFile: previous.sessionFile,
  };
  fs.writeFileSync('.verify-persist-result.json', JSON.stringify(result, null, 2));
  console.log('PERSIST RESULT:');
  console.log(JSON.stringify(result, null, 2));
  ws.close();
}

async function main() {
  if (mode === 'probe') return probe();
  if (mode === 'agent') return agent();
  if (mode === 'persist') return persist();
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
