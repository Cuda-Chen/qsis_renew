import asyncio
import json
import threading
import time
import io
import os
import zipfile
import glob
from datetime import datetime, timezone, timedelta
import numpy as np
from collections import deque
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from scipy.signal import butter, sosfilt, sosfilt_zi, sosfiltfilt, welch
from Phidget22.Devices.Accelerometer import Accelerometer
import obspy
from obspy import Trace, Stream

app = FastAPI(
    title="QSIS Streaming Dashboard API",
    description="""
API documentation for the QSIS Real-Time Streaming Dashboard.

### WebSocket Endpoints
Swagger UI does not natively support interactive WebSocket testing, but you can connect to the following endpoints using a WebSocket client:
* **Waveform Data**: `ws://<host>/ws/waveform` - Pushes 3 channels of 100Hz accelerometer data every ~33ms.
* **Spectrogram Data**: `ws://<host>/ws/spectrogram` - Pushes frequency bins and magnitudes every 0.5s for the 0.5Hz-50.0Hz range.
    """,
    version="1.0.0"
)

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

# We store 300 seconds (5 minutes) of raw continuous data for history/downloading and UI backfill.
# Buffer sized for up to 200Hz to accommodate actual Phidget delivery rates
# (sensor may fire faster than the configured DATA_INTERVAL_MS)
WAVEFORM_BUFFER_SIZE = int(200 * 300)  # 60,000 samples
waveform_ring = RingBuffer(WAVEFORM_BUFFER_SIZE)
data_lock = threading.Lock()

# Archival queue for continuous disk writing
archive_queue = deque()
archive_lock = threading.Lock()

# Latest spectrogram
latest_spectrogram = None
spectrogram_ring = deque(maxlen=300)

