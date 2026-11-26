// ─────────────────────────────────────────────────────────────────────────────
// app.mjs — 서비스 계층: 가져오기·분석·분류 수정·예산을 조립합니다. HTTP·화면과 무관한 업무 로직입니다.
//
// [가져오기 흐름]  CSV 바이트 → 글자 해석(UTF-8/CP949) → 거래 변환 → 가맹점 정리·분류 → 중복 제거 저장
// [중복 방지]  같은 파일을 다시 올려도 거래가 두 번 쌓이지 않도록 dedupe_key(날짜·시각·가맹점·금액·종류·같은 파일 안 순번)를 씁니다.
//              같은 날 같은 가게에서 같은 금액을 두 번 쓴 정상 거래는 "순번"으로 구분되어 둘 다 남습니다.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.mjs';
import { LLM } from './llm.mjs';
import { decodeText } from './csv.mjs';
import { readLedger } from './ledger.mjs';
import { normalizeMerchant, classify, EXPENSE_CATEGORIES } from './merchant.mjs';
import { summarize, detectAnomalies, findRecurring, budgetStatus, months, monthOf, won } from './analyze.mjs';
import { HttpError } from './errors.mjs';
import { suggestCategories } from './ai.mjs';

// 프로젝트 루트 폴더(src의 한 단계 위). 정적 파일·DB 경로 계산에 씁니다.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 월 형식 검사: 2026-01 ~ 2026-12 (13월·0월 거부)
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

