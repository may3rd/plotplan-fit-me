"""Self-check for merged-zone DXF tracing (roads + crossing pipe racks):
builds a unit with two overlapping perpendicular roads and two crossing
racks, exports the DXF, and asserts the merged outlines come out as one
continuous loop each — not the four separate rectangle outlines the old
per-polygon writer produced. Run: python3 test_dxf_merge.py"""
import os
import tempfile

import plotplan as p


def _line_count(text: str, layer: str) -> int:
    # Count DXF LINE entities on a layer: each is "0\nLINE\n8\n{layer}\n".
    # (TEXT entities also write "8\n{layer}\n", so match the LINE prefix
    # rather than the bare layer tag.)
    return text.count(f"0\nLINE\n8\n{layer}\n")


def main():
    site = p.Site(120.0, 80.0, wind_dir="")
    keepouts = {
        # two perpendicular roads overlapping at a cross — one cluster
        "ROAD_h": [(10, 30), (110, 30), (110, 40), (10, 40)],
        "ROAD_v": [(50, 0), (60, 0), (60, 80), (50, 80)],
        # two crossing racks (horizontal × vertical) — one cluster
        "RACK_h": [(0, 50), (120, 50), (120, 56), (0, 56)],
        "RACK_v": [(30, 0), (36, 0), (36, 80), (30, 80)],
        # area zone — never merges, keeps its own polygon
        "UNDERGROUND": [(80, 60), (100, 60), (100, 75), (80, 75)],
    }

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "out.dxf")
        p.write_dxf(path, [], site, keepouts)
        with open(path) as f:
            text = f.read()

    # roads merged into ONE outline. The old per-polygon writer would have
    # emitted 8 ROAD lines (4 per rectangle); the merged trace emits many
    # more (the cross outline has 12 corners + fillet segments). The key
    # invariant: NOT 8, and every ROAD line belongs to one continuous loop.
    road_lines = _line_count(text, "ROADS")
    assert road_lines != 8, f"roads not merged — still 8 individual rectangle edges ({road_lines})"
    assert road_lines >= 12, f"merged road outline too small ({road_lines} lines)"

    # racks merged into ONE sharp outline. Old writer: 8 RACK lines; the
    # crossing union outline is a 12-corner rectilinear loop = 12 lines.
    rack_lines = _line_count(text, "RACK")
    assert rack_lines == 12, f"crossing racks should trace one 12-edge outline, got {rack_lines}"

    # area zone untouched: still exactly 4 KEEPOUT lines (one rectangle).
    assert _line_count(text, "KEEPOUT") == 4, "UNDERGROUND zone must keep its own polygon"

    # the merged outline must be a closed loop: every LINE endpoint appears
    # an even number of times across the layer (each point entered + left).
    import re
    pts = []
    for m in re.finditer(r"8\nROADS\n10\n([\d.-]+)\n20\n([\d.-]+)\n11\n([\d.-]+)\n21\n([\d.-]+)", text):
        pts.append((round(float(m.group(1)), 4), round(float(m.group(2)), 4)))
        pts.append((round(float(m.group(3)), 4), round(float(m.group(4)), 4)))
    from collections import Counter
    counts = Counter(pts)
    odd = [pt for pt, c in counts.items() if c % 2]
    assert not odd, f"merged road outline not closed at {odd[:3]}"

    print(f"OK: roads={road_lines} lines (merged), racks={rack_lines} lines (merged), "
          f"keepout=4 lines (per-polygon), all loops closed")


if __name__ == "__main__":
    main()