"""발표자료 생성: python tools/build_deck.py  →  docs/MoneyMate_발표자료.pptx
python-pptx로 슬라이드를 코드로 만듭니다(수정은 이 파일을 고치고 다시 실행). 슬라이드 노트에 발표 멘트를 넣었습니다.
"""
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "images"
FONT = "Malgun Gothic"
INK, MUTED = RGBColor(0x1B, 0x24, 0x30), RGBColor(0x66, 0x70, 0x85)
BRAND, SOFT, WHITE = RGBColor(0x1D, 0x4E, 0xD8), RGBColor(0xE8, 0xEF, 0xFD), RGBColor(0xFF, 0xFF, 0xFF)
OK, WARN, BAD, LINE = RGBColor(0x0F, 0x9D, 0x6B), RGBColor(0xD9, 0x77, 0x06), RGBColor(0xD9, 0x2D, 0x20), RGBColor(0xE4, 0xE8, 0xF0)

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
BLANK = prs.slide_layouts[6]
N = 14


import math

WARNINGS = []


def estimate_height_pt(lines, width_in, size, safety=1.2):
    """글상자에 글이 몇 pt 높이로 들어갈지 어림합니다(한글 1자≈글자 크기, 영문·숫자≈0.55배, 폭 안전계수 1.2).
    PowerPoint와 다른 프로그램(Keynote, Google 슬라이드, WPS)은 글꼴이 달라 줄바꿈이 더 많아질 수 있어 여유를 둡니다."""
    avail = width_in * 72 - 14.4  # 기본 좌우 여백 0.1in씩
    total = 7.2  # 위아래 여백
    for ln in lines:
        w = sum(size * (1.0 if ord(c) > 0x2E80 else 0.55 if c != " " else 0.3) for c in ln) * safety
        total += max(1, math.ceil(w / avail)) * size * 1.3 + 4
    return total


