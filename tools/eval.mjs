// ─────────────────────────────────────────────────────────────────────────────
// eval.mjs — 정확도 측정: ① 파일 읽기 ② 카테고리 분류 ③ 이상 지출 탐지 (+ 선택: AI 제안)
//
//   node tools/eval.mjs                 개발용·held-out 세트 규칙 경로
//   node tools/eval.mjs --llm           + 사전에 없는 가맹점에 대한 AI 제안 정확도(Ollama 필요)
//
// [세트]  dev   개발 중 계속 본 데이터(시드 1~3)  → 부풀려진 값
//         held1 임계값을 정한 뒤 새로 만든 데이터(시드 11~13) → 1라운드 결과를 본 뒤 규칙을 고쳤으므로 이후 수치는 참고용
//         held2 고친 뒤 새로 만든 데이터(시드 21~23, 또 다른 가맹점·금액대) → 최종 수치
// [주의]  모든 데이터는 직접 만든 가상 데이터입니다. 실제 가계부보다 단순해 정확도는 상한선에 가깝습니다.
// ─────────────────────────────────────────────────────────────────────────────
import { generate } from './gen.mjs';
import { readLedger } from '../src/ledger.mjs';
import { normalizeMerchant, classify } from '../src/merchant.mjs';
import { detectAnomalies } from '../src/analyze.mjs';
import { suggestCategories } from '../src/ai.mjs';
import { LLM } from '../src/llm.mjs';

// 평가 세트: [시드, CSV 형식, 데이터 변형]. 개발용(dev)은 규칙을 만들며 계속 본 것, held1은 1라운드, held2는 수정 후 새로 만든 최종 평가용.
const SETS = {
  dev: [[1, 'A', 'dev'], [2, 'B', 'dev'], [3, 'C', 'dev']],
  held1: [[11, 'A', 'held'], [12, 'B', 'held'], [13, 'C', 'held']],
  held2: [[21, 'A', 'held2'], [22, 'B', 'held2'], [23, 'C', 'held2']],
};
// 비율을 '12.3%' 문자열로(분모 0이면 '-')
const pct = (a, b) => (b ? `${(Math.round((a / b) * 1000) / 10).toFixed(1)}%` : '-');
const which = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const useLlm = process.argv.includes('--llm');

// 세트 하나를 평가합니다: 생성 → 읽기 → 분류 → 이상 탐지 → 정답과 비교. 결과 숫자를 객체로 돌려줍니다.
function run([seed, style, variant]) {
  const g = generate({ seed, style, variant });
  const led = readLedger(g.text, { year: 2026 });
  const txs = led.transactions.map((t, i) => {
    const norm = normalizeMerchant(t.merchant);
    const c = t.kind === 'income' ? { category: '수입', method: 'rule' } : classify(norm);
    return { id: i + 1, ...t, norm, category: c.category, catMethod: c.method };
  });
  // (읽기 평가) 날짜·금액·종류가 같은 거래가 정답에 몇 개나 있는지 센다. 같은 값이 여러 개면 한 번씩만 대응시킨다.
  // ① 읽기: (날짜, 금액, 종류) 다중집합 일치
  const key = (t) => `${t.date}|${t.amount}|${t.kind}`;
  const pool = new Map(); for (const t of g.tx) pool.set(key(t), (pool.get(key(t)) ?? 0) + 1);
  let parseOk = 0; for (const t of txs) { const n = pool.get(key(t)) ?? 0; if (n > 0) { parseOk++; pool.set(key(t), n - 1); } }
  // (분류 평가) 규칙만 사용. 규칙이 분류를 시도한 것 중 맞은 비율(정밀도)과, 분류를 시도한 비율을 따로 센다.
  // ② 분류: 가맹점 이름 → 정답 카테고리 (같은 순서로 대응시키기 위해 정답 목록에서 이름·금액·날짜로 찾음)
  const truthBy = new Map(); for (const t of g.tx) { const k = `${t.date}|${t.merchant}|${t.amount}`; (truthBy.get(k) ?? truthBy.set(k, []).get(k)).push(t.category); }
  let cls = 0, clsOk = 0, covered = 0, coveredOk = 0; const wrong = new Map(), unknown = new Map();
  for (const t of txs) {
    if (t.kind === 'income') continue;
    const arr = truthBy.get(`${t.date}|${t.merchant}|${t.amount}`); const truth = arr?.shift();
    if (!truth) continue;
    cls++; if (t.category === truth) clsOk++;
    if (t.catMethod !== 'none') { covered++; if (t.category === truth) coveredOk++; if (t.category !== truth) wrong.set(`${t.merchant} → ${t.category}(정답 ${truth})`, 1); }
    else if (truth !== '기타') unknown.set(t.merchant, { norm: t.norm, truth });
  }
  // (이상 탐지 평가) 정답 5건과 (유형·날짜·금액)이 모두 같으면 TP, 정답에 없는 경고는 오탐(FP).
  // ③ 이상 지출
  const month = '2026-10';
  const found = detectAnomalies(txs, month);
  const fk = (a) => `${a.type}|${a.date}|${a.amount}`;
  const truthSet = new Set(g.truth.map(fk)), foundSet = new Set(found.map(fk));
  const tp = g.truth.filter((a) => foundSet.has(fk(a))).length;
  const fp = found.filter((a) => !truthSet.has(fk(a)));
  const anyKey = (a) => `${a.date}|${a.amount}`; const foundAny = new Set(found.map(anyKey));
  const anyTp = g.truth.filter((a) => foundAny.has(anyKey(a))).length;
  return { style, seed, rows: g.tx.length, parsed: txs.length, parseOk, cls, clsOk, covered, coveredOk, wrong: [...wrong.keys()], unknown, truthN: g.truth.length, tp, anyTp, fp, missed: g.truth.filter((a) => !foundSet.has(fk(a))) };
}

