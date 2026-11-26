// ─────────────────────────────────────────────────────────────────────────────
// http.mjs — HTTP API와 정적 파일 서빙 (프레임워크 없이 Node 기본 http만 사용)
//
// [엔드포인트]
//   GET  /api/status               서버·AI 상태, 카테고리 목록, 한도
//   GET  /api/sample               시연용 샘플 CSV
//   POST /api/llm/reconnect        AI(Ollama 등) 다시 연결
//   POST /api/import               CSV 파일(바이너리 본문) 가져오기 → 건수·제외된 줄
//   GET  /api/report               월별 리포트(요약·경고·정기결제·예산)
//   GET  /api/transactions         거래 목록(월·카테고리·검색)
//   POST /api/transactions/category 분류 고치기(가맹점 규칙으로 기억)
//   POST /api/classify/ai          분류되지 않은 가맹점에 AI 제안 받기
//   POST /api/budgets              카테고리 예산 설정/삭제
//   POST /api/alerts/dismiss       경고 숨기기 / POST /api/alerts/restore 숨긴 경고 되돌리기
//   POST /api/imports/delete       가져온 파일 한 번 삭제(거래 함께 삭제)
//   GET  /api/export               월 리포트 내려받기(.md)
//   POST /api/forget               내 기록 전부 삭제(confirm 필요, 복구 불가)
//   GET  /api/stats                운영 지표
//
// [보안 장치]
//   1) 본문 크기 제한(413): JSON 작게, CSV 5MB   2) userId 형식 검사 + 모든 조회에 소유자 조건(IDOR 방지, 남의 것은 404)
//   3) 사용자당 호출 간격 제한(429)   4) 정적 파일 경로 이탈(../) 차단   5) 보안 헤더(CSP 등)
//   6) 내부 오류는 일반 문구만 노출   7) 127.0.0.1 바인딩 기본값(로그인이 없으므로 외부 공개 금지)
//   8) 화면은 DOM으로만 출력(textContent) → 가맹점 이름에 HTML이 들어 있어도 실행되지 않음
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './app.mjs';
import { HttpError } from './errors.mjs';
import { CSV_LIMITS } from './csv.mjs';
import { CATEGORIES, EXPENSE_CATEGORIES } from './merchant.mjs';

// 정적 파일 확장자 → 응답 Content-Type. 목록에 없는 확장자는 일반 바이너리로 보냅니다.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

// CSP: 우리 서버의 스크립트·스타일만 실행(외부 스크립트·삽입 차단)
const SECURITY = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'permissions-policy': 'microphone=(), camera=(), geolocation=()',
};

// JSON 응답 도우미: 상태 코드·본문을 보내고, 캐시 금지(no-store)와 보안 헤더를 항상 붙입니다.
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(body));
};

// 본문 읽기: 한도를 넘으면 끝까지 읽어 버리고 413(바로 끊으면 브라우저가 오류 내용을 못 받음)
// 본문을 바이트 그대로 읽습니다(CSV 업로드용). size가 limit을 넘으면 tooBig만 표시하고 끝까지 읽어 버린 뒤 413을 냅니다.
const readRaw = (req, limit) => new Promise((resolve, reject) => {
  let size = 0, tooBig = false; const parts = [];
  req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else if (!tooBig) parts.push(c); });
  req.on('end', () => (tooBig ? reject(new HttpError(413, '요청이 너무 큽니다.')) : resolve(Buffer.concat(parts))));
  req.on('error', () => reject(new HttpError(400, '요청을 읽을 수 없습니다.')));
});
// JSON 본문 읽기: 크기 제한 후 파싱하고, 객체({})가 아니면(배열·숫자·깨진 JSON) 400.
const readBody = async (req, limit) => {
  const buf = await readRaw(req, limit);
  try {
    const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object');
    return body;
  } catch { throw new HttpError(400, '요청 본문은 JSON 객체여야 합니다.'); }
};

