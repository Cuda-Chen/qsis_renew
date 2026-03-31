const canvasZ = document.getElementById('canvasZ');
const canvasN = document.getElementById('canvasN');
const canvasE = document.getElementById('canvasE');
const spectroCanvas = document.getElementById('spectroCanvas');

const ctxZ = canvasZ.getContext('2d', { alpha: false });
const ctxN = canvasN.getContext('2d', { alpha: false });
const ctxE = canvasE.getContext('2d', { alpha: false });
const ctxSpec = spectroCanvas.getContext('2d', { alpha: false });

let wsWaveform, wsSpectro;

// Configuration
const FS = 100; // 100Hz
let SECONDS_TO_SHOW = 60;
const WEBSOCKET_URL = `ws://${window.location.host}`;
const Y_AXIS_WIDTH = 60;

// --- Server-Relative Clock Physics ---
let latestServerTime = 0;
let localTimeAtReceive = 0;

function getServerTime() {
    if (latestServerTime === 0) return Date.now() / 1000.0;
    const elapsedLocal = (Date.now() / 1000.0) - localTimeAtReceive;
    return latestServerTime + elapsedLocal;
}

// --- Waveform State ---
// Buffer sized for up to MAX_FS Hz to accommodate actual Phidget delivery rates.
// Timestamp-based rendering positions each sample correctly regardless of buffer size.
const MAX_FS = 200;  // max expected sample rate; must match server WAVEFORM_BUFFER_SIZE
const BUFFER_SIZE = MAX_FS * 300; // 5 minutes representing 60,000 samples
let waveX = new Float32Array(BUFFER_SIZE);
let waveY = new Float32Array(BUFFER_SIZE);
let waveZ = new Float32Array(BUFFER_SIZE);
let waveT = new Float64Array(BUFFER_SIZE); // epoch (Unix seconds) per sample

// Initialize waveT with synthetic timestamps spanning the full view window.
// Without this, samples default to epoch 0 and clamp to x=0 until the buffer fills.
{
    const initNow = getServerTime();
    const INIT_DELAY = 2.0;
    for (let i = 0; i < waveT.length; i++) {
        // Spread init timestamps evenly across 5 minutes, regardless of actual FS
        waveT[i] = initNow - INIT_DELAY - (waveT.length - 1 - i) * (300 / waveT.length);
    }
}
let scaleZ = 2.0;
let scaleN = 2.0;
let scaleE = 2.0;

// --- Spectrogram State ---
// Let's store 400 rows, giving us 400 seconds (6.5 hours) of history updated every 1s
const SPEC_ROWS = 400;
let specHistory = []; // array of {mags: Float32Array, epoch: number} objects
let maxFreqBins = 0;

// --- Spectrogram Controls ---
let specGain = 1.0;
let useLogScale = false;
let specTimeWindow = 60; // 10s to 60s
let specMinFreq = 0.02;
let specMaxFreq = 50.0;

// --- Spectrum State ---
let isSpectrumMode = true;
let spectrumWindowSize = '2s'; // '2s' or '60s'
let latestSpectrumData = null;
let useWaveformLogScale = false;
let currentTheme = localStorage.getItem('theme') || 'dark';

// --- Row Display Modes ---
let rowModes = {
    'Z': 'spec',
    'N': 'wave',
    'E': 'wave'
};

function applyTheme(theme) {
    currentTheme = theme;
    localStorage.setItem('theme', theme);
    if (theme === 'light') {
        document.body.classList.add('light-mode');
        document.getElementById('btnThemeLight').classList.add('active');
        document.getElementById('btnThemeDark').classList.remove('active');
    } else {
        document.body.classList.remove('light-mode');
        document.getElementById('btnThemeDark').classList.add('active');
        document.getElementById('btnThemeLight').classList.remove('active');
    }
}
document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme);
});

function getThemeColor(varName) {
    return getComputedStyle(document.body).getPropertyValue(varName).trim();
}

// Pre-compute a 256-entry rainbow LUT at startup
// Gradient: dark purple (silence) → blue → cyan → green → yellow → orange → red (max)
const RAINBOW_LUT = new Array(256);
for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const hue = (1.0 - t) * 270;
    const lightness = t > 0.05 ? 50 : 5;
    RAINBOW_LUT[i] = `hsl(${hue}, 100%, ${lightness}%)`;
}

function resize() {
    canvasZ.width = canvasZ.parentElement.clientWidth;
    canvasZ.height = canvasZ.parentElement.clientHeight;
    canvasN.width = canvasN.parentElement.clientWidth;
    canvasN.height = canvasN.parentElement.clientHeight;
    canvasE.width = canvasE.parentElement.clientWidth;
    canvasE.height = canvasE.parentElement.clientHeight;
    // Spectrogram
    spectroCanvas.width = spectroCanvas.parentElement.clientWidth;
    spectroCanvas.height = spectroCanvas.parentElement.clientHeight;
}

