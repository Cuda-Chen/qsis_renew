import streamlit as st
import numpy as np
import plotly.graph_objects as go
from scipy.signal import butter, lfilter, lfilter_zi
import collections
import threading
import time
from Phidget22.Devices.Accelerometer import Accelerometer

# --- 1. THE DATA BRIDGE ---
class SeismicDataBridge:
    def __init__(self):
        self.waveform = np.zeros(250)
        self.spec_z = None
        self.spec_x = None
        self.is_alert = False
        self.attached = False
        self.y_limit = 0.05 
        self.heartbeat = 0
        
        self.fs = 100
        self.b, self.a = butter(4, [0.5/50, 20/50], btype='band')
        self.zi = lfilter_zi(self.b, self.a)
        self.lock = threading.Lock()

@st.cache_resource
def get_bridge():
    return SeismicDataBridge()

bridge = get_bridge()

# --- 2. BACKGROUND THREADS ---
@st.cache_resource
def launch_background_threads():
    raw_buffer = collections.deque([0.0] * 500, maxlen=500)
    
    def hardware_loop():
        ch = Accelerometer()
        def on_accel(self, acc, ts):
            raw = acc[2] - 1.0
            with bridge.lock:
                filtered, bridge.zi = lfilter(bridge.b, bridge.a, [raw], zi=bridge.zi)
                val = filtered[0]
                raw_buffer.append(val)
                
                # Decimation
                current_full = np.array(list(raw_buffer))
                reshaped = current_full.reshape(-1, 2)
                bridge.waveform = np.where(np.abs(reshaped[:, 0]) > np.abs(reshaped[:, 1]), reshaped[:, 0], reshaped[:, 1])
                
                peak = np.max(np.abs(current_full))
                bridge.y_limit = max(0.01, peak * 1.2) 
                bridge.is_alert = peak > 0.04
                bridge.heartbeat = (bridge.heartbeat + 1) % 1000

        ch.setOnAccelerationChangeHandler(on_accel)
        ch.setOnAttachHandler(lambda x: setattr(bridge, 'attached', True))
        ch.setOnDetachHandler(lambda x: setattr(bridge, 'attached', False))
        try:
            ch.setDeviceSerialNumber(372690)
            ch.setIsLocal(True)
            ch.openWaitForAttachment(2000)
            ch.setDataInterval(10)
            while True: time.sleep(1)
        except: pass

    def math_loop():
        while True:
            if bridge.attached:
                with bridge.lock:
                    # Take a quick copy to avoid holding the lock during FFT
                    data = np.copy(bridge.waveform)
                
                mags = np.abs(np.fft.rfft(data))
                freqs = np.fft.rfftfreq(len(data), 1/50) # 50Hz because data is decimated
                
                with bridge.lock:
                    bridge.spec_z = [mags[1:60]]
                    bridge.spec_x = freqs[1:60]
            time.sleep(2.0)

    threading.Thread(target=hardware_loop, daemon=True).start()
    threading.Thread(target=math_loop, daemon=True).start()

launch_background_threads()

# --- 3. THE GUI ---
st.set_page_config(page_title="Seismic Station", layout="wide")

# Extreme CSS Locking to fight Streamlit Flicker
st.markdown("""
    <style>
    .main {background-color: #000 !important;}
    /* Lock both chart containers */
    div[data-testid="stPlotlyChart"] {
        background-color: #000 !important;
        border: none !important;
    }
    /* Prevent the blank flash during iframe swap */
    iframe { visibility: visible !important; background-color: #000 !important; }
    </style>
    """, unsafe_allow_html=True)

st.sidebar.markdown(f"### Status: {'🟢 ONLINE' if bridge.attached else '🔴 OFFLINE'}")

# WAVEFORM FRAGMENT (Fast: 120ms)
@st.fragment(run_every=0.12)
def ui_waveform():
    with bridge.lock:
        y_data = np.copy(bridge.waveform)
        y_lim = bridge.y_limit
        alert = bridge.is_alert
        hb = bridge.heartbeat
    
    color = "#FF3131" if alert else "#00FF41"

    fig = go.Figure(go.Scattergl(
        y=y_data, 
        mode='lines',
        line=dict(color=color, width=2),
        hoverinfo='skip'
    ))

    fig.update_layout(
        template="plotly_dark", height=400,
        uirevision='constant', 
        xaxis=dict(range=[0, 250], visible=False, fixedrange=True),
        yaxis=dict(range=[-y_lim, y_lim], fixedrange=True, gridcolor='#151515'),
        margin=dict(t=30, b=0, l=0, r=0),
        plot_bgcolor='black', paper_bgcolor='black',
        annotations=[
            dict(x=0.01, y=0.98, xref="paper", yref="paper", text=f"SCALE: ±{y_lim:.3f}G",
                 showarrow=False, font=dict(family="Courier New", size=14, color=color)),
            dict(x=0.99, y=0.98, xref="paper", yref="paper", text=f"LIVE {'●' if hb % 2 == 0 else '○'}",
                 showarrow=False, font=dict(family="Courier New", size=16, color=color))
        ]
    )
    st.plotly_chart(fig, use_container_width=True, config={'staticPlot': True, 'displayModeBar': False})

# SPECTROGRAM FRAGMENT (Slow: 2s)
@st.fragment(run_every=2.0)
def ui_spectrogram():
    with bridge.lock:
        z = bridge.spec_z
        x = bridge.spec_x
    
    if z is not None and x is not None:
        fig_spec = go.Figure(go.Heatmap(z=z, x=x, colorscale='Viridis', showscale=False))
        fig_spec.update_layout(
            height=200, template="plotly_dark",
            uirevision='constant', # Keeps the heatmap from flashing
            margin=dict(t=30, b=10, l=0, r=0),
            title=dict(text="FFT Spectrum (2s Update)", font=dict(size=14, color="#00FF41")),
            plot_bgcolor='black', paper_bgcolor='black'
        )
        st.plotly_chart(fig_spec, use_container_width=True, config={'staticPlot': True, 'displayModeBar': False})

# Render the UI
ui_waveform()
st.divider()
ui_spectrogram()
