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
    """Verify that date-based archival download works for a specific channel."""
    import os
    os.makedirs("mseed_archive", exist_ok=True)
    try:
        # Create a dummy file for 2026-03-20 (Jday 079)
        test_file = os.path.join("mseed_archive", "5AFD2.TW..HLE.2026.079")
        with open(test_file, "wb") as f:
            f.write(b"mock_mseed_data")
            
        # 1. Hit the download endpoint with required date and channel
        response = client.get("/api/download_mseed?date=2026-03-20&channel=HLE")
        
        # 2. Assert HTTP success
        assert response.status_code == 200
        assert response.content == b"mock_mseed_data"
        assert "5AFD2.TW..HLE.2026.079" in response.headers["content-disposition"]
    finally:
        # Cleanup
        if os.path.exists(test_file): os.remove(test_file)


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
        assert "5AFD2.TW..HLE.2026.070" in files_created
        assert "5AFD2.TW..HLN.2026.070" in files_created
        
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