// Use ResizeObserver for robust RWD layout tracking
const resizeObserver = new ResizeObserver(() => {
    // requestAnimationFrame prevents "ResizeObserver loop limit exceeded" errors
    // and minimizes layout thrashing.
    requestAnimationFrame(resize);
});

// Observe the parent containers of all canvases
resizeObserver.observe(canvasZ.parentElement);
resizeObserver.observe(canvasN.parentElement);
resizeObserver.observe(canvasE.parentElement);
resizeObserver.observe(spectroCanvas.parentElement);

// Initial forced resize to catch any synchronous layout values
resize();

// --- Connect WebSockets ---
function connectWaveform() {
    wsWaveform = new WebSocket(`${WEBSOCKET_URL}/ws/waveform`);
    wsWaveform.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.y && data.y.length > 0) {
            let yData = data.y;
            let len = yData.length;
            
            // --- SAFETY: Prevent buffer overflow if the backfill chunk is massive
            if (len > BUFFER_SIZE) {
                // Keep only the most recent BUFFER_SIZE samples
                yData = yData.slice(len - BUFFER_SIZE);
                len = BUFFER_SIZE;
            }
            // ---

            waveX.copyWithin(0, len);
            waveY.copyWithin(0, len);
            waveZ.copyWithin(0, len);
            waveT.copyWithin(0, len);

            const startIdx = waveX.length - len;
            // Use real timestamp if server provides it; fall back to estimated 'now - 2s delay'
            const WAVEFORM_DELAY = 2.0;
            const latestSampleEpoch = data.t;
            if (latestSampleEpoch != null) {
                latestServerTime = latestSampleEpoch;
                localTimeAtReceive = Date.now() / 1000.0;
            }
            const chunkEndEpoch = (latestSampleEpoch != null) ? latestSampleEpoch : (getServerTime() - WAVEFORM_DELAY);
            const dt = (data.fs && data.fs > 0) ? (1.0 / data.fs) : (1.0 / FS);
            for (let i = 0; i < len; i++) {
                waveX[startIdx + i] = yData[i][0];
                waveY[startIdx + i] = yData[i][1];
                waveZ[startIdx + i] = yData[i][2];
                waveT[startIdx + i] = chunkEndEpoch - (len - 1 - i) * dt;
            }
        }
    };
    wsWaveform.onopen = updateStatus;
    wsWaveform.onclose = () => { updateStatus(); setTimeout(connectWaveform, 1000); };
}

function connectSpectro() {
    wsSpectro = new WebSocket(`${WEBSOCKET_URL}/ws/spectrogram`);
    wsSpectro.onclose = () => { setTimeout(connectSpectro, 1000); };
    wsSpectro.onerror = () => { wsSpectro.close(); };
    wsSpectro.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        // If it's an array, it's the initial backfill history payload
        if (Array.isArray(msg)) {
            specHistory = [];
            // Server sends oldest first, newest last. specHistory needs newest at index 0.
            for (let i = msg.length - 1; i >= 0; i--) {
                const data = msg[i];
                if (data.mags && data.epoch != null) {
                    maxFreqBins = data.mags.length;
                    const entry = { mags: new Float32Array(data.mags), epoch: data.epoch };
                    if (data.mags_z) {
                        entry.mags_z = new Float32Array(data.mags_z);
                        entry.mags_n = new Float32Array(data.mags_n);
                        entry.mags_e = new Float32Array(data.mags_e);
                    }
                    specHistory.push(entry);
                }
            }
            if (msg.length > 0) {
                latestSpectrumData = msg[msg.length - 1];
            }
        } else {
            // Normal live update object
            const data = msg;
            if (data.mags && data.epoch != null) {
                maxFreqBins = data.mags.length;
                const newRow = { mags: new Float32Array(data.mags), epoch: data.epoch };
                if (data.mags_z) {
                    newRow.mags_z = new Float32Array(data.mags_z);
                    newRow.mags_n = new Float32Array(data.mags_n);
                    newRow.mags_e = new Float32Array(data.mags_e);
                }
                specHistory.unshift(newRow);
                if (specHistory.length > SPEC_ROWS) {
                    specHistory.pop();
                }
                latestSpectrumData = data;
            }
        }
    };
}

// --- i18n Localization ---
let i18nDict = {};

async function loadLanguage() {
    try {
        // Fetch language setting from configuration file
        const confRes = await fetch('/static/config.json');
        const config = await confRes.json();
        const lang = config.language || 'en';

        // Append a cache-busting timestamp to ensure the latest keys are pulled
        const timestamp = new Date().getTime();
        const response = await fetch(`/static/${lang}.json?t=${timestamp}`);
        i18nDict = await response.json();

        // Update DOM elements that possess the data-i18n tag
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (i18nDict[key]) {
                el.innerHTML = i18nDict[key];
            }
        });

        // Ensure dynamic status element also gets updated if it is currently rendered
        updateStatus();

        // Handle Spectrogram Disable feature flag
        if (typeof config.enable_spectrogram !== 'undefined' && !config.enable_spectrogram) {
            document.querySelectorAll('#btnModeSpectrogram, #timeWindow').forEach(el => {
                el.disabled = true;
                el.style.opacity = '0.3';
                el.style.pointerEvents = 'none';
                el.title = 'Spectrogram Disabled in Server Config';
            });
        }
    } catch (e) {
        console.error("Failed to load translation configuration:", e);
    }
}

