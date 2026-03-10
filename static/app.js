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
const SECONDS_TO_SHOW = 5;
const WEBSOCKET_URL = `ws://${window.location.host}`;

// --- Waveform State ---
let waveX = new Float32Array(FS * SECONDS_TO_SHOW);
let waveY = new Float32Array(FS * SECONDS_TO_SHOW);
let waveZ = new Float32Array(FS * SECONDS_TO_SHOW);
let currentScale = 3.0;

// --- Spectrogram State ---
// Let's store 5 rows, giving us 5 seconds of history updated every 1s, matching the Waveform SECONDS_TO_SHOW
const SPEC_ROWS = 5; 
let specHistory = []; // array of Float32Arrays
let maxFreqBins = 0; // Will be set when first payload arrives

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

window.addEventListener('resize', resize);
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
            for(let i=0; i<len; i++) {
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

    // Hardcode Scale to exactly 3.0G as requested
    currentScale = 3.0;

    // Helper to draw a single axis line
    function drawAxis(ctx, buffer, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const len = buffer.length;
        for (let i = 0; i < len; i++) {
            const x = (i / (len - 1)) * width;
            const normalized = (buffer[i] / currentScale + 1) / 2;
            const y = height - (normalized * height);
            
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    
    // Draw Z (Blue), N mapped to Y (Green), E mapped to X (Red)
    drawAxis(ctxZ, waveZ, '#3b82f6'); // Z
    drawAxis(ctxN, waveY, '#10b981'); // N (Y-axis of sensor)
    drawAxis(ctxE, waveX, '#ef4444'); // E (X-axis of sensor)
    
    // Request next frame for that buttery 60fps Blit mode effect
    requestAnimationFrame(drawWaveform);
}

// --- Render Loop (Spectrogram) ---
// Note: We only call this when a new WebSocket frame arrives (every 1s)
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
    for(let r=0; r<specHistory.length; r++) {
        for(let c=0; c<maxFreqBins; c++) {
            if (specHistory[r][c] > globalMax) globalMax = specHistory[r][c];
        }
    }
    
    // Draw columns (Time). Index 0 is newest. Let's draw newest on the far right.
    const limit = Math.min(SPEC_ROWS, specHistory.length);
    for (let t = 0; t < limit; t++) {
        const timeData = specHistory[t];
        // Center of the canvas is (limit-1). Newest (t=0) is at the far right.
        const xPos = (limit - 1 - t) * colWidth;
        
        for (let f = 0; f < maxFreqBins; f++) {
            // Normalize value 0 to 1
            let mag = timeData[f] / globalMax;
            if (mag > 1) mag = 1;
            
            // Map magnitude to a standard heatmap color (Viridis-ish approximation)
            const hue = (1.0 - mag) * 240; 
            ctxSpec.fillStyle = `hsl(${hue}, 100%, ${mag > 0.1 ? 50 : 10}%)`;
            
            // Frequencies map to Height. Lowest freq (f=0) should be drawn at the very bottom.
            // So we invert the Y axis visually.
            const yPos = height - ((f + 1) * rowHeight);
            
            ctxSpec.fillRect(xPos, yPos, Math.ceil(colWidth), Math.ceil(rowHeight));
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
