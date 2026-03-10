const waveformCanvas = document.getElementById('waveformCanvas');
const spectroCanvas = document.getElementById('spectroCanvas');
const ctxWave = waveformCanvas.getContext('2d', { alpha: false });
const ctxSpec = spectroCanvas.getContext('2d', { alpha: false });

let wsWaveform, wsSpectro;

// Configuration
const FS = 100; // 100Hz
const SECONDS_TO_SHOW = 5;
const WEBSOCKET_URL = `ws://${window.location.host}`;

// --- Waveform State ---
let waveformBuffer = new Float32Array(FS * SECONDS_TO_SHOW);
let currentScale = 0.05;

// --- Spectrogram State ---
// Let's store 60 rows for example, giving us 120 seconds of history if updated every 2s
const SPEC_ROWS = 60; 
let specHistory = []; // array of Float32Arrays
let maxFreqBins = 0; // Will be set when first payload arrives

function resize() {
    // Waveform
    waveformCanvas.width = waveformCanvas.parentElement.clientWidth;
    waveformCanvas.height = waveformCanvas.parentElement.clientHeight;
    // Spectrogram
    spectroCanvas.width = spectroCanvas.parentElement.clientWidth;
    spectroCanvas.height = spectroCanvas.parentElement.clientHeight;
}

window.addEventListener('resize', resize);
resize();

// --- Connect WebSockets ---
function connectWaveform() {
    wsWaveform = new WebSocket(`${WEBSOCKET_URL}/ws/waveform`);
    wsWaveform.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.y && data.y.length > 0) {
            // Shift the buffer left by the number of new samples
            const len = data.y.length;
            waveformBuffer.copyWithin(0, len);
            // Insert new data at the end (right side)
            waveformBuffer.set(data.y, waveformBuffer.length - len);
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
            
            // We draw the spectrogram statically on every 2s update
            drawSpectrogram();
        }
    };
}

function updateStatus() {
    const el = document.getElementById('conn-status');
    if (wsWaveform && wsWaveform.readyState === WebSocket.OPEN) {
        el.innerHTML = `<div class="status-dot"></div> Streaming LIVE`;
        el.style.color = 'var(--accent-green)';
    } else {
        el.innerHTML = `<div class="status-dot" style="background: var(--accent-red); box-shadow: none; animation: none;"></div> OFFLINE`;
        el.style.color = 'var(--accent-red)';
    }
}

// --- Render Loop (Waveform) ---
function drawWaveform() {
    const width = waveformCanvas.width;
    const height = waveformCanvas.height;
    
    // Clear Background
    ctxWave.fillStyle = '#000000';
    ctxWave.fillRect(0, 0, width, height);

    // Dynamic Scaling
    let localMax = 0;
    for (let i = 0; i < waveformBuffer.length; i++) {
        const abs = Math.abs(waveformBuffer[i]);
        if (abs > localMax) localMax = abs;
    }
    
    // Smooth scale adjustment
    const targetScale = Math.max(0.01, localMax * 1.5);
    currentScale += (targetScale - currentScale) * 0.1;
    
    document.getElementById('scale-indicator').innerText = `±${currentScale.toFixed(3)}G`;
    
    const isAlert = localMax > 0.04;
    ctxWave.strokeStyle = isAlert ? '#ef4444' : '#10b981';
    ctxWave.lineWidth = 2;
    ctxWave.lineJoin = 'round';
    
    ctxWave.beginPath();
    const len = waveformBuffer.length;
    for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * width;
        // Map value from [-currentScale, +currentScale] to [height, 0]
        const normalized = (waveformBuffer[i] / currentScale + 1) / 2;
        const y = height - (normalized * height);
        
        if (i === 0) ctxWave.moveTo(x, y);
        else ctxWave.lineTo(x, y);
    }
    ctxWave.stroke();
    
    // Request next frame for that buttery 60fps Blit mode effect
    requestAnimationFrame(drawWaveform);
}

// --- Render Loop (Spectrogram) ---
// Note: We only call this when a new WebSocket frame arrives (every 2s), 
// because a heatmap redrawing at 60fps is computationally expensive and unnecessary.
function drawSpectrogram() {
    if (specHistory.length === 0) return;
    
    const width = spectroCanvas.width;
    const height = spectroCanvas.height;
    const rowHeight = height / SPEC_ROWS;
    const colWidth = width / maxFreqBins;
    
    ctxSpec.fillStyle = '#000000';
    ctxSpec.fillRect(0, 0, width, height);
    
    // Find absolute max across history to normalize colors
    let globalMax = 0.0001; 
    for(let r=0; r<specHistory.length; r++) {
        for(let c=0; c<maxFreqBins; c++) {
            if (specHistory[r][c] > globalMax) globalMax = specHistory[r][c];
        }
    }
    
    // Draw from top (index 0 is newest) to bottom
    const limit = Math.min(SPEC_ROWS, specHistory.length);
    for (let r = 0; r < limit; r++) {
        const rowData = specHistory[r];
        const yPos = r * rowHeight;
        
        for (let c = 0; c < maxFreqBins; c++) {
            // Normalize value 0 to 1
            let mag = rowData[c] / globalMax;
            if (mag > 1) mag = 1;
            
            // Map magnitude to a standard heatmap color (Viridis-ish approximation)
            // Low = Blue, Mid = Green, High = Yellow
            const hue = (1.0 - mag) * 240; 
            ctxSpec.fillStyle = `hsl(${hue}, 100%, ${mag > 0.1 ? 50 : 10}%)`;
            
            ctxSpec.fillRect(c * colWidth, yPos, Math.ceil(colWidth), Math.ceil(rowHeight));
        }
    }
}

// Start everything
connectWaveform();
connectSpectro();
requestAnimationFrame(drawWaveform);
