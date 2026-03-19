---
description: Build Smooth Real-Time Streaming Dashboards (FastAPI + Canvas)
---
# Real-Time Streaming Dashboard (Oscilloscope Style)

Use **FastAPI + WebSockets + HTML5 Canvas** to separate heavy Python DSP from 60fps browser rendering.

## 1. Backend & DSP
- **Threading**: Run **Hardware Input** and **Math/FFT** on separate `threading.Thread` instances to avoid blocking.
- **RingBuffer**: Use pre-allocated NumPy arrays with a circular head pointer for O(1) appending.
- **Filtering**: Use `scipy.signal.sosfilt` for real-time de-meaning/filtering.
- **Nyquist**: Set filter limits to `0.5Hz` to `0.49 * FS` to maximize visible spectrum.

## 2. True Sync Architecture (Critical)
- **Absolute Timestamps**: Send a UTC Unix `epoch` with every packet (end-of-chunk for waveforms).
- **Unified Formula**: Both streams use `x = width - (now - sampleEpoch - VIEW_DELAY) * pxPerSecond`.
- **VIEW_DELAY**: Use a shared constant (e.g., 2.0s) to align processed data with the right edge.
- **Buffer Resilience**: Size buffers for `MAX_FS * 60` (e.g., 12000 samples) to handle hardware that drifts (e.g., 100Hz → 125Hz).
- **Init Loop**: Pre-fill timestamp arrays at startup spanning `[now - 62s, now - 2s]` to prevent initial gaps.

## 3. Frontend Rendering
- **Canvas API**: Use `requestAnimationFrame`, not `setInterval`.
- **Layout**: Stack distinct `<canvas>` elements vertically via CSS Flexbox for multi-axis data.
- **Time Labels**: Sync HH:MM:SS clock labels by subtracting `VIEW_DELAY` from `Date.now()`.
- **Spectrogram LUT**: Use a pre-computed 256-entry lookup table for heatmaps to avoid per-pixel `hsl()` strings.

## 4. Archival (MiniSEED)
- **Blockettes**: Use `reclen=4096` for disk archiving to minimize overhead.
- **Background Flushes**: Accumulate data in a `deque`, then flush to disk via a dedicated `archiver_loop` every 10–60s.
- **Rollover**: Derive filenames from the starting sample's `obspy.UTCDateTime`, not the system clock, to avoid midnight bleed.

## 5. UI Optimization
- **Clipping**: Set `currentScale` to the sensor's physical limit (e.g., ±2.0g) so clips naturally flatline at the edge.
- **Compaction**: Reduce CSS `gap` and `padding` to maximize vertical canvas area (recovers ~15% viewport).
- **Controls**: Implement Gain (`raw * gain`) and Log Scale (`Math.log10(1 + mag * 9)`) entirely on the frontend.