// Trigger initial i18n translation pass upon boot
loadLanguage();

function updateStatus() {
    const el = document.getElementById('conn-status');
    const txtLive = i18nDict['status_live'] || 'Streaming LIVE';
    const txtOffline = i18nDict['status_offline'] || 'OFFLINE';

    if (wsWaveform && wsWaveform.readyState === WebSocket.OPEN) {
        el.innerHTML = `<div class="status-dot"></div> <span data-i18n="status_live">${txtLive}</span>`;
        el.style.color = 'var(--accent-green)';
    } else {
        el.innerHTML = `<div class="status-dot" style="background: var(--accent-red); box-shadow: none; animation: none;"></div> <span data-i18n="status_offline">${txtOffline}</span>`;
        el.style.color = 'var(--accent-red)';
    }
}

// --- Render Loop (Waveform) ---
function drawWaveform() {
    // Assuming all 3 have the same dimensions due to flex layout
    const width = canvasZ.width;
    const height = canvasZ.height;

    const canvasBg = getThemeColor('--canvas-bg');

    // Clear Backgrounds
    ctxZ.fillStyle = canvasBg;
    ctxZ.fillRect(0, 0, width, height);
    ctxN.fillStyle = canvasBg;
    ctxN.fillRect(0, 0, width, height);
    ctxE.fillStyle = canvasBg;
    ctxE.fillRect(0, 0, width, height);

    // Shared time-axis: x = width - (age - VIEW_DELAY) * pxPerSecond
    // VIEW_DELAY shifts the window so the waveform fills the full canvas.
    // The right edge represents (now - 2s), left edge represents (now - 62s).
    const pxPerSecond = width / SECONDS_TO_SHOW;
    const nowSec = getServerTime();
    const VIEW_DELAY = 2.0; // must match server.py delay_samples / FS

    function drawAxis(ctx, buffer, color, scale) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const len = buffer.length;
        let started = false;
        for (let i = 0; i < len; i++) {
            const age = nowSec - waveT[i];
            const x = width - (age - VIEW_DELAY) * pxPerSecond;
            // Skip samples outside the visible 60-second window
            if (x < 0 || x > width) continue;
            
            let val = buffer[i];
            if (useWaveformLogScale) {
                // 1. Normalize the magnitude dynamically against the user-chosen slider 'scale'
                const magnitude = Math.abs(val) / scale;
                // 2. Compress the normalized magnitude. Math.log10(1 + x*9) maps [0, 1] to [0, 1]
                const logMagnitude = Math.log10(1 + magnitude * 9);
                // 3. Restore the original sign and multiply it back out to match the linear scale domain
                val = Math.sign(val) * logMagnitude * scale;
            }
            
            const normalized = (val / scale + 1) / 2;
            const y = height - (normalized * height);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Draw Z (Blue), N mapped to Y (Green), E mapped to X (Red)
    drawAxis(ctxZ, waveZ, '#3b82f6', scaleZ); // Z
    drawAxis(ctxN, waveY, '#10b981', scaleN); // N (Y-axis of sensor)
    drawAxis(ctxE, waveX, '#ef4444', scaleE); // E (X-axis of sensor)

    // Draw the Spectrogram in lockstep with the Waveforms
    drawSpectrogram();

    // Request next frame for that buttery 60fps Blit mode effect
    requestAnimationFrame(drawWaveform);
}

// --- Render Loop (Spectrogram or Spectrum) ---
function getSpecY(f, specMinFreq, specMaxFreq, height, useLogScale) {
    if (useLogScale) {
        // Clamp to avoid log10(0)
        const clampF = Math.max(0.1, f);
        const logF = Math.log10(clampF);
        const logMin = Math.log10(Math.max(0.1, specMinFreq));
        const logMax = Math.log10(Math.max(0.1, specMaxFreq));
        const percent = (logF - logMin) / (logMax - logMin);
        return height - (percent * height);
    } else {
        const percent = (f - specMinFreq) / (specMaxFreq - specMinFreq);
        return height - (percent * height);
    }
}

function getSpecX(f, specMinFreq, specMaxFreq, width, useLogScale) {
    const plotWidth = width - Y_AXIS_WIDTH;
    if (useLogScale) {
        const clampF = Math.max(0.1, f);
        const logF = Math.log10(clampF);
        const logMin = Math.log10(Math.max(0.1, specMinFreq));
        const logMax = Math.log10(Math.max(0.1, specMaxFreq));
        const percent = (logF - logMin) / (logMax - logMin);
        return Y_AXIS_WIDTH + (percent * plotWidth);
    } else {
        const percent = (f - specMinFreq) / (specMaxFreq - specMinFreq);
        return Y_AXIS_WIDTH + (percent * plotWidth);
    }
}

function drawSpectrogram() {
    if (isSpectrumMode) {
        drawSpectrumPlot();
        return;
    }

    if (specHistory.length === 0) return;

    const width = spectroCanvas.width;
    const height = spectroCanvas.height;

    // Filter bins based on frequency range
    // Resolution is 0.5Hz, starting at 0.5Hz
    const startBin = Math.max(0, Math.floor((specMinFreq - 0.5) / 0.5));
    const endBin = Math.min(maxFreqBins - 1, Math.floor((specMaxFreq - 0.5) / 0.5));
    const visibleBins = endBin - startBin + 1;

    if (visibleBins <= 0) return;

    // Shared time-axis. Must use the SAME pxPerSecond and VIEW_DELAY as drawWaveform.
    const plotWidth = width - Y_AXIS_WIDTH;
    const pxPerSecond = width / SECONDS_TO_SHOW;
    const rowHeight = height / visibleBins;
    const VIEW_DELAY = 2.0; // must match server.py delay_samples / FS

    const canvasBg = getThemeColor('--canvas-bg');

    ctxSpec.fillStyle = canvasBg;
    ctxSpec.fillRect(0, 0, width, height);

    // Find absolute max for color normalization (considering toggled channels)
    const useZ = rowModes['Z'] === 'spec';
    const useN = rowModes['N'] === 'spec';
    const useE = rowModes['E'] === 'spec';
    
    let globalMax = 0.0001;
    for (let r = 0; r < specHistory.length; r++) {
        const row = specHistory[r];
        const hasPerComp = row.mags_z != null;
        if (hasPerComp && (useZ || useN || useE)) {
            for (let c = 0; c < maxFreqBins; c++) {
                let sum = 0;
                if (useZ) sum += row.mags_z[c] ** 2;
                if (useN) sum += row.mags_n[c] ** 2;
                if (useE) sum += row.mags_e[c] ** 2;
                const v = Math.sqrt(sum);
                if (v > globalMax) globalMax = v;
            }
        } else {
            for (let c = 0; c < maxFreqBins; c++) {
                if (row.mags[c] > globalMax) globalMax = row.mags[c];
            }
        }
    }

    const limit = Math.min(SPEC_ROWS, specHistory.length);
    const nowSec = getServerTime();

    for (let t = 0; t < limit; t++) {
        const row = specHistory[t];
        if (row.epoch == null) continue;

        // Align the visual rendering perfectly with the 
        // true mathematical center of the 2-second Hanning FFT window.
        const adjustedEpoch = row.epoch - 0.5;
        const age = nowSec - adjustedEpoch;
        
        // x = width - (age - VIEW_DELAY) * pxPerSecond  (same formula as waveform)
        const xRight = width - (age - VIEW_DELAY) * pxPerSecond;
        const xPos = xRight - pxPerSecond; // left edge of this 1-second column

        // Skip columns fully outside the visible area
        if (xRight <= Y_AXIS_WIDTH) continue;
        if (xPos >= width) continue;

        // Use per-component mags if available, RSS-combining only toggled channels
        const hasPerComp = row.mags_z != null;
        
        for (let i = 0; i < visibleBins; i++) {
            const fIdx = startBin + i;
            
            let rawMag;
            if (hasPerComp && (useZ || useN || useE)) {
                // RSS-combine only toggled channels
                let sum = 0;
                if (useZ) sum += row.mags_z[fIdx] ** 2;
                if (useN) sum += row.mags_n[fIdx] ** 2;
                if (useE) sum += row.mags_e[fIdx] ** 2;
                rawMag = Math.sqrt(sum);
            } else {
                // Fallback to pre-combined RSS mags
                rawMag = row.mags[fIdx];
            }
            
            let mag = (rawMag / globalMax) * specGain;
            if (mag > 1) mag = 1;
            if (mag < 0) mag = 0;

            if (useLogScale) {
                mag = Math.log10(1 + mag * 9);
            }

            const lutIdx = Math.min(255, Math.floor(mag * 255));
            ctxSpec.fillStyle = RAINBOW_LUT[lutIdx];

            // Calculate the true frequency boundaries for this bin
            // Resolution is 0.5Hz per bin
            const f_start = specMinFreq + i * 0.5;
            const f_end = specMinFreq + (i + 1) * 0.5;

            // Invert the Y logic: higher frequency is smaller Y coordinate
            const yBottom = getSpecY(f_start, specMinFreq, specMaxFreq, height, useLogScale);
            const yTop = getSpecY(f_end, specMinFreq, specMaxFreq, height, useLogScale);

            const drawX = Math.floor(Math.max(xPos, Y_AXIS_WIDTH));
            if (drawX < width) {
                // Ensure floating point values overlap perfectly without bleeding or rendering gaps
                const yDraw = Math.floor(yTop);
                // Math.ceil the difference to absolutely fill the fractional sub-pixel gap bounds
                const hDraw = Math.ceil(yBottom - yDraw);
                
                ctxSpec.fillRect(drawX, yDraw, Math.ceil(pxPerSecond) + 1, hDraw + 1);
            }
        }
    }

    // --- Draw Frequency Ticks & Gridlines ---
    const textSecondary = getThemeColor('--text-secondary');
    const borderSemi = currentTheme === 'light' ? 'rgba(0,0,0,0.3)' : 'rgba(255, 255, 255, 0.5)';
    const gridLine = getThemeColor('--grid-line');

    ctxSpec.fillStyle = textSecondary;
    ctxSpec.font = '10px Courier New';
    ctxSpec.textAlign = 'left';
    ctxSpec.textBaseline = 'middle';

    const delta = specMaxFreq - specMinFreq;
    let ticks = [];

    if (useLogScale) {
        // Generate nice exponential ticks strictly fitting inside display bounds
        const logTicks = [0.5, 1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        ticks = logTicks.filter(t => t >= specMinFreq && t <= specMaxFreq);
    } else {
        let interval = 5;
        if (delta <= 10) interval = 1;
        else if (delta <= 20) interval = 2;

        let startTick = Math.ceil(specMinFreq / interval) * interval;
        for (let f = startTick; f <= specMaxFreq; f += interval) {
            ticks.push(f);
        }
    }

    ticks.forEach(f => {
        const yPos = getSpecY(f, specMinFreq, specMaxFreq, height, useLogScale);

        // Gridline (subtle)
        ctxSpec.strokeStyle = gridLine;
        ctxSpec.lineWidth = 1;
        ctxSpec.beginPath();
        ctxSpec.moveTo(Y_AXIS_WIDTH, yPos);
        ctxSpec.lineTo(width, yPos);
        ctxSpec.stroke();

        // Tick Mark
        ctxSpec.strokeStyle = borderSemi;
        ctxSpec.beginPath();
        ctxSpec.moveTo(Y_AXIS_WIDTH - 5, yPos);
        ctxSpec.lineTo(Y_AXIS_WIDTH, yPos);
        ctxSpec.stroke();

        // Label
        if (yPos < 10) ctxSpec.textBaseline = 'top';
        else if (yPos > height - 10) ctxSpec.textBaseline = 'bottom';
        else ctxSpec.textBaseline = 'middle';

        ctxSpec.fillText(`${f}Hz`, 5, yPos);
    });
}

function drawSpectrumPlot() {
    if (!latestSpectrumData) return;

    const width = spectroCanvas.width;
    const height = spectroCanvas.height;
    const canvasBg = getThemeColor('--canvas-bg');
    
    // Dedicate the bottom 22 physical pixels entirely to the X-Axis labels to prevent tracing overlap
    const X_AXIS_HEIGHT = 22;
    const plotHeight = height - X_AXIS_HEIGHT;
    
    ctxSpec.fillStyle = canvasBg;
    ctxSpec.fillRect(0, 0, width, height);

    const freqs = latestSpectrumData.freqs;
    const zData = spectrumWindowSize === '2s' ? latestSpectrumData.z_2s : latestSpectrumData.z_60s;
    const nData = spectrumWindowSize === '2s' ? latestSpectrumData.n_2s : latestSpectrumData.n_60s;
    const eData = spectrumWindowSize === '2s' ? latestSpectrumData.e_2s : latestSpectrumData.e_60s;

    if (!freqs || !zData) return;

    // Filter to selected freq range
    let minIdx = 0;
    let maxIdx = freqs.length - 1;
    for (let i = 0; i < freqs.length; i++) {
        if (freqs[i] < specMinFreq) minIdx = i + 1;
        if (freqs[i] <= specMaxFreq) maxIdx = i;
    }

    if (maxIdx <= minIdx || minIdx >= freqs.length) return;

    // Determine max amplitude for Y-axis scaling
    let maxAmp = 0.001;
    for (let i = minIdx; i <= maxIdx; i++) {
        if (zData[i] > maxAmp) maxAmp = zData[i];
        if (nData[i] > maxAmp) maxAmp = nData[i];
        if (eData[i] > maxAmp) maxAmp = eData[i];
    }
    
    let maxDisplayGal = (maxAmp * 1.1) / specGain; 

    // Drawing helper
    function drawLinePlot(dataArray, color) {
        ctxSpec.strokeStyle = color;
        ctxSpec.lineWidth = 1.5;
        ctxSpec.lineJoin = 'round';
        ctxSpec.beginPath();
        let started = false;

        for (let i = minIdx; i <= maxIdx; i++) {
            const f = freqs[i];
            const px = Y_AXIS_WIDTH + ((f - specMinFreq) / (specMaxFreq - specMinFreq)) * (width - Y_AXIS_WIDTH);
            let amp = dataArray[i];
            
            let py;
            if (useLogScale) {
                const logVal = Math.max(0, Math.log10(1 + (amp / maxDisplayGal) * 9));
                py = plotHeight - (plotHeight * logVal);
            } else {
                py = plotHeight - (plotHeight * (amp / maxDisplayGal));
            }
            if (py < 0) py = 0; // clamp to top of canvas

            if (!started) {
                ctxSpec.moveTo(px, py);
                started = true;
            } else {
                ctxSpec.lineTo(px, py);
            }
        }
        ctxSpec.stroke();
    }

    // Draw Z (Blue), N (Green), E (Red) only if toggled to SPEC mode
    if (rowModes['Z'] === 'spec') drawLinePlot(zData, '#3b82f6');
    if (rowModes['N'] === 'spec') drawLinePlot(nData, '#10b981');
    if (rowModes['E'] === 'spec') drawLinePlot(eData, '#ef4444');

    // --- Draw Ticks & Gridlines ---
    const textSecondary = getThemeColor('--text-secondary');
    const borderSemi = currentTheme === 'light' ? 'rgba(0,0,0,0.3)' : 'rgba(255, 255, 255, 0.5)';
    const gridLine = getThemeColor('--grid-line');

    ctxSpec.fillStyle = textSecondary;
    ctxSpec.font = '13px Courier New';

    // Y-axis tick values
    ctxSpec.textAlign = 'right';
    ctxSpec.textBaseline = 'top';
    ctxSpec.fillText(`${maxDisplayGal.toFixed(2)}`, Y_AXIS_WIDTH - 5, 5);
    ctxSpec.textBaseline = 'bottom';
    ctxSpec.fillText(`0`, Y_AXIS_WIDTH - 5, plotHeight);

    // Rotate canvas context to draw the long unit string sideways
    ctxSpec.save();
    ctxSpec.translate(15, plotHeight / 2);
    ctxSpec.rotate(-Math.PI / 2);
    ctxSpec.textAlign = 'center';
    ctxSpec.textBaseline = 'middle';
    ctxSpec.fillText(`(cm/s^2)^2/Hz`, 0, 0);
    ctxSpec.restore();

    // Draw Y-axis line
    ctxSpec.strokeStyle = borderSemi;
    ctxSpec.lineWidth = 1;
    ctxSpec.beginPath();
    ctxSpec.moveTo(Y_AXIS_WIDTH, 0);
    ctxSpec.lineTo(Y_AXIS_WIDTH, plotHeight);
    ctxSpec.stroke();

    // Draw X-axis boundary line to protect text margin
    ctxSpec.beginPath();
    ctxSpec.moveTo(Y_AXIS_WIDTH, plotHeight);
    ctxSpec.lineTo(width, plotHeight);
    ctxSpec.stroke();

    // X-axis ticks (Frequency)
    ctxSpec.textAlign = 'center';
    ctxSpec.textBaseline = 'bottom';
    
    let ticks = [];
    if (useLogScale) {
        const logTicks = [0.5, 1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        ticks = logTicks.filter(t => t >= specMinFreq && t <= specMaxFreq);
    } else {
        const delta = specMaxFreq - specMinFreq;
        let interval = 5;
        if (delta <= 10) interval = 1;
        else if (delta <= 20) interval = 2;

        let startTick = Math.ceil(specMinFreq / interval) * interval;
        for (let f = startTick; f <= specMaxFreq; f += interval) {
            ticks.push(f);
        }
    }

    ticks.forEach(f => {
        const px = getSpecX(f, specMinFreq, specMaxFreq, width, useLogScale);
        
        // Vertical grid line
        ctxSpec.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctxSpec.beginPath();
        ctxSpec.moveTo(px, 0);
        ctxSpec.lineTo(px, plotHeight);
        ctxSpec.stroke();
        
        // Tick mark descending visually into the text margin
        ctxSpec.strokeStyle = borderSemi;
        ctxSpec.beginPath();
        ctxSpec.moveTo(px, plotHeight);
        ctxSpec.lineTo(px, plotHeight + 5);
        ctxSpec.stroke();
        
        // Label text safely isolated inside the margin bounds
        ctxSpec.fillText(`${f}Hz`, px, height - 3);
    });
}

// Start everything
connectWaveform();
connectSpectro();
requestAnimationFrame(drawWaveform);

// --- History Data Export ---
const historyDateInput = document.getElementById('historyDate');

// Set default date to today (UTC)
const today = new Date().toISOString().split('T')[0];
if (historyDateInput) historyDateInput.value = today;

function triggerDownload(channel = null) {
    const date = historyDateInput.value;
    if (!date) {
        alert("Please select a date first");
        return;
    }
    let url = `/api/download_mseed?date=${date}`;
    if (channel) {
        url += `&channel=${channel}`;
    }
    window.location.href = url;
}

document.getElementById('downloadAllBtn').addEventListener('click', () => triggerDownload());
document.getElementById('downloadZBtn').addEventListener('click', () => triggerDownload('HLZ'));
document.getElementById('downloadNBtn').addEventListener('click', () => triggerDownload('HLN')); // HLN = North
document.getElementById('downloadEBtn').addEventListener('click', () => triggerDownload('HLE')); // HLE = East

// --- Spectrogram / Spectrum Controls ---
const gainSlider = document.getElementById('gainSlider');
const gainValueLabel = document.getElementById('gainValue');
const btnLin = document.getElementById('btnLin');
const btnLog = document.getElementById('btnLog');

const btnModeSpectrogram = document.getElementById('btnModeSpectrogram');
const btnModeSpectrum = document.getElementById('btnModeSpectrum');
const spectrumWindowControl = document.getElementById('spectrumWindowControl');
const btnWin2s = document.getElementById('btnWin2s');
const btnWin60s = document.getElementById('btnWin60s');

const timeWindowSlider = document.getElementById('timeWindow');
const valTimeWindow = document.getElementById('valTimeWindow');
const lblTimeLeft = document.getElementById('lblTimeLeft');

if (timeWindowSlider && valTimeWindow) {
    timeWindowSlider.addEventListener('input', (e) => {
        SECONDS_TO_SHOW = parseInt(e.target.value, 10);
        valTimeWindow.textContent = SECONDS_TO_SHOW;
        if (lblTimeLeft) {
            lblTimeLeft.textContent = `T-${SECONDS_TO_SHOW}s`;
        }
    });
}

if (btnModeSpectrogram) {
    btnModeSpectrogram.addEventListener('click', () => {
        isSpectrumMode = false;
        btnModeSpectrogram.classList.add('active');
        btnModeSpectrum.classList.remove('active');
        spectrumWindowControl.style.display = 'none';
    });

    btnModeSpectrum.addEventListener('click', () => {
        isSpectrumMode = true;
        btnModeSpectrum.classList.add('active');
        btnModeSpectrogram.classList.remove('active');
        spectrumWindowControl.style.display = 'flex';
    });
}

if (btnWin2s) {
    btnWin2s.addEventListener('click', () => {
        spectrumWindowSize = '2s';
        btnWin2s.classList.add('active');
        btnWin60s.classList.remove('active');
    });

    btnWin60s.addEventListener('click', () => {
        spectrumWindowSize = '60s';
        btnWin60s.classList.add('active');
        btnWin2s.classList.remove('active');
    });
}

// --- Theme Controls ---
document.getElementById('btnThemeDark').addEventListener('click', () => applyTheme('dark'));
document.getElementById('btnThemeLight').addEventListener('click', () => applyTheme('light'));

gainSlider.addEventListener('input', () => {
    specGain = parseFloat(gainSlider.value);
    gainValueLabel.textContent = specGain.toFixed(1) + 'x';
});

btnLin.addEventListener('click', () => {
    useLogScale = false;
    btnLin.classList.add('active');
    btnLog.classList.remove('active');
});

btnLog.addEventListener('click', () => {
    useLogScale = true;
    btnLog.classList.add('active');
    btnLin.classList.remove('active');
});

// --- Waveform Scale Controls ---
const btnWaveLin = document.getElementById('btnWaveLin');
const btnWaveLog = document.getElementById('btnWaveLog');

if (btnWaveLin) {
    btnWaveLin.addEventListener('click', () => {
        useWaveformLogScale = false;
        btnWaveLin.classList.add('active');
        btnWaveLog.classList.remove('active');
    });

    btnWaveLog.addEventListener('click', () => {
        useWaveformLogScale = true;
        btnWaveLog.classList.add('active');
        btnWaveLin.classList.remove('active');
    });
}

const sliderZ = document.getElementById('scaleZ');
const sliderN = document.getElementById('scaleN');
const sliderE = document.getElementById('scaleE');
const valZ = document.getElementById('valScaleZ');
const valN = document.getElementById('valScaleN');
const valE = document.getElementById('valScaleE');

const rZt = document.getElementById('rangeZTop'), rZb = document.getElementById('rangeZBottom');
const rNt = document.getElementById('rangeNTop'), rNb = document.getElementById('rangeNBottom');
const rEt = document.getElementById('rangeETop'), rEb = document.getElementById('rangeEBottom');

sliderZ.addEventListener('input', () => {
    scaleZ = parseFloat(sliderZ.value);
    const s = scaleZ.toFixed(1);
    valZ.textContent = s;
    rZt.textContent = '+' + s + 'g';
    rZb.textContent = '-' + s + 'g';
});
sliderN.addEventListener('input', () => {
    scaleN = parseFloat(sliderN.value);
    const s = scaleN.toFixed(1);
    valN.textContent = s;
    rNt.textContent = '+' + s + 'g';
    rNb.textContent = '-' + s + 'g';
});
sliderE.addEventListener('input', () => {
    scaleE = parseFloat(sliderE.value);
    const s = scaleE.toFixed(1);
    valE.textContent = s;
    rEt.textContent = '+' + s + 'g';
    rEb.textContent = '-' + s + 'g';
});

// --- Row Toggle Event Listeners ---
document.querySelectorAll('.row-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
        const channel = btn.getAttribute('data-channel');
        
        // Toggle the active state on the button
        btn.classList.toggle('active');
        const isActive = btn.classList.contains('active');
        
        // Update selection state for bottom panel filtering
        rowModes[channel] = isActive ? 'spec' : 'wave';
    });
});

