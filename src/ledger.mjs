// ─────────────────────────────────────────────────────────────────────────────
// ledger.mjs — CSV 행 → 거래(날짜·가맹점·금액·종류)로 바꾸기
//
// [핵심 원칙]
//   1) 금액은 "정수 원"으로만 다룹니다. 소수·부동소수점 오차가 생길 여지를 없앱니다(가계부 합계가 1원이라도 틀리면 신뢰를 잃음).
//   2) 읽지 못한 행은 조용히 버리지 않고 "몇 번째 줄이 왜 제외됐는지" 돌려줍니다.
//   3) 카드사·은행마다 헤더 이름이 달라서, 별칭 표로 열을 찾습니다(파일 위쪽의 안내 문구는 건너뜀).
//
// [종류(kind)]  expense 지출 · income 수입 · refund 취소/환불(지출에서 차감)
// [부호 규칙]   입금/출금 열이 따로 있으면 그대로. 금액 열 하나일 때:
//               · 잔액 열이 있으면 은행 거래내역으로 보고 (-)=출금, (+)=입금
//               · 없으면 카드 이용내역으로 보고 (+)=지출, (-)=취소
// ─────────────────────────────────────────────────────────────────────────────
import { parseCSV } from './csv.mjs';
import { HttpError } from './errors.mjs';

const ALIAS = {
  date: ['거래일시', '거래일자', '거래일', '이용일자', '이용일시', '이용일', '승인일자', '승인일시', '결제일', '일자', '날짜', 'date'],
  merchant: ['이용가맹점', '가맹점명', '가맹점', '사용처', '거래처', '상호', '적요', '거래내용', '기재내용', '내용', '받는분', '보낸분', 'description', 'merchant'],
  amount: ['이용금액', '승인금액', '결제금액', '거래금액', '금액', 'amount'],
  withdraw: ['출금액', '출금금액', '출금', '지출', '찾으신금액'],
  deposit: ['입금액', '입금금액', '입금', '수입', '맡기신금액'],
  status: ['승인구분', '취소여부', '구분', '상태', '거래구분'],
  balance: ['잔액', '거래후잔액', 'balance'],
};

// 헤더 글자 정리: 공백·괄호 안 설명 제거("이용금액(원)" → "이용금액")
const clean = (h) => String(h).normalize('NFKC').replace(/\(.*?\)|\[.*?\]/gu, '').replace(/\s+/gu, '').toLowerCase();

function findColumns(row) {
  const names = row.map(clean);
  const col = {};
  for (const [key, list] of Object.entries(ALIAS)) {
    for (const a of list) { const i = names.indexOf(a); if (i >= 0) { col[key] = i; break; } }
  }
  return col;
}

// 헤더 행 찾기: 날짜 열과 (금액 열 또는 출금/입금 열)이 함께 있는 첫 행(앞 40줄 안)
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const c = findColumns(rows[i]);
    if (c.date != null && (c.amount != null || c.withdraw != null || c.deposit != null)) return { index: i, col: c };
  }
  return null;
}

// "1,234원" "-5,000" "(3,000)" "12,000.00" → 정수. 읽을 수 없으면 null.
export function parseWon(s) {
  let t = String(s ?? '').normalize('NFKC').replace(/[\s₩원,]/gu, '');
  if (t === '') return null;
  let neg = false;
  if (/^\(.*\)$/u.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/^[△▲]/u.test(t)) { neg = true; t = t.slice(1); }
  if (!/^[+-]?\d+(\.0+)?$/u.test(t)) return null;
  const n = Number(t.replace(/\.0+$/u, ''));
  if (!Number.isSafeInteger(n) || Math.abs(n) > 1e12) return null;
  return neg ? -n : n;
}

export function isValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); // 그 달의 마지막 날짜
}

