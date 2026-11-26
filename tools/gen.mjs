// ─────────────────────────────────────────────────────────────────────────────
// gen.mjs — 평가·샘플용 "가상 거래내역" 생성기 (시드 고정, 정답과 함께 만듭니다)
//
// [왜 가상 데이터인가] 실제 카드 내역은 개인정보라 공개·평가에 쓸 수 없습니다. 대신 정답(분류·이상 지출 위치)을 알고 있는
//   데이터를 만들어 정확도를 숫자로 잽니다. 단, 내가 만든 데이터이므로 실제 가계부보다 단순합니다 → 정확도는 상한선에 가깝습니다.
// [세트]  variant 'dev'  : 개발 중 계속 본 가맹점·금액대(임계값을 이 데이터로 정함)
//         variant 'held' : 다른 가맹점·1.7배 금액대·다른 정기결제 (임계값을 정한 뒤 새로 만든 평가용, 1라운드)
//         variant 'held2': 또 다른 가맹점·1.35배 금액대·다른 정기결제 (1라운드 결과로 규칙을 고친 뒤 새로 만든 최종 평가용)
// [형식]  style A 카드(시각 포함, 취소 행)  B 카드(안내 문구·따옴표 금액·합계 행)  C 은행(출금/입금/잔액)
// ─────────────────────────────────────────────────────────────────────────────

// 시드 고정 난수 생성기(mulberry32): 같은 시드면 항상 같은 순서의 난수 → 평가 데이터를 언제나 똑같이 다시 만들 수 있음(재현성).
export const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

// 가맹점 풀: variant(dev/held/held2)마다 쓰는 가게 이름이 다릅니다. 평가 세트가 개발 때 본 가게와 겹치지 않게 하려는 장치입니다.
const POOLS = {
  held2: {
    식비: ['명륜진사갈비', '육회한판', '샐러디 강남점', '아딘타', '봉피양', '토속촌삼계탕', '버거앤프라이즈', '동대문엽기떡볶이'],
    카페: ['앤트러사이트', '카페 모모', '프릳츠', '커피한약방', '어니언 성수'],
    '마트·편의점': ['메가마트', '롯데슈퍼 방배점', 'GS25 성수점', 'CU 편의점 홍대', '이마트에브리데이 구로점'],
    교통: ['쏘카', '투루카', '고속도로통행료', '모두의주차장', '카카오T 바이크'],
    쇼핑: ['29CM', 'W컨셉', '아모레퍼시픽몰', '한샘몰', '러쉬 코리아'],
    '의료·건강': ['서울365의원', '하나이비인후과', '바디라인 요가원', '이편한약국'],
    '문화·여가': ['아트센터 공연', '예스24 티켓', 'CGV 용산', '롯데월드 어드벤처'],
    교육: ['시대인재', '유데미', '국민대 평생교육원'],
  },
  dev: {
    식비: ['맘스터치 강남점', '김밥천국 역삼점', '본죽 서초점', '배달의민족', '요기요', '교촌치킨 신림점', '한솥도시락 사당점', '홍콩반점0410 강남점'],
    카페: ['스타벅스 강남역점', '투썸플레이스 서초점', '이디야커피 역삼점', '메가MGC커피 신촌점', '빽다방 사당점'],
    '마트·편의점': ['GS25 역삼점', 'CU 서초점', '이마트 성수점', '홈플러스 영등포점', '노브랜드 서초점'],
    교통: ['티머니', '카카오T택시', '지하철 후불교통', '주유소 GS칼텍스'],
    쇼핑: ['쿠팡', '올리브영 강남점', '다이소 역삼점', '무신사', '11번가'],
    '의료·건강': ['한마음약국', '서울정형외과의원', '밝은안과'],
    '문화·여가': ['CGV 강남', '롯데시네마 건대', '교보문고 광화문점'],
    교육: ['토익학원 강남', '클래스101'],
  },
  held: {
    식비: ['신전떡볶이 홍대점', '프랭크버거', '서가앤쿡', '만강홍 강남', '을지로 노가리집', '이삭토스트 신촌점', '연남 쭈꾸미'],
    카페: ['카페드림', '블루보틀 성수', '로스터리 온도', '텐퍼센트커피 홍대점', '쿠키앤크림 카페'],
    '마트·편의점': ['이마트24 대치점', '세븐일레븐 논현점', '롯데슈퍼 신사점', 'GS더프레시', '홈플러스 익스프레스'],
    교통: ['SK엔크린 주유소', '후불교통카드', '카카오T블루', '타다', '서울시설공단 주차장'],
    쇼핑: ['에이블리', '스타일난다', '오늘의집', '탑텐 신촌점', '쿠팡'],
    '의료·건강': ['연세내과의원', '튼튼치과', '웰니스필라테스', '온누리약국'],
    '문화·여가': ['메가박스 코엑스', '블루스퀘어 공연', '락앤락볼링', '예스24'],
    교육: ['해커스어학원', '패스트캠퍼스', 'YBM 시사'],
  },
};
// (아래 RANGE는 카테고리별 금액 범위와 월 평균 건수, FIXED는 매달 고정으로 나가는 구독·통신비·월급·월세입니다.)
// [금액 범위] 카테고리별 [최소, 최대, 월 평균 건수]
const RANGE = { 식비: [8000, 26000, 9], 카페: [3900, 7200, 12], '마트·편의점': [2500, 70000, 11], 교통: [1450, 21000, 22], 쇼핑: [9000, 65000, 4], '의료·건강': [3500, 32000, 2], '문화·여가': [9000, 28000, 2], 교육: [30000, 90000, 1] };
const FIXED = {
  held2: { subs: [['디즈니플러스', 16900, 3], ['Spotify', 11990, 10], ['쿠팡와우멤버십', 7890, 22]], phone: ['LG유플러스 통신요금', 55000, 12], salary: 3300000, rent: 800000 },
  dev: { subs: [['Netflix', 17000, 5], ['YouTube Premium', 14900, 12], ['멜론', 10900, 20]], phone: ['KT 통신요금', 65000, 15], salary: 2800000, rent: 700000 },
  held: { subs: [['티빙', 13900, 6], ['OPENAI *CHATGPT SUBSCR', 29000, 14], ['왓챠', 12900, 21]], phone: ['SK텔레콤 통신요금', 84000, 18], salary: 3900000, rent: 950000 },
};

