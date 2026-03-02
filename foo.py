import numpy as np
import streamlit as st
import plotly.graph_objects as go
from scipy.signal import butter, lfilter
import collections
import time

# --- CONFIGURATION ---
FS = 100
WINDOW_SIZE = 500
ALERT_THRESHOLD = 0.04
LOWCUT, HIGHCUT = 0.5, 20.0

# --- 1. SESSION STATE PERSISTENCE ---
# We store the last 3 processed windows to create the "trail"
if 'history' not in st.session_state:
    st.session_state.history = collections.deque(maxlen=3)
if 'buffer' not in st.session_state:
    st.session_state.buffer = collections.deque([0.0]*WINDOW_SIZE, maxlen=WINDOW_SIZE)

# --- 2. THE PHIDGET GENERATOR (Clean Stream) ---
def seismic_gen():
    """Mock generator: Replace with your Phidget call"""
    while True:
        # val = ch.getVoltageRatio()
        yield np.random.normal(0, 0.005) + (np.sin(time.time() * 5) * 0.01)
        time.sleep(1/FS)

gen = seismic_gen()

# --- 3. SIGNAL PROCESSING ---
b, a = butter(4, [LOWCUT/(0.5*FS), HIGHCUT/(0.5*FS)], btype='band')

def process_stream(data):
    arr = np.array(data)
    centered = arr - np.mean(arr)
    return lfilter(b, a, centered)

# --- 4. UI LAYOUT ---
st.set_page_config(page_title="Seismic Persistence Monitor", layout="wide")
st.markdown("<style>.main {background-color: #050505;}</style>", unsafe_allow_html=True)

chart_place = st.empty()
spec_place = st.empty()

# --- 5. THE CONTINUOUS SWEEP LOOP ---
while True:
    # Batch pull for smoothness
    for _ in range(10): 
        st.session_state.buffer.append(next(gen))
    
    # Process current window
    current_proc = process_stream(list(st.session_state.buffer))
    st.session_state.history.append(current_proc)
    
    # Check Alert (Memory Trigger)
    is_alert = np.max(np.abs(current_proc)) > ALERT_THRESHOLD
    base_color = "rgba(255, 0, 0, " if is_alert else "rgba(0, 255, 65, "

    # --- PLOTLY PERSISTENCE ENGINE ---
    fig = go.Figure()

    # Add Ghost Trails (The Persistence Effect)
    for i, hist_data in enumerate(st.session_state.history):
        # Calculate opacity based on age (oldest is faintest)
        opacity = (i + 1) / (len(st.session_state.history) + 1)
        # Final trace (index 2) is the current bright one
        width = 2 if i == len(st.session_state.history)-1 else 1
        
        fig.add_trace(go.Scatter(
            y=hist_data,
            mode='lines',
            line=dict(color=f"{base_color}{opacity})", width=width),
            hoverinfo='skip'
        ))

    fig.update_layout(
        template="plotly_dark",
        showlegend=False,
        xaxis=dict(range=[0, WINDOW_SIZE], showgrid=False, zeroline=False),
        yaxis=dict(range=[-0.08, 0.08], gridcolor='#111'),
        margin=dict(l=0, r=0, t=20, b=0),
        height=400,
        plot_bgcolor='black'
    )

    chart_place.plotly_chart(fig, use_container_width=True, config={'displayModeBar': False})

    # Spectrogram Refresh (2s Granularity)
    if time.time() % 2 < 0.2:
        mags = np.abs(np.fft.rfft(current_proc[-200:]))
        freqs = np.fft.rfftfreq(200, 1/FS)
        fig_spec = go.Figure(go.Heatmap(z=[mags], x=freqs, colorscale='Magma'))
        fig_spec.update_layout(height=250, template="plotly_dark", margin=dict(t=0))
        spec_place.plotly_chart(fig_spec, use_container_width=True)

    time.sleep(0.05)
