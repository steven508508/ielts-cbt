#!/usr/bin/env python3
"""產生示範試卷缺的兩張圖。

samples/full-paper-academic.json 裡把這兩張圖描述得很細，但圖本身要另外上傳
（uploads/ 沒有進版控）。示範站不能少這兩張 —— 寫作 Task 1 沒有圖表就無題可
答，聽力 Section 2 的地圖標示題也一樣。所以照著 visualDescription 產出來。

    python3 scripts/build-demo-images.py

輸出：demo/images/task1-chart.png、demo/images/section2-map.png
"""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, Ellipse, FancyArrow, Circle
import numpy as np

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "demo", "images")
os.makedirs(OUT, exist_ok=True)

# 兩個系列的顏色跑過 dataviz 的驗證器：亮度與彩度都在範圍內，色盲分離度
# ΔE 28.6（protan）／31.9（tritan），一般視覺 35.5。對比度低於 3:1 的那一項
# 由「每根長條上都印數值 + 圖例」補足，所以辨識不只靠顏色。
BLUE = "#2E6FB7"
ORANGE = "#F0A04B"
INK = "#1a1a1a"
MUTED = "#6b6b6b"
GRID = "#d8d8d8"

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 11,
    "axes.edgecolor": "#9a9a9a",
})


def task1_chart():
    cats = ["Car", "Bus", "Train", "Bicycle"]
    y2000 = [55, 22, 13, 10]
    y2020 = [38, 18, 26, 18]
    assert sum(y2000) == 100 and sum(y2020) == 100, "每一年四個數字要剛好加總 100%"

    x = np.arange(len(cats))
    w = 0.36

    fig, ax = plt.subplots(figsize=(7.6, 4.9), dpi=150)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")

    # 2px 的底色縫隙：相鄰長條之間留白，不要黏在一起
    b1 = ax.bar(x - w / 2 - 0.012, y2000, w, label="2000", color=BLUE, zorder=3)
    b2 = ax.bar(x + w / 2 + 0.012, y2020, w, label="2020", color=ORANGE, zorder=3)

    for bars in (b1, b2):
        for r in bars:
            ax.text(r.get_x() + r.get_width() / 2, r.get_height() + 1.1,
                    f"{int(r.get_height())}%", ha="center", va="bottom",
                    fontsize=10, color=INK, zorder=4)

    ax.set_title("How commuters travelled to work in Riverton, 2000 and 2020",
                 fontsize=12.5, color=INK, pad=14)
    ax.set_ylabel("Percentage of commuters (%)", fontsize=11, color=INK)
    ax.set_ylim(0, 60)
    ax.set_yticks(range(0, 61, 10))
    ax.set_xticks(x)
    ax.set_xticklabels(cats)
    ax.tick_params(colors=MUTED, length=0)
    for lbl in ax.get_xticklabels():
        lbl.set_color(INK)

    ax.yaxis.grid(True, color=GRID, linewidth=0.9, zorder=0)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color("#9a9a9a")

    ax.legend(loc="upper right", frameon=False, fontsize=11)

    fig.tight_layout()
    p = os.path.join(OUT, "task1-chart.png")
    fig.savefig(p, facecolor="white")
    plt.close(fig)
    return p


