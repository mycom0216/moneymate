// 서비스·저장소·HTTP 테스트: 중복 방지, 소유자 격리(IDOR), DB 제약, 분류 규칙 기억, AI 제안, 보안 헤더·한도
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';
import { createHandler } from '../src/http.mjs';
import { Store } from '../src/db.mjs';

const TODAY = '2026-10-27';
const A = 'user-aaaaaa', B = 'user-bbbbbb';
const csv = (...lines) => Buffer.from(['이용일시,이용가맹점,이용금액,구분', ...lines].join('\n') + '\n', 'utf8');
const mk = async (llm = { available: false, label: 'off', ensure: async () => false }) => createApp({ llm, today: () => TODAY });

const BASE = csv(
  '2026-09-01 10:00:00,스타벅스 강남역점,5000,승인', '2026-09-02 10:00:00,스타벅스 서초점,5500,승인',
  '2026-10-02 12:00:00,알수없는상점,30000,승인', '2026-10-03 09:00:00,GS25 역삼점,3000,승인', '2026-10-03 09:00:00,GS25 역삼점,3000,승인',
);

test('가져오기: 거래·분류·건수, 같은 파일 재업로드는 중복으로 건너뜀(같은 날 같은 금액 두 건은 둘 다 보존)', async () => {
  const app = await mk();
  const r1 = app.importCsv(A, { filename: 'a.csv', bytes: BASE });
  assert.equal(r1.added, 5); assert.equal(r1.duplicates, 0); assert.equal(r1.unclassified, 1); assert.deepEqual(r1.months, ['2026-09', '2026-10']);
  const r2 = app.importCsv(A, { filename: 'a.csv', bytes: BASE });
  assert.equal(r2.added, 0); assert.equal(r2.duplicates, 5);
  assert.equal(app.store.stats().transactions, 5);
});
test('가져오기: 파일 이름은 정리되어 저장, 읽을 거래가 없으면 400', async () => {
  const app = await mk();
  app.importCsv(A, { filename: '../../x\u0007:y.csv', bytes: BASE });
  assert.equal(app.store.imports(A)[0].filename, '.._.._x _y.csv');
  assert.throws(() => app.importCsv(A, { filename: 'e.csv', bytes: csv('날짜아님,A,100,승인') }), (e) => e.status === 400);
});

test('소유자 격리: 남의 리포트·거래·가져오기·분류 수정·예산은 보이지도 바꿀 수도 없음', async () => {
  const app = await mk();
  app.importCsv(A, { filename: 'a.csv', bytes: BASE });
  assert.deepEqual(app.report(B, null), { months: [], month: null });
  assert.equal(app.store.listTransactions(B).total, 0);
  const txId = app.store.listTransactions(A).rows[0].id;
  assert.throws(() => app.setCategory(B, txId, '쇼핑', true), (e) => e.status === 404);
  assert.equal(app.store.deleteImport(B, app.store.imports(A)[0].id), false);
  assert.equal(app.store.getTransaction(B, txId), null);
  assert.equal(app.exportMarkdown(B, null), null);
});

test('분류 수정: 같은 가맹점 전체에 적용·규칙 기억·다음 가져오기에도 적용, 수입은 변경 불가', async () => {
  const app = await mk();
  app.importCsv(A, { filename: 'a.csv', bytes: BASE });
  const unk = app.store.listTransactions(A, { q: '알수없는' }).rows[0];
  assert.equal(unk.catMethod, 'none');
  assert.deepEqual(app.setCategory(A, unk.id, '쇼핑', true), { updated: 1 });
  assert.equal(app.store.getTransaction(A, unk.id).catMethod, 'user');
  app.importCsv(A, { filename: 'b.csv', bytes: csv('2026-10-20 10:00:00,알수없는상점 홍대점,1000,승인') }); // 지점이 달라도 같은 가맹점
  const again = app.store.listTransactions(A, { q: '알수없는' }).rows;
  assert.ok(again.every((t) => t.category === '쇼핑' && t.catMethod === 'user')); assert.equal(again.length, 2);
  const st = app.store.listTransactions(A, { q: '스타벅스' }).rows;
  assert.deepEqual(app.setCategory(A, st[0].id, '쇼핑', true), { updated: 2 }, '스타벅스 두 지점이 한 가맹점');
  assert.throws(() => app.setCategory(A, st[0].id, '없는카테고리', true), (e) => e.status === 400);
  app.importCsv(A, { filename: 'c.csv', bytes: Buffer.from('거래일,적요,출금액,입금액,잔액\n2026-10-25,급여,,3000000,3000000\n') });
  const inc = app.store.listTransactions(A, { q: '급여' }).rows[0];
  assert.equal(inc.category, '수입'); assert.throws(() => app.setCategory(A, inc.id, '쇼핑', true), (e) => e.status === 404);
});

