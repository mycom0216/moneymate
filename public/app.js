// MoneyMate 화면 로직.
// [보안] 서버에서 온 글(가맹점 이름·경고 문장)은 전부 textContent/DOM API로만 넣습니다. innerHTML을 쓰지 않으므로
//        가맹점 이름에 <script>가 들어 있어도 실행되지 않습니다(XSS 방지). CSP 헤더가 한 번 더 막습니다.
const $ = (s) => document.querySelector(s);

// 익명 ID: 브라우저가 만든 난수. 이름·연락처를 받지 않습니다.
const newId = () => 'u-' + crypto.randomUUID().replace(/-/gu, '').slice(0, 24);
const safe = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } } };
let userId = safe.get('mo_user') || newId(); safe.set('mo_user', userId);
let CATS = [];
let state = { month: null };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, { method, headers: raw ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `오류 ${res.status}`);
  return data;
}
const qs = (o = {}) => new URLSearchParams({ userId, ...o }).toString();
const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const signed = (n) => `${n > 0 ? '+' : ''}${won(n)}`;
const TYPE = { duplicate: '중복 결제 의심', outlier: '유난히 큰 지출', new_merchant: '처음 보는 가맹점', price_change: '정기결제 금액 변동' };
const STATUS = { over: ['초과', 'stat-over'], warn: ['초과 예상', 'stat-warn'], ok: ['정상', 'stat-ok'] };
const methodBadge = (t) => (t.catMethod === 'ai' ? h('span', { class: 'badge ai', title: 'AI가 제안한 분류입니다. 맞으면 "확인"을 눌러 확정하세요.' }, 'AI 제안(미확인)') : t.catMethod === 'none' ? h('span', { class: 'badge warn' }, '미분류') : null);

// ── 상태 줄 ────────────────────────────────────────────────
async function showStatus(reconnect = false) {
  try {
    const s = reconnect ? await api('/api/llm/reconnect', { method: 'POST', body: {} }) : await api('/api/status');
    if (s.categories) CATS = s.categories;
    $('#status').textContent = `AI: ${s.llm}`;
    $('#goAi').disabled = !s.llmProvider;
    $('#goAi').title = s.llmProvider ? '' : 'AI를 사용할 수 없습니다. 거래 내역에서 직접 분류해 주세요.';
  } catch { $('#status').textContent = '서버 연결 실패'; }
}
$('#reconnect').addEventListener('click', async () => { $('#reconnect').disabled = true; await showStatus(true); $('#reconnect').disabled = false; });

// ── 탭 ─────────────────────────────────────────────────────
const TABS = ['import', 'report', 'tx', 'budget'];
function openTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === name);
  for (const n of TABS) $('#tab-' + n).classList.toggle('hidden', n !== name);
  if (name === 'import') loadImports();
  if (name === 'report') loadReport();
  if (name === 'tx') loadTx();
  if (name === 'budget') loadBudgets();
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => openTab(t.dataset.tab));

