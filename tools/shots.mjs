// tools/shots.mjs — 실행 중인 MoneyMate 화면을 단계별로 캡처해 docs/images/ui-*.png 로 저장합니다.
// 사용법: (서버 실행 중) node tools/shots.mjs [서버주소=http://127.0.0.1:5600]
// 원리: Edge를 headless로 띄우고 CDP(WebSocket)로 클릭·입력·캡처를 지시합니다. 외부 라이브러리 없음.
// 촬영용 데이터: 임시 사용자 ID로 샘플 CSV(가상 데이터)를 올리고 예산을 넣은 뒤 화면을 찍습니다.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5600';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!EDGE) throw new Error('Edge 또는 Chrome을 찾을 수 없습니다.');
const out = join(ROOT, 'docs', 'images');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UID = 'u-shots0000000000000001';

const profile = mkdtempSync(join(tmpdir(), 'mo-shot-'));
const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${profile}`, '--window-size=1180,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
try {
  let target;
  for (let i = 0; i < 40 && !target; i++) { await sleep(300); try { target = (await (await fetch('http://127.0.0.1:9334/json')).json()).find((t) => t.type === 'page'); } catch { /* 부팅 중 */ } }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const png = async (name, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } }); writeFileSync(join(out, name), Buffer.from(r.result.data, 'base64')); console.log('saved', name); };
  const shot = async (name) => { const m = (await send('Page.getLayoutMetrics')).result.cssContentSize; await png(name, { x: 0, y: 0, width: 1180, height: Math.ceil(m.height) }); };
  // 선택자 구간 캡처: top 요소의 위쪽부터 bottom 요소(마지막 항목) 끝까지, 항목이 잘리지 않게
  const clipShot = async (name, topSel, lastSel) => {
    const r = await js(`(() => { const t = document.querySelector('${topSel}').getBoundingClientRect(); const l = [...document.querySelectorAll('${lastSel}')].pop().getBoundingClientRect(); const y = t.top + scrollY; return { x: Math.floor(t.left), y: Math.floor(y), width: Math.ceil(t.width), height: Math.ceil(l.bottom + scrollY - y + 12) }; })()`);
    await png(name, r); console.log('  ', r.width + 'x' + r.height);
  };

  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await sleep(1200);
  await js(`localStorage.setItem('mo_user', '${UID}')`);
  await send('Page.navigate', { url: BASE }); await sleep(1500);
  await js("(async () => { for (const [c, l] of [['식비', 800000], ['카페', 100000], ['마트·편의점', 300000], ['쇼핑', 600000]]) await fetch('/api/budgets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: '" + UID + "', category: c, limit: l }) }); })()");
  await shot('ui-1-import.png');
  await js("document.getElementById('sample').click()"); await sleep(1500);
  await shot('ui-2-imported.png');
  await js("document.querySelector('.tab[data-tab=report]').click()"); await sleep(1500);
  await shot('ui-3-report.png');
  await clipShot('crop-alerts.png', '#report h3', '#report .alert');
  await js("document.querySelector('.tab[data-tab=tx]').click()"); await sleep(1200);
  await js("document.getElementById('txCat').value = '기타'; document.getElementById('goTx').click()"); await sleep(800);
  await shot('ui-4-tx.png');
  await js("document.querySelector('.tab[data-tab=budget]').click()"); await sleep(1000);
  await shot('ui-5-budget.png');
} finally { try { ws?.close(); } catch { /* 이미 닫힘 */ } proc.kill(); }
