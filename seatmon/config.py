"""Validated runtime settings and API errors."""
from dataclasses import dataclass
CONTRACT_VERSION, BACKEND_VERSION = "1.0", "0.2.0"

@dataclass
class Settings:
    vacancy_seconds: float = 10.0       # 300 is typical in production
    cooldown_seconds: float = 120.0
    occupied_conf: float = 0.45
    low_conf: float = 0.20
    min_overlap_occ: float = 0.35       # share of the person box inside the ROI polygon
    min_overlap_any: float = 0.05
    enter_occupied: float = 0.60        # hysteresis band on the smoothed score
    exit_occupied: float = 0.35
    smoothing_tau_s: float = 1.5        # time-constant EMA: independent of FPS
    confirm_s: float = 1.0              # threshold must be crossed this long to flip
    show_transition_s: float = 0.6
    uncertain_hold_s: float = 2.0
    uncertain_warn_seconds: float = 30.0
    stale_timeout_s: float = 3.0
    recovery_grace_s: float = 3.0
    crop_padding: float = 0.10
    target_inference_fps: float = 15.0
    min_sharpness: float = 1.0
    inference_mode: str = "auto"  # auto: shared full-frame pass for >=4 seats
    batch_size: int = 8
    environment: str = "standard"  # standard | low_light | fast_motion
    preview_fps: float = 15.0
    preview_max_edge: int = 960
    jpeg_quality: int = 75

    def validate(self) -> None:
        checks = [
            (1 <= self.vacancy_seconds <= 86400, "vacancy_seconds"),
            (0 <= self.cooldown_seconds <= 86400, "cooldown_seconds"),
            (0 < self.low_conf < self.occupied_conf <= 1, "low_conf/occupied_conf"),
            (0 < self.exit_occupied < self.enter_occupied < 1, "exit/enter_occupied"),
            (0.1 <= self.smoothing_tau_s <= 30, "smoothing_tau_s"),
            (0.5 <= self.stale_timeout_s <= 60, "stale_timeout_s"),
            (0 <= self.crop_padding <= 1, "crop_padding"),
            (0.2 <= self.target_inference_fps <= 30, "target_inference_fps"),
            (self.inference_mode in ("auto", "roi_crop", "full_frame"), "inference_mode"),
            (1 <= self.batch_size <= 32, "batch_size"),
            (self.environment in ("standard", "low_light", "fast_motion"), "environment"),
            (1 <= self.preview_fps <= 30, "preview_fps"),
            (320 <= self.preview_max_edge <= 1920, "preview_max_edge"),
            (40 <= self.jpeg_quality <= 95, "jpeg_quality"),
        ]
        bad = [n for ok, n in checks if not ok]
        if bad:
            raise ApiError("SETTINGS_INVALID", f"Invalid: {', '.join(bad)}", status=422)


class ApiError(Exception):
    def __init__(self, code: str, message: str, hint: str = "", status: int = 400, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.hint, self.status, self.retryable = code, message, hint, status, retryable


# ───────────────────────────── ROI + crop ─────────────────────────────
