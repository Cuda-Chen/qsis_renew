# QSIS Real-Time Seismic Visualizer

A high-performance HTML5 Canvas and FastAPI dashboard for processing and streaming 100Hz 3-Axis Phidget Accelerometer data with zero-latency DSP filtering and a real-time FFT Spectrogram.

## System Architecture

```text
+---------------------+
| Hardware Layer      |
| (Phidget 3-Axis     |
|  Accelerometer)     |
+----------+----------+
           | (100Hz Raw Data)
           v
+---------------------+
| Backend Layer       |
| (Python / FastAPI)  |
|                     |
|  [ Ingestion Loop ] <--- [ NTP Sync (System Clock) ]
|          |          |
|  [ DSP Processor  ] <--- (Butterworth Bandpass + EMA Demean)
|          |          |
|  [ Ring Buffer    ] <--- (Rolling 60s Window)
|    /     |     \    |
|   v      v      v   |
| [WS] [Archive] [FFT]|
+--+-------+------+---+
   |       |      |
   |       |      +--------------------------------+
   |       v (Stream to Disk)                      |
   |    +----------------------+                   |
   |    | Storage / Export     |                   |
   |    | (MiniSEED Format)    |                   |
   |    +----------------------+                   |
   |                                               |
   v (WebSockets: Waveform & Spectrogram)          v
+------------------------------------------------------+
| Frontend Layer (JS / HTML5 Canvas)                   |
|                                                      |
| [Waveform Display]  [Spectrogram Heatmap]            |
| [i18n / UI Controls / Gain / Scale ]                 |
+------------------------------------------------------+
```

### Component Overview
- **Hardware**: Captures 3-axis acceleration. Supports high-resolution sampling up to 125Hz (8ms interval).
- **DSP Processor**: Real-time signal conditioning using infinite impulse response (IIR) filtering and baseline removal.
- **Ring Buffer**: Thread-safe memory structure sized for 12,000 samples to accommodate hardware rate drifts while maintaining a 60s history.
- **True Sync Architecture**: Both Waveform and Spectrogram streams are aligned using absolute wall-clock (UTC Epoch) timestamps, ensuring zero drift and perfect vertical phase alignment.
- **Archiver**: Continuous MiniSEED generation with daily rotation and automated retention policy.
- **Frontend**: Smooth 60fps rendering using the HTML5 Canvas API with timestamp-based positioning, supporting logarithmic spectrograms and gain control.

## 1. Install Dependencies

You must have [uv](https://github.com/astral-sh/uv) installed, then run the project synchronizer:
```bash
$ uv sync
```

## 2. Pre-launch: Time Synchronization

For professional seismic monitoring, accurate timestamps are critical. You **must** ensure your system clock is synchronized via NTP before starting the server.

Refer to the [NTP Synchronization Guide](./NTP_SYNC.md) for detailed setup instructions using `chrony`.

## 3. Run the Visualization Server

The system relies on a high-speed Python backend exposing data over WebSockets directly to the web browser. 

To run the local server, you must pass the `LD_LIBRARY_PATH` so Python can link to the proprietary C-based Phidget drivers on your Linux machine:

```bash
# Run the FastAPI server via Uvicorn on Port 8000
$ LD_LIBRARY_PATH=/usr/local/lib uv run uvicorn server:app --host 0.0.0.0 --port 8000
```
*(Optionally append `--reload` for local hot-reloading development).*

## 4. View the Dashboard

Once the server is running, simply open your favorite modern web browser and navigate to:
`http://localhost:8000`

## Helper commands

### Count the Overlaps and Gaps

```
$ python -c "import obspy; st=obspy.read('mseed_archive/<file>'); st.print_gaps()"
```