# Hardware metadata
# Latest sensor metadata
latest_sensor_id = None
sample_count = 0
actual_fs = 0.0
last_fs_log = 0.0
start_time = time.monotonic()

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
        global sample_count, actual_fs, last_fs_log, start_time
        
        processed = dsp.process(acc[0], acc[1], acc[2])
        with data_lock:
            waveform_ring.append(processed)
        with archive_lock:
            # Store raw (unprocessed) data in the archive
            archive_queue.append(acc)
            
        # Diagnostics: measure actual samplerate
        sample_count += 1
        now = time.monotonic()
        elapsed = now - start_time
        if elapsed > 1.0:
            actual_fs = sample_count / elapsed
            if now - last_fs_log > 10.0:
                print(f"HW Status: FS={actual_fs:.1f}Hz, Samples={sample_count}")
                last_fs_log = now

    ch.setOnAccelerationChangeHandler(on_accel)
    
    # Dynamic samplerate detection
    global actual_fs
    
    try:
        ch.setIsLocal(True)
        ch.openWaitForAttachment(5000)
        
        # Verify requested interval is supported
        ch.setDataInterval(DATA_INTERVAL_MS)
        actual_interval = ch.getDataInterval()
        print(f"Hardware Loop: Requested {DATA_INTERVAL_MS}ms, Got {actual_interval}ms")
        
        # Initial estimate of FS
        with data_lock:
            actual_fs = 1000.0 / actual_interval
        
        # Capture the actual connected device serial number
        global latest_sensor_id
        latest_sensor_id = ch.getDeviceSerialNumber()
        
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
    global latest_spectrogram, actual_fs
    
    next_tick = time.monotonic() + SPECTRO_PUBLISH_RATE
    while True:
        now = time.monotonic()
        sleep_duration = next_tick - now
        if sleep_duration > 0:
            time.sleep(sleep_duration)
        else:
            next_tick = now
            
        next_tick += SPECTRO_PUBLISH_RATE
        
        # Determine current samplerate
        curr_fs = actual_fs if actual_fs > 0 else FS
        window_samples = int(curr_fs * FFT_WINDOW_SEC)
        hanning_window = np.hanning(window_samples)
        
        # 60-second window for long-term spectrum (Welch)
        window_samples_60s = int(curr_fs * 60)
        
        with data_lock:
            data_window = waveform_ring.get_window(window_samples)
            data_window_60s = waveform_ring.get_window(window_samples_60s)
            
        if data_window is not None:
            # Linear approach: FFT per axis for the 2s spectrogram
            fft_e = np.fft.rfft(data_window[:, 0] * hanning_window)
            fft_n = np.fft.rfft(data_window[:, 1] * hanning_window)
            fft_z = np.fft.rfft(data_window[:, 2] * hanning_window)
            
            # Root-Sum-Square (RSS) of magnitudes for spectrogram
            combined_mags = np.sqrt(np.abs(fft_z)**2 + np.abs(fft_n)**2 + np.abs(fft_e)**2) / window_samples
            
            # Gal conversion for individual 2s spectrum
            # 1 g = 980 Gal
            gal_z = (np.abs(fft_z) / window_samples) * 980.0
            gal_n = (np.abs(fft_n) / window_samples) * 980.0
            gal_e = (np.abs(fft_e) / window_samples) * 980.0
            
            # Frequency vector based on ACTUAL FS
            freqs = np.fft.rfftfreq(window_samples, 1/curr_fs)
            
            # Filter for UI (0.5 - 50.0 Hz)
            valid_idx = (freqs >= 0.5) & (freqs <= 50.0)
            
            # Calculate 60s Welch PSD if enough data
            welch_z, welch_n, welch_e = [], [], []
            if data_window_60s is not None and len(data_window_60s) == window_samples_60s:
                # nperseg is exactly 2 seconds, to match the spectrogram's resolution
                f_welch, pxx_e = welch(data_window_60s[:, 0], fs=curr_fs, nperseg=window_samples)
                _, pxx_n = welch(data_window_60s[:, 1], fs=curr_fs, nperseg=window_samples)
                _, pxx_z = welch(data_window_60s[:, 2], fs=curr_fs, nperseg=window_samples)
                # Convert PSD from g^2/Hz to Gal^2/Hz, then take sqrt to get amplitude (pseudo-amplitude spectrum)
                # Actually, standard amplitude spectrum from Welch is sqrt(PSD). We want Gal.
                welch_z = (np.sqrt(pxx_z) * 980.0)[valid_idx].tolist()
                welch_n = (np.sqrt(pxx_n) * 980.0)[valid_idx].tolist()
                welch_e = (np.sqrt(pxx_e) * 980.0)[valid_idx].tolist()
            else:
                welch_z = gal_z[valid_idx].tolist()
                welch_n = gal_n[valid_idx].tolist()
                welch_e = gal_e[valid_idx].tolist()
            
            # Per-component magnitudes for selective spectrogram rendering
            mags_z = (np.abs(fft_z) / window_samples)[valid_idx].tolist()
            mags_n = (np.abs(fft_n) / window_samples)[valid_idx].tolist()
            mags_e = (np.abs(fft_e) / window_samples)[valid_idx].tolist()
            
            latest_spectrogram = {
                "freqs": freqs[valid_idx].tolist(),
                "mags": combined_mags[valid_idx].tolist(),
                "mags_z": mags_z,
                "mags_n": mags_n,
                "mags_e": mags_e,
                "z_2s": gal_z[valid_idx].tolist(),
                "n_2s": gal_n[valid_idx].tolist(),
                "e_2s": gal_e[valid_idx].tolist(),
                "z_60s": welch_z,
                "n_60s": welch_n,
                "e_60s": welch_e,
                "epoch": time.time()
            }
            with data_lock:
                spectrogram_ring.append(latest_spectrogram)

threading.Thread(target=math_loop, daemon=True).start()

