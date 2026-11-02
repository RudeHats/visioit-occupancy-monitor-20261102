"""Normalized seat geometry and full-resolution crop mapping."""
from dataclasses import dataclass
import cv2
import numpy as np
from .config import ApiError

def _orient(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(p1, p2, p3, p4) -> bool:
    d1, d2, d3, d4 = _orient(p3, p4, p1), _orient(p3, p4, p2), _orient(p1, p2, p3), _orient(p1, p2, p4)
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def polygon_area(poly) -> float:
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def validate_polygon(poly) -> list[tuple[float, float]]:
    if not (3 <= len(poly) <= 12):
        raise ApiError("ROI_INVALID", "Region needs 3 to 12 points", status=422)
    pts = [(float(x), float(y)) for x, y in poly]
    if any(not (0 <= x <= 1 and 0 <= y <= 1) for x, y in pts):
        raise ApiError("ROI_INVALID", "Coordinates must be normalized to [0,1]", status=422)
    if polygon_area(pts) < 0.005:
        raise ApiError("ROI_INVALID", "Region is smaller than 0.5% of the frame", status=422)
    n = len(pts)
    for i in range(n):
        for j in range(i + 1, n):
            if abs(i - j) in (1, n - 1):
                continue  # adjacent edges share a vertex
            if _segments_cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]):
                raise ApiError("ROI_INVALID", "Region edges cross each other", status=422)
    return pts


@dataclass
class Crop:
    img: np.ndarray        # BGR crop (padded bbox of the polygon, NOT masked, context helps detection)
    mask: np.ndarray       # uint8, 255 inside the polygon, same size as img
    x0: int
    y0: int
    frame_w: int
    frame_h: int


def make_crop(frame: np.ndarray, poly_norm, padding: float) -> Crop:
    """Always denormalize against the size of the frame being processed, never a preview size."""
    h, w = frame.shape[:2]
    pts = np.array([[round(x * (w - 1)), round(y * (h - 1))] for x, y in poly_norm], dtype=np.int32)
    bx1, by1 = pts.min(axis=0); bx2, by2 = pts.max(axis=0)
    px, py = int((bx2 - bx1) * padding), int((by2 - by1) * padding)
    x0, y0 = max(0, bx1 - px), max(0, by1 - py)
    x1, y1 = min(w, bx2 + px + 1), min(h, by2 + py + 1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ApiError("ROI_INVALID", "Region is too small in pixels", status=422)
    mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.fillPoly(mask, [pts - np.array([x0, y0], dtype=np.int32)], 255)
    return Crop(frame[y0:y1, x0:x1], mask, int(x0), int(y0), w, h)


# ───────────────────────────── device selection ─────────────────────────────
