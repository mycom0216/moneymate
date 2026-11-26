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
//               · "구분/상태" 열이 있으면 그 값(입금·출금·취소)이 부호보다 우선합니다.
//
// [전체 흐름]  readLedger(text)
//     ① parseCSV로 표(2차원 배열)를 만든다
//     ② findHeader로 "헤더 행"과 각 열의 위치를 찾는다(앞쪽 안내 문구는 건너뜀)
//     ③ 헤더 아래 각 행을 거래로 변환한다: 날짜 → 금액 → 종류 → 가맹점
//     ④ 변환 못 한 줄은 skipped에 (줄 번호, 이유)로 모은다
// ─────────────────────────────────────────────────────────────────────────────
import { parseCSV } from './csv.mjs';
import { HttpError } from './errors.mjs';

// 열 이름 별칭 표: 키는 우리가 쓰는 이름, 값은 카드사·은행에서 흔히 쓰는 헤더 이름들.
// 낯선 카드사 파일을 만나면 여기에 이름을 추가하면 됩니다. (목록 앞쪽일수록 우선순위가 높음)
const ALIAS = {
  date: ['거래일시', '거래일자', '거래일', '이용일자', '이용일시', '이용일', '승인일자', '승인일시', '결제일', '일자', '날짜', 'date'],
  merchant: ['이용가맹점', '가맹점명', '가맹점', '사용처', '거래처', '상호', '적요', '거래내용', '기재내용', '내용', '받는분', '보낸분', 'description', 'merchant'],
  amount: ['이용금액', '승인금액', '결제금액', '거래금액', '금액', 'amount'],       // 금액 열이 하나인 형식(주로 카드)
  withdraw: ['출금액', '출금금액', '출금', '지출', '찾으신금액'],                    // 출금/입금 열이 따로 있는 형식(주로 은행)
  deposit: ['입금액', '입금금액', '입금', '수입', '맡기신금액'],
  status: ['승인구분', '취소여부', '구분', '상태', '거래구분'],                      // 승인/취소, 입금/출금 표시 열
  balance: ['잔액', '거래후잔액', 'balance'],                                        // 잔액 열이 있으면 "은행 거래내역"으로 판단
};

// 헤더 글자 정리: 공백·괄호 안 설명 제거("이용금액(원)" → "이용금액"), 소문자화. 별칭과 비교하기 전에 항상 적용합니다.
const clean = (h) => String(h).normalize('NFKC').replace(/\(.*?\)|\[.*?\]/gu, '').replace(/\s+/gu, '').toLowerCase();

// 한 행이 헤더라고 가정하고 각 열의 위치를 찾습니다. 반환 예: { date: 0, merchant: 1, amount: 2 }
function findColumns(row) {
  const names = row.map(clean);
  const col = {};
  for (const [key, list] of Object.entries(ALIAS)) {
    for (const a of list) { const i = names.indexOf(a); if (i >= 0) { col[key] = i; break; } } // 우선순위가 높은 별칭부터 찾아 처음 발견한 것을 사용
  }
  return col;
}

// 헤더 행 찾기: 날짜 열과 (금액 열 또는 출금/입금 열)이 함께 있는 첫 행(앞 40줄 안).
// 카드사 파일은 맨 위에 "조회기간: …", "고객명: …" 같은 안내 문구가 있는 경우가 많아서 첫 줄이 헤더라고 가정하지 않습니다.
export function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const c = findColumns(rows[i]);
    if (c.date != null && (c.amount != null || c.withdraw != null || c.deposit != null)) return { index: i, col: c };
  }
  return null;
}

