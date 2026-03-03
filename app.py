import streamlit as st
import numpy as np
import plotly.graph_objects as go
from scipy.signal import butter, lfilter
import collections
import time
import os

# Phidget Accelerometer Class (Confirmed for 1043_1)
from Phidget22.Devices.Accelerometer import Accelerometer

# --- 1. CONFIGURATION ---
FS = 100            # Target 100Hz
WINDOW_SIZE = 500   # 5 seconds of visibility
ALERT_THRESHOLD = 0.04 
LOWCUT, HIGHCUT = 0.5, 20.0

# --- 2. PERSISTENT HARDWARE CONNECTION ---
@st.cache_resource
def init_seismic_hardware():
    # Ring Buffer for raw data
    buffer = collections.deque([0.0] * 1000, maxlen=1000)
    ch = Accelerometer()
    state = {"attached": False}

    def on_attach(self):
        state["attached"] = True
    def on_detach(self):
        state["attached"] = False

    def on_accel_change(self, acceleration, timestamp):
        # Index 2 is Z-axis. Subtract 1.0 to remove gravity (De-mean)
        buffer.append(acceleration[2] - 1.0)

    ch.setOnAttachHandler(on_attach)
    ch.setOnDetachHandler(on_detach)
    ch.setOnAccelerationChangeHandler(on_accel_change)

    try:
        ch.setDeviceSerialNumber(372690)
        ch.setIsLocal(True)
        ch.openWaitForAttachment(2000)
        ch.setDataInterval(10) # 10ms = 100Hz
    except:
        pass # UI handles the 'False' state

    return ch, buffer, state

# --- 3. UI SETUP ---
st.set_page_config(page_title="Seismic Vibe 1043", layout="wide")
st.markdown("<style>.main {background-color: #050505;}</style>", unsafe_allow_html=True)

ch, data_buffer, phidget_state = init_seismic_hardware()

# Sidebar Health
st.sidebar.header("System Health")
if phidget_state["attached"]:
    st.sidebar.success("🟢 Phidget 1043 (0/0/3) Online")
else:
    st.sidebar.error("🔴 Phidget Offline")
    if st.sidebar.button("Re-sync Hardware"):
        st.cache_resource.clear()
        st.rerun()

# Processing Config
b, a = butter(4, [LOWCUT/(0.5*FS), HIGHCUT/(0.5*FS)], btype='band')

# History for Persistence Effect
if 'history' not in st.session_state:
    st.session_state.history = collections.deque(maxlen=4)

# Placeholders for Smooth Updates
chart_place = st.empty()
spec_place = st.empty()

# --- 4. THE MONITORING LOOP ---
while phidget_state["attached"]:
    # 1. Grab snapshot from Ring Buffer
    raw_snapshot = np.array(list(data_buffer))[-WINDOW_SIZE:]
    
    if len(raw_snapshot) >= WINDOW_SIZE:
        # 2. Bandpass Filter (De-mean happened in callback)
        processed = lfilter(b, a, raw_snapshot)
        st.session_state.history.append(processed)
        
        # 3. Alert Trigger (Memory)
        is_alert = np.max(np.abs(processed)) > ALERT_THRESHOLD
        color_base = "rgba(255, 0, 0, " if is_alert else "rgba(0, 255, 65, "

        # --- 4. PERSISTENCE SWEEP (Plotly) ---
        fig = go.Figure()
        
        # Layer older traces with fading alpha
        for i, hist_trace in enumerate(st.session_state.history):
            alpha = (i + 1) / (len(st.session_state.history) + 1)
            width = 2.5 if i == len(st.session_state.history)-1 else 1
            
            fig.add_trace(go.Scatter(
                y=hist_trace,
                mode='lines',
                line=dict(color=f"{color_base}{alpha})", width=width),
                hoverinfo='skip'
            ))

        fig.update_layout(
            template="plotly_dark",
            showlegend=False,
            xaxis=dict(range=[0, WINDOW_SIZE], showticklabels=False, showgrid=False),
            yaxis=dict(range=[-0.06, 0.06], gridcolor='#111'),
            margin=dict(l=0, r=0, t=20, b=0),
            height=400,
            plot_bgcolor='black'
        )
        chart_place.plotly_chart(fig, use_container_width=True, config={'displayModeBar': False})

        # --- 5. SPECTROGRAM (2s Granularity) ---
        if time.time() % 2 < 0.2:
            # FFT on the last 200 samples
            window_2s = processed[-200:]
            mags = np.abs(np.fft.rfft(window_2s))
            freqs = np.fft.rfftfreq(200, 1/FS)
            
            fig_spec = go.Figure(go.Heatmap(z=[mags], x=freqs, colorscale='Viridis', showscale=False))
            fig_spec.update_layout(height=250, template="plotly_dark", title="Frequency Energy (2s Window)")
            spec_place.plotly_chart(fig_spec, use_container_width=True)

    time.sleep(0.1) # UI Refresh Rate (10 FPS)
