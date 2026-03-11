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
    np.testing.assert_allclose(z_trace.data, test_data[:, 2])
    
    x_trace = stream.select(channel="HLX")[0]
    np.testing.assert_allclose(x_trace.data, test_data[:, 0])
    
    y_trace = stream.select(channel="HLY")[0]
    np.testing.assert_allclose(y_trace.data, test_data[:, 1])


