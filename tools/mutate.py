# 변이 검사: 핵심 로직을 일부러 망가뜨리고 테스트가 잡아내는지 확인합니다(끝나면 원래대로 복구).
import subprocess, re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
# 각 항목: (파일, 원래 코드 조각, 망가뜨린 코드 조각, 설명). 원래 조각을 찾아 한 번만 바꾸고 테스트를 돌립니다.
# 테스트가 하나라도 실패하면 "검출"(테스트가 그 결함을 잡는다는 뜻), 모두 통과하면 "미검출"(테스트가 약하다는 뜻 → 테스트 보강 필요).
M = [
 ('src/analyze.mjs', "if (Math.max(...mins) - Math.min(...mins) > 10) continue;", "", '중복 결제의 시각 간격 검사 제거'),
 ('src/db.mjs', "SELECT * FROM transactions WHERE user_id = ? AND tx_id = ?", "SELECT * FROM transactions WHERE ? IS NOT NULL AND tx_id = ?", '거래 조회의 소유자 조건 제거'),
 ('src/app.mjs', "`${base}|${n}`", "`${base}`", '같은 파일 안 순번(dedupe) 제거'),
 ('src/ai.mjs', "!EXPENSE_CATEGORIES.includes(category) || category === '기타'", "false", 'AI 카테고리 목록 검증 제거'),
 ('src/ledger.mjs', "else kind = v < 0 ? 'refund' : 'expense';", "else kind = 'expense';", '카드 (-)금액을 환불로 보는 규칙 제거'),
 ('src/analyze.mjs', "t.kind === 'refund' ? -t.amount : 0", "0", '환불 차감 제거'),
 ('src/http.mjs', "if (b.confirm !== true) throw", "if (false) throw", '전체 삭제 confirm 제거'),
 ('src/analyze.mjs', "if (FIXED_CATS.has(t.category)) continue;", "", '고정비 제외 제거'),
 ('src/merchant.mjs', "(!best || e.word.length > best.word.length)", "(!best)", '가장 긴 키워드 우선 제거'),
 ('src/db.mjs', "AND merchant_norm = ? AND kind <> 'income'\").run(category, userId, t.norm)", "AND merchant_norm = ? AND kind <> 'income' AND tx_id = \" + txId).run(category, userId, t.norm)", '같은 가맹점 전체 적용 제거'),
 ('src/analyze.mjs', "cur && elapsed >= 7", "cur && elapsed >= 1", '월말 예상의 7일 조건 제거'),
 ('src/ledger.mjs', "isValidDate(y, mo, d)", "true", '존재하지 않는 날짜 검사 제거'),
]
# 실행 루프: 파일을 바꾸고 → 전체 테스트 실행 → 실패 개수 확인 → finally에서 반드시 원래 내용으로 복구합니다.
killed = 0
for f, old, new, label in M:
    s = open(f, encoding='utf8').read()
    if old not in s: print('??', label, '(패턴 없음)'); continue
    open(f, 'w', encoding='utf8').write(s.replace(old, new, 1))
    try:
        out = subprocess.run(['node', '--test', 'test/'], capture_output=True, text=True, encoding='utf-8').stdout
        n = int(re.search(r'ℹ fail (\d+)', out).group(1))
    finally:
        open(f, 'w', encoding='utf8').write(s)
    killed += n > 0
    print(f"{'검출' if n else '통과(미검출)'} {n:>2}건 실패 — {label}")
print(f'{killed}/{len(M)} 검출')