test('DB 제약: 수입↔수입 카테고리, 양수 금액, 알 수 없는 카테고리·종류는 저장 거부', () => {
  const s = new Store(':memory:'); s.ensureUser(A);
  const imp = s.addImport(A, { filename: 'x', format: 'card', rows: [], skipped: 0 }).importId;
  const ins = (cat, kind, amt) => s.db.prepare("INSERT INTO transactions(user_id,import_id,tx_date,merchant,merchant_norm,amount,kind,category,cat_method,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?)").run(A, imp, '2026-10-01', 'm', 'm', amt, kind, cat, 'rule', `k${Math.random()}`);
  assert.doesNotThrow(() => ins('식비', 'expense', 100)); assert.doesNotThrow(() => ins('수입', 'income', 100));
  assert.throws(() => ins('수입', 'expense', 100)); assert.throws(() => ins('식비', 'income', 100));
  assert.throws(() => ins('식비', 'expense', 0)); assert.throws(() => ins('식비', 'expense', -5));
  assert.throws(() => ins('우주', 'expense', 5)); assert.throws(() => ins('식비', 'gift', 5));
  assert.throws(() => s.db.prepare("INSERT INTO transactions(user_id,import_id,tx_date,merchant,merchant_norm,amount,kind,category,cat_method,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?)").run(A, imp, '2026/10/01', 'm', 'm', 5, 'expense', '식비', 'rule', 'z'), '날짜 형식');
});

test('삭제: 가져온 파일 삭제 시 거래 함께 삭제, 전체 삭제는 모든 표가 비워짐(CASCADE)', async () => {
  const app = await mk();
  const r = app.importCsv(A, { filename: 'a.csv', bytes: BASE });
  app.setBudget(A, '카페', 50000); app.store.dismiss(A, 'k'); app.setCategory(A, app.store.listTransactions(A).rows[0].id, '쇼핑', true);
  assert.equal(app.store.deleteImport(A, r.importId), true); assert.equal(app.store.listTransactions(A).total, 0);
  app.importCsv(A, { filename: 'a.csv', bytes: BASE });
  assert.equal(app.store.deleteUser(A), 1);
  const n = (t) => app.store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  for (const t of ['users', 'imports', 'transactions', 'merchant_rules', 'budgets', 'dismissals']) assert.equal(n(t), 0, t);
});

test('리포트·예산·숨긴 경고: 예산 검증, 상태 계산, 숨긴 경고는 리포트에서 빠짐', async () => {
  const app = await mk();
  const lines = []; for (let m = 7; m <= 9; m++) for (let d = 1; d <= 10; d++) lines.push(`2026-0${m}-${String(d).padStart(2, '0')} 12:00:00,식당${d % 3},${10000 + d * 100},승인`);
  lines.push('2026-09-20 12:00:00,식당0,300000,승인');
  app.importCsv(A, { filename: 'a.csv', bytes: csv(...lines) });
  assert.throws(() => app.setBudget(A, '식비', 0), (e) => e.status === 400); assert.throws(() => app.setBudget(A, '식비', 1.5), (e) => e.status === 400);
  assert.throws(() => app.setBudget(A, '수입', 5000), (e) => e.status === 400);
  app.setBudget(A, '식비', 200000);
  const r = app.report(A, '2026-09');
  assert.equal(r.budgets[0].status, 'over'); assert.equal(r.alerts.some((a) => a.type === 'outlier'), true);
  app.store.dismiss(A, r.alerts[0].key);
  const r2 = app.report(A, '2026-09');
  assert.equal(r2.alerts.length, r.alerts.length - 1); assert.equal(r2.dismissedCount, 1);
  assert.throws(() => app.report(A, '2026-13'), (e) => e.status === 400);
  app.setBudget(A, '식비', null); assert.equal(app.report(A, '2026-09').budgets.length, 0);
  assert.match(app.exportMarkdown(A, '2026-09'), /# 2026-09 지출 리포트/);
});

test('AI 분류 제안: 미분류 가맹점에만, 금액 없이 이름만 전달, 결과는 ai(미확인)로 표시', async () => {
  let prompt = null;
  const llm = { available: true, label: 'fake', ensure: async () => true, async complete({ messages }) { prompt = messages[0].content; return '[{"merchant":"알수없는상점","category":"쇼핑"}]'; } };
  const app = await mk(llm);
  app.importCsv(A, { filename: 'a.csv', bytes: BASE });
  const r = await app.classifyAi(A);
  assert.equal(r.suggested, 1); assert.equal(r.updatedTransactions, 1);
  assert.ok(!/30000|30,000/u.test(prompt), 'AI에 금액이 전달되면 안 됨'); assert.equal(prompt, '["알수없는상점"]');
  const t = app.store.listTransactions(A, { q: '알수없는' }).rows[0];
  assert.equal(t.catMethod, 'ai'); assert.equal(t.category, '쇼핑');
  assert.equal(app.report(A, '2026-10').summary.unconfirmed.amount, 30000, '미확인 비율에 포함');
  app.setCategory(A, t.id, '쇼핑', true); assert.equal(app.report(A, '2026-10').summary.unconfirmed.amount, 0, '확인하면 줄어듦');
  const off = await mk(); await assert.rejects(off.classifyAi(A), (e) => e.status === 503);
});

// ── HTTP ──────────────────────────────────────────────────
async function withServer(fn, opts = {}) {
  const app = await mk();
  const server = createServer(createHandler(app, { minGapMs: 0, ...opts })).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, o = {}) => { const res = await fetch(base + path, o); const ct = res.headers.get('content-type') ?? ''; return { res, body: ct.includes('json') ? await res.json() : await res.text() }; };
  const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try { await fn({ app, call, post, base }); } finally { server.close(); }
}

