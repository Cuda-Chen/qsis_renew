import io
import pytest
import obspy
from obspy import Stream
from fastapi.testclient import TestClient
import numpy as np
import threading
import time

from server import app, waveform_ring, FS, data_lock
import server

client = TestClient(app)

def test_read_root():
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]

def test_download_mseed_valid():
    # 1. Inject some mock accelerometer data directly into the RingBuffer
    test_data = np.array([
        [1.0, 2.0, 3.0], # E, N, Z
        [1.1, 2.1, 3.1],
        [1.2, 2.2, 3.2],
        [1.3, 2.3, 3.3],
        [1.4, 2.4, 3.4],
    ])
    
    with data_lock:
        # Clear buffer and simulate writing 5 records
        waveform_ring.head = 0
        waveform_ring.full = False
        for row in test_data:
            waveform_ring.append(row)

    # 1.5 Inject a mock hardware ID into the server module so it can be formatted to hex
    server.latest_sensor_id = 372690  # 372690 in decimal -> 5AFD2 in hex

    # 2. Hit the download endpoint
    response = client.get("/api/download_mseed")
    
    # 3. Assert HTTP success
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.fdsn.mseed"
    assert "attachment; filename=QSIS_5AFD2_" in response.headers["content-disposition"]
    
    # 4. Read the raw bytes back into an Obspy Stream
    mseed_bytes = io.BytesIO(response.content)
    stream = obspy.read(mseed_bytes, format="MSEED")
    
    # 5. Verify the Obspy Stream contents
    assert isinstance(stream, Stream)
    assert len(stream) == 3  # We expect Z, X, and Y channels
    
    channels_found = [tr.stats.channel for tr in stream]
    assert "HLZ" in channels_found
    assert "HLX" in channels_found
    assert "HLY" in channels_found
    
    # The station ID should be the 5-digit hex representation (5AFD2)
    # The network should be TW, location should be empty
    z_trace = stream.select(channel="HLZ")[0]
    assert z_trace.stats.station == "5AFD2"
    assert z_trace.stats.network == "TW"
    assert z_trace.stats.location == ""
    assert z_trace.stats.npts >= len(test_data) # Obspy may pad records to fulfill blockette frames
    np.testing.assert_allclose(z_trace.data[:len(test_data)], test_data[:, 2])
    
    x_trace = stream.select(channel="HLX")[0]
    np.testing.assert_allclose(x_trace.data[:len(test_data)], test_data[:, 0])
    
    y_trace = stream.select(channel="HLY")[0]
    np.testing.assert_allclose(y_trace.data[:len(test_data)], test_data[:, 1])


def test_flush_archive_rollover(tmp_path):
    from server import flush_archive, archive_queue, archive_lock, FS
    import os
    
    # Setup mock data (10 samples)
    test_data = np.ones((10, 3)) * 4.2
    with archive_lock:
        archive_queue.clear()
        for row in test_data:
            archive_queue.append(row)
            
    # Mock exact time right before midnight boundary on 2026-03-11 (Julian day 070)
    fake_time_str = "2026-03-11T23:59:59.000"
    test_start = obspy.UTCDateTime(fake_time_str)
    
    from datetime import datetime as real_datetime, timezone
    class MockDatetime(real_datetime):
        @classmethod
        def now(cls, tz=None):
            return test_start.datetime.replace(tzinfo=timezone.utc)
            
    original_datetime = server.datetime
    server.datetime = MockDatetime
    try:
        archive_dir = str(tmp_path)
        station = "5AFD2"
        
        # 1. Execute flush
        next_time = flush_archive(archive_dir, station, test_start)
        
        # 2. Assert continuous time progression exactly matches sample length
        expected_duration = len(test_data) / FS
        assert abs((next_time - test_start) - expected_duration) < 1e-6
        
        # 3. Assert filename mapped successfully to YYYY.DDD (2026.070)
        files_created = os.listdir(archive_dir)
        assert len(files_created) == 3
        assert "5AFD2.TW..HLZ.2026.070" in files_created
        assert "5AFD2.TW..HLX.2026.070" in files_created
        assert "5AFD2.TW..HLY.2026.070" in files_created
        
        # 4. Assert MiniSEED file structure is intact
        st = obspy.read(os.path.join(archive_dir, "5AFD2.TW..HLZ.2026.070"))
        assert len(st) == 1
        assert st[0].stats.npts >= 10
        assert st[0].stats.channel == "HLZ"
    finally:
        server.datetime = original_datetime

def test_cleanup_old_archives(tmp_path):
    from server import cleanup_old_archives
    from datetime import datetime, timezone
    import os
    
    archive_dir = str(tmp_path)
    
    # Touch a recent file (2026-03-10 is Day 069)
    open(os.path.join(archive_dir, "5AFD2.TW..HLZ.2026.069"), "w").close()
    
    # Touch a very old file (2025-01-01 is Day 001)
    open(os.path.join(archive_dir, "5AFD2.TW..HLZ.2025.001"), "w").close()
    
    # Pretend today is 2026-03-11
    now_utc = datetime(2026, 3, 11, tzinfo=timezone.utc)
    
    # Execute cleanup
    cleanup_old_archives(archive_dir, now_utc)
    
    files = os.listdir(archive_dir)
    assert len(files) == 1
    assert "5AFD2.TW..HLZ.2026.069" in files
    assert "5AFD2.TW..HLZ.2025.001" not in files
