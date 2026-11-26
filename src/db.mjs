// ─────────────────────────────────────────────────────────────────────────────
// db.mjs — 데이터 저장소(SQLite). 데이터정의서·ERD 문서의 실제 구현체입니다.
//
// [테이블 6개]
//   users ─1:N─ imports (가져온 파일 한 번) ─1:N─ transactions (거래)
//   users ─1:N─ merchant_rules (사용자가 고친 가맹점 분류) · budgets (카테고리별 월 예산) · dismissals (숨긴 경고)
//
// [설계 포인트]
//   · transactions UNIQUE(user_id, dedupe_key): 같은 파일을 다시 올려도 거래가 두 번 쌓이지 않습니다.
//   · CHECK: 금액은 양수, 종류·분류 방법·카테고리는 정해진 값만, "수입 종류 ⇔ 수입 카테고리"를 DB가 강제합니다.
//   · 모든 사용자 데이터가 users ON DELETE CASCADE → "내 기록 모두 삭제"가 한 문장.
//   · 모든 조회·수정 함수가 userId를 함께 받아 "내 것만" 접근합니다(IDOR 방지).
//   · 원본 CSV 파일은 저장하지 않습니다. 정리된 거래(날짜·가맹점·금액)만 남습니다.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { CATEGORIES, EXPENSE_CATEGORIES } from './merchant.mjs';

// SQL의 CHECK (category IN (...)) 안에 넣을 목록 문자열을 만듭니다: ['식비','카페'] → "'식비','카페'"
// 카테고리 목록을 merchant.mjs 한 곳에서만 관리하고 DB 제약에도 그대로 재사용하려는 목적입니다.
const list = (a) => a.map((c) => `'${c}'`).join(',');

