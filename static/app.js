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
const SECONDS_TO_SHOW = 60;
const WEBSOCKET_URL = `ws://${window.location.host}`;

// --- Waveform State ---
let waveX = new Float32Array(FS * SECONDS_TO_SHOW);
let waveY = new Float32Array(FS * SECONDS_TO_SHOW);
let waveZ = new Float32Array(FS * SECONDS_TO_SHOW);
let scaleZ = 2.0;
let scaleN = 2.0;
let scaleE = 2.0;

// --- Spectrogram State ---
// Let's store 60 rows, giving us 60 seconds of history updated every 1s, matching the Waveform SECONDS_TO_SHOW
const SPEC_ROWS = 60;
let specHistory = []; // array of Float32Arrays
let maxFreqBins = 0; // Will be set when first payload arrives
let lastSpectroTime = performance.now(); // Track when the last Spectrogram frame arrived

// --- Spectrogram Controls ---
let specGain = 1.0;
let useLogScale = false;

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
            const len = data.y.length;
            waveX.copyWithin(0, len);
            waveY.copyWithin(0, len);
            waveZ.copyWithin(0, len);

            const startIdx = waveX.length - len;
            for (let i = 0; i < len; i++) {
                waveX[startIdx + i] = data.y[i][0];
                waveY[startIdx + i] = data.y[i][1];
                waveZ[startIdx + i] = data.y[i][2];
            }
        }
    };
    wsWaveform.onopen = updateStatus;
    wsWaveform.onclose = () => { updateStatus(); setTimeout(connectWaveform, 1000); };
}

function connectSpectro() {
    wsSpectro = new WebSocket(`${WEBSOCKET_URL}/ws/spectrogram`);
    wsSpectro.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.mags) {
            maxFreqBins = data.mags.length;
            const newRow = new Float32Array(data.mags);

            // Waterfall down: Add new to top, remove from bottom
            specHistory.unshift(newRow);
            if (specHistory.length > SPEC_ROWS) {
                specHistory.pop();
            }

            // Record when we received this frame
            lastSpectroTime = performance.now();
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

        const response = await fetch(`/static/${lang}.json`);
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

    // Clear Backgrounds
    ctxZ.fillStyle = '#000000';
    ctxZ.fillRect(0, 0, width, height);
    ctxN.fillStyle = '#000000';
    ctxN.fillRect(0, 0, width, height);
    ctxE.fillStyle = '#000000';
    ctxE.fillRect(0, 0, width, height);

    // Helper to draw a single axis line
    function drawAxis(ctx, buffer, color, scale) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const len = buffer.length;
        for (let i = 0; i < len; i++) {
            const x = (i / (len - 1)) * width;
            const normalized = (buffer[i] / scale + 1) / 2;
            const y = height - (normalized * height);

            if (i === 0) ctx.moveTo(x, y);
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

// --- Render Loop (Spectrogram) ---
function drawSpectrogram() {
    if (specHistory.length === 0) return;

    const width = spectroCanvas.width;
    const height = spectroCanvas.height;
    const colWidth = width / SPEC_ROWS; // Time mapped to Width
    const rowHeight = height / maxFreqBins; // Frequency mapped to Height

    ctxSpec.fillStyle = '#000000';
    ctxSpec.fillRect(0, 0, width, height);

    // Find absolute max across history to normalize colors
    let globalMax = 0.0001;
    for (let r = 0; r < specHistory.length; r++) {
        for (let c = 0; c < maxFreqBins; c++) {
            if (specHistory[r][c] > globalMax) globalMax = specHistory[r][c];
        }
    }

    // Calculate the sub-second offset to continuously push the blocks leftwards.
    // Floating without clamping allows it to remain perfectly aligned through slight micro-drifts.
    const elapsedSeconds = (performance.now() - lastSpectroTime) / 1000.0;
    const pixelOffsetLeft = elapsedSeconds * colWidth;

    // Draw columns (Time). Index 0 is newest. Let's draw newest on the far right.
    const limit = Math.min(SPEC_ROWS, specHistory.length);
    for (let t = 0; t < limit; t++) {
        const timeData = specHistory[t];
        const xPos = (SPEC_ROWS - 2 - t) * colWidth - pixelOffsetLeft;

        for (let f = 0; f < maxFreqBins; f++) {
            // Normalize value 0 to 1, apply gain multiplier
            let mag = (timeData[f] / globalMax) * specGain;
            if (mag > 1) mag = 1;
            if (mag < 0) mag = 0;

            // Optional log scale: compress dynamic range to reveal weak signals
            if (useLogScale) {
                mag = Math.log10(1 + mag * 9);
            }

            // Rainbow LUT lookup (0–255)
            const lutIdx = Math.min(255, Math.floor(mag * 255));
            ctxSpec.fillStyle = RAINBOW_LUT[lutIdx];

            // Frequencies map to Height. Lowest freq (f=0) at the very bottom.
            const yPos = height - ((f + 1) * rowHeight);

            // Render block, adding 1 to width to eliminate sub-pixel tearing gaps
            ctxSpec.fillRect(Math.floor(xPos), Math.floor(yPos), Math.ceil(colWidth) + 1, Math.ceil(rowHeight));
        }
    }
}

// Start everything
connectWaveform();
connectSpectro();
requestAnimationFrame(drawWaveform);

// Export Data
document.getElementById('downloadMseedBtn').addEventListener('click', () => {
    window.location.href = '/api/download_mseed';
});

// --- Spectrogram Controls ---
const gainSlider = document.getElementById('gainSlider');
const gainValueLabel = document.getElementById('gainValue');
const btnLin = document.getElementById('btnLin');
const btnLog = document.getElementById('btnLog');

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

// --- Dynamic Datetime Clock ---
function updateAxisClocks() {
    const now = new Date();
    // Offset by 60 seconds for the left axis
    const past = new Date(now.getTime() - 60000);

    const pad = (n) => n.toString().padStart(2, '0');

    // Format: HH:MM:SS
    const timeRightStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const timeLeftStr = `${pad(past.getHours())}:${pad(past.getMinutes())}:${pad(past.getSeconds())}`;

    // Update all right-side labels (NOW)
    const rightLabels = document.querySelectorAll('.time-right');
    rightLabels.forEach(el => {
        // For the spectrogram, it technically is 2 seconds delayed mathematically due to FFT chunking,
        // but we can append the label gracefully.
        if (el.parentElement.className === 'spectro-container') {
            el.innerHTML = `${timeRightStr} (-2s)`;
        } else {
            el.innerHTML = timeRightStr;
        }
    });

    // Update all left-side labels (T-60s)
    const leftLabels = document.querySelectorAll('.time-left');
    leftLabels.forEach(el => {
        el.innerHTML = timeLeftStr;
    });
}

// Start Clock and tick every 1000ms
setInterval(updateAxisClocks, 1000);
updateAxisClocks(); // Initial call