// ── 가져오기 ───────────────────────────────────────────────
async function sendCsv(filename, bytes) {
  $('#importMsg').textContent = '가져오는 중…'; $('#importMsg').className = 'muted';
  $('#goImport').disabled = true; $('#sample').disabled = true;
  try {
    const r = await api(`/api/import?${qs({ filename })}`, { method: 'POST', raw: bytes });
    $('#importMsg').textContent = `완료: 새 거래 ${r.added}건${r.duplicates ? `, 이미 있던 거래 ${r.duplicates}건(중복이라 건너뜀)` : ''}, 형식 ${r.format === 'bank' ? '은행' : '카드'}.`;
    const box = $('#importResult'); box.replaceChildren();
    if (r.unclassified) box.append(h('div', { class: 'notice' }, `분류되지 않은 가맹점이 ${r.unclassified}곳 있습니다. 아래 "AI에게 분류 제안 받기"를 쓰거나 거래 내역에서 직접 고쳐 주세요.`));
    if (r.skippedCount) box.append(h('div', { class: 'notice' }, `읽지 못해 제외한 줄이 ${r.skippedCount}개 있습니다: `, r.skipped.slice(0, 5).map((s) => `${s.line}번째 줄(${s.reason})`).join(', '), r.skippedCount > 5 ? ' 외' : ''));
    if (r.summaryRows) box.append(h('p', { class: 'muted' }, `합계 줄 ${r.summaryRows}개는 거래가 아니라서 제외했습니다.`));
    state.month = r.months[r.months.length - 1];
    await loadImports();
  } catch (e) { $('#importMsg').textContent = e.message; $('#importMsg').className = 'err'; }
  finally { $('#goImport').disabled = false; $('#sample').disabled = false; }
}
$('#goImport').addEventListener('click', async () => {
  const f = $('#file').files[0];
  if (!f) { $('#importMsg').textContent = 'CSV 파일을 선택해 주세요.'; $('#importMsg').className = 'err'; return; }
  await sendCsv(f.name, await f.arrayBuffer());
});
$('#sample').addEventListener('click', async () => {
  const s = await api('/api/sample');
  if (!s.csv) { $('#importMsg').textContent = '샘플 파일이 없습니다.'; return; }
  await sendCsv(s.filename, new TextEncoder().encode(s.csv));
});
async function loadImports() {
  const list = await api(`/api/report?${qs()}`).then((r) => r.imports ?? []).catch(() => []);
  const box = $('#imports'); box.replaceChildren();
  if (!list.length) { box.append(h('p', { class: 'muted' }, '아직 가져온 파일이 없습니다.')); return; }
  for (const i of list) box.append(h('div', { class: 'card', style: 'cursor:default' },
    h('span', {}, h('b', {}, i.filename), ' ', h('span', { class: 'badge' }, i.format === 'bank' ? '은행' : '카드'), ` 새 ${i.added}건 · 중복 ${i.duplicates}건 · 제외 ${i.skipped}줄`),
    h('button', { class: 'ghost mini danger', type: 'button', onclick: async () => { if (!confirm(`'${i.filename}'에서 가져온 거래 ${i.added}건을 삭제할까요?`)) return; await api('/api/imports/delete', { method: 'POST', body: { userId, importId: i.id } }); loadImports(); } }, '삭제')));
}
$('#goAi').addEventListener('click', async () => {
  $('#goAi').disabled = true; $('#aiMsg').textContent = 'AI가 분류를 제안하는 중… (몇 십 초 걸릴 수 있어요)'; $('#aiMsg').className = 'muted';
  try {
    const r = await api('/api/classify/ai', { method: 'POST', body: { userId } });
    $('#aiMsg').textContent = r.asked ? `물어본 가맹점 ${r.asked}곳 중 ${r.suggested}곳에 제안(거래 ${r.updatedTransactions}건). "거래 내역"에서 확인해 주세요.${r.error ? ' ' + r.error : ''}` : '분류되지 않은 가맹점이 없습니다.';
  } catch (e) { $('#aiMsg').textContent = e.message; $('#aiMsg').className = 'err'; }
  finally { $('#goAi').disabled = false; }
});

