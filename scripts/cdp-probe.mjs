/**
 * 无第三方依赖的真实浏览器探针（Chrome DevTools Protocol + Node 原生 WebSocket）。
 *
 * 用途：在真机上打开 vite dev 页面，收集 console/异常，执行调试钩子表达式，
 * 用来核实 draw call、三角形、帧率与角色动画状态。
 *
 * 用法：
 *   node scripts/cdp-probe.mjs --url http://127.0.0.1:5173/ --steps ./steps.json
 * steps.json: [{ "wait": 2000 }, { "eval": "__DUST_STRIKE__.arena.rendererInfo()" }]
 * 输出：JSON 行，每步一条。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((path) => existsSync(path));

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = arg('--url', 'http://127.0.0.1:5173/');
const stepsPath = arg('--steps', '');
const port = Number(arg('--port', '9333'));
const steps = stepsPath ? JSON.parse(readFileSync(stepsPath, 'utf8')) : [{ wait: 2000 }];

if (!CHROME) {
  console.error(JSON.stringify({ ok: false, error: 'chrome not found' }));
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'cbim-cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--window-size=1280,720',
  '--hide-scrollbars',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return (await response.json()).webSocketDebuggerUrl;
      }
    } catch {
      /* 端口尚未就绪 */
    }
    await sleep(250);
  }
  throw new Error('devtools endpoint not ready');
}

const logs = [];
let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
    }, 60000);
  });
}

try {
  const wsUrl = await devtoolsUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (event) => reject(new Error(String(event.message ?? 'ws error'))), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} ${JSON.stringify(message.error.data ?? '')}`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      logs.push({
        kind: message.params.type,
        text: message.params.args
          .map((item) => item.value ?? item.description ?? item.type)
          .join(' '),
      });
    }
    if (message.method === 'Runtime.exceptionThrown') {
      logs.push({
        kind: 'exception',
        text: message.params.exceptionDetails.exception?.description
          ?? message.params.exceptionDetails.text,
      });
    }
    if (message.method === 'Log.entryAdded') {
      logs.push({ kind: `log:${message.params.entry.level}`, text: message.params.entry.text });
    }
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  }, sessionId);
  await send('Page.navigate', { url }, sessionId);

  for (const step of steps) {
    if (step.wait) {
      await sleep(step.wait);
      continue;
    }
    if (step.eval || step.evalFile) {
      const expression = step.evalFile ? readFileSync(step.evalFile, 'utf8') : step.eval;
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }, sessionId);
      const payload = result.exceptionDetails
        ? { error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text }
        : result.result.value;
      console.log(JSON.stringify({ eval: step.evalFile ?? step.eval, value: payload }));
      continue;
    }
    if (step.key) {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', code: step.key, key: step.key, windowsVirtualKeyCode: step.keyCode ?? 0,
      }, sessionId);
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', code: step.key, key: step.key, windowsVirtualKeyCode: step.keyCode ?? 0,
      }, sessionId);
      console.log(JSON.stringify({ key: step.key }));
      continue;
    }
    if (step.shot) {
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(step.shot, Buffer.from(shot.data, 'base64'));
      console.log(JSON.stringify({ shot: step.shot }));
      continue;
    }
  }

  const errors = logs.filter((entry) => entry.kind === 'error' || entry.kind === 'exception' || entry.kind === 'log:error');
  console.log(JSON.stringify({ consoleErrors: errors, consoleCount: logs.length }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  await sleep(200);
}
