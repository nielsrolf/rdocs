"""
Build script: Africa GDP per capita vs Population scatter plot
Output: assets/africa_gdp_scatter.png
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import numpy as np

# Data: (country, gdp_total_bn, population_M, gdp_per_capita)
data = [
    ("Nigeria",       477, 223, 2140),
    ("Egypt",         396, 105, 3770),
    ("South Africa",  377,  60, 6290),
    ("Algeria",       239,  45, 5300),
    ("Ethiopia",      156, 127, 1230),
    ("Morocco",       142,  37, 3840),
    ("Kenya",         118,  54, 2190),
    ("Angola",         84,  34, 2470),
    ("Tanzania",       79,  63, 1255),
    ("Côte d'Ivoire",  78,  27, 2890),
    ("Ghana",          76,  33, 2300),
    ("DR Congo",       67, 100,  670),
    ("Libya",          38,   7, 5430),
    ("Uganda",         48,  47, 1020),
    ("Cameroon",       46,  28, 1640),
    ("Tunisia",        46,  12, 3840),
    ("Sudan",          30,  46,  650),
    ("Senegal",        28,  17, 1650),
    ("Zambia",         28,  19, 1470),
    ("Zimbabwe",       26,  16, 1625),
]

names   = [d[0] for d in data]
gdp_tot = [d[1] for d in data]
pop     = [d[2] for d in data]
gdp_pc  = [d[3] for d in data]

def tier_color(pc):
    if pc >= 4000:
        return "#2ecc71"   # high – green
    elif pc >= 2000:
        return "#3498db"   # mid  – blue
    else:
        return "#e74c3c"   # low  – red

colors = [tier_color(pc) for pc in gdp_pc]
sizes  = [g * 0.9 for g in gdp_tot]   # bubble size ∝ total GDP

fig, ax = plt.subplots(figsize=(11, 7))
ax.scatter(pop, gdp_pc, s=sizes, c=colors, alpha=0.75,
           edgecolors="white", linewidths=0.8, zorder=3)

# Label offsets to reduce clutter
label_offsets = {
    "Nigeria":       ( 4, -200),
    "Egypt":         ( 4,   90),
    "South Africa":  ( 2,  110),
    "Ethiopia":      ( 4,   70),
    "DR Congo":      ( 4,   70),
    "Libya":         (-4,   90),
    "Tunisia":       ( 2,   90),
    "Algeria":       ( 3,   90),
}

for name, x, y in zip(names, pop, gdp_pc):
    dx, dy = label_offsets.get(name, (4, 60))
    use_arrow = abs(dy) > 55
    ax.annotate(
        name, xy=(x, y),
        xytext=(dx, dy), textcoords="offset points",
        fontsize=8.2, color="#333333",
        arrowprops=dict(arrowstyle="-", color="#bbbbbb", lw=0.6) if use_arrow else None,
    )

# Tier legend
from matplotlib.lines import Line2D
legend_elements = [
    Line2D([0],[0], marker='o', color='w', label='GDP/capita ≥ $4,000',
           markerfacecolor='#2ecc71', markersize=11),
    Line2D([0],[0], marker='o', color='w', label='GDP/capita $2,000–3,999',
           markerfacecolor='#3498db', markersize=11),
    Line2D([0],[0], marker='o', color='w', label='GDP/capita < $2,000',
           markerfacecolor='#e74c3c', markersize=11),
]
ax.legend(handles=legend_elements, loc="upper right", fontsize=9, framealpha=0.9)
ax.text(0.01, 0.98, "Bubble size ∝ total GDP (USD bn)",
        transform=ax.transAxes, fontsize=8.5, va="top", color="#666666")

ax.set_xlabel("Population (millions)", fontsize=11)
ax.set_ylabel("GDP per Capita (USD)", fontsize=11)
ax.set_title("Top-20 African Economies: GDP per Capita vs Population (2023)",
             fontsize=13, fontweight="bold", pad=14)
ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"${v:,.0f}"))
ax.grid(True, linestyle="--", alpha=0.4, zorder=0)
ax.set_xlim(-10, 250)
ax.set_ylim(0, 7400)

plt.tight_layout()
plt.savefig("assets/africa_gdp_scatter.png", dpi=150, bbox_inches="tight")
print("Saved: assets/africa_gdp_scatter.png")