// ── 월 리포트 ──────────────────────────────────────────────
function fillMonths(sel, months, cur) {
  sel.replaceChildren(...months.map((m) => h('option', { value: m, selected: m === cur }, m)));
}
async function loadReport() {
  const r = await api(`/api/report?${qs(state.month ? { month: state.month } : {})}`);
  const box = $('#report'); box.replaceChildren();
  if (!r.month) { box.append(h('p', { class: 'muted' }, '거래가 없습니다. "가져오기"에서 CSV를 올려 주세요.')); $('#month').replaceChildren(); return; }
  state.month = r.month; fillMonths($('#month'), r.months, r.month);
  $('#exportLink').href = `/api/export?${qs({ month: r.month })}`;
  const s = r.summary;

  box.append(h('div', { class: 'kpis' },
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, '지출(환불 차감)'), h('div', { class: 'v' }, won(s.expense))),
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, '수입'), h('div', { class: 'v' }, s.income ? won(s.income) : '-')),
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, s.prev ? `지난달(${s.prev.month}) 대비` : '지난달 대비'), h('div', { class: 'v' }, s.prev ? signed(s.prev.change) : '비교할 데이터 없음'), s.prev?.changePct != null ? h('div', { class: 'l' }, `${s.prev.changePct > 0 ? '+' : ''}${s.prev.changePct}%`) : null),
    h('div', { class: 'kpi' }, h('div', { class: 'l' }, '미확인 분류가 차지하는 지출'), h('div', { class: 'v' }, s.unconfirmed.share != null ? `${s.unconfirmed.share}%` : '-'), h('div', { class: 'l' }, s.unconfirmed.amount ? `${won(s.unconfirmed.amount)} — 분류를 확인하면 줄어듭니다` : '모두 확인됨'))));

  // 확인할 지출(이상 지출)
  box.append(h('h3', {}, `확인할 지출 ${r.alerts.length}건`));
  if (!r.alerts.length) box.append(h('p', { class: 'muted' }, r.dismissedCount ? `새 경고가 없습니다(숨긴 경고 ${r.dismissedCount}건).` : '이번 달에는 특별히 이상한 지출이 없습니다.'));
  for (const a of r.alerts) {
    box.append(h('div', { class: `alert ${a.severity}` },
      h('div', {}, h('span', { class: 'badge warn' }, TYPE[a.type] ?? a.type), ' ', a.message, h('div', { class: 'why' }, `${a.date} · ${a.category}${a.evidence?.samples ? ` · 비교 거래 ${a.evidence.samples}건` : ''} — 코드가 계산한 근거이며, 정상 지출이면 숨기세요.`)),
      h('button', { class: 'ghost mini', type: 'button', onclick: async () => { await api('/api/alerts/dismiss', { method: 'POST', body: { userId, key: a.key } }); loadReport(); } }, '정상이에요(숨기기)')));
  }
  if (r.dismissedCount) box.append(h('button', { class: 'ghost mini', type: 'button', onclick: async () => { await api('/api/alerts/restore', { method: 'POST', body: { userId } }); loadReport(); } }, `숨긴 경고 ${r.dismissedCount}건 다시 보기`));

  // 예산
  if (r.budgets.length) {
    box.append(h('h3', {}, '예산'));
    for (const b of r.budgets) {
      const [label, cls] = STATUS[b.status];
      box.append(h('div', { class: 'catrow' }, h('span', {}, b.category),
        h('div', { class: 'track', title: `${b.pct}%` }, h('div', { class: 'fill', style: `width:${Math.min(100, b.pct)}%;${b.status === 'over' ? 'background:var(--bad)' : b.status === 'warn' ? 'background:var(--warn)' : ''}` })),
        h('span', { class: 'amt' }, `${won(b.spent)} / ${won(b.limit)} `, h('span', { class: cls }, label))));
      if (b.status === 'warn') box.append(h('div', { class: 'muted', style: 'margin:-2px 0 4px 106px' }, `이 속도면 월말에 ${won(b.projected)}로 예산을 넘습니다.`));
    }
  }

  // 카테고리
  box.append(h('h3', {}, '카테고리별 지출'));
  const max = Math.max(1, ...s.byCategory.map((c) => c.total));
  for (const c of s.byCategory) box.append(h('div', { class: 'catrow' }, h('span', {}, c.category), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${Math.max(0, (c.total / max) * 100)}%` })), h('span', { class: 'amt' }, `${won(c.total)} (${c.share}%)`)));

  box.append(h('h3', {}, '일별 지출'));
  const dmax = Math.max(1, ...s.daily);
  box.append(h('div', { class: 'days', role: 'img', 'aria-label': '일별 지출 막대' }, s.daily.map((v, i) => h('i', { class: v === dmax && v > 0 ? 'peak' : '', style: `height:${Math.max(1, (v / dmax) * 100)}%`, title: `${i + 1}일 ${won(v)}` }))));

  box.append(h('h3', {}, '많이 쓴 가맹점'));
  box.append(h('table', {}, h('tbody', {}, s.topMerchants.map((m) => h('tr', {}, h('td', {}, m.merchant), h('td', {}, m.category), h('td', { class: 'n' }, `${m.count}건`), h('td', { class: 'n' }, won(m.total)))))));

  if (r.recurring.length) {
    box.append(h('h3', {}, `정기결제(구독) ${r.recurring.length}개 · 월 합계 ${won(r.recurring.reduce((x, y) => x + y.amount, 0))}`));
    box.append(h('table', {}, h('tbody', {}, r.recurring.map((m) => h('tr', {}, h('td', {}, m.merchant), h('td', {}, m.category), h('td', { class: 'n' }, won(m.amount)), h('td', { class: 'muted' }, m.priceChanged ? `가격 변동(이전 ${won(m.previous)})` : `${m.count}회 연속`))))));
  }
}
$('#month').addEventListener('change', (e) => { state.month = e.target.value; loadReport(); });

// ── 거래 내역 ──────────────────────────────────────────────
async function loadTx() {
  const rep = await api(`/api/report?${qs()}`).catch(() => ({ months: [] }));
  const mSel = $('#txMonth'), cur = mSel.value || state.month || '';
  mSel.replaceChildren(h('option', { value: '' }, '전체 기간'), ...rep.months.map((m) => h('option', { value: m, selected: m === cur }, m)));
  const cSel = $('#txCat'), cc = cSel.value;
  cSel.replaceChildren(h('option', { value: '' }, '전체 카테고리'), ...CATS.map((c) => h('option', { value: c, selected: c === cc }, c)));
  await queryTx();
}
async function queryTx() {
  const p = {}; if ($('#txMonth').value) p.month = $('#txMonth').value; if ($('#txCat').value) p.category = $('#txCat').value; if ($('#txQ').value.trim()) p.q = $('#txQ').value.trim();
  const r = await api(`/api/transactions?${qs(p)}`);
  const box = $('#txs'); box.replaceChildren();
  if (!r.total) { box.append(h('p', { class: 'muted' }, '조건에 맞는 거래가 없습니다.')); return; }
  box.append(h('p', { class: 'muted' }, `총 ${r.total}건${r.total > r.rows.length ? ` 중 최근 ${r.rows.length}건` : ''}`));
  box.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '날짜'), h('th', {}, '가맹점'), h('th', {}, '카테고리'), h('th', { class: 'n' }, '금액'))),
    h('tbody', {}, r.rows.map((t) => h('tr', {},
      h('td', {}, t.date + (t.time ? ` ${t.time.slice(0, 5)}` : '')),
      h('td', {}, t.merchant, t.kind === 'refund' ? h('span', { class: 'badge' }, '취소/환불') : null),
      h('td', {}, t.kind === 'income' ? h('span', { class: 'badge' }, '수입') : [
        h('select', { 'aria-label': `${t.merchant} 카테고리`, onchange: async (e) => { try { const x = await api('/api/transactions/category', { method: 'POST', body: { userId, txId: t.id, category: e.target.value } }); $('#importMsg').textContent = ''; queryTx(); if (x.updated > 1) console.info(`${x.updated}건 적용`); } catch (err) { alert(err.message); queryTx(); } } },
          CATS.map((c) => h('option', { value: c, selected: c === t.category }, c))), ' ', methodBadge(t),
        t.catMethod === 'ai' ? h('button', { class: 'ghost mini', type: 'button', onclick: async () => { await api('/api/transactions/category', { method: 'POST', body: { userId, txId: t.id, category: t.category } }); queryTx(); } }, '확인') : null]),
      h('td', { class: `n ${t.kind === 'refund' ? 'refund' : ''}` }, `${t.kind === 'refund' ? '-' : ''}${won(t.amount)}`))))));
}
$('#goTx').addEventListener('click', queryTx);
$('#txQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') queryTx(); });

// ── 예산 ───────────────────────────────────────────────────
async function loadBudgets() {
  const rep = await api(`/api/report?${qs(state.month ? { month: state.month } : {})}`).catch(() => ({ budgets: [] }));
  const cur = new Map((rep.budgets ?? []).map((b) => [b.category, b]));
  const box = $('#budgets'); box.replaceChildren();
  for (const c of CATS.filter((x) => x !== '기타')) {
    const b = cur.get(c);
    const inp = h('input', { type: 'number', min: '1', step: '1000', placeholder: '월 예산(원)', value: b ? String(b.limit) : '', 'aria-label': `${c} 월 예산` });
    const msg = h('span', { class: 'muted' }, b ? `${rep.month} 사용 ${won(b.spent)}` : '');
    box.append(h('div', { class: 'budget' }, h('span', {}, c), inp, msg, h('button', { class: 'ghost mini', type: 'button', onclick: async () => {
      try { await api('/api/budgets', { method: 'POST', body: { userId, category: c, limit: inp.value === '' ? null : Number(inp.value) } }); msg.textContent = '저장됨'; } catch (e) { msg.textContent = e.message; msg.className = 'err'; } } }, '저장')));
  }
}

// ── 전체 삭제 ──────────────────────────────────────────────
$('#forget').addEventListener('click', async () => {
  if (!confirm('이 브라우저의 모든 가계부 기록(거래·분류 규칙·예산)을 삭제합니다. 복구할 수 없습니다. 계속할까요?')) return;
  await api('/api/forget', { method: 'POST', body: { userId, confirm: true } });
  userId = newId(); safe.set('mo_user', userId); state = { month: null };
  $('#importResult').replaceChildren(); $('#importMsg').textContent = '모두 삭제했습니다.'; loadImports();
});

showStatus().then(() => openTab('import'));