// --- Spectrogram Frequency Range Controls ---
const inpFreqMin = document.getElementById('freqMin');
const inpFreqMax = document.getElementById('freqMax');
const valFreqMin = document.getElementById('valFreqMin');
const valFreqMax = document.getElementById('valFreqMax');
const freqSliderFill = document.getElementById('freqSliderFill');

function updateFreqFill() {
    const minVal = parseFloat(inpFreqMin.value);
    const maxVal = parseFloat(inpFreqMax.value);
    const totalRange = 50.0 - 0.02;
    const minPercent = ((minVal - 0.02) / totalRange) * 100;
    const maxPercent = ((maxVal - 0.02) / totalRange) * 100;
    freqSliderFill.style.left = minPercent + '%';
    freqSliderFill.style.width = (maxPercent - minPercent) + '%';
}

inpFreqMin.addEventListener('input', (e) => {
    let val = parseFloat(e.target.value);
    if (val >= specMaxFreq) {
        val = specMaxFreq - 0.5;
        if (val < 0.02) val = 0.02;
        e.target.value = val;
    }
    specMinFreq = val;
    valFreqMin.textContent = specMinFreq.toFixed(2);
    updateFreqFill();
});

inpFreqMax.addEventListener('input', (e) => {
    let val = parseFloat(e.target.value);
    if (val <= specMinFreq) {
        val = specMinFreq + 0.5;
        if (val > 50.0) val = 50.0;
        e.target.value = val;
    }
    specMaxFreq = val;
    valFreqMax.textContent = specMaxFreq.toFixed(2);
    updateFreqFill();
});