// 2026-11-03 · 2026.11.03 · 2026/11/03 · 20261103 · "2026-11-03 14:22:10" · "11/03"(연도 없음 → year 사용)
export function parseDate(s, year) {
  const t = String(s ?? '').normalize('NFKC').trim();
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/u.exec(t)
    ?? /^(\d{4})(\d{2})(\d{2})(?:[ T]*(\d{2}):?(\d{2}))?$/u.exec(t);
  let y, mo, d, hh, mm;
  if (m) { [, y, mo, d, hh, mm] = m; }
  else {
    m = /^(\d{1,2})[-./](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/u.exec(t);
    if (!m || !year) return null;
    [, mo, d, hh, mm] = m; y = year;
  }
  y = Number(y); mo = Number(mo); d = Number(d);
  if (y < 2000 || y > 2100 || !isValidDate(y, mo, d)) return null;
  const time = hh != null && Number(hh) < 24 && Number(mm) < 60 ? `${String(hh).padStart(2, '0')}:${mm}` : null;
  return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, time };
}

const SUMMARY_ROW = /합계|총계|소계|^total$/iu;
const cleanMerchant = (s) => String(s ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 60);

// 본문: 텍스트 → { transactions, skipped, summaryRows, format }
export function readLedger(text, { year = new Date().getFullYear() } = {}) {
  const rows = parseCSV(text);
  const head = findHeader(rows);
  if (!head) throw new HttpError(400, '거래내역 표를 찾지 못했습니다. 날짜 열과 금액(또는 출금/입금) 열이 있는 CSV인지 확인해 주세요.');
  const { col } = head;
  // 가맹점 열: 별칭 우선순위가 가장 높은 열 하나
  let mCol = null;
  const names = rows[head.index].map(clean);
  for (const a of ALIAS.merchant) { const i = names.indexOf(a); if (i >= 0) { mCol = i; break; } }
  const split = col.withdraw != null || col.deposit != null;
  const bankLike = col.balance != null;

  const transactions = [], skipped = []; let summaryRows = 0;
  for (let r = head.index + 1; r < rows.length; r++) {
    const row = rows[r], line = r + 1;
    if (row.every((c) => c === '')) continue;
    const first = row.find((c) => c !== '') ?? '';
    const when = parseDate(row[col.date], year);
    if (!when) {
      if (SUMMARY_ROW.test(first)) { summaryRows++; continue; }
      skipped.push({ line, reason: '날짜를 읽을 수 없음' }); continue;
    }
    let amount = 0, kind = null;
    const status = col.status != null ? clean(row[col.status] ?? '') : '';
    if (split) {
      const w = col.withdraw != null ? parseWon(row[col.withdraw]) : null;
      const d = col.deposit != null ? parseWon(row[col.deposit]) : null;
      if ((col.withdraw != null && row[col.withdraw] !== '' && w == null) || (col.deposit != null && row[col.deposit] !== '' && d == null)) { skipped.push({ line, reason: '금액을 읽을 수 없음' }); continue; }
      if (w) { amount = Math.abs(w); kind = 'expense'; } else if (d) { amount = Math.abs(d); kind = 'income'; }
      else { skipped.push({ line, reason: '금액이 0원이거나 비어 있음' }); continue; }
    } else {
      const v = parseWon(row[col.amount]);
      if (v == null) { skipped.push({ line, reason: '금액을 읽을 수 없음' }); continue; }
      if (v === 0) { skipped.push({ line, reason: '금액이 0원이거나 비어 있음' }); continue; }
      amount = Math.abs(v);
      if (/^(입금|수입)/u.test(status)) kind = 'income';
      else if (/^(출금|지출)/u.test(status)) kind = 'expense';
      else if (status.includes('취소')) kind = 'refund';
      else if (bankLike) kind = v < 0 ? 'expense' : 'income';
      else kind = v < 0 ? 'refund' : 'expense';
    }
    // 출금·입금 열이 있어도 "취소" 표시가 있으면 환불로 처리(카드 취소는 출금 열에 (-)로 오는 경우도 있음)
    if (kind === 'expense' && split && status.includes('취소')) kind = 'refund';
    const merchant = cleanMerchant(mCol != null ? row[mCol] : '') || '(내용 없음)';
    transactions.push({ date: when.date, time: when.time, merchant, amount, kind, line });
  }
  return { format: split || bankLike ? 'bank' : 'card', transactions, skipped, summaryRows };
}
