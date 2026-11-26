// ─────────────────────────────────────────────────────────────────────────────
// analyze.mjs — 월별 요약 · 이상 지출 탐지 · 정기결제 찾기 · 예산 상태 (전부 코드가 계산)
//
// [원칙]  AI는 숫자를 만들지 않습니다. 합계·평균·증감·경고 문장의 모든 숫자는 이 파일에서 정수로 계산합니다.
//         모든 경고는 "근거 숫자(evidence)"를 함께 가지고, 화면에서 그 근거를 그대로 보여줍니다.
//
// [이상 지출 규칙 — 단순하고 설명 가능하게]
//   ① duplicate     같은 가맹점·같은 금액이 같은 날 2번 이상(시각이 있으면 10분 이내). 5천원 이상, 교통 제외.
//   ② outlier       같은 카테고리의 "중앙값 + 5×(MAD)"를 넘고, 중앙값의 3배 이상이며 3만원 이상.
//                   (평균·표준편차는 큰 값 하나에 끌려가므로 중앙값과 MAD를 씁니다.)
//                   카테고리가 미분류('기타')이거나 거래가 8건 미만이면 고정비를 뺀 전체 지출과 비교하되 더 엄격하게(20만원·5배).
//   ③ new_merchant  처음 보는 가맹점인데 15만원 이상. 비교할 과거가 28일 이상 있을 때만.
//   ④ price_change  매달 같은 금액이던 정기결제가 10% 이상 달라짐.
// [정기결제]  같은 가맹점이 25~35일 간격으로 3번 이상, 금액이 거의 같음(±5%).
// [왜 임계값을 이렇게?]  개발용 합성 데이터로 정했고, 새 데이터(held-out)로 따로 재서 테스트결과서에 적었습니다.
// ─────────────────────────────────────────────────────────────────────────────

export const monthOf = (date) => String(date).slice(0, 7);
export const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const dayNum = (date) => { const [y, m, d] = date.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
const prevMonth = (month) => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
export const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;

export const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const mad = (a, med) => median(a.map((x) => Math.abs(x - med)));
const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null); // 소수 첫째 자리(표시용)

// 지출 순액 = 지출 − 환불
const signed = (t) => (t.kind === 'expense' ? t.amount : t.kind === 'refund' ? -t.amount : 0);

export function months(txs) { return [...new Set(txs.map((t) => monthOf(t.date)))].sort(); }

// ── 월별 요약 ─────────────────────────────────────────────
export function summarize(txs, month) {
  const cur = txs.filter((t) => monthOf(t.date) === month);
  const byCat = new Map(), byMer = new Map(), daily = new Array(daysInMonth(month)).fill(0);
  let expense = 0, income = 0, unconfirmed = 0;
  for (const t of cur) {
    if (t.kind === 'income') { income += t.amount; continue; }
    const v = signed(t);
    expense += v;
    byCat.set(t.category, (byCat.get(t.category) ?? 0) + v);
    const m = byMer.get(t.norm) ?? { norm: t.norm, merchant: t.merchant, category: t.category, total: 0, count: 0 };
    m.total += v; m.count += 1; byMer.set(t.norm, m);
    daily[Number(t.date.slice(8, 10)) - 1] += v;
    if (t.catMethod === 'none' || t.catMethod === 'ai') unconfirmed += v;
  }
  const pm = prevMonth(month);
  const prevExpense = txs.filter((t) => monthOf(t.date) === pm).reduce((s, t) => s + signed(t), 0);
  const hasPrev = txs.some((t) => monthOf(t.date) === pm);
  return {
    month, expense, income, net: income - expense, count: cur.length,
    byCategory: [...byCat].map(([category, total]) => ({ category, total, share: pct1(total, expense) })).sort((a, b) => b.total - a.total),
    topMerchants: [...byMer.values()].sort((a, b) => b.total - a.total).slice(0, 5),
    daily,
    prev: hasPrev ? { month: pm, expense: prevExpense, change: expense - prevExpense, changePct: pct1(expense - prevExpense, prevExpense) } : null,
    unconfirmed: { amount: unconfirmed, share: pct1(unconfirmed, expense) }, // 아직 사람이 확인하지 않은 분류가 차지하는 비율
  };
}

