"""Core tests: no FastAPI, no model weights, no camera needed. Run: pytest -q  (or python test_core.py)"""
import time
import numpy as np
import cv2
from app import (Settings, SeatTracker, ApiError, validate_polygon, make_crop, decide, Crop,
                 Runtime, SimulatedBlobAdapter, SourceSpec, DEMO_POLY, frame_valid, mask_url)

FAST = Settings(vacancy_seconds=10, cooldown_seconds=60, smoothing_tau_s=1.0, confirm_s=1.0,
                uncertain_hold_s=2.0, show_transition_s=0.5, recovery_grace_s=3.0)


def drive(tr, s, t0, seconds, raw, fps=5, cam=True, model=True):
    """Feed one observation per frame; return (events, t_end)."""
    ev, t = [], t0
    for _ in range(int(seconds * fps)):
        t += 1 / fps
        ev += tr.step(t, s, cam, model, raw)
    return ev, t


def test_polygon_validation():
    validate_polygon([(0.1, 0.1), (0.5, 0.1), (0.5, 0.5), (0.1, 0.5)])
    for bad in ([(0.1, 0.1), (0.5, 0.5), (0.5, 0.1), (0.1, 0.5)],            # bow-tie
                [(0.1, 0.1), (0.11, 0.1), (0.11, 0.11)],                      # tiny
                [(0.1, 0.1), (1.5, 0.1), (0.5, 0.5)],                         # out of range
                [(0.1, 0.1), (0.2, 0.2)]):                                    # too few
        try: validate_polygon(bad); assert False, bad
        except ApiError as e: assert e.code == "ROI_INVALID"