// 실행: 인자로 세트 이름을 주면 그 세트만, 없으면 전부. --llm이면 AI 제안 정확도도 측정합니다(Ollama 필요).
const names = which.length ? which : Object.keys(SETS);
for (const name of names) {
  console.log(`\n══ ${name} ══`);
  const rs = SETS[name].map(run);
  const sum = (f) => rs.reduce((s, r) => s + f(r), 0);
  for (const r of rs) {
    console.log(`  [${r.style}] 읽기 ${r.parseOk}/${r.rows} · 분류 ${pct(r.clsOk, r.cls)} · 이상지출 ${r.tp}/${r.truthN} 정확 일치, 오탐 ${r.fp.length}` + (r.fp.length ? ` (${r.fp.map((a) => `${a.type}:${a.merchant} ${a.amount}`).join('; ')})` : '') + (r.missed.length ? ` · 놓침 ${r.missed.map((a) => `${a.type}:${a.amount}`).join(',')}` : ''));
  }
  const cls = sum((r) => r.cls), ok = sum((r) => r.clsOk), cov = sum((r) => r.covered);
  const tp = sum((r) => r.tp), tn = sum((r) => r.truthN), fp = sum((r) => r.fp.length);
  console.log(`  읽기 정확 일치 ${pct(sum((r) => r.parseOk), sum((r) => r.rows))} (${sum((r) => r.parseOk)}/${sum((r) => r.rows)}), 읽지 못한 줄 ${sum((r) => r.rows - r.parsed)}`);
  console.log(`  분류 정확도 ${pct(ok, cls)} (${ok}/${cls}) · 규칙이 분류한 비율 ${pct(cov, cls)} · 분류한 것의 정밀도 ${pct(sum((r) => r.coveredOk), cov)}`);
  const wrongAll = rs.flatMap((r) => r.wrong); if (wrongAll.length) console.log('  규칙이 잘못 분류:', [...new Set(wrongAll)].join(' / '));
  console.log(`  이상 지출 정밀도 ${pct(tp, tp + fp)} · 재현율 ${pct(tp, tn)} (유형까지 일치) · 재현율 ${pct(sum((r) => r.anyTp), tn)} (유형 무관 위치만)`);

  if (useLlm) {
    const llm = await new LLM({ timeoutMs: 120000 }).init();
    if (!llm.available) { console.log('  (AI 사용 불가 — 건너뜀)'); continue; }
    const all = new Map(); for (const r of rs) for (const [m, v] of r.unknown) all.set(v.norm, { merchant: m, truth: v.truth });
    const asked = [...all].map(([norm, v]) => ({ norm, merchant: v.merchant }));
    const t0 = Date.now(); const { suggestions } = await suggestCategories(llm, asked);
    const okS = suggestions.filter((s) => all.get(s.norm).truth === s.category).length;
    console.log(`  AI 제안: 물어본 미분류 가맹점 ${asked.length}곳 → 제안 ${suggestions.length}곳, 정답 ${okS}곳 (제안 정밀도 ${pct(okS, suggestions.length)}, 전체 대비 ${pct(okS, asked.length)}) · ${Math.round((Date.now() - t0) / 1000)}초`);
    for (const s of suggestions.filter((x) => all.get(x.norm).truth !== x.category)) console.log(`    틀림: ${all.get(s.norm).merchant} → ${s.category} (정답 ${all.get(s.norm).truth})`);
  }
}