// createApp: 서비스 객체를 만드는 공장 함수. 테스트에서 가짜 LLM·고정된 오늘 날짜를 주입할 수 있게 인자로 받습니다.
//   dbPath ':memory:' → 메모리 DB(테스트용),  llm → AI 어댑터(생략하면 환경설정대로 자동 연결),  today → 오늘 날짜를 돌려주는 함수
export async function createApp({ dbPath = ':memory:', llm, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  const store = new Store(dbPath);
  llm ??= await new LLM({ timeoutMs: 60000 }).init();

  // 파일 이름 정리: 경로 문자(\ / : * ? " < > |)와 제어문자를 '_'로 바꾸고 80자로 제한 → 화면·DB에 안전한 이름만 남김
  const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f]/gu, ' ').replace(/[\\/:*?"<>|]/gu, '_').trim().slice(0, 80) || '내역.csv';

  // 가져오기 한 번의 전체 흐름. 반환: 새로 들어간/중복 건수, 제외된 줄 목록, 포함된 월, 미분류 가맹점 수.
  //   ① 바이트 → 글자  ② 글자 → 거래(날짜·정수 금액·종류)  ③ 가맹점 이름 정리와 분류  ④ 중복 키 계산  ⑤ DB에 저장(트랜잭션)
  function importCsv(userId, { filename, bytes }) {
    const text = decodeText(bytes);
    const led = readLedger(text, { year: Number(today().slice(0, 4)) });
    const rules = store.rules(userId); // 이 사용자가 예전에 고친 분류 규칙(가맹점 키 → 카테고리)
    // ordinal: 같은 내용의 거래가 한 파일에 여러 번 나올 때 "몇 번째인지" 세는 장부(아래 dedupe 설명 참고)
    const ordinal = new Map();
    const rows = led.transactions.map((t) => {
      const norm = normalizeMerchant(t.merchant); // 같은 가게를 묶는 키
      const c = t.kind === 'income' ? { category: '수입', method: 'rule' } : classify(norm, rules);
      // 중복 제거 키: 날짜·시각·가맹점·금액·종류가 모두 같은 거래는 "같은 거래"입니다. 그런데 같은 날 같은 가게에서
      // 같은 금액을 정말 두 번 쓴 경우(커피 2잔)도 있으므로, 같은 파일 안에서 몇 번째인지(n)를 키에 넣어 둘 다 보존합니다.
      // 같은 파일을 다시 올리면 모든 키가 이미 있으므로 하나도 추가되지 않습니다(DB의 UNIQUE가 걸러냄).
      const base = `${t.date}|${t.time ?? ''}|${t.merchant}|${t.amount}|${t.kind}`;
      const n = (ordinal.get(base) ?? 0) + 1; ordinal.set(base, n);
      const dedupeKey = createHash('sha1').update(`${base}|${n}`).digest('hex');
      return { ...t, norm, category: c.category, catMethod: c.method, dedupeKey };
    });
    // 읽을 수 있는 거래가 하나도 없으면(예: 전부 형식 오류) 가져오기 자체를 실패로 처리하고 첫 번째 이유를 알려 줍니다.
    if (!rows.length) throw new HttpError(400, '읽을 수 있는 거래가 없습니다. ' + (led.skipped[0] ? `예) ${led.skipped[0].line}번째 줄: ${led.skipped[0].reason}` : ''));
    const res = store.addImport(userId, { filename: cleanName(filename), format: led.format, rows, skipped: led.skipped.length });
    return {
      ...res, format: led.format, rows: rows.length, summaryRows: led.summaryRows,
      skippedCount: led.skipped.length, skipped: led.skipped.slice(0, 20),
      months: [...new Set(rows.map((r) => monthOf(r.date)))].sort(),
      unclassified: new Set(rows.filter((r) => r.catMethod === 'none' && r.kind !== 'income').map((r) => r.norm)).size,
    };
  }

  // 월 선택: 지정하지 않으면 데이터가 있는 가장 최근 달. 형식이 틀리면 400, 데이터가 전혀 없으면 null.
  const pickMonth = (txs, m) => {
    const all = months(txs);
    if (!all.length) return null;
    if (m == null || m === '') return all[all.length - 1];
    if (!MONTH.test(String(m))) throw new HttpError(400, '월은 YYYY-MM 형식이어야 합니다.');
    return String(m);
  };

  // 월 리포트 한 화면에 필요한 모든 것을 한 번에 계산합니다(요약·경고·정기결제·예산·가져온 파일 목록).
  // 숨긴 경고(dismissals)는 목록에서 빼고 개수만 알려 줍니다.
  function report(userId, m) {
    const txs = store.allTransactions(userId);
    const month = pickMonth(txs, m);
    if (!month) return { months: [], month: null };
    const dismissed = store.dismissed(userId);
    const all = detectAnomalies(txs, month);
    const alerts = all.filter((a) => !dismissed.has(a.key));
    const t = today();
    return {
      months: months(txs), month, summary: summarize(txs, month),
      alerts, dismissedCount: all.length - alerts.length,
      recurring: findRecurring(txs),
      budgets: budgetStatus(txs, month, store.budgets(userId), t),
      imports: store.imports(userId),
    };
  }

  // 분류 고치기. remember=true(기본)면 같은 가맹점 전체에 적용하고 규칙으로 저장. 수입 거래·목록 밖 카테고리는 거부.
  function setCategory(userId, txId, category, remember) {
    if (!EXPENSE_CATEGORIES.includes(category)) throw new HttpError(400, '카테고리가 올바르지 않습니다.');
    const r = store.setCategory(userId, txId, category, remember !== false);
    if (!r) throw new HttpError(404, '거래를 찾을 수 없습니다(수입 거래는 분류를 바꿀 수 없습니다).');
    return r;
  }

  // 예산 설정. limit=null이면 삭제. 1원 이상 100억 이하의 정수만 허용(소수·0·음수·비정상적으로 큰 값 거부).
  function setBudget(userId, category, limit) {
    if (!EXPENSE_CATEGORIES.includes(category)) throw new HttpError(400, '카테고리가 올바르지 않습니다.');
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000_000_000)) throw new HttpError(400, '예산은 1원 이상의 정수여야 합니다.');
    store.setBudget(userId, category, limit);
    return { ok: true };
  }

  // 사전에 없는 가맹점 분류 제안(AI). 금액 없이 가맹점 이름만 보냅니다.
  // 흐름: AI 연결 확인 → 미분류 가맹점 이름 최대 24개 → AI 제안 → 검증 통과분만 저장(cat_method='ai').
  async function classifyAi(userId) {
    await llm.ensure?.();
    if (!llm.available) throw new HttpError(503, 'AI를 사용할 수 없습니다. 분류되지 않은 가맹점은 직접 고쳐 주세요.');
    const asked = store.unknownMerchants(userId, 24).map((r) => ({ norm: r.norm, merchant: r.merchant }));
    const { suggestions, error } = await suggestCategories(llm, asked);
    const updated = store.applyAi(userId, suggestions);
    return { asked: asked.length, suggested: suggestions.length, updatedTransactions: updated, error };
  }

  // 월 리포트를 마크다운 텍스트로 만듭니다(내려받기용). 화면과 같은 report() 결과를 쓰므로 숫자가 항상 일치합니다.
  function exportMarkdown(userId, m) {
    const r = report(userId, m);
    if (!r.month) return null;
    const s = r.summary;
    const L = [`# ${r.month} 지출 리포트`, '', `- 지출 ${won(s.expense)} · 수입 ${won(s.income)} · 거래 ${s.count}건`];
    if (s.prev) L.push(`- 지난달(${s.prev.month}) 대비 ${s.prev.change >= 0 ? '+' : ''}${won(s.prev.change)}${s.prev.changePct != null ? ` (${s.prev.changePct}%)` : ''}`);
    if (s.unconfirmed.amount) L.push(`- 확인되지 않은 분류가 차지하는 지출: ${won(s.unconfirmed.amount)} (${s.unconfirmed.share}%)`);
    L.push('', '## 카테고리별', ...s.byCategory.map((c) => `- ${c.category}: ${won(c.total)} (${c.share}%)`));
    if (r.alerts.length) L.push('', '## 확인할 지출', ...r.alerts.map((a) => `- ${a.date} ${a.message}`));
    if (r.budgets.length) L.push('', '## 예산', ...r.budgets.map((b) => `- ${b.category}: ${won(b.spent)} / ${won(b.limit)} (${b.pct}%) ${{ over: '초과', warn: '초과 예상', ok: '정상' }[b.status]}`));
    if (r.recurring.length) L.push('', '## 정기결제', ...r.recurring.map((x) => `- ${x.merchant} ${won(x.amount)}`));
    return L.join('\n') + '\n';
  }

  return { store, llm, today, importCsv, report, setCategory, setBudget, classifyAi, exportMarkdown, pickMonth };
}
