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

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

export async function createApp({ dbPath = ':memory:', llm, today = () => new Date().toISOString().slice(0, 10) } = {}) {
  const store = new Store(dbPath);
  llm ??= await new LLM({ timeoutMs: 60000 }).init();

  const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f]/gu, ' ').replace(/[\\/:*?"<>|]/gu, '_').trim().slice(0, 80) || '내역.csv';

  function importCsv(userId, { filename, bytes }) {
    const text = decodeText(bytes);
    const led = readLedger(text, { year: Number(today().slice(0, 4)) });
    const rules = store.rules(userId);
    const ordinal = new Map();
    const rows = led.transactions.map((t) => {
      const norm = normalizeMerchant(t.merchant);
      const c = t.kind === 'income' ? { category: '수입', method: 'rule' } : classify(norm, rules);
      const base = `${t.date}|${t.time ?? ''}|${t.merchant}|${t.amount}|${t.kind}`;
      const n = (ordinal.get(base) ?? 0) + 1; ordinal.set(base, n);
      const dedupeKey = createHash('sha1').update(`${base}|${n}`).digest('hex');
      return { ...t, norm, category: c.category, catMethod: c.method, dedupeKey };
    });
    if (!rows.length) throw new HttpError(400, '읽을 수 있는 거래가 없습니다. ' + (led.skipped[0] ? `예) ${led.skipped[0].line}번째 줄: ${led.skipped[0].reason}` : ''));
    const res = store.addImport(userId, { filename: cleanName(filename), format: led.format, rows, skipped: led.skipped.length });
    return {
      ...res, format: led.format, rows: rows.length, summaryRows: led.summaryRows,
      skippedCount: led.skipped.length, skipped: led.skipped.slice(0, 20),
      months: [...new Set(rows.map((r) => monthOf(r.date)))].sort(),
      unclassified: new Set(rows.filter((r) => r.catMethod === 'none' && r.kind !== 'income').map((r) => r.norm)).size,
    };
  }

  const pickMonth = (txs, m) => {
    const all = months(txs);
    if (!all.length) return null;
    if (m == null || m === '') return all[all.length - 1];
    if (!MONTH.test(String(m))) throw new HttpError(400, '월은 YYYY-MM 형식이어야 합니다.');
    return String(m);
  };

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

  function setCategory(userId, txId, category, remember) {
    if (!EXPENSE_CATEGORIES.includes(category)) throw new HttpError(400, '카테고리가 올바르지 않습니다.');
    const r = store.setCategory(userId, txId, category, remember !== false);
    if (!r) throw new HttpError(404, '거래를 찾을 수 없습니다(수입 거래는 분류를 바꿀 수 없습니다).');
    return r;
  }

  function setBudget(userId, category, limit) {
    if (!EXPENSE_CATEGORIES.includes(category)) throw new HttpError(400, '카테고리가 올바르지 않습니다.');
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000_000_000)) throw new HttpError(400, '예산은 1원 이상의 정수여야 합니다.');
    store.setBudget(userId, category, limit);
    return { ok: true };
  }

  // 사전에 없는 가맹점 분류 제안(AI). 금액 없이 가맹점 이름만 보냅니다.
  async function classifyAi(userId) {
    await llm.ensure?.();
    if (!llm.available) throw new HttpError(503, 'AI를 사용할 수 없습니다. 분류되지 않은 가맹점은 직접 고쳐 주세요.');
    const asked = store.unknownMerchants(userId, 24).map((r) => ({ norm: r.norm, merchant: r.merchant }));
    const { suggestions, error } = await suggestCategories(llm, asked);
    const updated = store.applyAi(userId, suggestions);
    return { asked: asked.length, suggested: suggestions.length, updatedTransactions: updated, error };
  }

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
