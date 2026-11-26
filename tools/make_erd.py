"""ERD 이미지 생성: python tools/make_erd.py  →  docs/images/erd.png
데이터정의서·기획서·발표자료에 들어가는 ERD입니다. src/db.mjs 의 SCHEMA 와 같은 구조를 손으로 옮긴 것이므로
테이블을 바꾸면 이 파일과 docs/MeetMate_데이터정의서.md 도 함께 고쳐야 합니다. (matplotlib만 사용)
"""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

plt.rcParams["font.family"] = "Malgun Gothic"
plt.rcParams["axes.unicode_minus"] = False

T = {
    "users": (0.5, 9.2, [("PK", "user_id"), ("", "created_at")]),
    "imports": (5.6, 9.2, [("PK", "import_id"), ("FK", "user_id"), ("", "filename"), ("", "format (card|bank)"), ("", "rows_added"), ("", "rows_duplicate"), ("", "rows_skipped"), ("", "created_at")]),
    "transactions": (11.2, 9.2, [("PK", "tx_id"), ("FK", "user_id"), ("FK", "import_id"), ("", "tx_date  (YYYY-MM-DD)"), ("", "tx_time"), ("", "merchant"), ("", "merchant_norm"), ("", "amount  (정수 원, > 0)"), ("", "kind (expense|income|refund)"), ("", "category"), ("", "cat_method (rule|user|ai|none)"), ("UQ", "dedupe_key  (user_id, dedupe_key)")]),
    "merchant_rules": (0.5, 4.2, [("PK,FK", "user_id"), ("PK", "merchant_norm"), ("", "category"), ("", "created_at")]),
    "budgets": (5.6, 4.2, [("PK,FK", "user_id"), ("PK", "category"), ("", "monthly_limit  (> 0)")]),
    "dismissals": (11.2, 3.0, [("PK,FK", "user_id"), ("PK", "alert_key")]),
}
ROW, HEAD, W = 0.42, 0.6, 4.2
EDGE = "#1d4ed8"

def box(n):
    x, y, cols = T[n]
    return x, y, W, HEAD + ROW * len(cols)

fig, ax = plt.subplots(figsize=(17.5, 10.0))
ax.set_xlim(0, 17.5); ax.set_ylim(0.2, 11.2); ax.axis("off")
ax.text(0.5, 10.7, "MoneyMate ERD (SQLite, 6개 테이블)", fontsize=20, fontweight="bold", color="#1b2430")
ax.text(0.5, 10.25, "1:N 관계는 부모(1) → 자식(N). CHECK: 금액은 양수, 수입 종류 ⇔ 수입 카테고리, 날짜 형식. 같은 파일을 다시 올려도 UNIQUE(user_id, dedupe_key)로 거래가 중복되지 않음.", fontsize=10.5, color="#667085")

def side(n, s):
    x, y, w, h = box(n)
    return {"l": (x, y - h / 2), "r": (x + w, y - h / 2), "t": (x + w / 2, y), "b": (x + w / 2, y - h)}[s]

def rel(a, sa, b, sb, via=None, one=True, dashed=False, lab=None, lab_at=None):
    p1, p2 = side(a, sa), side(b, sb)
    pts = [p1] + (via or []) + [p2]
    for i in range(len(pts) - 1):
        last = i == len(pts) - 2
        ax.annotate("", xy=pts[i + 1], xytext=pts[i], arrowprops=dict(arrowstyle="-|>" if last else "-", color="#475467", lw=1.4, shrinkA=0, shrinkB=0, linestyle="--" if dashed else "-"))
    if one:
        ax.text(p1[0] + (pts[1][0] - p1[0]) * 0.1 + 0.05, p1[1] + (pts[1][1] - p1[1]) * 0.1 + 0.12, "1", fontsize=10, color="#d92d20", fontweight="bold")
        qx, qy = pts[-2]
        ax.text(p2[0] + (qx - p2[0]) * 0.12 - 0.05, p2[1] + (qy - p2[1]) * 0.12 + 0.12, "N", fontsize=10, color="#d92d20", fontweight="bold")
    if lab:
        ax.text(lab_at[0], lab_at[1], lab, fontsize=9, color="#475467", ha="center", bbox=dict(fc="white", ec="none", pad=1), zorder=9)

def line(pts, dashed=False, lab=None, lab_at=None):
    for i in range(len(pts) - 1):
        last = i == len(pts) - 2
        ax.annotate("", xy=pts[i + 1], xytext=pts[i], arrowprops=dict(arrowstyle="-|>" if last else "-", color="#475467", lw=1.4, shrinkA=0, shrinkB=0, linestyle="--" if dashed else "-"))
    ax.text(pts[0][0] + 0.12, pts[0][1] - 0.32 if pts[1][1] < pts[0][1] else pts[0][1] + 0.12, "1", fontsize=10, color="#d92d20", fontweight="bold")
    ax.text(pts[-1][0] - 0.3, pts[-1][1] + 0.22 if pts[-2][1] > pts[-1][1] else pts[-1][1] - 0.3, "N", fontsize=10, color="#d92d20", fontweight="bold")
    if lab:
        ax.text(lab_at[0], lab_at[1], lab, fontsize=9, color="#475467", ha="center", bbox=dict(fc="white", ec="none", pad=1), zorder=9)

line([(4.7, 8.48), (5.6, 8.48)])                                     # users → imports
line([(9.8, 8.0), (11.2, 8.0)])                                      # imports → transactions
line([(2.6, 9.2), (2.6, 9.85), (13.3, 9.85), (13.3, 9.2)], dashed=True, lab="user_id (소유자 조건)", lab_at=(8.0, 9.85))
line([(2.6, 7.76), (2.6, 4.2)])                                      # users → merchant_rules
line([(4.7, 7.95), (5.2, 7.95), (5.2, 4.7), (7.7, 4.7), (7.7, 4.2)])  # users → budgets
line([(4.7, 7.8), (4.95, 7.8), (4.95, 1.0), (13.3, 1.0), (13.3, 1.56)])  # users → dismissals

for name, (x, y, cols) in T.items():
    h = HEAD + ROW * len(cols)
    ax.add_patch(FancyBboxPatch((x, y - h), W, h, boxstyle="round,pad=0.02,rounding_size=0.12", fc="white", ec=EDGE, lw=2, zorder=3))
    ax.add_patch(FancyBboxPatch((x, y - HEAD), W, HEAD, boxstyle="round,pad=0.02,rounding_size=0.12", fc=EDGE, ec=EDGE, lw=2, zorder=4))
    ax.text(x + W / 2, y - HEAD / 2, name, color="white", fontsize=13, fontweight="bold", ha="center", va="center", zorder=5)
    for i, (k, c) in enumerate(cols):
        yy = y - HEAD - ROW * (i + 0.5)
        if k:
            ax.text(x + 0.15, yy, k, fontsize=9, color="#b42318" if "PK" in k else "#175cd3", fontweight="bold", va="center", zorder=5)
        ax.text(x + 1.15, yy, c, fontsize=10.5, color="#1b2430", va="center", zorder=5)

out = Path(__file__).resolve().parent.parent / "docs" / "images" / "erd.png"
out.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(out, dpi=110, bbox_inches="tight", facecolor="white")
print("saved", out)
