# QSIS Real-Time Seismic Visualizer

A high-performance HTML5 Canvas and FastAPI dashboard for processing and streaming 100Hz 3-Axis Phidget Accelerometer data with zero-latency DSP filtering and a real-time FFT Spectrogram.

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
