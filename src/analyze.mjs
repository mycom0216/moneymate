// ─────────────────────────────────────────────────────────────────────────────
// analyze.mjs — 월별 요약 · 이상 지출 탐지 · 정기결제 찾기 · 예산 상태 (전부 코드가 계산)
//
// [원칙]  AI는 숫자를 만들지 않습니다. 합계·평균·증감·경고 문장의 모든 숫자는 이 파일에서 정수로 계산합니다.
//         모든 경고는 "근거 숫자(evidence)"를 함께 가지고, 화면에서 그 근거를 그대로 보여줍니다.
//
// [입력 형태]  이 파일의 모든 함수는 "거래 배열"을 받습니다. 거래 한 건은 이런 모양입니다(db.mjs의 toTx가 만듭니다):
//     { id, date:'2026-10-05', time:'12:30'|null, merchant:'스타벅스 강남역점', norm:'스타벅스',
//       amount:4500 (정수 원, 항상 양수), kind:'expense'|'income'|'refund', category:'카페', catMethod:'rule'|'user'|'ai'|'none' }
//   · amount는 항상 양수이고, 방향(지출/수입/환불)은 kind가 말합니다.
//   · norm은 "같은 가게"를 묶는 키입니다(merchant.mjs의 normalizeMerchant).
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
//                       (한계: 15만원·20만원은 절대 금액이라 소비 규모가 큰 사람에게는 오탐이 있을 수 있습니다.)
// ─────────────────────────────────────────────────────────────────────────────

// ── 날짜·숫자 도우미 ──────────────────────────────────────

// '2026-10-05' → '2026-10' (월 키). 월별로 거래를 묶을 때 씁니다.
export const monthOf = (date) => String(date).slice(0, 7);

// 그 달의 일수. Date.UTC(y, m, 0)은 "다음 달 0일 = 이번 달 마지막 날"이라 윤년(2월 29일)도 자동으로 맞습니다.
export const daysInMonth = (month) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// 날짜 → "1970-01-01부터 며칠째"인 정수. 두 날짜의 간격(일)을 빼기만 하면 구할 수 있게 합니다.
// UTC로 계산하는 이유: 시간대·여름시간제 때문에 하루가 23/25시간이 되는 오류를 피하기 위함입니다.
const dayNum = (date) => { const [y, m, d] = date.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };

// '2026-01' → '2025-12'. 전월 대비를 계산할 때 해를 넘기는 경우를 처리합니다.
const prevMonth = (month) => { const [y, m] = month.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

// 화면·경고 문장용 금액 문자열: 1234567 → '1,234,567원'
export const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;

// 중앙값: 크기순으로 줄 세웠을 때 가운데 값(짝수 개면 가운데 두 값의 평균).
// 평균과 달리 아주 큰 값 하나가 있어도 거의 변하지 않아서 "평소 금액"의 기준으로 적합합니다.
export const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

// MAD(중앙값 절대 편차): "각 값이 중앙값에서 얼마나 떨어졌나"의 중앙값. 표준편차의 이상치에 강한 버전입니다.
const mad = (a, med) => median(a.map((x) => Math.abs(x - med)));

// 비율(%)을 소수 첫째 자리까지. 분모가 0이면 계산할 수 없으므로 null(화면에서 '-'로 표시).
// 화면 표시용 숫자일 뿐이고, 합계·판단에는 쓰지 않습니다.
const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

// 한 거래가 "지출 순액"에 기여하는 값: 지출은 +, 환불(취소)은 −, 수입은 0(지출에 포함하지 않음).
const signed = (t) => (t.kind === 'expense' ? t.amount : t.kind === 'refund' ? -t.amount : 0);

// 거래가 있는 달 목록(오름차순). 월 선택 상자에 쓰입니다.
export function months(txs) { return [...new Set(txs.map((t) => monthOf(t.date)))].sort(); }

// ── 월별 요약 ─────────────────────────────────────────────
// 반환: 지출·수입·전월 대비·카테고리별·일별·상위 가맹점·"미확인 분류 비율".
export function summarize(txs, month) {
  const cur = txs.filter((t) => monthOf(t.date) === month);
  const byCat = new Map(), byMer = new Map(), daily = new Array(daysInMonth(month)).fill(0);
  let expense = 0, income = 0, unconfirmed = 0;
  for (const t of cur) {
    if (t.kind === 'income') { income += t.amount; continue; } // 수입은 지출 통계에서 제외
    const v = signed(t);                                       // 환불이면 음수로 더해져 지출이 줄어듭니다
    expense += v;
    byCat.set(t.category, (byCat.get(t.category) ?? 0) + v);
    // 가맹점별 합계는 norm(같은 가게 키)으로 묶어서 "스타벅스 강남점/서초점"이 한 줄로 나옵니다.
    const m = byMer.get(t.norm) ?? { norm: t.norm, merchant: t.merchant, category: t.category, total: 0, count: 0 };
    m.total += v; m.count += 1; byMer.set(t.norm, m);
    daily[Number(t.date.slice(8, 10)) - 1] += v;               // 일별 막대그래프용(1일 = 인덱스 0)
    // 사람이 아직 확인하지 않은 분류(미분류 'none' 또는 AI 제안 'ai')가 지출에서 차지하는 금액
    if (t.catMethod === 'none' || t.catMethod === 'ai') unconfirmed += v;
  }
  const pm = prevMonth(month);
  const prevExpense = txs.filter((t) => monthOf(t.date) === pm).reduce((s, t) => s + signed(t), 0);
  const hasPrev = txs.some((t) => monthOf(t.date) === pm); // 전월 데이터가 없으면 비교하지 않음(0원과 "없음"을 구분)
  return {
    month, expense, income, net: income - expense, count: cur.length,
    byCategory: [...byCat].map(([category, total]) => ({ category, total, share: pct1(total, expense) })).sort((a, b) => b.total - a.total),
    topMerchants: [...byMer.values()].sort((a, b) => b.total - a.total).slice(0, 5),
    daily,
    prev: hasPrev ? { month: pm, expense: prevExpense, change: expense - prevExpense, changePct: pct1(expense - prevExpense, prevExpense) } : null,
    unconfirmed: { amount: unconfirmed, share: pct1(unconfirmed, expense) }, // 아직 사람이 확인하지 않은 분류가 차지하는 비율
  };
}

// ── 정기결제(구독) 찾기 ───────────────────────────────────
// 같은 가맹점이 "한 달 간격(25~35일)"으로 3번 이상 나오고 금액이 거의 같으면 정기결제로 봅니다.
// 마지막 한 건만 금액이 달라도 허용해서 "가격이 올랐다"를 탐지할 수 있게 합니다(priceChanged).
export function findRecurring(txs) {
  // ① 가맹점(norm)별로 지출 거래를 모읍니다.
  const groups = new Map();
  for (const t of txs) if (t.kind === 'expense') { if (!groups.has(t.norm)) groups.set(t.norm, []); groups.get(t.norm).push(t); }
  const out = [];
  for (const [norm, list] of groups) {
    // ② 날짜순으로 정렬하고 최근 6건만 봅니다(오래전 기록 때문에 간격이 어긋나는 것을 피함).
    const g = list.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id).slice(-6);
    if (g.length < 3) continue; // 3번 미만이면 반복이라고 단정할 수 없음
    // ③ 연속한 결제 사이의 간격(일)이 모두 25~35일이어야 "매달"입니다.
    const gaps = g.slice(1).map((t, i) => dayNum(t.date) - dayNum(g[i].date));
    if (!gaps.every((d) => d >= 25 && d <= 35)) continue;
    // ④ 마지막을 뺀 나머지 금액이 중앙값의 ±5% 안이면 "같은 금액"입니다. (들쭉날쭉하면 구독이 아님)
    const base = g.slice(0, -1).map((t) => t.amount), med = median(base);
    if (!base.every((a) => Math.abs(a - med) <= med * 0.05)) continue; // 마지막 한 건만 달라도 허용(가격 변경 탐지용)
    const last = g[g.length - 1];
    out.push({ norm, merchant: last.merchant, category: last.category, amount: last.amount, previous: med, count: g.length, lastDate: last.date, lastId: last.id, priceChanged: Math.abs(last.amount - med) >= med * 0.1 });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// ── 이상 지출 ─────────────────────────────────────────────
// 숨기기(dismissals)에 쓰는 경고 식별자. 거래 번호(id)가 아니라 "내용"으로 만들어서,
// 파일을 지우고 다시 가져와 id가 바뀌어도 이미 숨긴 경고가 다시 나타나지 않습니다.
const key = (type, t) => `${type}:${t.norm}:${t.date}:${t.amount}`;

// 반환: 선택한 달의 경고 목록(날짜순). 각 경고 = { type, severity, key, txId, date, merchant, amount, category, message, evidence }
// 비교 기준(중앙값 등)은 "그 달까지의 전체 이력"에서 계산하므로 txs에는 모든 달의 거래를 넘겨야 합니다.
export function detectAnomalies(txs, month) {
  const exp = txs.filter((t) => t.kind === 'expense');            // 이상 탐지는 지출만 대상
  const inMonth = exp.filter((t) => monthOf(t.date) === month);   // 경고를 낼 대상은 선택한 달의 지출
  const out = [];
  const add = (type, severity, t, message, evidence) => out.push({ type, severity, key: key(type, t), txId: t.id, date: t.date, merchant: t.merchant, amount: t.amount, category: t.category, message, evidence });

  // ① 중복 결제 의심 ────────────────────────────────────────
  // "같은 가맹점 + 같은 금액 + 같은 날"로 묶어서 2건 이상이면 후보입니다.
  const dup = new Map();
  for (const t of inMonth) { const k = `${t.norm}|${t.amount}|${t.date}`; if (!dup.has(k)) dup.set(k, []); dup.get(k).push(t); }
  for (const g of dup.values()) {
    // 5천원 미만(편의점 소액)과 교통(하루에 같은 요금을 여러 번 내는 게 정상)은 제외
    if (g.length < 2 || g[0].amount < 5000 || g[0].category === '교통') continue;
    const times = g.map((t) => t.time).filter(Boolean);
    if (times.length === g.length) { // 모든 거래에 시각이 있을 때만 시각을 비교
      const mins = times.map((x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3))); // 'HH:MM' → 분
      if (Math.max(...mins) - Math.min(...mins) > 10) continue; // 시각이 10분 넘게 벌어지면 정상 반복 구매로 봄(아침·오후 커피 등)
    }
    add('duplicate', 'high', g[1], `${g[0].date} ${g[0].merchant}에서 ${won(g[0].amount)}이 ${g.length}번 결제됐습니다. 중복 결제인지 확인해 보세요.`, { count: g.length, amount: g[0].amount });
  }

  // ②③ 금액이 유난히 큰 지출 / 처음 보는 가맹점의 큰 지출 — 한 거래에 경고는 최대 1개(더 구체적인 쪽)
  // 비교 대상: 카테고리가 분명하고 거래가 8건 이상이면 "같은 카테고리", 아니면(미분류 '기타'·표본 부족) "고정비를 뺀 전체 지출".
  // 전체 지출과 비교하는 것은 근거가 약하므로 기준을 더 엄격하게(20만원 이상 + 중앙값의 5배 이상) 둡니다.
  const FIXED_CATS = new Set(['주거·통신', '금융']); // 월세·통신비·이체는 원래 금액이 커서 "이상"이 아님
  const byCat = new Map(), pooled = []; // byCat: 카테고리별 금액 목록, pooled: 고정비를 뺀 전체 금액 목록
  for (const t of exp) { if (!byCat.has(t.category)) byCat.set(t.category, []); byCat.get(t.category).push(t.amount); if (!FIXED_CATS.has(t.category)) pooled.push(t.amount); }

  // 이상치 판정: amount가 (중앙값 + 5×산포)보다 크고, 중앙값의 minRatio배 이상이며, floor원 이상일 때만 "유난히 큼".
  // 산포는 MAD×1.4826(정규분포에서 표준편차와 같아지게 하는 보정값)이되, MAD가 0에 가까운 경우(금액이 거의 같은 가게들)를
  // 대비해 최소 "중앙값의 30%"를 보장합니다. 표본이 8건 미만이면 통계가 불안정하므로 판단을 보류(null)합니다.
  const test = (a, amount, minRatio, floor) => {
    if (a.length < 8) return null;
    const med = median(a), spread = Math.max(1.4826 * mad(a, med), 0.3 * med);
    return amount > med + 5 * spread && amount >= minRatio * med && amount >= floor ? { med, ratio: Math.round((amount / med) * 10) / 10, samples: a.length } : null;
  };

  // "처음 보는 가맹점" 판단에 필요한 준비: 비교할 과거가 충분한지(28일 이상), 이번 달 이전에 본 가맹점 목록.
  let baselineOk = false, seenBefore = new Set(), monthStart = 0;
  if (exp.length) {
    monthStart = dayNum(`${month}-01`);
    baselineOk = monthStart - Math.min(...exp.map((t) => dayNum(t.date))) >= 28; // 데이터가 막 시작된 달은 모든 가게가 "처음"이라 의미 없음
    seenBefore = new Set(exp.filter((t) => dayNum(t.date) < monthStart).map((t) => t.norm));
  }
  for (const t of inMonth) {
    if (FIXED_CATS.has(t.category)) continue; // 고정비·이체는 원래 금액이 큼
    // own: 이 거래의 카테고리로 비교할 수 있는가(분류가 확실하고 표본 8건 이상)
    const own = t.category !== '기타' && (byCat.get(t.category)?.length ?? 0) >= 8;
    const hit = own ? test(byCat.get(t.category), t.amount, 3, 30000) : test(pooled, t.amount, 5, 200000);
    // isNew: 이번 달 이전에 본 적 없는 가게에서 15만원 이상, 그리고 이번 달의 "첫" 거래(같은 가게의 앞선 거래가 이번 달에 없음)
    const isNew = baselineOk && !seenBefore.has(t.norm) && t.amount >= 150000 && !inMonth.some((o) => o.norm === t.norm && o.id !== t.id && o.date < t.date);
    // 우선순위: ① 분류가 분명한 카테고리의 큰 지출 → ② 처음 보는 가게 → ③ 전체와 비교한 큰 지출 (한 거래에 경고 1개)
    if (hit && own) add('outlier', 'high', t, `${t.merchant} ${won(t.amount)}은 '${t.category}' 평소 금액(중앙값 ${won(hit.med)})의 ${hit.ratio}배입니다.`, { median: Math.round(hit.med), ratio: hit.ratio, samples: hit.samples, scope: 'category' });
    else if (isNew) add('new_merchant', 'mid', t, `처음 보는 가맹점 ${t.merchant}에서 ${won(t.amount)}을 썼습니다.` + (hit ? ` 전체 지출 평소 금액(중앙값 ${won(hit.med)})의 ${hit.ratio}배입니다.` : ''), { amount: t.amount, ratio: hit?.ratio ?? null });
    else if (hit) add('outlier', 'high', t, `${t.merchant} ${won(t.amount)}은 전체 지출 평소 금액(중앙값 ${won(hit.med)})의 ${hit.ratio}배입니다. 분류가 확실하지 않아 전체와 비교했습니다.`, { median: Math.round(hit.med), ratio: hit.ratio, samples: hit.samples, scope: 'all' });
  }

  // ④ 정기결제 금액 변동 ────────────────────────────────────
  // findRecurring이 "마지막 결제가 직전 금액과 10% 이상 다름"으로 표시한 구독 중, 마지막 결제가 이번 달인 것만 경고합니다.
  for (const r of findRecurring(exp)) {
    if (!r.priceChanged || monthOf(r.lastDate) !== month) continue;
    const t = inMonth.find((x) => x.id === r.lastId);
    if (t) add('price_change', 'mid', t, `정기결제 ${r.merchant}이 ${won(r.previous)}에서 ${won(r.amount)}으로 바뀌었습니다(${r.amount > r.previous ? '+' : ''}${Math.round(((r.amount - r.previous) / r.previous) * 1000) / 10}%).`, { previous: Math.round(r.previous), amount: r.amount });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ── 예산 ─────────────────────────────────────────────────
// budgets: [{category, limit}], today: 'YYYY-MM-DD'. 이번 달이면 지금까지 쓴 속도로 월말 지출을 예상(7일 이상 지난 뒤부터).
// 상태: over(이미 초과) · warn(이 속도면 월말에 초과) · ok(정상). 지난 달은 "월말 예상"이 필요 없으니 확정 값(spent)이 곧 projected입니다.
export function budgetStatus(txs, month, budgets, today) {
  const sum = summarize(txs, month);
  const spent = new Map(sum.byCategory.map((c) => [c.category, c.total]));
  const dim = daysInMonth(month), cur = monthOf(today) === month; // cur: 조회하는 달이 "이번 달"인가
  const elapsed = cur ? Number(today.slice(8, 10)) : dim;        // 이번 달이면 오늘이 며칠째인지
  return budgets.map(({ category, limit }) => {
    const s = spent.get(category) ?? 0;
    // 월말 예상 = 지금까지 쓴 금액 ÷ 지난 일수 × 그 달 일수. 초반(7일 미만)에는 표본이 적어 예상이 크게 흔들리므로 보류(null).
    const projected = cur && elapsed >= 7 ? Math.floor((s * dim) / elapsed) : cur ? null : s;
    let status = 'ok';
    if (s > limit) status = 'over';
    else if (cur && projected != null && projected > limit) status = 'warn';
    return { category, limit, spent: s, pct: pct1(s, limit), projected, status, remaining: limit - s };
  }).sort((a, b) => ({ over: 0, warn: 1, ok: 2 }[a.status] - { over: 0, warn: 1, ok: 2 }[b.status]) || b.pct - a.pct); // 위험한 것부터
}