// 사용자 ID 형식: 영문·숫자·_- 6~64자. 형식을 엄격히 제한해 DB 조회·로그에 이상한 값이 섞이지 않게 합니다.
const USER_ID = /^[\w-]{6,64}$/u;
// 요청 값에서 userId를 꺼내 검증합니다(형식이 틀리면 400).
const userOf = (v) => { const id = String(v ?? ''); if (!USER_ID.test(id)) throw new HttpError(400, 'userId가 필요합니다.'); return id; };
// 0 이상의 정수만 허용(소수·음수·문자 거부). txId·importId·offset 같은 번호 값에 씁니다.
const intOf = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} 값이 올바르지 않습니다.`); return n; };
// 월 값 검증: 비어 있으면 null(= 최근 달), 'YYYY-MM' 형식(1~12월)이 아니면 400.
const monthOf = (v) => { if (v == null || v === '') return null; if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(String(v))) throw new HttpError(400, '월은 YYYY-MM 형식이어야 합니다.'); return String(v); };
// 카테고리 값 검증: 정해진 목록 안의 값만 허용.
const catOf = (v) => { const c = String(v ?? ''); if (!CATEGORIES.includes(c)) throw new HttpError(400, '카테고리가 올바르지 않습니다.'); return c; };

// createHandler: HTTP 요청을 처리하는 함수를 만듭니다. svc는 app.mjs의 서비스 객체.
//   minGapMs: 같은 사용자의 연속 요청 최소 간격(테스트에서는 0으로 줄임).
export function createHandler(svc, { sampleFile = join(ROOT, 'samples', 'sample_card.csv'), minGapMs = 700 } = {}) {
  // 호출 간격 제한(throttle)의 기록장: 키(사용자 등) → 마지막 호출 시각.
  const lastCall = new Map();
  // 너무 빠른 연속 호출이면 429를 던집니다. 기록이 5000개를 넘으면 비워서 메모리가 무한히 늘지 않게 합니다.
  const throttle = (key, gap = minGapMs) => {
    const t = Date.now(), prev = lastCall.get(key) ?? 0;
    if (t - prev < gap) throw new HttpError(429, '요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.');
    lastCall.set(key, t);
    if (lastCall.size > 5000) lastCall.clear();
  };

  // API 라우터: 메서드(GET/POST)와 경로로 분기합니다. 처리되지 않은 경로는 맨 끝에서 404.
  // 모든 라우트 공통 규칙: ① userId 검증 ② 입력 검증 ③ 서비스 호출 ④ JSON 응답.
  async function api(req, res, url) {
    const m = req.method, p = url.pathname, q = url.searchParams;

    // [상태] AI 연결 상태·카테고리 목록·한도(화면이 시작할 때 호출)
    if (m === 'GET' && p === '/api/status') {
      await svc.llm.ensure?.();
      return json(res, 200, {
        llm: svc.llm.label, llmProvider: svc.llm.available ? svc.llm.provider : null, llmError: svc.llm.lastError,
        categories: EXPENSE_CATEGORIES, limits: { csvMB: CSV_LIMITS.maxBytes / 1048576, rows: CSV_LIMITS.maxRows },
      });
    }
    // [AI 다시 연결] Ollama를 나중에 켰을 때 서버 재시작 없이 연결(남용 방지로 간격 제한)
    if (m === 'POST' && p === '/api/llm/reconnect') {
      throttle('llm-reconnect');
      await svc.llm.ensure({ force: true });
      return json(res, 200, { llm: svc.llm.label, llmProvider: svc.llm.available ? svc.llm.provider : null, llmError: svc.llm.lastError });
    }
    // [샘플] 체험용 가상 CSV 내용을 돌려줍니다(파일이 없으면 빈 문자열).
    if (m === 'GET' && p === '/api/sample') {
      return json(res, 200, { filename: 'sample_card.csv', csv: existsSync(sampleFile) ? readFileSync(sampleFile, 'utf8') : '' });
    }
    // [지표] 숫자 통계만(개인 내용 없음)
    if (m === 'GET' && p === '/api/stats') return json(res, 200, svc.store.stats());

    // [가져오기] CSV 파일을 "바이너리 본문"으로 받습니다(JSON/base64로 감싸면 크기가 1.33배가 되고 메모리를 더 씀). 크기 상한 5MB.
    if (m === 'POST' && p === '/api/import') {
      const userId = userOf(q.get('userId')); throttle(userId);
      const bytes = await readRaw(req, CSV_LIMITS.maxBytes);
      return json(res, 200, svc.importCsv(userId, { filename: q.get('filename'), bytes }));
    }
    // [월 리포트] 요약·경고·정기결제·예산을 한 번에
    if (m === 'GET' && p === '/api/report') return json(res, 200, svc.report(userOf(q.get('userId')), monthOf(q.get('month'))));
    // [거래 목록] 월·카테고리·검색어 필터, 한 번에 최대 200건
    if (m === 'GET' && p === '/api/transactions') {
      const category = q.get('category') ? catOf(q.get('category')) : null;
      return json(res, 200, svc.store.listTransactions(userOf(q.get('userId')), { month: monthOf(q.get('month')), category, q: String(q.get('q') ?? '').slice(0, 60), limit: 200, offset: intOf(q.get('offset') ?? 0, 'offset') }));
    }
    // [분류 고치기] remember가 false가 아니면 같은 가맹점 전체에 적용하고 규칙으로 기억
    if (m === 'POST' && p === '/api/transactions/category') {
      const b = await readBody(req, 1000);
      return json(res, 200, svc.setCategory(userOf(b.userId), intOf(b.txId, 'txId'), String(b.category ?? ''), b.remember !== false));
    }
    // [AI 분류 제안] 오래 걸리고 자원을 쓰므로 호출 간격을 더 길게(minGapMs×4) 제한
    if (m === 'POST' && p === '/api/classify/ai') {
      const b = await readBody(req, 1000);
      const userId = userOf(b.userId); throttle(`ai-${userId}`, minGapMs * 4);
      return json(res, 200, await svc.classifyAi(userId));
    }
    // [예산] limit이 null/빈 값이면 삭제, 아니면 숫자로 변환해 서비스가 범위(1원~100억 정수)를 검증
    if (m === 'POST' && p === '/api/budgets') {
      const b = await readBody(req, 1000);
      const limit = b.limit === null || b.limit === '' ? null : Number(b.limit);
      return json(res, 200, svc.setBudget(userOf(b.userId), String(b.category ?? ''), limit));
    }
    // [경고 숨기기] 키는 내용 기반 문자열(유형:가맹점:날짜:금액), 200자 제한
    if (m === 'POST' && p === '/api/alerts/dismiss') {
      const b = await readBody(req, 1000);
      const key = String(b.key ?? '');
      if (!key || key.length > 200) throw new HttpError(400, 'key가 올바르지 않습니다.');
      svc.store.dismiss(userOf(b.userId), key);
      return json(res, 200, { ok: true });
    }
    // [숨긴 경고 되돌리기]
    if (m === 'POST' && p === '/api/alerts/restore') {
      const b = await readBody(req, 1000);
      return json(res, 200, { restored: svc.store.restoreDismissed(userOf(b.userId)) });
    }
    // [가져온 파일 삭제] 내 것이 아니면 404(존재 여부도 알려 주지 않음)
    if (m === 'POST' && p === '/api/imports/delete') {
      const b = await readBody(req, 1000);
      if (!svc.store.deleteImport(userOf(b.userId), intOf(b.importId, 'importId'))) throw new HttpError(404, '가져온 기록을 찾을 수 없습니다.');
      return json(res, 200, { ok: true });
    }
    // [월 리포트 내려받기] 마크다운 파일로 응답(content-disposition: attachment)
    if (m === 'GET' && p === '/api/export') {
      const month = monthOf(q.get('month'));
      const md = svc.exportMarkdown(userOf(q.get('userId')), month);
      if (md == null) throw new HttpError(404, '내보낼 거래가 없습니다.');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="moneymate-${month ?? 'latest'}.md"`, ...SECURITY });
      return res.end(md);
    }
    // [내 기록 모두 삭제] 되돌릴 수 없으므로 confirm:true를 명시적으로 요구(실수 방지)
    if (m === 'POST' && p === '/api/forget') {
      const b = await readBody(req, 1000);
      const userId = userOf(b.userId);
      if (b.confirm !== true) throw new HttpError(400, '삭제하려면 confirm: true 가 필요합니다. 삭제한 기록은 복구할 수 없습니다.');
      return json(res, 200, { ok: true, deleted: svc.store.deleteUser(userId) });
    }
    // 위 어디에도 해당하지 않으면 없는 API
    throw new HttpError(404, '찾을 수 없는 API입니다.');
  }

  // 정적 파일(화면) 제공. 경로 이탈 방어: 요청 경로를 public/ 폴더 안으로 정규화한 뒤, 그 폴더 밖이면 404.
  // 예) /../server.mjs 나 /%2e%2e/ 같은 요청이 와도 public 밖의 파일은 절대 읽히지 않습니다.
  function serveStatic(req, res, url) {
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, '주소 형식이 올바르지 않습니다.'); }
    const rel = url.pathname === '/' ? 'index.html' : decoded.replace(/^[/\\]+/u, '');
    const root = join(ROOT, 'public');
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY }); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY });
    res.end(readFileSync(file));
  }

  // 최종 요청 처리기: /api/ 로 시작하면 api(), 아니면 정적 파일. 업무 오류(HttpError)는 해당 상태 코드로,
  // 예상 못 한 오류는 서버 로그에만 남기고 사용자에게는 일반 문구만 보냅니다(내부 정보 노출 방지).
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청입니다.');
      return serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error('[error]', e);
      return json(res, 500, { error: '서버 내부 오류가 발생했습니다.' });
    }
  };
}
