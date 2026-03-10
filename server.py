import asyncio
import json
import threading
import time
import io
from datetime import datetime, timezone
import numpy as np
from collections import deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse
from scipy.signal import butter, sosfilt, sosfilt_zi, sosfiltfilt
from Phidget22.Devices.Accelerometer import Accelerometer
import obspy
from obspy import Trace, Stream

app = FastAPI()

# --- Configuration ---
FS = 100.0  # 100 Hz sampling rate
DATA_INTERVAL_MS = int(1000 / FS)
FFT_WINDOW_SEC = 2.0
SPECTRO_PUBLISH_RATE = 1.0 # Publish every 1s, but with a 2s overlapping observation string
UI_STREAM_MS = 33 # 30fps websocket push

# --- Global Buffers & Locks ---
class RingBuffer:
    def __init__(self, size):
        self.size = size
        self.buffer = np.zeros((size, 3))
        self.head = 0
        self.full = False

    def append(self, val):
        self.buffer[self.head] = val
        self.head += 1
        if self.head >= self.size:
            self.head = 0
            self.full = True

    def get_window(self, length):
        # Extract the most recent 'length' samples
        if not self.full and self.head < length:
            return None # Not enough data yet
        
        idx = (self.head - length) % self.size
        
        if idx < self.head:
            return self.buffer[idx:self.head]
        else:
            return np.concatenate((self.buffer[idx:], self.buffer[:self.head]))

    def get_all(self):
        # Return all currently contiguous valid data
        if not self.full:
            if self.head == 0:
                return np.zeros((0, 3))
            return self.buffer[:self.head]
        else:
            return np.concatenate((self.buffer[self.head:], self.buffer[:self.head]))

# We store 60 seconds of raw continuous data for history/downloading
WAVEFORM_BUFFER_SIZE = int(FS * 60)
waveform_ring = RingBuffer(WAVEFORM_BUFFER_SIZE)
data_lock = threading.Lock()

# Latest spectrogram
latest_spectrogram = None

# --- DSP ---
class DSPProcessor:
    def __init__(self):
        self.sos = butter(4, [0.5, 49.9], btype='bandpass', fs=FS, output='sos')
        self.zi_x = sosfilt_zi(self.sos)
        self.zi_y = sosfilt_zi(self.sos)
        self.zi_z = sosfilt_zi(self.sos)
        self.alpha = 0.05
        self.mean_x = None
        self.mean_y = None
        self.mean_z = None

    def process(self, x, y, z):
        if self.mean_x is None:
            self.mean_x, self.mean_y, self.mean_z = x, y, z
            self.zi_x *= 0
            self.zi_y *= 0
            self.zi_z *= 0

        self.mean_x = self.alpha * x + (1 - self.alpha) * self.mean_x
        self.mean_y = self.alpha * y + (1 - self.alpha) * self.mean_y
        self.mean_z = self.alpha * z + (1 - self.alpha) * self.mean_z
        
        dm_x = x - self.mean_x
        dm_y = y - self.mean_y
        dm_z = z - self.mean_z
        
        fx, self.zi_x = sosfilt(self.sos, [dm_x], zi=self.zi_x)
        fy, self.zi_y = sosfilt(self.sos, [dm_y], zi=self.zi_y)
        fz, self.zi_z = sosfilt(self.sos, [dm_z], zi=self.zi_z)
        
        return fx[0], fy[0], fz[0]

dsp = DSPProcessor()

# --- Hardware Loop ---
def hardware_loop():
    ch = Accelerometer()
    
    def on_accel(self, acc, ts):
        f = dsp.process(acc[0], acc[1], acc[2])
        with data_lock:
            waveform_ring.append(f)

    ch.setOnAccelerationChangeHandler(on_accel)
    
    try:
        ch.setDeviceSerialNumber(372690)
        ch.setIsLocal(True)
        ch.openWaitForAttachment(5000)
        ch.setDataInterval(DATA_INTERVAL_MS)
        while True:
            time.sleep(1)
    except Exception as e:
        print(f"Hardware Loop Error: {e}")
    finally:
        try:
            ch.close()
        except:
            pass

threading.Thread(target=hardware_loop, daemon=True).start()