// 테이블 정의(SQL). 앱이 시작될 때마다 실행되며, IF NOT EXISTS 덕분에 이미 있으면 아무 일도 하지 않습니다.
// 규칙(CHECK·UNIQUE·FOREIGN KEY)을 앱 코드가 아니라 DB가 직접 지키게 해서, 코드에 버그가 있어도 잘못된 데이터는 저장되지 않습니다.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS imports (
  import_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  filename TEXT NOT NULL, format TEXT NOT NULL CHECK (format IN ('card','bank')),
  rows_added INTEGER NOT NULL, rows_duplicate INTEGER NOT NULL, rows_skipped INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  tx_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  import_id INTEGER NOT NULL REFERENCES imports(import_id) ON DELETE CASCADE,
  tx_date TEXT NOT NULL CHECK (tx_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  tx_time TEXT,
  merchant TEXT NOT NULL, merchant_norm TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  kind TEXT NOT NULL CHECK (kind IN ('expense','income','refund')),
  category TEXT NOT NULL CHECK (category IN (${list(CATEGORIES)})),
  cat_method TEXT NOT NULL CHECK (cat_method IN ('rule','user','ai','none')),
  dedupe_key TEXT NOT NULL,
  CHECK ((kind = 'income') = (category = '수입')),
  UNIQUE (user_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS merchant_rules (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  merchant_norm TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (${list(EXPENSE_CATEGORIES)})),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, merchant_norm)
);
CREATE TABLE IF NOT EXISTS budgets (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (${list(EXPENSE_CATEGORIES)})),
  monthly_limit INTEGER NOT NULL CHECK (monthly_limit > 0),
  PRIMARY KEY (user_id, category)
);
CREATE TABLE IF NOT EXISTS dismissals (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  alert_key TEXT NOT NULL,
  PRIMARY KEY (user_id, alert_key)
);
CREATE INDEX IF NOT EXISTS ix_tx_user_date ON transactions(user_id, tx_date);
CREATE INDEX IF NOT EXISTS ix_tx_user_norm ON transactions(user_id, merchant_norm);
`;

// DB 행(snake_case 컬럼) → 분석 코드가 쓰는 거래 객체(camelCase)로 바꿉니다. analyze.mjs는 DB 컬럼 이름을 몰라도 됩니다.
const toTx = (r) => ({ id: r.tx_id, date: r.tx_date, time: r.tx_time, merchant: r.merchant, norm: r.merchant_norm, amount: r.amount, kind: r.kind, category: r.category, catMethod: r.cat_method, importId: r.import_id });
// 지금 시각(ISO 8601 문자열). created_at 컬럼에 기록합니다.
const now = () => new Date().toISOString();

// Store: 모든 DB 접근을 한 곳에 모은 클래스. 다른 파일은 SQL을 직접 쓰지 않고 이 클래스의 메서드만 호출합니다.
// 모든 메서드가 userId를 받아 "내 데이터만" 조회·수정합니다(남의 데이터는 없는 것처럼 취급 = IDOR 방지).
export class Store {
  // path: DB 파일 경로. ':memory:'면 메모리 DB(테스트용, 프로그램이 끝나면 사라짐).
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    // foreign_keys: 외래키·CASCADE 삭제를 켭니다(SQLite는 기본이 꺼져 있을 수 있음). WAL: 읽기와 쓰기가 서로 덜 막히는 저널 방식.
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }
  // DB 연결을 닫습니다(테스트 정리용).
  close() { this.db.close(); }

  // 트랜잭션 도우미: fn 안의 모든 DB 작업을 "전부 성공하거나 전부 취소"합니다.
  // 예) 가져오기 도중 오류가 나면 이미 넣은 거래까지 모두 되돌려, 파일이 반쪽만 저장되는 일을 막습니다.
  #tx(fn) { // 전부 성공하거나 전부 취소
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  // 사용자 행이 없으면 만듭니다(OR IGNORE: 이미 있으면 무시). 다른 표가 users를 외래키로 참조하므로 먼저 있어야 합니다.
  ensureUser(userId) { this.db.prepare('INSERT OR IGNORE INTO users(user_id, created_at) VALUES (?, ?)').run(userId, now()); }

  // 가져오기 한 번 = 파일 1개. rows: 분류까지 끝난 거래 배열(dedupeKey 포함). 새로 들어간 건수와 중복 건수를 돌려줍니다.
  // 사용 흐름: ① 사용자 보장 ② imports 행 생성(건수는 일단 0) ③ 거래를 한 건씩 INSERT OR IGNORE
  //   ④ 실제로 들어간 건수(changes)를 세어 imports 행에 기록. 중복은 UNIQUE 제약 때문에 조용히 무시되고 건수에서 빠집니다.
  addImport(userId, { filename, format, rows, skipped }) {
    return this.#tx(() => {
      this.ensureUser(userId);
      const imp = this.db.prepare('INSERT INTO imports(user_id, filename, format, rows_added, rows_duplicate, rows_skipped, created_at) VALUES (?,?,?,0,0,?,?)')
        .run(userId, filename, format, skipped, now());
      const importId = Number(imp.lastInsertRowid);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO transactions(user_id, import_id, tx_date, tx_time, merchant, merchant_norm, amount, kind, category, cat_method, dedupe_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      let added = 0;
      for (const r of rows) added += Number(ins.run(userId, importId, r.date, r.time, r.merchant, r.norm, r.amount, r.kind, r.category, r.catMethod, r.dedupeKey).changes);
      const duplicates = rows.length - added;
      this.db.prepare('UPDATE imports SET rows_added = ?, rows_duplicate = ? WHERE import_id = ?').run(added, duplicates, importId);
      return { importId, added, duplicates };
    });
  }

  // 가져온 파일 목록(최신순). 화면의 "가져온 파일" 영역에 표시됩니다.
  imports(userId) {
    return this.db.prepare('SELECT * FROM imports WHERE user_id = ? ORDER BY import_id DESC').all(userId)
      .map((r) => ({ id: r.import_id, filename: r.filename, format: r.format, added: r.rows_added, duplicates: r.rows_duplicate, skipped: r.rows_skipped, createdAt: r.created_at }));
  }
  // 가져온 파일 하나를 삭제합니다. 그 파일의 거래는 ON DELETE CASCADE로 함께 지워집니다. 내 것이 아니면 false(→ 404).
  deleteImport(userId, importId) { return Number(this.db.prepare('DELETE FROM imports WHERE user_id = ? AND import_id = ?').run(userId, importId).changes) > 0; }

  // 분석에 쓰는 전체 거래(오래된 순)
  // 분석(요약·이상 탐지)에 쓰는 이 사용자의 전체 거래(오래된 순). 비교 기준(중앙값 등)을 계산하려면 모든 달이 필요합니다.
  allTransactions(userId) { return this.db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY tx_date, tx_time, tx_id').all(userId).map(toTx); }

  // 거래 목록 화면용 조회. 월·카테고리·가맹점 검색을 선택적으로 조합하고 페이지(limit/offset)를 지원합니다.
  // 검색어의 % _ \ 는 LIKE의 특수문자라 이스케이프해서 "글자 그대로" 찾습니다(사용자가 %를 입력해도 전체 검색이 되지 않게).
  listTransactions(userId, { month, category, q, limit = 200, offset = 0 } = {}) {
    const where = ['user_id = ?'], args = [userId];
    if (month) { where.push('substr(tx_date,1,7) = ?'); args.push(month); }
    if (category) { where.push('category = ?'); args.push(category); }
    if (q) { where.push("merchant LIKE ? ESCAPE '\\'"); args.push(`%${String(q).replace(/[\\%_]/gu, '\\$&')}%`); }
    const total = this.db.prepare(`SELECT COUNT(*) n FROM transactions WHERE ${where.join(' AND ')}`).get(...args).n;
    const rows = this.db.prepare(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY tx_date DESC, tx_time DESC, tx_id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toTx);
    return { total, rows };
  }
  // 거래 한 건 조회. user_id 조건이 함께 걸려 있어 남의 거래는 null이 됩니다.
  getTransaction(userId, txId) { const r = this.db.prepare('SELECT * FROM transactions WHERE user_id = ? AND tx_id = ?').get(userId, txId); return r ? toTx(r) : null; }

  // 이 사용자가 고친 분류 규칙을 Map(가맹점 키 → 카테고리)으로 돌려줍니다. 가져오기 때 classify()에 전달됩니다.
  rules(userId) { return new Map(this.db.prepare('SELECT merchant_norm, category FROM merchant_rules WHERE user_id = ?').all(userId).map((r) => [r.merchant_norm, r.category])); }

  // 분류 고치기. remember=true면 "이 가맹점은 앞으로 항상 이 카테고리" 규칙으로 저장하고 같은 가맹점의 모든 거래에 적용.
  setCategory(userId, txId, category, remember = true) {
    return this.#tx(() => {
      const t = this.getTransaction(userId, txId);
      if (!t || t.kind === 'income') return null;
      if (remember) {
        this.db.prepare('INSERT INTO merchant_rules(user_id, merchant_norm, category, created_at) VALUES (?,?,?,?) ON CONFLICT(user_id, merchant_norm) DO UPDATE SET category = excluded.category')
          .run(userId, t.norm, category, now());
        const r = this.db.prepare("UPDATE transactions SET category = ?, cat_method = 'user' WHERE user_id = ? AND merchant_norm = ? AND kind <> 'income'").run(category, userId, t.norm);
        return { updated: Number(r.changes) };
      }
      this.db.prepare("UPDATE transactions SET category = ?, cat_method = 'user' WHERE user_id = ? AND tx_id = ?").run(category, userId, txId);
      return { updated: 1 };
    });
  }

  // AI 제안을 걸러서 받아야 할 "분류되지 않은 가맹점" (금액은 포함하지 않음: AI에게 돈 정보를 보내지 않기 위함)
  unknownMerchants(userId, limit = 20) {
    return this.db.prepare("SELECT merchant_norm norm, MIN(merchant) merchant, COUNT(*) n FROM transactions WHERE user_id = ? AND cat_method = 'none' AND kind <> 'income' GROUP BY merchant_norm ORDER BY n DESC LIMIT ?").all(userId, limit);
  }
  // 검증을 통과한 AI 제안을 저장합니다. 조건 cat_method='none' 덕분에 사람이 이미 고친 분류(user)나 규칙 분류(rule)는 덮어쓰지 않습니다.
  // 반환: 갱신된 거래 수.
  applyAi(userId, suggestions) {
    return this.#tx(() => {
      let updated = 0;
      const st = this.db.prepare("UPDATE transactions SET category = ?, cat_method = 'ai' WHERE user_id = ? AND merchant_norm = ? AND cat_method = 'none' AND kind <> 'income'");
      for (const s of suggestions) updated += Number(st.run(s.category, userId, s.norm).changes);
      return updated;
    });
  }

  // 이 사용자의 카테고리별 월 예산 목록.
  budgets(userId) { return this.db.prepare('SELECT category, monthly_limit limit_amount FROM budgets WHERE user_id = ? ORDER BY category').all(userId).map((r) => ({ category: r.category, limit: r.limit_amount })); }
  // 예산 저장(upsert: 있으면 금액 갱신, 없으면 추가). limit이 null이면 삭제합니다.
  setBudget(userId, category, limit) {
    this.ensureUser(userId);
    if (limit == null) return Number(this.db.prepare('DELETE FROM budgets WHERE user_id = ? AND category = ?').run(userId, category).changes) > 0;
    this.db.prepare('INSERT INTO budgets(user_id, category, monthly_limit) VALUES (?,?,?) ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit').run(userId, category, limit);
    return true;
  }

  // 사용자가 "정상이에요"로 숨긴 경고 키 집합. report()에서 경고 목록을 걸러낼 때 사용합니다.
  dismissed(userId) { return new Set(this.db.prepare('SELECT alert_key FROM dismissals WHERE user_id = ?').all(userId).map((r) => r.alert_key)); }
  // 경고 하나를 숨김 처리(이미 숨겼으면 무시).
  dismiss(userId, key) { this.ensureUser(userId); this.db.prepare('INSERT OR IGNORE INTO dismissals(user_id, alert_key) VALUES (?,?)').run(userId, key); }
  // 숨긴 경고를 모두 되돌립니다. 반환: 되돌린 개수.
  restoreDismissed(userId) { return Number(this.db.prepare('DELETE FROM dismissals WHERE user_id = ?').run(userId).changes); }

  // 사용자 삭제 = 「내 기록 모두 삭제」. users 한 행을 지우면 CASCADE로 거래·규칙·예산·숨김까지 전부 지워집니다.
  deleteUser(userId) { return Number(this.db.prepare('DELETE FROM users WHERE user_id = ?').run(userId).changes); }
  // 운영 지표(사용자·가져오기·거래 수, 분류 방법별 건수). 개인 내용 없이 숫자만 반환합니다.
  stats() {
    const n = (sql) => this.db.prepare(sql).get().n;
    return {
      users: n('SELECT COUNT(*) n FROM users'), imports: n('SELECT COUNT(*) n FROM imports'), transactions: n('SELECT COUNT(*) n FROM transactions'),
      byMethod: Object.fromEntries(this.db.prepare("SELECT cat_method m, COUNT(*) n FROM transactions WHERE kind <> 'income' GROUP BY cat_method").all().map((r) => [r.m, r.n])),
    };
  }
}