def test_crop_is_resolution_independent():
    """Same normalized ROI must hit the same scene content at any frame size."""
    for w, h in [(1280, 720), (640, 360), (1920, 1080)]:
        f = np.zeros((h, w, 3), np.uint8)
        cv2.rectangle(f, (int(.40 * w), int(.40 * h)), (int(.60 * w), int(.60 * h)), (0, 255, 0), -1)
        c = make_crop(f, [(0.35, 0.35), (0.65, 0.35), (0.65, 0.65), (0.35, 0.65)], 0.10)
        center = c.img[c.img.shape[0] // 2, c.img.shape[1] // 2]
        assert tuple(center) == (0, 255, 0), (w, h)
        green_frac = (c.img[:, :, 1] == 255).mean()
        assert 0.25 < green_frac < 0.55, (w, h, green_frac)


def test_box_maps_back_to_frame():
    f = np.random.default_rng(1).integers(0, 255, (720, 1280, 3), dtype=np.uint8)
    c = make_crop(f, [(0.5, 0.5), (0.7, 0.5), (0.7, 0.9), (0.5, 0.9)], 0.0)
    obs = decide(np.array([[0, 0, 10, 10]], np.float32), np.array([0.9], np.float32), c, Settings())
    nx = obs.boxes[0]["xyxy_norm"]
    assert abs(nx[0] - c.x0 / 1280) < 1e-3 and abs(nx[1] - c.y0 / 720) < 1e-3


def test_decide_overlap_logic():
    s = Settings(); img = np.random.default_rng(0).integers(0, 255, (100, 100, 3), dtype=np.uint8)
    mask = np.zeros((100, 100), np.uint8); mask[:, :50] = 255                # left half is the seat
    c = Crop(img, mask, 0, 0, 100, 100)
    inside = decide(np.array([[5, 5, 45, 95]], np.float32), np.array([0.9], np.float32), c, s)
    beside = decide(np.array([[60, 5, 95, 95]], np.float32), np.array([0.9], np.float32), c, s)
    weak = decide(np.array([[5, 5, 45, 95]], np.float32), np.array([0.3], np.float32), c, s)
    nobody = decide(np.zeros((0, 4), np.float32), np.zeros((0,), np.float32), c, s)
    assert inside.raw == "occupied"
    assert beside.raw == "vacant"      # person NEAR the chair is not an occupied chair
    assert weak.raw == "uncertain"
    assert nobody.raw == "vacant"
    dark = Crop(np.zeros((100, 100, 3), np.uint8), mask, 0, 0, 100, 100)
    assert decide(np.zeros((0, 4), np.float32), np.zeros((0,), np.float32), dark, s).raw == "uncertain"  # dark != empty


def test_single_bad_frame_never_alerts_and_one_alert_per_episode():
    tr, t = SeatTracker("s"), 0.0
    ev, t = drive(tr, FAST, t, 6, "occupied"); assert tr.state == "occupied"
    ev, t = drive(tr, FAST, t, 1 / 5, "vacant")                               # one wrong frame
    ev2, t = drive(tr, FAST, t, 5, "occupied")
    assert tr.state == "occupied" and not [e for e in ev + ev2 if e["type"] == "vacancy_confirmed"]
    ev, t = drive(tr, FAST, t, 40, "vacant")
    alerts = [e for e in ev if e["type"] == "vacancy_confirmed"]
    assert len(alerts) == 1, alerts                                          # deduped; cooldown (60s) not reached
    ev, t = drive(tr, FAST, t, 45, "vacant")                                 # now >60s since alert
    assert len([e for e in ev if e["type"] == "vacancy_confirmed"]) == 1     # cooldown re-alert
    _, t = drive(tr, FAST, t, 6, "occupied")
    ev, t = drive(tr, FAST, t, 20, "vacant")
    assert len([e for e in ev if e["type"] == "vacancy_confirmed"]) == 1     # new episode -> new alert


def test_camera_loss_is_never_vacancy():
    tr, t = SeatTracker("s"), 0.0
    _, t = drive(tr, FAST, t, 6, "vacant")                                    # vacancy timer running
    assert tr.state == "vacant" and tr.vacant_for(t) > 0
    ev, t = drive(tr, FAST, t, 120, None, cam=False)                          # camera gone for 2 minutes
    assert tr.state == "camera_unavailable" and tr.vacant_for(t) == 0
    assert not [e for e in ev if e["type"] == "vacancy_confirmed"]
    ev, t = drive(tr, FAST, t, 2, "vacant")                                   # recovered: grace period
    assert tr.state == "transitioning" and not ev
    ev, t = drive(tr, FAST, t, 30, "vacant")
    first = [e for e in ev if e["type"] == "vacancy_confirmed"]
    assert len(first) == 1 and first[0]["vacant_duration_s"] >= 10            # had to re-earn the full duration


def test_model_error_is_never_vacancy():
    tr, t = SeatTracker("s"), 0.0
    _, t = drive(tr, FAST, t, 6, "vacant")
    ev, t = drive(tr, FAST, t, 60, None, model=False)
    assert tr.state == "model_error" and not ev and tr.confidence is None


def test_uncertain_pauses_timer_and_no_instant_flip():
    tr, t = SeatTracker("s"), 0.0
    _, t = drive(tr, FAST, t, 6, "vacant")
    _, t = drive(tr, FAST, t, 5, "uncertain")
    assert tr.state == "uncertain" and tr.vacant_for(t) == 0


def test_no_new_frame_is_not_evidence():
    tr, t = SeatTracker("s"), 0.0
    _, t = drive(tr, FAST, t, 6, "occupied")
    ema = tr.ema
    _, t = drive(tr, FAST, t, 30, None)                                       # time passes, camera "ok", no new frames
    assert abs(tr.ema - ema) < 1e-9 and tr.state == "occupied"


def test_helpers():
    assert not frame_valid(np.zeros((50, 50, 3), np.uint8)) and not frame_valid(None)
    assert "secret" not in mask_url("rtsp://admin:secret@10.0.0.5:554/s1")


def test_end_to_end_synthetic_pipeline():
    """Real crop + real timing + whole pipeline, with the simulated detector (flagged simulated)."""
    s = Settings(vacancy_seconds=2, smoothing_tau_s=0.4, confirm_s=0.5, uncertain_hold_s=1.0,
                 show_transition_s=0.3, target_inference_fps=10, stale_timeout_s=2.0)
    rt = Runtime(s, SimulatedBlobAdapter(), demo=True)
    rt.load_model(); rt.upsert_seat("seat-1", "Demo seat", DEMO_POLY)
    import app as A
    orig = A.SyntheticSource.__init__
    A.SyntheticSource.__init__ = lambda self, **kw: orig(self, present_s=3.5, absent_s=9.0, fps=15.0)
    try:
        rt.start(); rt.camera.start(SourceSpec("synthetic"))
        deadline, seen = time.monotonic() + 16, set()
        while time.monotonic() < deadline and "vacancy_confirmed" not in seen:
            seen = {e["type"] for e in rt.events}; time.sleep(0.2)
        types = [e["type"] for e in rt.events]
        assert rt.simulated and all(e["simulated"] for e in rt.events)
        assert "seat_occupied" in types and "seat_vacant" in types, types
        assert types.count("vacancy_confirmed") == 1, types
        m = rt.metrics()
        assert m["inference_ms"]["p50"] is not None and m["processing_fps"] and m["capture_fps"]
        rt.camera.stop(); time.sleep(3.5)                                     # kill the source mid-run
        assert rt.seats["seat-1"].tracker.state == "camera_unavailable"
        assert "camera_unavailable" in [e["type"] for e in rt.events]
        assert types.count("vacancy_confirmed") == [e["type"] for e in rt.events].count("vacancy_confirmed")
        print("e2e metrics:", {k: m[k] for k in ("capture_fps", "processing_fps", "inference_ms")})
    finally:
        A.SyntheticSource.__init__ = orig; rt.shutdown()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn(); print("PASS", name)