// "1,234원" "-5,000" "(3,000)" "12,000.00" → 정수. 읽을 수 없으면 null.
// 엄격하게 검사하는 이유: "12.5원"이나 "열두"를 억지로 숫자로 바꾸면 합계가 조용히 틀어집니다. 모르면 거부하고 사용자에게 알립니다.
export function parseWon(s) {
  let t = String(s ?? '').normalize('NFKC').replace(/[\s₩원,]/gu, ''); // 공백·원 표시·천 단위 쉼표 제거
  if (t === '') return null;
  let neg = false;
  if (/^\(.*\)$/u.test(t)) { neg = true; t = t.slice(1, -1); }   // 회계식 음수 "(3,000)"
  if (/^[△▲]/u.test(t)) { neg = true; t = t.slice(1); }          // 일본·한국식 음수 표시 "▲3000"
  if (!/^[+-]?\d+(\.0+)?$/u.test(t)) return null;                // 정수 또는 ".00"으로 끝나는 값만 허용(소수는 거부)
  const n = Number(t.replace(/\.0+$/u, ''));
  if (!Number.isSafeInteger(n) || Math.abs(n) > 1e12) return null; // 자바스크립트가 정확히 표현하는 범위 + 상식 밖의 큰 수 거부
  return neg ? -n : n;
}

// 실제로 존재하는 날짜인가? 그 달의 마지막 날을 구해서 비교하므로 2/30·4/31은 거부하고 윤년 2/29는 허용합니다.
export function isValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); // 그 달의 마지막 날짜
}