def text(slide, x, y, w, h, s, size=18, bold=False, color=INK, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    for i, ln in enumerate(s if isinstance(s, list) else [s]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = ln
        r.font.size, r.font.bold, r.font.name = Pt(size), bold, FONT
        r.font.color.rgb = color
        p.space_after = Pt(4)
    need = estimate_height_pt(s if isinstance(s, list) else [s], w, size)
    if need > h * 72 + 1:
        WARNINGS.append(f"슬라이드 {len(prs.slides)}: 글상자 높이 부족 가능(필요 약 {need:.0f}pt > {h * 72:.0f}pt) : {(s if isinstance(s, str) else s[0])[:28]}")
    return tb


def box(slide, x, y, w, h, fill=SOFT, line=None, shape=MSO_SHAPE.ROUNDED_RECTANGLE):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line:
        s.line.color.rgb = line
        s.line.width = Pt(1)
    else:
        s.line.fill.background()
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = 0.08
    s.shadow.inherit = False
    return s


def card(slide, x, y, w, h, title, body, accent=BRAND, tsize=17, bsize=14):
    box(slide, x, y, w, h, WHITE, LINE)
    box(slide, x, y, 0.09, h, accent, None, MSO_SHAPE.RECTANGLE)
    text(slide, x + 0.25, y + 0.12, w - 0.4, 0.5, title, tsize, True)
    text(slide, x + 0.25, y + 0.68, w - 0.4, h - 0.8, body, bsize, False, MUTED)


def base(title, n, notes=""):
    s = prs.slides.add_slide(BLANK)
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = RGBColor(0xF7, 0xF9, 0xFD)
    box(s, 0, 0, 13.333, 0.12, BRAND, None, MSO_SHAPE.RECTANGLE)
    text(s, 0.6, 0.35, 12, 0.8, title, 30, True)
    text(s, 12.0, 6.98, 1.0, 0.4, f"{n} / {N}", 11, False, MUTED, PP_ALIGN.RIGHT)
    text(s, 0.6, 6.98, 8, 0.4, "MoneyMate · 내 PC에서 처리하는 카드·은행 내역 분석", 11, False, MUTED)
    if notes:
        s.notes_slide.notes_text_frame.text = notes
    return s


def pic(slide, name, x, y, w=None, h=None):
    kw = {"width": Inches(w)} if w else {"height": Inches(h)}
    p = slide.shapes.add_picture(str(IMG / name), Inches(x), Inches(y), **kw)
    p.line.color.rgb = LINE
    p.line.width = Pt(1)


# 평가 수치(tools/eval.mjs 결과, docs/MoneyMate_테스트결과서.md와 동일해야 함)
LIGHT = RGBColor(0xDB, 0xE6, 0xFB)

# 1 표지
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 1.7, 11, 1.5, "MoneyMate", 60, True, WHITE)
text(s, 0.9, 3.25, 11.8, 1.3, "내 PC에서 처리하는 카드·은행 내역 분석 시스템", 28, False, WHITE)
text(s, 0.9, 4.8, 11.5, 0.6, "금액은 AI가 아니라 코드가 계산하고, AI의 분류는 '미확인'으로 표시합니다", 18, False, LIGHT)
text(s, 0.9, 6.3, 11.5, 0.5, "인공지능 응용 시스템 개발 종합 프로젝트 · 기획서 2026.12.04 · 발표 2026.12.30 · 반재영", 14, False, LIGHT)
s.notes_slide.notes_text_frame.text = "안녕하세요. 카드·은행 내역을 내 PC에서 분류하고 이상 지출을 알려 주는 MoneyMate를 소개하겠습니다."

# 2 문제
s = base("왜 만들었나: 내 돈이 어디로 가는지 모른다", 2, "카드 앱은 시간순 목록이라 이상 결제가 묻힙니다. 클라우드 가계부는 소비 내역을 밖으로 보내고, 생성형 AI는 합계를 틀리게 말하면서도 그럴듯합니다.")
card(s, 0.6, 1.5, 3.9, 2.4, "① 이상 결제가 묻힌다", "중복 결제, 오른 구독료, 모르는 가게의 큰 결제가 긴 목록 속에 숨어 있습니다.", BRAND, 17, 15)
card(s, 4.7, 1.5, 3.9, 2.4, "② 내역을 밖으로?", "가맹점·금액은 생활 패턴을 그대로 드러내는데 클라우드 가계부는 외부 서버로 보냅니다.", WARN, 17, 15)
card(s, 8.8, 1.5, 3.9, 2.4, "③ AI가 합계를 틀린다", "돈 계산은 1원이라도 틀리면 쓸모가 없는데 AI는 틀려도 그럴듯하게 말합니다.", BAD, 17, 15)
box(s, 0.6, 4.3, 12.1, 2.1, BRAND)
text(s, 0.9, 4.5, 11.5, 0.55, "해결 방향", 20, True, WHITE)
text(s, 0.9, 5.15, 11.5, 1.1, ["로컬 처리 · 모든 금액은 정수 원, 코드가 계산 · 경고에는 근거 숫자", "AI는 가맹점 이름만 받아 분류를 '제안'하고, 확정은 사람이"], 17, False, WHITE)

# 3 기능
s = base("핵심 기능", 3, "CSV를 올리면 읽고, 분류하고, 분석해 월 리포트로 보여 줍니다. 틀린 분류는 한 번만 고치면 같은 가게 전체에 적용됩니다.")
feats = [("CSV 가져오기", "카드·은행 형식 자동 인식, UTF-8/CP949, 못 읽은 줄은 줄 번호와 이유 보고", BRAND),
         ("자동 분류·교정", "가맹점 이름 정리 → 내 규칙 → 키워드 사전. 고치면 같은 가맹점 전체에 적용", OK),
         ("AI 분류 제안", "사전에 없는 가게의 이름만 전송(금액 제외), 'AI 제안(미확인)' 표시", WARN),
         ("이상 지출 탐지", "중복 결제·유난히 큰 지출·신규 고액·구독 가격 변동, 근거 숫자와 함께", BAD),
         ("정기결제·예산", "구독 자동 발견, 카테고리 예산 초과·월말 초과 예상 경고", BRAND),
         ("기술 스택", "Node.js 24 · SQLite · Ollama(선택) · 외부 npm 패키지 0개", MUTED)]
for i, (t, b, c) in enumerate(feats):
    card(s, 0.6 + (i % 2) * 6.15, 1.4 + (i // 2) * 1.85, 5.95, 1.7, t, b, c, 18, 14)

# 4 화면 ① 경고
s = base("화면 ①: 이상 지출을 근거 숫자와 함께", 4, "샘플 데이터의 10월 리포트입니다. 모든 경고에 근거 숫자가 있습니다. 예를 들어 한우 고깃집 38만원은 식비 중앙값 17,880원의 21.3배입니다. 정상이면 숨길 수 있습니다.")
pic(s, "crop-alerts.png", 0.6, 1.3, w=7.4)
card(s, 8.3, 1.5, 4.5, 1.55, "근거를 보여 준다", "중앙값·배수·비교 거래 수. AI가 아니라 코드가 계산", BRAND, 16, 13)
card(s, 8.3, 3.25, 4.5, 1.55, "정상이면 숨기기", "내용 기반 키로 저장해 다시 가져와도 유지", OK, 16, 13)
card(s, 8.3, 5.0, 4.5, 1.75, "미분류는 더 엄격히", "분류가 불확실한 거래는 전체 지출과 비교하되 20만원·5배 이상만", WARN, 16, 13)

# 5 화면 ② 거래
s = base("화면 ②: 분류 교정과 미확인 표시", 5, "미분류 가맹점은 거래 내역에서 카테고리를 고칩니다. 한 번 고치면 같은 가맹점의 모든 거래와 앞으로의 가져오기에 적용됩니다. AI가 제안한 분류는 AI 제안 미확인 배지로 표시되고 확인을 눌러야 확정됩니다.")
pic(s, "ui-4-tx.png", 0.6, 1.3, w=7.2)
card(s, 8.1, 1.5, 4.7, 1.6, "가맹점 단위로 기억", "지점이 달라도 같은 가게로 묶어 전체 적용", BRAND, 16, 13)
card(s, 8.1, 3.3, 4.7, 1.6, "미확인 비율 상시 표시", "리포트 맨 위에 '미확인 분류가 지출의 몇 %'인지", WARN, 16, 13)
card(s, 8.1, 5.1, 4.7, 1.65, "AI는 제안만", "확인해야 규칙이 됨 (제안 정밀도 56.3%라서)", BAD, 16, 13)

# 6 구조
s = base("시스템 구조", 6, "http 층이 검증·제한·보안을 맡고 app 층이 가져오기와 리포트를 조립합니다. 분석은 전부 코드, AI는 분류 제안 한 군데에만 쓰입니다.")
for i, (t, b) in enumerate([("브라우저", "화면 4개 탭"), ("http.mjs", "검증·제한·보안"), ("app.mjs", "가져오기·리포트 흐름"), ("SQLite", "6개 테이블·CHECK")]):
    x = 0.6 + i * 3.15
    box(s, x, 1.5, 2.7, 1.2, WHITE, BRAND)
    text(s, x, 1.6, 2.7, 0.5, t, 17, True, BRAND, PP_ALIGN.CENTER)
    text(s, x, 2.15, 2.7, 0.5, b, 13, False, MUTED, PP_ALIGN.CENTER)
mods = [("csv · ledger", "글자 해석, CSV 파싱, 행 → 정수 금액 거래, 못 읽은 줄 보고", OK), ("merchant", "가맹점 이름 정리, 키워드 분류(가장 긴 키워드 우선)", BRAND), ("analyze", "월 요약, 이상 지출 4종, 정기결제, 예산 (전부 코드 계산)", BAD), ("ai · llm", "미분류 가맹점 분류 제안 + 검증, Ollama/Claude/ChatGPT 어댑터", WARN)]
for i, (t, b, c) in enumerate(mods):
    card(s, 0.6 + i * 3.1, 3.2, 2.95, 2.6, t, b, c, 15, 13)
text(s, 0.6, 6.1, 12, 0.6, "AI가 없어도 가져오기·분류·분석·예산이 모두 동작 (NFR-01)", 16, True, BRAND)

# 7 순서도
s = base("처리 순서도와 개발 절차 순서도", 7, "왼쪽은 개발 절차, 가운데는 프로그램 처리 순서도입니다. 입력 검사 실패, 분류되지 않은 가맹점 분기, 분류 교정 반복을 처리합니다.")
pic(s, "flow-dev.png", 0.6, 1.25, h=5.6)
pic(s, "flow-system.png", 5.0, 1.25, h=5.3)
card(s, 9.9, 1.5, 2.9, 2.4, "개발 절차", "기획 → 설계 → 분석·구현 → 테스트 → 유지보수, 결함 시 구현으로 반복", BRAND, 15, 12)
card(s, 9.9, 4.1, 2.9, 2.6, "처리 흐름", "CSV 검사 → 변환 → 분류 → 저장 → (AI 제안) → 리포트 계산 → 교정 반복", OK, 15, 12)

# 8 금액은 코드
s = base("핵심: 금액은 코드가, AI는 제안만", 8, "AI에게 맡기는 일은 사전에 없는 가맹점의 카테고리 제안 하나뿐입니다. 이름만 보내고 금액은 보내지 않습니다. 합계, 증감, 경고 문장의 숫자는 전부 코드가 정수로 계산합니다.")
steps = [("1 정수 원", "소수·문자·0원·없는 날짜는 거부, 못 읽은 줄은 줄 번호와 이유 보고", OK), ("2 규칙 분류", "사용자 규칙 → 키워드 사전. 규칙이 분류한 것은 틀리지 않음(정밀도 100%)", BRAND), ("3 AI 제안", "미분류 가게 이름만 전송, 검증 후 'AI 제안(미확인)'", WARN), ("4 사람 확인", "확인해야 규칙이 되고, 미확인 비율이 리포트에 항상 표시", BAD)]
for i, (t, b, c) in enumerate(steps):
    card(s, 0.6 + i * 3.1, 1.5, 2.95, 2.7, t, b, c, 17, 14)
box(s, 0.6, 4.5, 12.1, 2.1, SOFT)
text(s, 0.9, 4.65, 11.5, 1.9, ["측정으로 발견한 약점: 규칙은 정밀하지만 처음 보는 가게를 못 맞힌다", "최종 새 세트에서 규칙 분류율 58%(정밀도 100%) · AI 제안 정밀도 56.3%(3B 모델)", "→ 그래서 교정(가맹점 단위 기억)과 '미확인' 표시를 정식 기능으로 설계"], 15, False, INK)

# 9 이상 탐지
s = base("이상 지출 탐지: 설명할 수 있는 규칙 4개", 9, "평균과 표준편차는 큰 값 하나가 기준을 끌어올려 이상치를 놓칩니다. 그래서 중앙값과 MAD를 씁니다. 월세 같은 고정비는 원래 크므로 큰 지출 검사에서 제외합니다.")
rules = [("중복 결제 의심", "같은 가맹점·같은 금액이 같은 날 2번(시각이 있으면 10분 이내). 5천원 이상, 교통 제외", BAD),
         ("유난히 큰 지출", "카테고리 중앙값+5MAD 초과·중앙값 3배↑·3만원↑. 표본 부족·미분류는 전체와 비교(20만원·5배)", WARN),
         ("처음 보는 가맹점", "과거 28일↑ 데이터가 있고 처음 나온 가게에서 15만원 이상", BRAND),
         ("정기결제 금액 변동", "25~35일 간격 3회↑·금액 ±5%인 구독의 마지막 결제가 10%↑ 변동", OK)]
for i, (t, b, c) in enumerate(rules):
    card(s, 0.6 + (i % 2) * 6.15, 1.4 + (i // 2) * 2.1, 5.95, 1.95, t, b, c, 18, 14)
text(s, 0.6, 5.75, 12, 1.0, ["한 거래에 경고는 최대 1개, 근거 숫자 표시, '정상이에요(숨기기)'", "월세·통신비('주거·통신', '금융')는 큰 지출 검사에서 제외"], 15, False, INK)

# 10 ERD
s = base("데이터 설계 (ERD)", 10, "테이블 6개입니다. 금액 양수, 수입 종류와 수입 카테고리의 일치, 날짜 형식을 DB가 직접 강제합니다. 같은 파일을 다시 올려도 중복 방지 키로 거래가 쌓이지 않습니다.")
pic(s, "erd.png", 0.6, 1.3, h=5.4)
card(s, 9.4, 1.5, 3.4, 1.5, "DB가 규칙 강제", "금액>0, 수입⇔수입 카테고리", OK, 15, 12)
card(s, 9.4, 3.2, 3.4, 1.5, "중복 방지", "UNIQUE(user_id, dedupe_key)", BRAND, 15, 12)
card(s, 9.4, 4.9, 3.4, 1.5, "삭제", "CASCADE로 전체 삭제 한 번에", BAD, 15, 12)

# 11 평가
s = base("정확도: 새 세트에서 확인한 것", 11, "분류 정확도입니다. 개발용 100%는 부풀려진 값이고, 처음 보는 가맹점이 있는 새 세트에서는 68%였습니다. 사전을 보강하면 같은 세트가 96.6%로 오르지만 그 세트를 보고 고친 것이라 오염입니다. 새로 만든 최종 세트는 60%입니다.")
cd = CategoryChartData()
cd.categories = ["개발용(부풀려짐)", "새 세트 1라운드", "수정 후(그 세트, 오염)", "최종 새 세트"]
cd.add_series("분류 정확도(%)", (100, 68.1, 96.6, 60.0))
gf = s.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(0.6), Inches(1.4), Inches(7.6), Inches(5.2), cd)
ch = gf.chart
ch.has_legend = False
ch.has_title = True
ch.chart_title.text_frame.text = "규칙 분류 정확도 (%) — 가상 데이터"
ch.chart_title.text_frame.paragraphs[0].runs[0].font.size = Pt(14)
pl = ch.plots[0]
pl.has_data_labels = True
pl.data_labels.font.size = Pt(14)
pl.data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
pl.series[0].format.fill.solid()
pl.series[0].format.fill.fore_color.rgb = BRAND
ch.value_axis.maximum_scale = 100
ch.value_axis.tick_labels.font.size = Pt(12)
ch.category_axis.tick_labels.font.size = Pt(11)
card(s, 8.5, 1.5, 4.3, 1.7, "이상 지출(최종 세트)", "정답 15/15 발견, 오탐 0 (기준값 영향이 있어 한계 표기)", OK, 16, 13)
card(s, 8.5, 3.4, 4.3, 1.7, "읽기 · AI 제안", "읽기 100%(891/891) · AI 제안 정밀도 56.3%(9/16)", BRAND, 16, 13)
card(s, 8.5, 5.3, 4.3, 1.5, "한계", "가상 데이터. 실제 카드 내역은 더 복잡", BAD, 16, 13)

# 12 테스트
s = base("테스트와 발견한 결함", 12, "자동 테스트 36개가 통과하고 핵심 로직 12곳을 망가뜨려 모두 검출했습니다. 처음에는 11곳이었고 놓친 한 곳은 월세 같은 고정비 오경고를 잡는 테스트가 없어서였습니다. 테스트를 추가했습니다.")
card(s, 0.6, 1.5, 5.9, 2.4, "자동 테스트 36개 통과", "CSV·CP949 · 금액·날짜 검증 · 부호 규칙 · 분류 · 이상 탐지 경계 · 예산 · AI 검증 · IDOR · 413/415/429 · DB 제약", OK, 18, 14)
card(s, 6.8, 1.5, 5.9, 2.4, "변이 검사 12/12", "핵심 로직 12곳을 일부러 망가뜨려 모두 검출. 처음엔 11/12 — 고정비 제외 결함을 못 잡아 테스트를 추가", BRAND, 17, 13)
box(s, 0.6, 4.2, 12.1, 2.5, WHITE, LINE)
text(s, 0.9, 4.3, 11.5, 0.5, "측정으로 발견해 고친 것", 17, True)
text(s, 0.9, 4.85, 11.5, 1.8, ["미분류 '기타'에 섞인 가게들이 큰 지출 기준을 무너뜨림 → 전체 지출과 비교하되 기준 강화", "키워드 사전은 처음 보는 가게를 못 맞힘(60%) → 교정·AI 제안(미확인) 정식 기능", "이상 탐지 기준(15만·20만원)이 절대 금액 → 소비 규모가 큰 세트에서 오탐, 한계로 기록", "AI 제안 정밀도 56% → 그대로 믿지 않고 미확인 표시·미확인 비율 표시"], 14, False, INK)

# 13 한계·일정
s = base("한계와 앞으로의 계획", 13, "정직하게 한계를 말씀드립니다. 평가 데이터가 직접 만든 가상 거래내역이고, 처음 보는 가맹점은 분류하지 못하며, AI 제안은 절반 남짓만 맞고, 로그인이 없습니다. 12월에 실제 내역과 사용자 평가를 할 계획입니다.")
card(s, 0.6, 1.5, 5.9, 3.4, "한계", "평가 데이터 모두 가상(실제보다 단순)\n처음 보는 가맹점은 분류 안 됨(규칙 분류율 58%)\nAI 제안 정밀도 56%(3B 모델)\n이상 탐지 기준이 절대 금액\n로그인 없음(127.0.0.1 전용)", BAD, 18, 15)
card(s, 6.8, 1.5, 5.9, 3.4, "일정", "12/04 기획서 제출\n12/08 핵심 기능 완성(완료)\n12/08~12/19 실제 CSV·사용자 평가\n12/24 결과보고서\n12/30 발표", BRAND, 18, 15)
text(s, 0.6, 5.3, 12, 1.0, "다음 개선: 실제 카드사 CSV 확인 · 키워드 사전 보강 · 소비 규모에 비례하는 기준 · 더 큰 모델/Claude/ChatGPT 분류 제안 실측 · 로그인", 16, False, INK)

# 14 마무리
s = prs.slides.add_slide(BLANK)
s.background.fill.solid()
s.background.fill.fore_color.rgb = BRAND
text(s, 0.9, 2.0, 11.5, 1.4, "감사합니다", 54, True, WHITE)
text(s, 0.9, 3.6, 11.5, 1.2, ["내역은 내 PC 안에서, 숫자는 코드가, 확정은 사람이", "질문 받겠습니다"], 24, False, LIGHT)
text(s, 0.9, 6.2, 11.5, 0.5, "소스·문서: projects/MoneyMate · 실행: node server.mjs (Node.js 24+)", 14, False, LIGHT)

import sys

# 출력 경로를 인자로 바꿀 수 있습니다(파일이 PowerPoint에서 열려 있어 덮어쓸 수 없을 때 임시 파일로 먼저 확인하는 용도).
out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "MoneyMate_발표자료.pptx"
prs.save(out)
print("saved", out, "slides:", len(prs.slides))
for w in WARNINGS:
    print("WARN", w)
print("경고", len(WARNINGS), "건")
