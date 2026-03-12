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
- **Visual Math Synchronization (Phase Alignment)**: A major pitfall in Data Dashboards involves mixing continuous streams (60fps raw data) with chunked calculations (e.g. a 2-second FFT window computed every 1 second). Because that FFT chunk spans `[NOW-2s, NOW]`, its *chronological midpoint* is exactly `NOW-1s`. When drawing it horizontally on the screen, if you plot the FFT at the absolute edge `x=NOW` (offset 0), it will be visually out of phase with the waveform data by +1 second. You **must** compensate by rendering the FFT chunks explicitly delayed by exactly half their window interval natively in your Javascript column iterations to retain true vertical physical stack synchronicity.
- **Live Timelines**: Avoid drawing heavy numbers directly inside HTML5 Canvas contexts. Generate a rapid Javascript `setInterval(clock, 1000)` that parses the `new Date()` and overwrites floating HTML `div` CSS tags absolutely positioned over the left and right borders of the element bounding boxes.
- **Hardware Agnostic & White Labeling**: Ensure your UI limits proprietary naming. You can achieve this by storing all Dashboard Labels in a `static/en.json` dictionary. Use Javascript `fetch()` on a master `config.json` to swap the text content of generic `data-i18n` tagged HTML elements. This lets you securely showcase custom analytics dashboards in your portfolio without breaching client confidentiality.

## 5. API Documentation & Testing Architecture
- **Interactive Swagger UI**: Leverage FastAPI's native OpenAPI integration by enriching `@app.get` definitions with `summary`, `tags`, and explicit `description` strings. 
- **Documenting WebSockets**: Because Swagger does not inherently expose interactive WebSocket layouts out-of-the-box, clearly detail connecting instructions and data payloads for the `ws://` feeds in the master `FastAPI(description="...")` block.
- **Unit Testing**: Structure tests logically using `pytest`. Emulate HTTP requests using FastAPI's `TestClient` (which wraps `httpx` / Starlette).
- **Asynchronous Testing Quirks**: `TestClient.websocket_connect` can be tricky and sometimes causes thread deadlocks on infinite `while True` backend publisher loops if the test context drops rapidly. In robust cases, explicitly design your buffer flush logic or prefer strictly testing the non-socket data extraction endpoints (like `.mseed` downloads) to guarantee CI/CD stability, relying on integration tests for the sockets.

## 6. Example Stack
- **Python**: `fastapi`, `uvicorn`, `websockets`, `numpy`, `scipy`, `pytest`
- **Client**: `HTML5 Canvas API`

*Note: Always remember to handle device locking gracefully in `finally:` blocks for hardware sensors.*

## 7. Continuous Archival Storage (MiniSEED)
When upgrading a live in-memory dashboard into a serious continuous 24/7 logging system (like a seismograph), follow these precise specifications for `obspy`:
- **Blockette Sizing for Disk vs Network**: While 512-byte Miniseed blockettes are heavily preferred for low-latency network protocols (e.g. SeedLink) to prevent transmission buffering lag, **4096-byte blockettes (`reclen=4096`) are the golden standard for physical disk archiving**. The 4096-byte size vastly reduces the fixed-header overhead ratio, maximizing physical disk storage density and random-access speeds.
- **Background Flushes**: Never append to disk directly from the high-speed hardware reading thread. Append incoming data safely via a threading lock into an intermediate Python `deque()`, then spawn a 3rd entirely independent `archiver_loop` thread that wakes up every 10-60 seconds to consume that queue, format the Obspy traces, and execute the physical binary unbuffered append (`"ab"`).
- **Strict UTC Midnight Rollovers**: Archival systems conventionally organize logs in an `SNLCYJ` (Station, Network, Location, Channel, Year, Julian Day) format. To prevent data spanning the `23:59:59` to `00:00:01` timeline from accidentally bleeding across two daily files due to thread latency, **never derive the log filename from the system's execution timestamp**. Always mathematically derive the target Julian Day exclusively from the precisely extrapolated `obspy.UTCDateTime(starttime)` of the very first data sample within the chunk being written.
- **Zero-Overhead Retention Policies**: Do not run constant file-stat scraping on the server. If building a standard "Keep 180 Days" retention feature, only trigger the strict Python `os.listdir()` and `os.remove()` garbage collection logic **once per day**, triggered strictly only when the loop detects the UTC Julian Day has incremented since its last execution.

## 8. Sensor Clipping / Saturation Detection
When visualizing accelerometer data in real-time, **clipping detection** (signal hitting the sensor's physical measurement limit) is critical for data integrity awareness. The simplest and most effective approach:
- **Match Y-Axis to Hardware Range**: Set the Canvas waveform `currentScale` to exactly the sensor's maximum (e.g. `±2.0g` for a high-precision Phidget accelerometer). When a signal clips, it **visually flatlines at the canvas edge** — no backend logic, no extra WebSocket fields, no additional state management needed.
- **CSS Danger Zones**: Add permanent faint red gradient overlays (`.clip-zone`) at the top and bottom edges (4px) of each waveform panel using `linear-gradient(to bottom, rgba(239,68,68,0.35), transparent)`. These serve as subtle but always-visible visual cues marking where saturation occurs, rendered as simple positioned `<div>` elements layered above the canvas.
- **Why NOT dynamic API detection**: The Phidget22 API provides `getMaxAcceleration()` and `getMinAcceleration()` methods that return the sensor's physical limits. While useful for hardware-agnostic systems, for a known single-sensor deployment this adds unnecessary complexity (new global state, new locks, new WebSocket payload fields, frontend parsing logic) to accomplish what a fixed Y-axis already shows visually for free.
- **When to upgrade**: If you later need to **log** clip events (e.g. timestamping them in MiniSEED metadata), **alert** operators programmatically, or support **multiple sensor models** with different ranges, then refactor to the dynamic API approach by checking `abs(acc[axis]) >= ch.getMaxAcceleration()[axis]` in the `on_accel` callback before passing data to the DSP pipeline.
