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

const list = (a) => a.map((c) => `'${c}'`).join(',');

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

const toTx = (r) => ({ id: r.tx_id, date: r.tx_date, time: r.tx_time, merchant: r.merchant, norm: r.merchant_norm, amount: r.amount, kind: r.kind, category: r.category, catMethod: r.cat_method, importId: r.import_id });
const now = () => new Date().toISOString();

export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  #tx(fn) { // 전부 성공하거나 전부 취소
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  ensureUser(userId) { this.db.prepare('INSERT OR IGNORE INTO users(user_id, created_at) VALUES (?, ?)').run(userId, now()); }

  // 가져오기 한 번 = 파일 1개. rows: 분류까지 끝난 거래 배열(dedupeKey 포함). 새로 들어간 건수와 중복 건수를 돌려줍니다.
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

  imports(userId) {
    return this.db.prepare('SELECT * FROM imports WHERE user_id = ? ORDER BY import_id DESC').all(userId)
      .map((r) => ({ id: r.import_id, filename: r.filename, format: r.format, added: r.rows_added, duplicates: r.rows_duplicate, skipped: r.rows_skipped, createdAt: r.created_at }));
  }
  deleteImport(userId, importId) { return Number(this.db.prepare('DELETE FROM imports WHERE user_id = ? AND import_id = ?').run(userId, importId).changes) > 0; }

  // 분석에 쓰는 전체 거래(오래된 순)
  allTransactions(userId) { return this.db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY tx_date, tx_time, tx_id').all(userId).map(toTx); }

  listTransactions(userId, { month, category, q, limit = 200, offset = 0 } = {}) {
    const where = ['user_id = ?'], args = [userId];
    if (month) { where.push('substr(tx_date,1,7) = ?'); args.push(month); }
    if (category) { where.push('category = ?'); args.push(category); }
    if (q) { where.push("merchant LIKE ? ESCAPE '\\'"); args.push(`%${String(q).replace(/[\\%_]/gu, '\\$&')}%`); }
    const total = this.db.prepare(`SELECT COUNT(*) n FROM transactions WHERE ${where.join(' AND ')}`).get(...args).n;
    const rows = this.db.prepare(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY tx_date DESC, tx_time DESC, tx_id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(toTx);
    return { total, rows };
  }
  getTransaction(userId, txId) { const r = this.db.prepare('SELECT * FROM transactions WHERE user_id = ? AND tx_id = ?').get(userId, txId); return r ? toTx(r) : null; }

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
  applyAi(userId, suggestions) {
    return this.#tx(() => {
      let updated = 0;
      const st = this.db.prepare("UPDATE transactions SET category = ?, cat_method = 'ai' WHERE user_id = ? AND merchant_norm = ? AND cat_method = 'none' AND kind <> 'income'");
      for (const s of suggestions) updated += Number(st.run(s.category, userId, s.norm).changes);
      return updated;
    });
  }

  budgets(userId) { return this.db.prepare('SELECT category, monthly_limit limit_amount FROM budgets WHERE user_id = ? ORDER BY category').all(userId).map((r) => ({ category: r.category, limit: r.limit_amount })); }
  setBudget(userId, category, limit) {
    this.ensureUser(userId);
    if (limit == null) return Number(this.db.prepare('DELETE FROM budgets WHERE user_id = ? AND category = ?').run(userId, category).changes) > 0;
    this.db.prepare('INSERT INTO budgets(user_id, category, monthly_limit) VALUES (?,?,?) ON CONFLICT(user_id, category) DO UPDATE SET monthly_limit = excluded.monthly_limit').run(userId, category, limit);
    return true;
  }

  dismissed(userId) { return new Set(this.db.prepare('SELECT alert_key FROM dismissals WHERE user_id = ?').all(userId).map((r) => r.alert_key)); }
  dismiss(userId, key) { this.ensureUser(userId); this.db.prepare('INSERT OR IGNORE INTO dismissals(user_id, alert_key) VALUES (?,?)').run(userId, key); }
  restoreDismissed(userId) { return Number(this.db.prepare('DELETE FROM dismissals WHERE user_id = ?').run(userId).changes); }

  deleteUser(userId) { return Number(this.db.prepare('DELETE FROM users WHERE user_id = ?').run(userId).changes); }
  stats() {
    const n = (sql) => this.db.prepare(sql).get().n;
    return {
      users: n('SELECT COUNT(*) n FROM users'), imports: n('SELECT COUNT(*) n FROM imports'), transactions: n('SELECT COUNT(*) n FROM transactions'),
      byMethod: Object.fromEntries(this.db.prepare("SELECT cat_method m, COUNT(*) n FROM transactions WHERE kind <> 'income' GROUP BY cat_method").all().map((r) => [r.m, r.n])),
    };
  }
}
