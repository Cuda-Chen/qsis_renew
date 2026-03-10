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
- **FFT Frequency Limits**: Always calculate your theoretical Nyquist Limit, which is exactly half of your sampling rate (e.g. 100Hz Sampling Rate = 50.0Hz Limit). explicitly open your Butterworth Bandpass filters (e.g. `[0.5, 49.9]`) and your downstream API mask (`valid_idx`) to stream up to this limit to maximize your Spectrogram viewable spectrum.

## 3. Data Export & Scientific Formats
- **Standardizing Network Data**: If exporting accelerometer or seismograph data, use `obspy.Stream` and `obspy.Trace`.
- **Dependency Issues**: Note that `obspy` has historic dependencies on `pkg_resources`. Ensure you lock `setuptools==69.5.1` (or earlier) in `uv` environments to avoid `ModuleNotFoundError` during `obspy` import.
- **Serving Binary Downloads**: To download data from memory instead of the disk, instruct FastAPI to return a natively chunked `StreamingResponse` wrapping an `io.BytesIO()` binary blob with headers like `{"Content-Disposition": "attachment; filename=..."}`.

## 4. Frontend: Vanilla JS + HTML5 Canvas
- Use the standard Javascript `canvas.getContext('2d')`.
- Connect to the backend using native `new WebSocket()`.
- **Waveform Rendering**: Use `requestAnimationFrame(drawLoop)` to draw the graph. Never use `setInterval`. Append raw Float arrays directly to the canvas memory buffer.
- **Multi-Axis Layouts**: If rendering distinct Multi-Axis data (e.g. X, Y, Z from an accelerometer), avoid layering them on a single complex canvas layout. Use CSS Flexbox to stack multiple distinct `<canvas>` elements vertically, and let a single `requestAnimationFrame` loop clear and draw to all 2D contexts simultaneously. This guarantees perfect time-step alignment across the axes while maintaining clean UI separation.
- **Alignment**: For syncing high-speed data (waveforms) with inherently slower chunked data (like a 2-second FFT Spectrogram), explicitly delay the high-speed data stream by the equivalent block size (e.g. `NOW - 2s`) in the RingBuffer extraction to guarantee visual alignment. 

## 4. Example Stack
- **Python**: `fastapi`, `uvicorn`, `websockets`, `numpy`, `scipy`
- **Client**: `HTML5 Canvas API`

*Note: Always remember to handle device locking gracefully in `finally:` blocks for hardware sensors.*