// Initialize fill
updateFreqFill();

// --- Waveform Hover Tooltip ---
const tooltip = document.getElementById('hoverTooltip');

// Since scales can change, we need the logic to use the current scale variables
// instead of a captured value. 
canvasZ.addEventListener('mousemove', (e) => updateTooltip(e, canvasZ, scaleZ, waveZ));
canvasN.addEventListener('mousemove', (e) => updateTooltip(e, canvasN, scaleN, waveY));
canvasE.addEventListener('mousemove', (e) => updateTooltip(e, canvasE, scaleE, waveX));

const hideTooltip = () => { tooltip.style.display = 'none'; };
canvasZ.addEventListener('mouseleave', hideTooltip);
canvasN.addEventListener('mouseleave', hideTooltip);
canvasE.addEventListener('mouseleave', hideTooltip);
spectroCanvas.addEventListener('mouseleave', hideTooltip);

function updateTooltip(e, canvas, currentScale, dataArray) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const w = rect.width;

    let sampleValue = 0;
    if (dataArray && dataArray.length > 0) {
        const idx = Math.floor((mouseX / w) * (dataArray.length - 1));
        const safeIdx = Math.max(0, Math.min(dataArray.length - 1, idx));
        sampleValue = dataArray[safeIdx];
    }

    tooltip.style.display = 'block';
    tooltip.innerHTML = `<span style="color: var(--accent-green); font-weight:bold;">${sampleValue.toFixed(4)} g</span>`;

    positionTooltip(e);
}

