// ─────────────────────────────────────────────────────────────────────────────
// csv.mjs — CSV 읽기 (외부 라이브러리 없이)
//
// [왜 직접 만들었나]  카드사·은행 내역 파일은 "따옴표 안의 쉼표", 윗부분의 안내 문구, UTF-8과 CP949(EUC-KR) 혼재 등
//   일반 split(',')로는 깨지는 경우가 많습니다. 필요한 만큼만 안전하게 구현하고 테스트로 고정했습니다.
// [한도]  파일 5MB · 50,000행. 넘으면 거부합니다(메모리·시간 폭주 방지).
// ─────────────────────────────────────────────────────────────────────────────
import { HttpError } from './errors.mjs';

// 한도: 5MB·50,000행. 일반 가계부 파일(수천 행)보다 훨씬 크게 잡았지만, 악의적으로 큰 파일로 서버 메모리를 고갈시키는 것은 막습니다.
export const CSV_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 50000 };

// 바이트 → 문자열. UTF-8을 먼저 엄격하게 시도하고, 깨지면 CP949(EUC-KR)로 해석합니다.
// 한국 카드사 엑셀 "CSV로 저장"은 CP949인 경우가 흔합니다.
export function decodeText(buf) {
  // ① 크기 검사를 가장 먼저: 큰 파일을 문자열로 바꾸기 전에 거부해야 메모리를 아낄 수 있습니다.
  if (buf.length > CSV_LIMITS.maxBytes) throw new HttpError(413, '파일이 너무 큽니다(최대 5MB).');
  let bytes = buf;
  // ② UTF-8 BOM(EF BB BF)은 엑셀이 "UTF-8 CSV"를 저장할 때 붙이는 표식입니다. 그대로 두면 첫 헤더 이름 앞에 보이지 않는 글자가 붙어 열을 못 찾습니다.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3); // UTF-8 BOM
  // ③ 먼저 UTF-8을 "엄격하게"(fatal) 해석합니다. 한 글자라도 규칙에 어긋나면 예외 → CP949로 다시 해석.
  //    (CP949 바이트는 UTF-8 규칙을 거의 항상 위반하므로 이 판별은 실용적으로 정확합니다.)
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('euc-kr').decode(bytes); }
  // 바이너리(엑셀 .xlsx 등)를 CSV로 착각하지 않도록: 널 문자가 있으면 거부
  if (text.includes('\u0000')) throw new HttpError(415, 'CSV(텍스트) 파일이 아닙니다. 엑셀이면 "CSV로 저장"한 파일을 올려 주세요.');
  return text;
}

// 첫 몇 줄에서 가장 많이 나온 구분자를 고릅니다(따옴표 안은 세지 않음).
// 방법: 첫 15줄에서 쉼표·탭·세미콜론이 각각 몇 번 나오는지 센 뒤 가장 많은 것을 구분자로 씁니다.
// 따옴표 안의 쉼표(예: "1,000")는 구분자가 아니므로 세지 않습니다(q 플래그로 따옴표 안/밖을 추적).
function detectDelimiter(text) {
  const head = text.split(/\r?\n/u).slice(0, 15);
  const score = { ',': 0, '\t': 0, ';': 0 };
  for (const line of head) {
    let q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch in score) score[ch]++; }
  }
  return Object.entries(score).sort((a, b) => b[1] - a[1])[0][0];
}

// RFC 4180에 가까운 파서: 따옴표 필드, "" 이스케이프, 필드 안의 줄바꿈, CRLF/LF 모두 처리.
// 한 글자씩 읽는 상태 기계입니다. 상태: q(따옴표 안인가), cur(지금 만드는 칸), row(지금 만드는 줄), rows(완성된 줄들)
//   · 따옴표 밖의 구분자 → 칸 종료    · 따옴표 밖의 줄바꿈 → 줄 종료
//   · 따옴표 안에서는 구분자·줄바꿈도 그냥 글자    · 따옴표 안의 "" → 큰따옴표 글자 하나
// 반환: 모든 칸을 trim한 2차원 문자열 배열.
export function parseCSV(text) {
  const d = detectDelimiter(text);
  const rows = []; let row = [], cur = '', q = false, i = 0, started = false;
  const endRow = () => { // 줄 하나를 마감해 rows에 넣는 도우미
    row.push(cur); cur = '';
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row); // 빈 줄 건너뜀
    row = []; started = false;
    if (rows.length > CSV_LIMITS.maxRows + 40) throw new HttpError(413, `행이 너무 많습니다(최대 ${CSV_LIMITS.maxRows}행).`);
  };
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"' && cur === '') { q = true; started = true; }
    else if (ch === d) { row.push(cur); cur = ''; started = true; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else { cur += ch; started = true; }
    i++;
  }
  if (started || cur !== '' || row.length) endRow();
  return rows.map((r) => r.map((c) => c.trim()));
}