test('HTTP: 가져오기→리포트 흐름과 userId 검증·소유자 격리·한도(400/404/413)', async () => {
  await withServer(async ({ call, post }) => {
    const imp = await call(`/api/import?userId=${A}&filename=a.csv`, { method: 'POST', body: BASE });
    assert.equal(imp.res.status, 200); assert.equal(imp.body.added, 5);
    assert.equal((await call(`/api/report?userId=${A}`)).body.month, '2026-10');
    assert.equal((await call('/api/report?userId=x')).res.status, 400);
    assert.equal((await call(`/api/report?userId=${B}`)).body.month, null);
    assert.equal((await call(`/api/report?userId=${A}&month=2026-99`)).res.status, 400);
    const txId = (await call(`/api/transactions?userId=${A}`)).body.rows[0].id;
    assert.equal((await post('/api/transactions/category', { userId: B, txId, category: '쇼핑' })).res.status, 404);
    assert.equal((await post('/api/transactions/category', { userId: A, txId, category: '쇼핑' })).res.status, 200);
    assert.equal((await post('/api/imports/delete', { userId: B, importId: 1 })).res.status, 404);
    assert.equal((await call('/api/nothing')).res.status, 404);
    assert.equal((await post('/api/budgets', { userId: A, category: '식비', limit: -1 })).res.status, 400);
    const big = await call(`/api/import?userId=${A}`, { method: 'POST', body: Buffer.alloc(5 * 1024 * 1024 + 10, 0x61) });
    assert.equal(big.res.status, 413);
    const bin = await call(`/api/import?userId=${A}`, { method: 'POST', body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]) });
    assert.equal(bin.res.status, 415);
    assert.equal((await call('/api/transactions?userId=' + A + '&category=없는')).res.status, 400);
  });
});
test('HTTP: 전체 삭제는 confirm 필요, 분류 AI는 AI 없으면 503, 샘플·내보내기', async () => {
  await withServer(async ({ call, post }) => {
    await call(`/api/import?userId=${A}&filename=a.csv`, { method: 'POST', body: BASE });
    assert.equal((await post('/api/forget', { userId: A })).res.status, 400);
    assert.equal((await post('/api/classify/ai', { userId: A })).res.status, 503);
    const ex = await call(`/api/export?userId=${A}&month=2026-10`);
    assert.equal(ex.res.status, 200); assert.match(ex.res.headers.get('content-disposition'), /moneymate-2026-10\.md/); assert.match(ex.body, /지출 리포트/);
    assert.equal((await call(`/api/export?userId=${B}`)).res.status, 404);
    assert.equal((await post('/api/forget', { userId: A, confirm: true })).body.deleted, 1);
    assert.equal((await call(`/api/report?userId=${A}`)).body.month, null);
    assert.equal((await call('/api/sample')).res.status, 200);
  });
});
test('HTTP: 보안 헤더, 정적 파일 경로 이탈 차단, HTML 가맹점 이름은 JSON 데이터로만', async () => {
  await withServer(async ({ call }) => {
    const home = await call('/');
    assert.equal(home.res.status, 200); assert.match(home.res.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(home.res.headers.get('x-frame-options'), 'DENY');
    assert.equal((await call('/..%2f..%2fpackage.json')).res.status, 404); assert.equal((await call('/%2e%2e/server.mjs')).res.status, 404);
    await call(`/api/import?userId=${A}&filename=x.csv`, { method: 'POST', body: csv('2026-10-02 12:00:00,"<img src=x onerror=alert(1)>",30000,승인') });
    const tx = (await call(`/api/transactions?userId=${A}`)).body.rows[0];
    assert.equal(tx.merchant, '<img src=x onerror=alert(1)>');
    assert.match((await call(`/api/transactions?userId=${A}`)).res.headers.get('content-type'), /application\/json/);
  });
});
test('HTTP: 너무 빠른 연속 요청은 429', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call(`/api/import?userId=${A}&filename=a.csv`, { method: 'POST', body: BASE })).res.status, 200);
    assert.equal((await call(`/api/import?userId=${A}&filename=a.csv`, { method: 'POST', body: BASE })).res.status, 429);
  }, { minGapMs: 700 });
});
