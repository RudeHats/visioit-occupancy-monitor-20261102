"""Image quality, occupancy evidence, and time-based seat tracking."""
import math
from dataclasses import dataclass
from typing import Optional
import cv2
import numpy as np
from .config import Settings
from .geometry import Crop


def prepare_image(image, environment):
    """Improve usable low-light contrast; quality gates still inspect the original."""
    if environment != "low_light": return image
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lab[:, :, 0])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

@dataclass
class Observation:
    raw: str                 # occupied | vacant | uncertain
    person_conf: float
    overlap: float
    boxes: list[dict]
    quality: dict
    inference_ms: float = 0.0


def crop_quality(img: np.ndarray, s: Settings) -> dict:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bright, sharp = float(g.mean()), float(cv2.Laplacian(g, cv2.CV_32F).var())
    return {"brightness": round(bright, 1), "blur": round(sharp, 1),
            "ok": 15 <= bright <= 245 and sharp >= s.min_sharpness}


def decide(boxes: np.ndarray, scores: np.ndarray, crop: Crop, s: Settings) -> Observation:
    q = crop_quality(crop.img, s)
    best_conf, best_ov, any_cand, occ = 0.0, 0.0, False, False
    out = []
    for (x1, y1, x2, y2), sc in zip(boxes, scores):
        xa, ya = max(0, int(x1)), max(0, int(y1))
        xb, yb = min(crop.mask.shape[1], int(x2)), min(crop.mask.shape[0], int(y2))
        area = max(1.0, float((x2 - x1) * (y2 - y1)))
        inter = float(np.count_nonzero(crop.mask[ya:yb, xa:xb])) if xb > xa and yb > ya else 0.0
        ov = inter / area                      # share of the PERSON inside the seat polygon
        out.append({"cls": "person", "conf": round(float(sc), 3),
                    "xyxy_norm": [round(float((x1 + crop.x0) / crop.frame_w), 4), round(float((y1 + crop.y0) / crop.frame_h), 4),
                                  round(float((x2 + crop.x0) / crop.frame_w), 4), round(float((y2 + crop.y0) / crop.frame_h), 4)]})
        if ov >= s.min_overlap_any and sc >= s.low_conf:
            any_cand = True
            if sc > best_conf:
                best_conf, best_ov = float(sc), ov
            if sc >= s.occupied_conf and ov >= s.min_overlap_occ:
                occ = True
    if not q["ok"]:
        raw = "uncertain"                      # bad image must never read as "vacant"
    elif occ:
        raw = "occupied"
    elif any_cand:
        raw = "uncertain"
    else:
        raw = "vacant"
    return Observation(raw, best_conf, best_ov, out, q)


# ───────────────────────────── seat state machine ─────────────────────────────
class SeatTracker:
    """Time-constant EMA + hysteresis + confirmation window + vacancy timer + alert dedupe.
    step() takes `now` explicitly, so tests drive it with a fake clock."""

    def __init__(self, seat_id: str):
        self.seat_id = seat_id
        self.reset_evidence()
        self.state = "transitioning"
        self.episode = 0
        self.alerted_at: Optional[float] = None
        self._fault: Optional[str] = None
        self._recover_until = 0.0
        self.last_t: Optional[float] = None
        self.uncertain_warned = False

    def reset_evidence(self):
        self.ema, self.stable = 0.5, None
        self.cross_target, self.cross_since = None, 0.0
        self.disagree_since: Optional[float] = None
        self.uncertain_since: Optional[float] = None
        self.vacant_since: Optional[float] = None

    @property
    def confidence(self) -> Optional[float]:
        return round(max(self.ema, 1 - self.ema), 3) if self.state in ("occupied", "vacant") else None

    def vacant_for(self, now: float) -> float:
        return 0.0 if self.vacant_since is None else max(0.0, now - self.vacant_since)

    def step(self, now: float, s: Settings, cam_ok: bool, model_ok: bool, raw: Optional[str]) -> list[dict]:
        ev: list[dict] = []
        if not (cam_ok and model_ok):
            fault = "camera_unavailable" if not cam_ok else "model_error"
            if self._fault != fault:
                self.reset_evidence()          # drop all vacancy progress; faults never become vacancy
                self._fault = fault
            self.state, self.last_t = fault, now
            return ev
        if self._fault:                        # just recovered: distrust the first seconds
            self._fault, self._recover_until = None, now + s.recovery_grace_s
        if now < self._recover_until:
            self.state, self.last_t = "transitioning", now
            return ev

        dt = 0.0 if self.last_t is None else min(now - self.last_t, 1.0)
        self.last_t = now
        if raw in ("occupied", "vacant"):
            a = 1 - math.exp(-dt / s.smoothing_tau_s)
            self.ema += a * ((1.0 if raw == "occupied" else 0.0) - self.ema)
            self.uncertain_since = None
            self.uncertain_warned = False
        elif raw == "uncertain" and self.uncertain_since is None:
            self.uncertain_since = now

        target = "occupied" if self.ema >= s.enter_occupied else "vacant" if self.ema <= s.exit_occupied else None
        if target and target != self.stable:
            if self.cross_target != target:
                self.cross_target, self.cross_since = target, now
            elif now - self.cross_since >= s.confirm_s:
                prev, self.stable, self.cross_target = self.stable, target, None
                if target == "vacant":
                    self.episode += 1
                    self.alerted_at = None
                ev.append({"type": "seat_vacant" if target == "vacant" else "seat_occupied",
                           "severity": "info", "message": f"Seat {target}", "prev": prev})
        else:
            self.cross_target = None

        if raw in ("occupied", "vacant") and self.stable and raw != self.stable:
            self.disagree_since = self.disagree_since or now
        elif raw in ("occupied", "vacant"):
            self.disagree_since = None

        if self.stable is None:
            rep = "transitioning"
        elif self.uncertain_since is not None and now - self.uncertain_since >= s.uncertain_hold_s:
            rep = "uncertain"
        elif self.disagree_since is not None and now - self.disagree_since >= s.show_transition_s:
            rep = "transitioning"
        else:
            rep = self.stable
        self.state = rep

        if rep == "vacant":
            self.vacant_since = self.vacant_since if self.vacant_since is not None else now
        else:
            self.vacant_since = None           # any non-vacant state restarts the confirmation clock

        if rep == "uncertain" and not self.uncertain_warned and self.uncertain_since is not None \
                and now - self.uncertain_since >= s.uncertain_warn_seconds:
            self.uncertain_warned = True
            ev.append({"type": "seat_uncertain", "severity": "warning",
                       "message": f"Uncertain for {s.uncertain_warn_seconds:.0f}s"})

        if rep == "vacant" and self.vacant_for(now) >= s.vacancy_seconds and \
                (self.alerted_at is None or now - self.alerted_at >= s.cooldown_seconds):
            self.alerted_at = now
            ev.append({"type": "vacancy_confirmed", "severity": "critical",
                       "message": f"Seat vacant for {self.vacant_for(now):.0f} s (threshold {s.vacancy_seconds:.0f} s)",
                       "vacant_duration_s": round(self.vacant_for(now), 1), "episode_id": f"ep_{self.episode}"})
        return ev


# ───────────────────────────── camera layer ─────────────────────────────
