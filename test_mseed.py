import io
import obspy
from obspy import Stream
from fastapi.testclient import TestClient
import numpy as np
import time

# Import the FastAPI app and the ring buffer variable
from server import app, waveform_ring, FS, data_lock

client = TestClient(app)

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

    # 2. Hit the download endpoint
    response = client.get("/api/download_mseed")
    
    # 3. Assert HTTP success
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.fdsn.mseed"
    assert "attachment; filename=QSIS_Z_" in response.headers["content-disposition"]
    
    # 4. Read the raw bytes back into an Obspy Stream
    mseed_bytes = io.BytesIO(response.content)
    stream = obspy.read(mseed_bytes, format="MSEED")
    
    # 5. Verify the Obspy Stream contents
    assert isinstance(stream, Stream)
    assert len(stream) == 3  # We expect Z, N, and E channels
    
    channels_found = [tr.stats.channel for tr in stream]
    assert "BHZ" in channels_found
    assert "BHN" in channels_found
    assert "BHE" in channels_found
    
    # Verify the data was perfectly reconstructed (Z-axis was the 3rd column, which is index 2)
    z_trace = stream.select(channel="BHZ")[0]
    assert z_trace.stats.sampling_rate == float(FS)
    assert z_trace.stats.npts == 5
    np.testing.assert_allclose(z_trace.data, test_data[:, 2])
    
    e_trace = stream.select(channel="BHE")[0]
    np.testing.assert_allclose(e_trace.data, test_data[:, 0])

    print("\n[SUCCESS] The exported MiniSEED file is valid and parses perfectly into obspy traces!")