# --- Continuous Archiver Loop ---
def flush_archive(archive_dir, station_hex, next_start_time):
    with archive_lock:
        if not archive_queue:
            return next_start_time
        data_to_write = np.array(archive_queue, dtype=np.float32)
        archive_queue.clear()
        
    npts = len(data_to_write)
    if npts == 0:
        return next_start_time
        
    now_utc = datetime.now(timezone.utc)
    
    if next_start_time is None or abs(now_utc.timestamp() - next_start_time.timestamp) > 5.0:
        next_start_time = obspy.UTCDateTime(now_utc)
        
    # Strictly derive the filename from the first sample's timestamp
    # This ensures data spanning 23:59:59 doesn't accidentally bleed into the next day's file
    # due to thread execution latency
    year_str = next_start_time.datetime.replace(tzinfo=timezone.utc).strftime('%Y')
    jday_str = next_start_time.datetime.replace(tzinfo=timezone.utc).strftime('%j')
    
    stats_base = {
        'network': 'TW', 
        'station': station_hex, 
        'location': '', 
        'npts': npts, 
        'sampling_rate': FS, 
        'starttime': next_start_time
    }
    
    # Set record length and professional encoding (STEIM-2 for compressed integers)
    reclen = 512
    encoding = "STEIM2"

    # Scale data to integers (g * 1e6) to preserve precision while enabling compression
    scaled_data = (data_to_write * 1e6).astype(np.int32)

    # Write Z channel (col 2)
    trace_z = Trace(data=np.ascontiguousarray(scaled_data[:, 2]), header={**stats_base, 'channel': 'HLZ'})
    with open(os.path.join(archive_dir, f"{station_hex}.TW..HLZ.{year_str}.{jday_str}"), "ab") as f:
        Stream([trace_z]).write(f, format="MSEED", reclen=reclen, encoding=encoding)
        
    # Write East channel (col 0) - Standard name: HLE
    trace_e = Trace(data=np.ascontiguousarray(scaled_data[:, 0]), header={**stats_base, 'channel': 'HLE'})
    with open(os.path.join(archive_dir, f"{station_hex}.TW..HLE.{year_str}.{jday_str}"), "ab") as f:
        Stream([trace_e]).write(f, format="MSEED", reclen=reclen, encoding=encoding)
        
    # Write North channel (col 1) - Standard name: HLN
    trace_n = Trace(data=np.ascontiguousarray(scaled_data[:, 1]), header={**stats_base, 'channel': 'HLN'})
    with open(os.path.join(archive_dir, f"{station_hex}.TW..HLN.{year_str}.{jday_str}"), "ab") as f:
        Stream([trace_n]).write(f, format="MSEED", reclen=reclen, encoding=encoding)
        
    # Return the incremented start time for contiguous subsequent blocks
    return next_start_time + (npts / FS)

def cleanup_old_archives(archive_dir, now_utc):
    cutoff_date = now_utc - timedelta(days=180)
    for fname in os.listdir(archive_dir):
        parts = fname.split('.')
        if len(parts) >= 6:
            try:
                f_year = int(parts[-2])
                f_jday = int(parts[-1])
                f_date = datetime.strptime(f"{f_year}-{f_jday}", "%Y-%j").replace(tzinfo=timezone.utc)
                if f_date < cutoff_date:
                    os.remove(os.path.join(archive_dir, fname))
            except ValueError:
                pass

def archiver_loop():
    global latest_sensor_id
    archive_dir = "mseed_archive"
    os.makedirs(archive_dir, exist_ok=True)
    
    while latest_sensor_id is None:
        time.sleep(1)
        
    station_hex = f"{latest_sensor_id:05X}"
    current_jday = datetime.now(timezone.utc).strftime('%j')
    next_start_time = None
    
    while True:
        time.sleep(10) # flush to disk every 10 seconds
        
        next_start_time = flush_archive(archive_dir, station_hex, next_start_time)
        
        now_utc = datetime.now(timezone.utc)
        jday_str = now_utc.strftime('%j')
        
        # 180-Day Cleanup check (execute upon detecting a midnight rollover)
        if jday_str != current_jday:
            current_jday = jday_str
            cleanup_old_archives(archive_dir, now_utc)

threading.Thread(target=archiver_loop, daemon=True).start()

# --- WebSockets ---
waveform_connections = set()
spectro_connections = set()

# We mount our static files (HTML/JS)
import os
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", summary="Dashboard Homepage", tags=["UI"])
def read_root():
    """Returns the main HTML interface for the real-time streaming dashboard."""
    with open("static/index.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/api/download_mseed", summary="Download MiniSEED Data", tags=["Data Export"])