# --- Math Loop (Spectrogram) ---
def math_loop():
    global latest_spectrogram
    window_samples = int(FS * FFT_WINDOW_SEC)
    hanning_window = np.hanning(window_samples)
    
    # Create a Butterworth bandpass filter for the spectrogram magnitude 
    # (magnitude operation introduces a DC offset and harmonics)
    sos_spec = butter(4, [0.5, 49.9], btype='bandpass', fs=FS, output='sos')
    
    while True:
        time.sleep(SPECTRO_PUBLISH_RATE)
        with data_lock:
            data_window = waveform_ring.get_window(window_samples)
            
        if data_window is not None:
            # Calculate magnitude vector: sqrt(x^2 + y^2 + z^2)
            mag_window = np.sqrt(np.sum(data_window**2, axis=1))
            
            # Apply Butterworth filter to the magnitude envelope
            mag_filtered = sosfiltfilt(sos_spec, mag_window)
            
            # Calculate FFT on the filtered magnitude
            windowed = mag_filtered * hanning_window
            fft_vals = np.abs(np.fft.rfft(windowed)) / window_samples
            freqs = np.fft.rfftfreq(window_samples, 1/FS)
            
            # Filter freqs between 0.5 and 50.0 Hz
            valid_idx = (freqs >= 0.5) & (freqs <= 50.0)
            f_bins = freqs[valid_idx]
            mags = fft_vals[valid_idx]
            
            latest_spectrogram = {
                "freqs": f_bins.tolist(),
                "mags": mags.tolist()
            }

threading.Thread(target=math_loop, daemon=True).start()

# --- WebSockets ---
waveform_connections = set()
spectro_connections = set()

# We mount our static files (HTML/JS)
import os
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def read_root():
    with open("static/index.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/api/download_mseed")
def download_mseed():
    with data_lock:
        data = waveform_ring.get_all()
        
    if len(data) == 0:
        return {"error": "No data available yet"}
        
    # Infer start time based on current time minus the buffer duration
    end_time = obspy.UTCDateTime()
    start_time = end_time - (len(data) / FS)
    
    # ObsPy traces expect contiguous 1D arrays
    # In our buffer: col 0=X(E), col 1=Y(N), col 2=Z(Z)
    data_e = np.ascontiguousarray(data[:, 0], dtype=np.float32)
    data_n = np.ascontiguousarray(data[:, 1], dtype=np.float32)
    data_z = np.ascontiguousarray(data[:, 2], dtype=np.float32)
    
    stats_base = {'network': 'QS', 'station': 'Z', 'location': '00', 'npts': len(data), 'sampling_rate': FS, 'starttime': start_time}
    
    trace_e = Trace(data=data_e, header={**stats_base, 'channel': 'BHE'})
    trace_n = Trace(data=data_n, header={**stats_base, 'channel': 'BHN'})
    trace_z = Trace(data=data_z, header={**stats_base, 'channel': 'BHZ'})
    
    stream = Stream([trace_z, trace_n, trace_e])
    
    buf = io.BytesIO()
    stream.write(buf, format="MSEED")
    buf.seek(0)
    
    # User Note: Temporary dynamic length/filename. To be refactored per user feedback later.
    filename = f"QSIS_Z_{end_time.strftime('%Y%m%d_%H%M%S')}.mseed"
    
    return StreamingResponse(
        buf, 
        media_type="application/vnd.fdsn.mseed", 
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@app.websocket("/ws/waveform")
async def ws_waveform(websocket: WebSocket):
    await websocket.accept()
    waveform_connections.add(websocket)
    try:
        # We push a small chunk of new data every ~33ms
        # To align with the 2s spectrogram, we pull data from EXACTLY 2 seconds ago.
        # But wait, actually, the easiest way to delay the waveform is to send the sample
        # that is currently (FS * 2) samples behind the head.
        
        # However, to avoid dropping samples across the async websocket, we just send
        # whatever is new in the buffer at the delay point.
        delay_samples = int(FS * 2.0)
        last_head = -1
        
        while True:
            await asyncio.sleep(UI_STREAM_MS / 1000.0)
            
            with data_lock:
                current_head = waveform_ring.head
                
            if last_head == -1:
                # Initialize
                last_head = current_head
                continue
                
            if current_head != last_head:
                # How many samples have arrived since last tick?
                frames = current_head - last_head
                if frames < 0:
                    frames += WAVEFORM_BUFFER_SIZE
                    
                # We want to extract `frames` amount of samples, but originating from `delay_samples` ago.
                delayed_start = (last_head - delay_samples) % WAVEFORM_BUFFER_SIZE
                delayed_end = (current_head - delay_samples) % WAVEFORM_BUFFER_SIZE
                
                with data_lock:
                    if delayed_start < delayed_end:
                        chunk = waveform_ring.buffer[delayed_start:delayed_end]
                    else:
                        chunk = np.concatenate((waveform_ring.buffer[delayed_start:], waveform_ring.buffer[:delayed_end]))
                        
                last_head = current_head
                
                if len(chunk) > 0:
                    await websocket.send_text(json.dumps({"y": chunk.tolist()}))
                    
    except WebSocketDisconnect:
        waveform_connections.remove(websocket)


@app.websocket("/ws/spectrogram")
async def ws_spectrogram(websocket: WebSocket):
    await websocket.accept()
    spectro_connections.add(websocket)
    last_sent = None
    try:
        while True:
            await asyncio.sleep(0.5)
            if latest_spectrogram and latest_spectrogram != last_sent:
                await websocket.send_text(json.dumps(latest_spectrogram))
                last_sent = latest_spectrogram
    except WebSocketDisconnect:
        spectro_connections.remove(websocket)