// 날짜 문자열 → { date:'YYYY-MM-DD', time:'HH:MM'|null }. 읽을 수 없거나 존재하지 않는 날짜면 null.
// 지원: 2026-11-03 · 2026.11.03 · 2026/11/03 · 20261103 · "2026-11-03 14:22:10" · "11/03"(연도 없음 → year 인자 사용)
export function parseDate(s, year) {
  const t = String(s ?? '').normalize('NFKC').trim();
  // 연도가 있는 형식을 먼저 시도: 구분자(-./) 형식, 구분자 없는 8자리 형식. 뒤에 시각이 붙어도 됨.
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/u.exec(t)
    ?? /^(\d{4})(\d{2})(\d{2})(?:[ T]*(\d{2}):?(\d{2}))?$/u.exec(t);
  let y, mo, d, hh, mm;
  if (m) { [, y, mo, d, hh, mm] = m; }
  else {
    // 연도가 없는 "11/03" 형식: 호출자가 알려 준 연도(기본: 올해)를 씁니다. 연도를 모르면(undefined) 거부합니다.
    m = /^(\d{1,2})[-./](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?$/u.exec(t);
    if (!m || !year) return null;
    [, mo, d, hh, mm] = m; y = year;
  }
  y = Number(y); mo = Number(mo); d = Number(d);
  if (y < 2000 || y > 2100 || !isValidDate(y, mo, d)) return null; // 상식 밖의 연도(예: 0001, 9999)와 없는 날짜 거부
  const time = hh != null && Number(hh) < 24 && Number(mm) < 60 ? `${String(hh).padStart(2, '0')}:${mm}` : null; // 시각이 올바를 때만 채택
  return { date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, time };
}

// 표 맨 아래의 "합계/총계/소계" 줄은 거래가 아니므로 오류가 아니라 "합계 줄"로 따로 센다.
const SUMMARY_ROW = /합계|총계|소계|^total$/iu;

// 가맹점 문자열 정리: 제어문자(화면·DB를 깨뜨릴 수 있음) 제거, 공백 정리, 60자 제한.
const cleanMerchant = (s) => String(s ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 60);

// 본문: 텍스트 → { transactions, skipped, summaryRows, format }
//   transactions: [{ date, time, merchant, amount(정수·양수), kind, line(원본 줄 번호) }]
//   skipped: [{ line, reason }]  — 읽지 못해 제외한 줄(사용자에게 그대로 보여 줌)
//   summaryRows: 합계 줄 개수,  format: 'card' | 'bank'
export function readLedger(text, { year = new Date().getFullYear() } = {}) {
  const rows = parseCSV(text);
  const head = findHeader(rows);
  if (!head) throw new HttpError(400, '거래내역 표를 찾지 못했습니다. 날짜 열과 금액(또는 출금/입금) 열이 있는 CSV인지 확인해 주세요.');
  const { col } = head;
  // 가맹점 열: 별칭 우선순위가 가장 높은 열 하나("이용가맹점"이 "내용"보다 먼저)
  let mCol = null;
  const names = rows[head.index].map(clean);
  for (const a of ALIAS.merchant) { const i = names.indexOf(a); if (i >= 0) { mCol = i; break; } }
  const split = col.withdraw != null || col.deposit != null; // 출금/입금 열이 따로 있는 형식인가
  const bankLike = col.balance != null;                      // 잔액 열이 있으면 은행 거래내역으로 간주(부호 해석이 달라짐)

  const transactions = [], skipped = []; let summaryRows = 0;
  for (let r = head.index + 1; r < rows.length; r++) {
    const row = rows[r], line = r + 1; // line: 사람이 파일을 열어 볼 때의 줄 번호(1부터)
    if (row.every((c) => c === '')) continue; // 완전히 빈 행은 조용히 건너뜀(오류가 아님)
    const first = row.find((c) => c !== '') ?? '';
    // ① 날짜: 읽을 수 없으면 이 줄은 거래가 아닙니다. 합계 줄이면 따로 세고, 아니면 이유와 함께 보고.
    const when = parseDate(row[col.date], year);
    if (!when) {
      if (SUMMARY_ROW.test(first)) { summaryRows++; continue; }
      skipped.push({ line, reason: '날짜를 읽을 수 없음' }); continue;
    }
    // ② 금액·종류 결정
    let amount = 0, kind = null;
    const status = col.status != null ? clean(row[col.status] ?? '') : ''; // "승인/취소/입금/출금" 표시
    if (split) {
      // 출금/입금 열이 따로 있는 형식: 값이 있는 쪽이 방향을 결정. 둘 다 비면 거래가 아님.
      const w = col.withdraw != null ? parseWon(row[col.withdraw]) : null;
      const d = col.deposit != null ? parseWon(row[col.deposit]) : null;
      // 칸에 뭔가 적혀 있는데 숫자로 못 읽으면(예: "열두") 조용히 0원 처리하지 않고 오류로 보고
      if ((col.withdraw != null && row[col.withdraw] !== '' && w == null) || (col.deposit != null && row[col.deposit] !== '' && d == null)) { skipped.push({ line, reason: '금액을 읽을 수 없음' }); continue; }
      if (w) { amount = Math.abs(w); kind = 'expense'; } else if (d) { amount = Math.abs(d); kind = 'income'; }
      else { skipped.push({ line, reason: '금액이 0원이거나 비어 있음' }); continue; }
    } else {
      // 금액 열 하나인 형식: 부호와 "구분" 열로 방향을 판단
      const v = parseWon(row[col.amount]);
      if (v == null) { skipped.push({ line, reason: '금액을 읽을 수 없음' }); continue; }
      if (v === 0) { skipped.push({ line, reason: '금액이 0원이거나 비어 있음' }); continue; }
      amount = Math.abs(v); // DB에는 항상 양수로 저장하고, 방향은 kind로 표현
      if (/^(입금|수입)/u.test(status)) kind = 'income';        // 구분 열의 명시적 표시가 가장 우선
      else if (/^(출금|지출)/u.test(status)) kind = 'expense';
      else if (status.includes('취소')) kind = 'refund';
      else if (bankLike) kind = v < 0 ? 'expense' : 'income';    // 은행: (-)=출금, (+)=입금
      else kind = v < 0 ? 'refund' : 'expense';                  // 카드: (+)=사용, (-)=취소
    }
    // 출금·입금 열이 있어도 "취소" 표시가 있으면 환불로 처리(카드 취소는 출금 열에 (-)로 오는 경우도 있음)
    if (kind === 'expense' && split && status.includes('취소')) kind = 'refund';
    // ③ 가맹점: 비어 있으면 대체 문구(나중에 사용자가 분류를 고칠 수 있도록 거래 자체는 남김)
    const merchant = cleanMerchant(mCol != null ? row[mCol] : '') || '(내용 없음)';
    transactions.push({ date: when.date, time: when.time, merchant, amount, kind, line });
  }
  return { format: split || bankLike ? 'bank' : 'card', transactions, skipped, summaryRows };
}