def download_mseed(date: str, channel: str = None):
    """
    Downloads archived MiniSEED data for a specific date.
    
    - **date**: Date in YYYY-MM-DD format (Required)
    - **channel**: Specific channel to download (HLZ, HLX, or HLY). 
      If omitted, all three channels are returned in a ZIP file.
    """
    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
        year_str = dt.strftime("%Y")
        jday_str = dt.strftime("%j")
    except ValueError:
        return {"error": "Invalid date format. Use YYYY-MM-DD."}
    
    archive_dir = "mseed_archive"
    
    # Path A: Specific Channel (Fast direct download)
    if channel:
        if channel not in ["HLZ", "HLE", "HLN"]:
            return {"error": "Invalid channel. Must be HLZ, HLE, or HLN."}
            
        # Backward compatibility: map standard codes back to legacy if new files missing
        search_codes = [channel]
        if channel == "HLE": search_codes.append("HLX")
        if channel == "HLN": search_codes.append("HLY")
        
        matches = []
        for code in search_codes:
            pattern = os.path.join(archive_dir, f"*.TW..{code}.{year_str}.{jday_str}")
            matches.extend(glob.glob(pattern))
        
        if not matches:
            return HTMLResponse(content="Data not found for the selected date/channel", status_code=404)
            
        # Take the first match (prefer standard code if both exist)
        target_path = matches[0]
        filename = os.path.basename(target_path)
        return FileResponse(path=target_path, filename=filename, media_type="application/octet-stream")
    
    # Path B: All Channels (ZIP bundle)
    else:
        pattern = os.path.join(archive_dir, f"*.*.*.*.{year_str}.{jday_str}")
        matches = glob.glob(pattern)
        
        # Filter for our target HL channels (include legacy HLX/HLY for transition)
        target_chans = ["HLZ", "HLE", "HLN", "HLX", "HLY"]
        hl_matches = [m for m in matches if any(ch in m for ch in target_chans)]
        
        if not hl_matches:
            return HTMLResponse(content="Data not found for the selected date", status_code=404)
            
        # Create ZIP in-memory using STORED (no compression) for max speed and min CPU
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_STORED) as zf:
            for file_path in hl_matches:
                zf.write(file_path, arcname=os.path.basename(file_path))
        
        zip_buffer.seek(0)
        zip_name = f"QSIS_Archive_{date}.zip"
        
        return StreamingResponse(
            zip_buffer, 
            media_type="application/x-zip-compressed",
            headers={"Content-Disposition": f"attachment; filename={zip_name}"}
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
        
        # --- Send Initial Backfill Payload ---
        with data_lock:
            all_data = waveform_ring.get_all()
            if len(all_data) > delay_samples:
                # Send everything up to the 2s delay point
                initial_chunk = all_data[:-delay_samples]
                initial_epoch = time.time() - (delay_samples / FS)
                # Ensure we don't block the async event loop with json dumping
                # But for this one-time payload, it's acceptable.
                await websocket.send_text(json.dumps({
                    "y": initial_chunk.tolist(),
                    "t": initial_epoch,
                    "fs": actual_fs
                }))
                
                # set last_head so the regular loop picks up from the right spot
                last_head = waveform_ring.head
        
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
                    # Epoch of the last sample in this chunk
                    # delayed_end is delay_samples behind the head, so it's delay_samples/FS seconds old
                    chunk_epoch = time.time() - (delay_samples / FS)
                    await websocket.send_text(json.dumps({"y": chunk.tolist(), "t": chunk_epoch}))
                    
    except WebSocketDisconnect:
        waveform_connections.remove(websocket)


@app.websocket("/ws/spectrogram")
async def ws_spectrogram(websocket: WebSocket):
    await websocket.accept()
    spectro_connections.add(websocket)
    
    with data_lock:
        history = list(spectrogram_ring)
        
    if history:
        # Strip heavy Welch PSD arrays from historical items to prevent JS thread freezing on parse
        optimized_history = []
        for i, row in enumerate(history):
            if i == len(history) - 1:
                optimized_history.append(row)
            else:
                # Include per-component mags for selective spectrogram rendering
                entry = {
                    "mags": row["mags"],
                    "epoch": row["epoch"]
                }
                if "mags_z" in row:
                    entry["mags_z"] = row["mags_z"]
                    entry["mags_n"] = row["mags_n"]
                    entry["mags_e"] = row["mags_e"]
                optimized_history.append(entry)
        await websocket.send_text(json.dumps(optimized_history))
        
    last_sent = None
    try:
        while True:
            await asyncio.sleep(0.5)
            if latest_spectrogram and latest_spectrogram != last_sent:
                await websocket.send_text(json.dumps(latest_spectrogram))
                last_sent = latest_spectrogram
    except WebSocketDisconnect:
        spectro_connections.remove(websocket)