// 숫자를 두 자리로(5 → '05'), 천 단위 쉼표 문자열, CSV 칸 따옴표 처리(쉼표·따옴표·줄바꿈이 있으면 감쌈)
const pad = (n) => String(n).padStart(2, '0');
const wonStr = (n) => n.toLocaleString('en-US');
const q = (s) => (/[",\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s);

// generate: 거래 목록(tx), 정답 이상 지출(truth), CSV 텍스트(text)를 함께 만듭니다.
//   순서: ① 달마다 일반 지출 생성 ② 고정 구독·통신비 ③ 헷갈리기 쉬운 정상 거래(오탐 점검용) ④ 마지막 달에 이상 지출 5건 심기 ⑤ CSV로 렌더링
export function generate({ seed = 1, style = 'A', variant = 'dev', months = ['2026-07', '2026-08', '2026-09', '2026-10'] } = {}) {
  const R = rng(seed), pool = POOLS[variant], fx = FIXED[variant], scale = { dev: 1, held: 1.7, held2: 1.35 }[variant];
  const pick = (a) => a[Math.floor(R() * a.length)];
  const between = (lo, hi) => Math.round((lo + R() * (hi - lo)) / 10) * 10;
  const tx = [], truth = [];
  const hasTime = style === 'A';
  const clock = () => `${pad(8 + Math.floor(R() * 13))}:${pad(Math.floor(R() * 60))}:${pad(Math.floor(R() * 60))}`;
  const add = (date, merchant, amount, category, extra = {}) => tx.push({ date, time: hasTime ? clock() : null, merchant, amount, kind: 'expense', category, ...extra });

  months.forEach((month, mi) => {
    const last = mi === months.length - 1;
    for (const [cat, [lo, hi, n]] of Object.entries(RANGE)) {
      const count = Math.max(1, Math.round(n * (0.8 + R() * 0.4)));
      for (let i = 0; i < count; i++) add(`${month}-${pad(1 + Math.floor(R() * 28))}`, pick(pool[cat]), Math.round(between(lo, hi) * scale / 10) * 10, cat);
    }
    // 정기결제(마지막 달에 한 곳만 가격 인상 → 정답 이상)
    fx.subs.forEach(([name, amt, day], si) => {
      const raise = last && si === 0;
      add(`${month}-${pad(day)}`, name, raise ? Math.round(amt * 1.25 / 10) * 10 : amt, '구독');
      if (raise) truth.push({ type: 'price_change', date: `${month}-${pad(day)}`, amount: Math.round(amt * 1.25 / 10) * 10 });
    });
    add(`${month}-${pad(fx.phone[2])}`, fx.phone[0], fx.phone[1], '주거·통신');
    if (style === 'C') { add(`${month}-25`, '월세 이체', fx.rent, '주거·통신'); }

    // ── 정상이지만 헷갈리기 쉬운 거래(오탐 점검) ──
    const m2 = (d) => `${month}-${pad(d)}`;
    const cafe = pick(pool['카페']), cafeAmt = Math.round(5500 * scale / 10) * 10;
    if (hasTime) { tx.push({ date: m2(9), time: '09:10:03', merchant: cafe, amount: cafeAmt, kind: 'expense', category: '카페' }, { date: m2(9), time: '15:40:51', merchant: cafe, amount: cafeAmt, kind: 'expense', category: '카페' }); }
    add(m2(13), pick(pool['쇼핑']), Math.round(70000 * scale / 10) * 10, '쇼핑');       // 약간 큰 쇼핑(이상 아님)
    add(m2(17), '새로생긴가게', Math.round(120000 * scale / 10) * 10, '기타');          // 처음 보는 가맹점이지만 15만원 미만
    if (hasTime && mi === 1) tx.push({ ...tx[tx.length - 4], kind: 'refund', time: clock() }); // 취소 거래 1건

    // ── 마지막 달에 이상 지출 심기 ──
    if (last) {
      const rest = pick(pool['식비']), a = Math.round(between(12000, 20000) * scale / 10) * 10, d = m2(21);
      tx.push({ date: d, time: hasTime ? '12:30:10' : null, merchant: rest, amount: a, kind: 'expense', category: '식비' }, { date: d, time: hasTime ? '12:31:42' : null, merchant: rest, amount: a, kind: 'expense', category: '식비' });
      truth.push({ type: 'duplicate', date: d, amount: a });
      const big = Math.round(380000 * scale / 10) * 10;
      add(m2(8), 'OO한우 고깃집', big, '식비'); truth.push({ type: 'outlier', date: m2(8), amount: big });
      const big2 = Math.round(520000 * scale / 10) * 10;
      add(m2(15), { dev: '쿠팡', held: '오늘의집', held2: '한샘몰' }[variant], big2, '쇼핑'); truth.push({ type: 'outlier', date: m2(15), amount: big2 });
      const nm = Math.round(1250000 * scale / 10) * 10;
      add(m2(26), '삼성디지털프라자 매장', nm, '기타'); truth.push({ type: 'new_merchant', date: m2(26), amount: nm });
    }
  });
  if (style === 'C') for (const month of months) tx.push({ date: `${month}-25`, time: null, merchant: '급여 (주)가나다', amount: fx.salary, kind: 'income', category: '수입' });
  tx.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
  return { text: render(tx, style, months), tx, truth, style, variant };
}

// 거래 목록을 형식별 CSV로 만듭니다. A: 카드(시각·취소 행), B: 카드(안내 문구·따옴표 금액·합계 줄), C: 은행(출금/입금/잔액).
function render(tx, style, months) {
  const L = [];
  if (style === 'A') {
    L.push('이용일시,이용가맹점,이용금액,구분');
    for (const t of tx) L.push([`${t.date} ${t.time}`, q(t.merchant), t.amount, t.kind === 'refund' ? '취소' : '승인'].join(','));
  } else if (style === 'B') {
    L.push('가상카드 이용내역 조회', `조회기간: ${months[0]}-01 ~ ${months[months.length - 1]}-28`, '');
    L.push('승인일자,가맹점명,승인금액(원),할부');
    for (const t of tx) L.push([t.date.replaceAll('-', '.'), q(t.merchant), `"${wonStr(t.amount)}"`, '일시불'].join(','));
    L.push(`합계,,"${wonStr(tx.reduce((s, t) => s + t.amount, 0))}",`);
  } else {
    L.push('거래일시,적요,출금액,입금액,잔액');
    let bal = 5000000;
    for (const t of tx) {
      bal += t.kind === 'income' ? t.amount : -t.amount;
      L.push([`${t.date} ${pad(9 + (t.amount % 10))}:${pad(t.amount % 60)}`, q(t.merchant), t.kind === 'income' ? '' : t.amount, t.kind === 'income' ? t.amount : '', bal].join(','));
    }
  }
  return L.join('\r\n') + '\r\n';
}
