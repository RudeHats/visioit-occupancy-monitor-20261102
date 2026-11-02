import io
import subprocess
import time
import cv2
import numpy as np
from fastapi.testclient import TestClient
from app import Runtime, Settings, SimulatedBlobAdapter, SourceSpec, FfmpegGatewaySource, ffmpeg_executable, create_app, DEMO_POLY


def test_real_ffmpeg_gateway_decodes_video_frames():
    gateway = FfmpegGatewaySource(SourceSpec('rtsp'))
    gateway.proc = subprocess.Popen([ffmpeg_executable(), '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=5', '-frames:v', '3',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        frames = [gateway.read() for _ in range(3)]
        assert all(frame is not None and frame.shape == (180, 320, 3) for frame in frames)
    finally:
        gateway.close()


def test_gateway_reads_fragmented_and_buffered_jpegs():
    image = np.random.default_rng(1).integers(0, 255, (100, 160, 3), dtype=np.uint8)
    ok, encoded = cv2.imencode('.jpg', image)
    assert ok
    class Process:
        stdout = io.BytesIO(encoded.tobytes() * 2)
    gateway = FfmpegGatewaySource(SourceSpec('rtsp', url='rtsp://example/live'))
    gateway.proc = Process()
    assert gateway.read().shape == image.shape
    assert gateway.read().shape == image.shape
    assert gateway.read() is None


def test_api_websocket_preview_and_source_lifecycle():
    rt = Runtime(Settings(), SimulatedBlobAdapter())
    rt.upsert_seat('seat-1', 'Test seat', DEMO_POLY)
    with TestClient(create_app(rt, SourceSpec('synthetic'))) as client:
        deadline = time.monotonic() + 5
        while rt.camera.latest() is None and time.monotonic() < deadline:
            time.sleep(.1)
        assert client.get('/api/v1/health').json()['camera']['state'] == 'connected'
        assert client.get('/api/v1/seats').json()[0]['camera_id'] == 'cam0'
        occupancy = client.get('/api/v1/occupancy').json()
        assert occupancy['expected_seats'] == 1
        assert occupancy['actual_people'] in (0, 1)
        jpg = client.get('/api/v1/stream/cam0/snapshot.jpg')
        assert jpg.status_code == 200 and jpg.content.startswith(b'\xff\xd8')
        assert cv2.imdecode(np.frombuffer(jpg.content, np.uint8), 1) is not None
        # The live MJPEG stream uses this rendered frame: it contains the seat
        # polygon, person box (when present), and expected/actual summary.
        annotated = rt.annotated_jpeg()
        assert annotated and annotated.startswith(b'\xff\xd8')
        assert cv2.imdecode(np.frombuffer(annotated, np.uint8), 1) is not None
        with client.websocket_connect('/api/v1/ws') as socket:
            hello = socket.receive_json()
            assert hello['type'] == 'hello'
            socket.send_json({'type': 'ping'})
            message = socket.receive_json()
            assert message['type'] == 'pong'
            rt.hub.publish({'type': 'metrics', 'ts': 'test', 'data': rt.metrics()}, 'metrics')
            received = set()
            for _ in range(8):
                received.add(socket.receive_json()['type'])
                if {'inference', 'metrics'} <= received: break
            assert {'inference', 'metrics'} <= received
        old_spec = rt.camera.spec
        probe = client.post('/api/v1/sources/test', json={'type': 'synthetic', 'duration_s': .5})
        assert probe.status_code == 200 and probe.json()['frames'] > 0
        assert rt.camera.spec is old_spec
        assert client.put('/api/v1/settings', json={'vacancy_seconds': 45}).status_code == 200
        assert client.get('/api/v1/settings').json()['vacancy_seconds'] == 45
        assert client.post('/api/v1/sources/stop').status_code == 200