// ── 정기결제 ─────────────────────────────────────────────
export function findRecurring(txs) {
  const groups = new Map();
  for (const t of txs) if (t.kind === 'expense') { if (!groups.has(t.norm)) groups.set(t.norm, []); groups.get(t.norm).push(t); }
  const out = [];
  for (const [norm, list] of groups) {
    const g = list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).slice(-6);
    if (g.length < 3) continue;
    const gaps = g.slice(1).map((t, i) => dayNum(t.date) - dayNum(g[i].date));
    if (!gaps.every((d) => d >= 25 && d <= 35)) continue;
    const base = g.slice(0, -1).map((t) => t.amount), med = median(base);
    if (!base.every((a) => Math.abs(a - med) <= med * 0.05)) continue; // 마지막 한 건만 달라도 허용(가격 변경 탐지용)
    const last = g[g.length - 1];
    out.push({ norm, merchant: last.merchant, category: last.category, amount: last.amount, previous: med, count: g.length, lastDate: last.date, lastId: last.id, priceChanged: Math.abs(last.amount - med) >= med * 0.1 });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// ── 이상 지출 ─────────────────────────────────────────────
const key = (type, t) => `${type}:${t.norm}:${t.date}:${t.amount}`;

export function detectAnomalies(txs, month) {
  const exp = txs.filter((t) => t.kind === 'expense');
  const inMonth = exp.filter((t) => monthOf(t.date) === month);
  const out = [];
  const add = (type, severity, t, message, evidence) => out.push({ type, severity, key: key(type, t), txId: t.id, date: t.date, merchant: t.merchant, amount: t.amount, category: t.category, message, evidence });

  // ① 중복 결제 의심
  const dup = new Map();
  for (const t of inMonth) { const k = `${t.norm}|${t.amount}|${t.date}`; if (!dup.has(k)) dup.set(k, []); dup.get(k).push(t); }
  for (const g of dup.values()) {
    if (g.length < 2 || g[0].amount < 5000 || g[0].category === '교통') continue;
    const times = g.map((t) => t.time).filter(Boolean);
    if (times.length === g.length) {
      const mins = times.map((x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3)));
      if (Math.max(...mins) - Math.min(...mins) > 10) continue; // 시각이 10분 넘게 벌어지면 정상 반복 구매로 봄
    }
    add('duplicate', 'high', g[1], `${g[0].date} ${g[0].merchant}에서 ${won(g[0].amount)}이 ${g.length}번 결제됐습니다. 중복 결제인지 확인해 보세요.`, { count: g.length, amount: g[0].amount });
  }

  // ②③ 금액이 유난히 큰 지출 / 처음 보는 가맹점의 큰 지출 — 한 거래에 경고는 최대 1개(더 구체적인 쪽)
  // 비교 대상: 카테고리가 분명하고 거래가 8건 이상이면 "같은 카테고리", 아니면(미분류 '기타'·표본 부족) "고정비를 뺀 전체 지출".
  // 전체 지출과 비교하는 것은 근거가 약하므로 기준을 더 엄격하게(20만원 이상 + 중앙값의 5배 이상) 둡니다.
  const FIXED_CATS = new Set(['주거·통신', '금융']);
  const byCat = new Map(), pooled = [];
  for (const t of exp) { if (!byCat.has(t.category)) byCat.set(t.category, []); byCat.get(t.category).push(t.amount); if (!FIXED_CATS.has(t.category)) pooled.push(t.amount); }
  const test = (a, amount, minRatio, floor) => {
    if (a.length < 8) return null;
    const med = median(a), spread = Math.max(1.4826 * mad(a, med), 0.3 * med);
    return amount > med + 5 * spread && amount >= minRatio * med && amount >= floor ? { med, ratio: Math.round((amount / med) * 10) / 10, samples: a.length } : null;
  };
  let baselineOk = false, seenBefore = new Set(), monthStart = 0;
  if (exp.length) {
    monthStart = dayNum(`${month}-01`);
    baselineOk = monthStart - Math.min(...exp.map((t) => dayNum(t.date))) >= 28;
    seenBefore = new Set(exp.filter((t) => dayNum(t.date) < monthStart).map((t) => t.norm));
  }
  for (const t of inMonth) {
    if (FIXED_CATS.has(t.category)) continue; // 고정비·이체는 원래 금액이 큼
    const own = t.category !== '기타' && (byCat.get(t.category)?.length ?? 0) >= 8;
    const hit = own ? test(byCat.get(t.category), t.amount, 3, 30000) : test(pooled, t.amount, 5, 200000);
    const isNew = baselineOk && !seenBefore.has(t.norm) && t.amount >= 150000 && !inMonth.some((o) => o.norm === t.norm && o.id !== t.id && o.date < t.date);
    if (hit && own) add('outlier', 'high', t, `${t.merchant} ${won(t.amount)}은 '${t.category}' 평소 금액(중앙값 ${won(hit.med)})의 ${hit.ratio}배입니다.`, { median: Math.round(hit.med), ratio: hit.ratio, samples: hit.samples, scope: 'category' });
    else if (isNew) add('new_merchant', 'mid', t, `처음 보는 가맹점 ${t.merchant}에서 ${won(t.amount)}을 썼습니다.` + (hit ? ` 전체 지출 평소 금액(중앙값 ${won(hit.med)})의 ${hit.ratio}배입니다.` : ''), { amount: t.amount, ratio: hit?.ratio ?? null });
    else if (hit) add('outlier', 'high', t, `${t.merchant} ${won(t.amount)}은 전체 지출 평소 금액(중앙값 ${won(hit.med)})의 ${hit.ratio}배입니다. 분류가 확실하지 않아 전체와 비교했습니다.`, { median: Math.round(hit.med), ratio: hit.ratio, samples: hit.samples, scope: 'all' });
  }

  // ④ 정기결제 금액 변동
  for (const r of findRecurring(exp)) {
    if (!r.priceChanged || monthOf(r.lastDate) !== month) continue;
    const t = inMonth.find((x) => x.id === r.lastId);
    if (t) add('price_change', 'mid', t, `정기결제 ${r.merchant}이 ${won(r.previous)}에서 ${won(r.amount)}으로 바뀌었습니다(${r.amount > r.previous ? '+' : ''}${Math.round(((r.amount - r.previous) / r.previous) * 1000) / 10}%).`, { previous: Math.round(r.previous), amount: r.amount });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── 예산 ─────────────────────────────────────────────────
// budgets: [{category, limit}], today: 'YYYY-MM-DD'. 이번 달이면 지금까지 쓴 속도로 월말 지출을 예상(7일 이상 지난 뒤부터).
export function budgetStatus(txs, month, budgets, today) {
  const sum = summarize(txs, month);
  const spent = new Map(sum.byCategory.map((c) => [c.category, c.total]));
  const dim = daysInMonth(month), cur = monthOf(today) === month;
  const elapsed = cur ? Number(today.slice(8, 10)) : dim;
  return budgets.map(({ category, limit }) => {
    const s = spent.get(category) ?? 0;
    const projected = cur && elapsed >= 7 ? Math.floor((s * dim) / elapsed) : cur ? null : s;
    let status = 'ok';
    if (s > limit) status = 'over';
    else if (cur && projected != null && projected > limit) status = 'warn';
    return { category, limit, spent: s, pct: pct1(s, limit), projected, status, remaining: limit - s };
  }).sort((a, b) => ({ over: 0, warn: 1, ok: 2 }[a.status] - { over: 0, warn: 1, ok: 2 }[b.status]) || b.pct - a.pct);
}