def section2_map():
    fig, ax = plt.subplots(figsize=(7.4, 6.4), dpi=150)
    fig.patch.set_facecolor("white")
    ax.set_facecolor("#fbfbf7")
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.set_aspect("equal")
    ax.axis("off")

    ax.add_patch(Rectangle((1, 1), 98, 98, fill=False, ec="#8a8a8a", lw=1.4))

    # 湖
    lake = Ellipse((50, 58), 38, 46, facecolor="#cfe3f2", ec="#7fa8c9", lw=1.3, zorder=2)
    ax.add_patch(lake)
    ax.text(50, 58, "Lake", ha="center", va="center", fontsize=11,
            color="#3d6c92", style="italic", zorder=3)

    # 小溪：從西北角流進來
    sx = [3, 9, 15, 20, 25, 30, 34]
    sy = [97, 92, 88, 84, 79, 74, 70]
    ax.plot(sx, sy, color="#7fa8c9", lw=2.2, zorder=2, solid_capstyle="round")
    # 標籤放在小溪中段，不要壓到西北角的 H
    ax.text(19, 77.5, "Stream", fontsize=9.5, color="#3d6c92", rotation=-38, style="italic")

    # 沼澤：在東北、湖與東側步道之間，這樣 E 才會是「隔著沼澤」而不是站在沼澤上
    for mx, my in [(64, 81), (68, 84), (61, 84), (70, 80)]:
        ax.add_patch(Ellipse((mx, my), 7, 3.4, facecolor="#cfe0cd", ec="#8fae8b", lw=0.8, zorder=2))
    ax.text(60, 89, "Marsh", fontsize=9.5, color="#5d7a59", style="italic")

    # 樹（西岸）
    for tx, ty in [(19, 52), (17, 60), (21, 66), (16, 46), (22, 58), (18, 70)]:
        ax.add_patch(Circle((tx, ty), 2.3, facecolor="#cfe0cd", ec="#7f9c7b", lw=0.8, zorder=2))

    # 路徑：從遊客中心分東西兩條繞湖，在北端會合
    west = [(46, 25), (36, 28), (29, 34), (26, 44), (24, 58), (27, 72), (36, 84), (50, 88)]
    east = [(54, 25), (63, 29), (70, 36), (75, 47), (76, 58), (74, 72), (64, 84), (50, 88)]
    for pts, name, lx, ly, rot in ((west, "West Path", 20, 40, 74), (east, "East Path", 81, 42, -70)):
        ax.plot([p[0] for p in pts], [p[1] for p in pts], color="#a08a63", lw=2.6,
                ls=(0, (6, 3)), zorder=3, solid_capstyle="round")
        ax.text(lx, ly, name, fontsize=9.5, color="#7a6748", rotation=rot, style="italic")

    # 建築與停車場
    ax.add_patch(Rectangle((41, 15), 18, 9, facecolor="#e8e2d4", ec="#8a8a8a", lw=1.2, zorder=4))
    ax.text(50, 19.5, "Visitor\nCentre", ha="center", va="center", fontsize=9.5, color=INK, zorder=5)
    ax.add_patch(Rectangle((36, 3), 28, 8, facecolor="#eeeeee", ec="#8a8a8a", lw=1.1, zorder=4))
    ax.text(50, 7, "Car park", ha="center", va="center", fontsize=9.5, color=INK, zorder=5)
    ax.annotate("", xy=(50, 14.6), xytext=(50, 11.2),
                arrowprops=dict(arrowstyle="-|>", color="#5a5a5a", lw=1.3), zorder=5)
    ax.text(66.5, 7, "Main\nentrance", ha="left", va="center", fontsize=8.5, color=MUTED)

    # A–H 標點
    # 位置照 instructions 裡對 A–H 的描述擺，A–H 都要落在該落的步道上
    marks = {
        "A": (24, 15), "B": (28.5, 37), "C": (23, 58), "D": (50, 88),
        "E": (73, 74), "F": (77, 58), "G": (61.5, 30), "H": (8, 92),
    }
    for letter, (px, py) in marks.items():
        ax.add_patch(Circle((px, py), 3.1, facecolor="white", ec=BLUE, lw=1.9, zorder=6))
        ax.text(px, py, letter, ha="center", va="center", fontsize=11,
                fontweight="bold", color=BLUE, zorder=7)

    # 描述裡特別提到的兩個地物
    ax.plot([26.6, 30.4], [33.6, 33.6], color="#7a6748", lw=2.2, zorder=5)
    ax.text(32, 33, "bench", fontsize=8.2, color=MUTED, va="center")
    ax.plot([46.6, 46.6], [86.4, 91.2], color="#7a6748", lw=1.8, zorder=5)
    ax.plot([44.4, 46.6], [91.2, 91.2], color="#7a6748", lw=1.8, zorder=5)
    ax.text(41.6, 92.6, "signpost", fontsize=8.2, color=MUTED, ha="center")

    # 指北針與比例尺
    ax.add_patch(FancyArrow(93, 86, 0, 7, width=0.5, head_width=2.6, head_length=2.6,
                            color=INK, zorder=6))
    ax.text(93, 82.5, "N", ha="center", fontsize=11, fontweight="bold", color=INK)
    # 比例尺挪到左下，不要跟「Main entrance」擠在同一角
    ax.plot([7, 22], [6, 6], color=INK, lw=1.6)
    for xx in (7, 22):
        ax.plot([xx, xx], [4.8, 7.2], color=INK, lw=1.6)
    ax.text(14.5, 8.2, "100 m", ha="center", fontsize=8.6, color=MUTED)

    ax.set_title("Bramblewood Nature Reserve", fontsize=12.5, color=INK, pad=10)
    fig.tight_layout()
    p = os.path.join(OUT, "section2-map.png")
    fig.savefig(p, facecolor="white")
    plt.close(fig)
    return p


for path in (task1_chart(), section2_map()):
    print(f"  {os.path.relpath(path)}  {os.path.getsize(path) // 1024} KB")
print("完成 → demo/images/")
