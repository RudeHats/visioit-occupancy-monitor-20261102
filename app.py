"""Compatibility entry point. Implementation lives in the seatmon package."""
import dataclasses
from seatmon.config import Settings, ApiError, CONTRACT_VERSION, BACKEND_VERSION
from seatmon.geometry import Crop, polygon_area, validate_polygon, make_crop
from seatmon.models import Adapter, SimulatedBlobAdapter, YoloAdapter, pick_device
from seatmon.decisions import Observation, SeatTracker, crop_quality, decide
from seatmon.camera import Frame, SourceSpec, SyntheticSource, CvSource, FfmpegGatewaySource, CameraManager, frame_valid, mask_url, run_with_deadline, render_no_signal, ffmpeg_executable
from seatmon.telemetry import Hub, pct, hardware_info, _iso
from seatmon.runtime import Runtime, Seat, DEMO_POLY
from seatmon.web import SourceReq, SourceTestReq, SeatReq, create_app
from seatmon.cli import parse_source, main

if __name__ == "__main__":
    main()
