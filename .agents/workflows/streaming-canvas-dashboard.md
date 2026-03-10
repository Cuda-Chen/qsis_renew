---
description: Build Smooth Real-Time Streaming Dashboards (FastAPI + Canvas)
---
# How to build a Smooth Real-Time Streaming Dashboard (Oscilloscope / Blit Style)

When a user requests a "flowing line", "oscilloscope-style", or "tape recorder" near real-time visualization that updates continuously (e.g. 60fps) without flickering, jumping, or skipping, you **must not use Streamlit or standard Plotly**. Instead, use the **FastAPI + WebSockets + HTML5 Canvas** architecture.

This layout cleanly separates the heavy Python data processing from the high-speed rendering engine of the browser.

## 1. Backend: FastAPI + Uvicorn + WebSockets
- Use `uvicorn` and `FastAPI` as the server.
- Serve the static index HTML directly from `FastAPI`.
- Create explicit `@app.websocket()` endpoints.

## 2. DSP & Threading
- **Hardware/Input Loop**: Run your sensor/data collection on an isolated `threading.Thread()`.
- **Math/Processing Loop**: Run heavy FFT or aggregation in a *separate* independent `threading.Thread()` so it doesn't block the fast hardware collection.
- **Buffering**: Use custom `RingBuffer` (pre-allocated 1D or 2D Numpy Array `np.zeros((SIZE, CHANNELS))`) with a circular head pointer, rather than `collections.deque()`. `deque` requires slow `list()` conversions before math can be done. Pre-allocated arrays prevent memory reallocation pauses.
- **Live Filtering**: Use `scipy.signal.sosfilt` and an Exponential Moving Average for de-meaning real-time streams, as it is strictly superior and more stable than `lfilter`.
- **FFT & Magnitudes**: If you are calculating the magnitude of multiple axes (e.g. $\sqrt{x^2+y^2+z^2}$) before an FFT mathematically, this inherently introduces a massive mathematical DC offset (0Hz) because it squares the signals. You **must** scrub this synthesized magnitude through a zero-phase `scipy.signal.sosfiltfilt` bandpass *before* applying the FFT Hanning window, otherwise your low-frequency spectrum will be blown out.

## 3. Frontend: Vanilla JS + HTML5 Canvas
- Use the standard Javascript `canvas.getContext('2d')`.
- Connect to the backend using native `new WebSocket()`.
- **Waveform Rendering**: Use `requestAnimationFrame(drawLoop)` to draw the graph. Never use `setInterval`. Append raw Float arrays directly to the canvas memory buffer. If rendering Multi-Axis data (X,Y,Z), loop `beginPath` for each trace on the same canvas rather than layering transparent canvases.
- **Alignment**: For syncing high-speed data (waveforms) with inherently slower chunked data (like a 2-second FFT Spectrogram), explicitly delay the high-speed data stream by the equivalent block size (e.g. `NOW - 2s`) in the RingBuffer extraction to guarantee visual alignment. 

## 4. Example Stack
- **Python**: `fastapi`, `uvicorn`, `websockets`, `numpy`, `scipy`
- **Client**: `HTML5 Canvas API`

*Note: Always remember to handle device locking gracefully in `finally:` blocks for hardware sensors.*
