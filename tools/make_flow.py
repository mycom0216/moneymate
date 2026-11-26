"""순서도 이미지 생성: python tools/make_flow.py → docs/images/flow-dev.png, flow-system.png
 - flow-dev.png    : 개발 절차 순서도(기획 → 설계 → 분석·구현 → 테스트 → 유지보수, 결함 시 구현으로 되돌아가는 반복 포함)
 - flow-system.png : 프로그램 처리 순서도(CSV 입력 → 검사 → 거래 변환 → 분류 → 저장 → (AI 제안) → 리포트 계산 → 교정 반복)
표준 순서도 기호: 둥근 사각형=시작/끝, 사각형=처리, 마름모=판단, 평행사변형=입출력.
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Polygon

plt.rcParams["font.family"] = "Malgun Gothic"
OUT = Path(__file__).resolve().parent.parent / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
BRAND, GREEN, RED, ORANGE, INK = "#1d4ed8", "#0f9d6b", "#d92d20", "#d97706", "#1b2430"


class Flow:
    def __init__(self, w, h, y0=-1.2):
        self.fig, self.ax = plt.subplots(figsize=(w, h - y0 if y0 < 0 else h - y0))
        self.ax.set_xlim(-1.2, w + 0.8)
        self.ax.set_ylim(y0, h)
        self.ax.axis("off")
        self.nodes = {}

    def node(self, key, x, y, text, kind="proc", w=3.4, h=0.8):
        a = self.ax
        if kind == "term":
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.3", fc=BRAND, ec=BRAND, zorder=3))
            col = "white"
        elif kind == "dec":
            hw, hh = w / 2 + 0.2, h / 2 + 0.25
            a.add_patch(Polygon([(x, y + hh), (x + hw, y), (x, y - hh), (x - hw, y)], fc="#fff7e6", ec=ORANGE, lw=1.8, zorder=3))
            col = INK
        elif kind == "io":
            s = 0.3
            a.add_patch(Polygon([(x - w / 2 + s, y + h / 2), (x + w / 2 + s, y + h / 2), (x + w / 2 - s, y - h / 2), (x - w / 2 - s, y - h / 2)], fc="#e8effd", ec=BRAND, lw=1.8, zorder=3))
            col = INK
        else:
            a.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle="round,pad=0,rounding_size=0.08", fc="white", ec=BRAND, lw=1.8, zorder=3))
            col = INK
        a.text(x, y, text, ha="center", va="center", fontsize=11, color=col, zorder=5, fontweight="bold" if kind == "term" else "normal")
        hh = (h / 2 + 0.25) if kind == "dec" else h / 2
        hw = (w / 2 + 0.2) if kind == "dec" else w / 2
        self.nodes[key] = (x, y, hw, hh)

    def pt(self, key, side):
        x, y, hw, hh = self.nodes[key]
        return {"t": (x, y + hh), "b": (x, y - hh), "l": (x - hw, y), "r": (x + hw, y)}[side]

    def arrow(self, a, sa, b, sb, label="", via=None, color="#475467"):
        p1, p2 = self.pt(a, sa), self.pt(b, sb)
        pts = [p1] + (via or []) + [p2]
        for i in range(len(pts) - 1):
            last = i == len(pts) - 2
            self.ax.annotate("", xy=pts[i + 1], xytext=pts[i], zorder=2,
                             arrowprops=dict(arrowstyle="-|>" if last else "-", color=color, lw=1.5, shrinkA=0, shrinkB=0))
        if label:
            mx, my = pts[0][0] + (pts[1][0] - pts[0][0]) * 0.35, pts[0][1] + (pts[1][1] - pts[0][1]) * 0.35
            self.ax.text(mx + 0.12, my + 0.08, label, fontsize=10, color=RED if label.startswith("아니") else GREEN, fontweight="bold", zorder=6,
                         bbox=dict(fc="white", ec="none", pad=1))

    def save(self, name, title):
        self.ax.text(-1.0, self.ax.get_ylim()[1] - 0.35, title, fontsize=16, fontweight="bold", color=INK)
        self.fig.savefig(OUT / name, dpi=110, bbox_inches="tight", facecolor="white")
        print("saved", OUT / name)


# ── 1) 개발 절차 순서도 ──────────────────────────────────────────────
f = Flow(9, 12.4)
f.node("s", 4.5, 11.3, "시작 (2026-11-26)", "term", 3.0, 0.7)
f.node("p1", 4.5, 10.1, "1 기획\n주제·범위 확정, 기획서 작성 (~12/04 제출)", "proc", 5.4)
f.node("p2", 4.5, 8.8, "2 설계\n요구사항 분석서·명세서, 아키텍처, ERD", "proc", 5.4)
f.node("p3", 4.5, 7.5, "3 분석·구현\nCSV 읽기, 분류, 이상 지출·예산 계산, DB·API, 화면", "proc", 5.6)
f.node("p4", 4.5, 6.2, "4 테스트\n자동 테스트, 정확도 평가, 사용자 평가", "proc", 5.4)
f.node("d1", 4.5, 4.7, "결함·개선 사항이\n남아 있는가?", "dec", 2.6, 0.7)
f.node("p5", 4.5, 3.2, "5 유지보수\n결함 수정, 규칙 보강, 문서 갱신, 결과보고서", "proc", 5.4)
f.node("p6", 4.5, 1.95, "발표자료 정리, 시연 리허설", "proc", 4.4)
f.node("e", 4.5, 0.85, "최종 발표 (2026-12-30)", "term", 3.2, 0.7)
for a, b in [("s", "p1"), ("p1", "p2"), ("p2", "p3"), ("p3", "p4"), ("p4", "d1")]:
    f.arrow(a, "b", b, "t")
f.arrow("d1", "b", "p5", "t", "아니오")
f.arrow("d1", "r", "p3", "r", "예 → 구현으로 수정", via=[(7.9, 4.7), (7.9, 7.5)], color=RED)
f.arrow("p5", "b", "p6", "t"); f.arrow("p6", "b", "e", "t")
f.save("flow-dev.png", "개발 절차 순서도 (기획 → 설계 → 분석·구현 → 테스트 → 유지보수)")

# ── 2) 프로그램 처리 순서도 (한 장, 2열) ──────────────────────────────
g = Flow(10.4, 13.9, y0=-1.6)
g.node("s", 2.4, 12.2, "시작", "term", 2.0, 0.6)
g.node("in", 2.4, 11.2, "카드·은행 내역 CSV 업로드", "io", 3.4, 0.75)
g.node("d1", 2.4, 9.7, "형식·크기(5MB)\n검사 통과?", "dec", 2.4, 0.7)
g.node("rd", 2.4, 8.2, "글자 해석(UTF-8·CP949)\n헤더 행·열 찾기", "proc", 3.6, 0.75)
g.node("cv", 2.4, 6.8, "행 → 거래 변환(날짜·정수 금액·종류)\n읽지 못한 줄은 이유와 함께 기록", "proc", 4.4, 0.85)
g.node("nm", 2.4, 5.4, "가맹점 이름 정리 + 분류\n(사용자 규칙 → 키워드 사전)", "proc", 3.8, 0.8)
g.node("sv", 7.2, 5.4, "중복 제거 후 DB 저장\n(같은 파일 재업로드 안전)", "proc", 3.5, 0.8)
g.node("d2", 7.2, 3.9, "분류되지 않은\n가맹점이 있는가?", "dec", 2.4, 0.65)
g.node("ai", 7.2, 2.5, "AI 제안(가맹점 이름만 전송)\n→ 검증 → 'AI 제안(미확인)' 표시", "proc", 3.8, 0.85)
g.node("rp", 7.2, 1.1, "리포트 계산(코드): 월 요약·\n이상 지출·정기결제·예산", "proc", 3.7, 0.85)
g.node("sh", 7.2, -0.2, "화면 표시(근거 숫자와 함께)", "proc", 3.4, 0.6)
g.node("cor", 2.4, -0.2, "분류를 고칠까?", "dec", 2.2, 0.6)
g.node("e", 2.4, -1.3, "끝", "term", 1.8, 0.55)
g.arrow("s", "b", "in", "t"); g.arrow("in", "b", "d1", "t")
g.arrow("d1", "b", "rd", "t", "예")
g.arrow("d1", "l", "in", "l", "아니오", via=[(0.2, 9.7), (0.2, 11.2)])
g.ax.text(-0.15, 10.45, "오류 안내 후\n다시 입력", fontsize=9.5, color=RED, ha="center", va="center", bbox=dict(fc="white", ec="none", pad=1), zorder=7)
g.arrow("rd", "b", "cv", "t"); g.arrow("cv", "b", "nm", "t")
g.arrow("nm", "r", "sv", "l")
g.arrow("sv", "b", "d2", "t")
g.arrow("d2", "b", "ai", "t", "예")
g.arrow("d2", "r", "rp", "r", "아니오", via=[(9.6, 3.9), (9.6, 1.1)])
g.arrow("ai", "b", "rp", "t"); g.arrow("rp", "b", "sh", "t")
g.arrow("sh", "l", "cor", "r")
g.arrow("cor", "b", "e", "t", "아니오")
g.arrow("cor", "l", "nm", "l", via=[(0.2, -0.2), (0.2, 5.4)], color=RED)
g.ax.text(-0.15, 2.4, "예: 카테고리 수정\n(규칙 저장·재계산)", fontsize=9.5, color=RED, ha="center", va="center", bbox=dict(fc="white", ec="none", pad=1), zorder=7)
g.save("flow-system.png", "MoneyMate 프로그램 처리 순서도")