function positionTooltip(e) {
    const offset = 15;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;

    let left = e.clientX + offset;
    let top = e.clientY + 10;

    if (left + tooltipWidth > window.innerWidth) {
        left = e.clientX - offset - tooltipWidth;
    }

    if (top + tooltipHeight > window.innerHeight) {
        top = e.clientY - 10 - tooltipHeight;
    }

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
}

// --- Dynamic Datetime Clock ---
function updateAxisClocks() {
    const VIEW_DELAY = 2.0; // matching waveform delay
    const now = new Date((getServerTime() * 1000) - VIEW_DELAY * 1000);
    const past = new Date(now.getTime() - SECONDS_TO_SHOW * 1000);

    const pad = (n) => n.toString().padStart(2, '0');

    // Format: HH:MM:SS
    const timeRightStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const timeLeftStr = `${pad(past.getHours())}:${pad(past.getMinutes())}:${pad(past.getSeconds())}`;

    // Update all right-side labels
    document.querySelectorAll('.time-right').forEach(el => {
        el.innerHTML = timeRightStr;
    });
    // Update all left-side labels
    document.querySelectorAll('.time-left').forEach(el => {
        el.innerHTML = timeLeftStr;
    });
}

// Start Clock and tick every 1000ms
setInterval(updateAxisClocks, 1000);
updateAxisClocks(); // Initial call
