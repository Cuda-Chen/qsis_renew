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
const Y_AXIS_WIDTH = 50;

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
let specMinFreq = 0.5;
let specMaxFreq = 50.0;

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

    // Filter bins based on frequency range
    // Resolution is 0.5Hz, starting at 0.5Hz
    const startBin = Math.max(0, Math.floor((specMinFreq - 0.5) / 0.5));
    const endBin = Math.min(maxFreqBins - 1, Math.floor((specMaxFreq - 0.5) / 0.5));
    const visibleBins = endBin - startBin + 1;

    if (visibleBins <= 0) return;

    const colWidth = (width - Y_AXIS_WIDTH) / SPEC_ROWS; // Time mapped to Width
    const rowHeight = height / visibleBins; // Frequency mapped to Height

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
        const xPos = Y_AXIS_WIDTH + (SPEC_ROWS - 2 - t) * colWidth - pixelOffsetLeft;

        for (let i = 0; i < visibleBins; i++) {
            const fIdx = startBin + i;
            // Normalize value 0 to 1, apply gain multiplier
            let mag = (timeData[fIdx] / globalMax) * specGain;
            if (mag > 1) mag = 1;
            if (mag < 0) mag = 0;

            // Optional log scale: compress dynamic range to reveal weak signals
            if (useLogScale) {
                mag = Math.log10(1 + mag * 9);
            }

            // Rainbow LUT lookup (0–255)
            const lutIdx = Math.min(255, Math.floor(mag * 255));
            ctxSpec.fillStyle = RAINBOW_LUT[lutIdx];

            // Frequencies map to Height. Lowest visible freq at the very bottom.
            const yPos = height - ((i + 1) * rowHeight);

            // Render block, adding 1 to width to eliminate sub-pixel tearing gaps
            if (xPos >= Y_AXIS_WIDTH) {
                ctxSpec.fillRect(Math.floor(xPos), Math.floor(yPos), Math.ceil(colWidth) + 1, Math.ceil(rowHeight));
            }
        }
    }
    
    // --- Draw Frequency Ticks & Gridlines ---
    ctxSpec.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctxSpec.font = '10px Courier New';
    ctxSpec.textAlign = 'left';
    ctxSpec.textBaseline = 'middle';

    const ticks = [];
    // 0~10Hz: 1Hz interval
    for (let f = 0; f <= 10; f += 1) if (f >= specMinFreq && f <= specMaxFreq) ticks.push(f);
    // 10~20Hz: 2Hz interval 
    for (let f = 12; f <= 20; f += 2) if (f >= specMinFreq && f <= specMaxFreq) ticks.push(f);
    // 20Hz~: 5Hz interval
    for (let f = 25; f <= 100; f += 5) if (f >= specMinFreq && f <= specMaxFreq) ticks.push(f);

    ticks.forEach(f => {
        const percent = (f - specMinFreq) / (specMaxFreq - specMinFreq);
        const yPos = height - (percent * height);

        // Gridline (subtle)
        ctxSpec.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctxSpec.lineWidth = 1;
        ctxSpec.beginPath();
        ctxSpec.moveTo(Y_AXIS_WIDTH, yPos);
        ctxSpec.lineTo(width, yPos);
        ctxSpec.stroke();

        // Tick Mark
        ctxSpec.strokeStyle = 'rgba(255, 255, 255, 0.5)';
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

// --- Spectrogram Frequency Range Controls ---
const sliderFreqMin = document.getElementById('freqMin');
const sliderFreqMax = document.getElementById('freqMax');
const valFreqMin = document.getElementById('valFreqMin');
const valFreqMax = document.getElementById('valFreqMax');

sliderFreqMin.addEventListener('input', () => {
    let min = parseFloat(sliderFreqMin.value);
    let max = parseFloat(sliderFreqMax.value);
    
    if (min >= max) {
        min = max - 0.5;
        sliderFreqMin.value = min;
    }
    
    specMinFreq = min;
    valFreqMin.textContent = min.toFixed(1);
});

sliderFreqMax.addEventListener('input', () => {
    let min = parseFloat(sliderFreqMin.value);
    let max = parseFloat(sliderFreqMax.value);
    
    if (max <= min) {
        max = min + 0.5;
        sliderFreqMax.value = max;
    }
    
    specMaxFreq = max;
    valFreqMax.textContent = max.toFixed(1);
});

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
