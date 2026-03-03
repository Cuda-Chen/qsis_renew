import streamlit as st
import numpy as np
import plotly.graph_objects as go
from scipy.signal import butter, lfilter, lfilter_zi
import collections
import time
from Phidget22.Devices.Accelerometer import Accelerometer

# --- 1. SIGNAL PROCESSING ---
FS = 100
LOWCUT, HIGHCUT = 0.5, 20.0
WINDOW_SIZE = 500 # 5 Seconds
ALERT_THRESHOLD = 0.04
B, A = butter(4, [LOWCUT/(0.5*FS), HIGHCUT/(0.5*FS)], btype='band')

@st.cache_resource
def get_seismic_engine():
    # We use a deque for the scrolling effect (Right-to-Left)
    scroll_buffer = collections.deque([0.0] * WINDOW_SIZE, maxlen=WINDOW_SIZE)
    # Persistence history
    history = collections.deque([np.zeros(WINDOW_SIZE)] * 3, maxlen=3)
    
    ch = Accelerometer()
    state = {"attached": False, "zi": lfilter_zi(B, A), "counter": 0}

    def on_accel(self, acc, ts):
        # 1. De-mean (Z - Gravity)
        raw = acc[2] - 1.0
        # 2. Stateful Bandpass
        filtered, state["zi"] = lfilter(B, A, [raw], zi=state["zi"])
        # 3. Append to Right side of deque
        scroll_buffer.append(filtered[0])
        
        # 4. Trigger Persistence every 5 seconds (500 samples)
        state["counter"] += 1
        if state["counter"] >= WINDOW_SIZE:
            history.append(np.array(list(scroll_buffer)))
            state["counter"] = 0

    ch.setOnAccelerationChangeHandler(on_accel)
    ch.setOnAttachHandler(lambda x: state.update({"attached": True}))
    ch.setOnDetachHandler(lambda x: state.update({"attached": False}))

    try:
        ch.setDeviceSerialNumber(372690)
        ch.setIsLocal(True)
        ch.openWaitForAttachment(1000)
        ch.setDataInterval(10)
    except: pass
    
    return ch, scroll_buffer, history, state

# --- 2. UI ---
st.set_page_config(page_title="Seismic Scroll (R->L)", layout="wide")
st.markdown("<style>.main {background-color: #000;}</style>", unsafe_allow_html=True)

ch, scroll_buffer, history, shared_state = get_seismic_engine()

# --- 3. SCROLLING WAVEFORM FRAGMENT ---
@st.fragment(run_every=0.1)
def seismic_scroll():
    if not shared_state["attached"]:
        st.error("Hardware Offline - Check LD_LIBRARY_PATH")
        return

    # Snapshot of the current scrolling buffer
    current_data = np.array(list(scroll_buffer))
    
    # Alert Logic (Highlight Red)
    is_alert = np.max(np.abs(current_data)) > ALERT_THRESHOLD
    line_color = "rgb(255, 35, 35)" if is_alert else "rgb(0, 255, 100)"

    fig = go.Figure()

    # Persistence (Faint trails of previous 5-second windows)
    for i, trail in enumerate(history):
        alpha = (i + 1) / 5
        fig.add_trace(go.Scattergl(
            y=trail, mode='lines',
            line=dict(color=f"rgba(0, 180, 80, {alpha})", width=1),
            hoverinfo='skip'
        ))

    # Main Scroll (Newest data is at the right index 499)
    fig.add_trace(go.Scattergl(
        y=current_data, mode='lines',
        line=dict(color=line_color, width=2.5),
        hoverinfo='skip'
    ))

    fig.update_layout(
        template="plotly_dark", height=450, uirevision='fixed',
        xaxis=dict(range=[0, WINDOW_SIZE], showgrid=False, visible=False, fixedrange=True),
        yaxis=dict(range=[-0.05, 0.05], gridcolor='#222', fixedrange=True),
        margin=dict(t=20, b=0, l=0, r=0),
        plot_bgcolor='black', paper_bgcolor='black'
    )

    st.plotly_chart(fig, use_container_width=True, config={'staticPlot': True})

# --- 4. SPECTROGRAM ---
@st.fragment(run_every=1.5)
def spectrogram():
    if shared_state["attached"]:
        data = np.array(list(scroll_buffer))
        mags = np.abs(np.fft.rfft(data))
        freqs = np.fft.rfftfreq(WINDOW_SIZE, 1/FS)
        
        fig_spec = go.Figure(go.Heatmap(
            z=[mags[1:60]], x=freqs[1:60], colorscale='Viridis', showscale=False
        ))
        fig_spec.update_layout(height=200, template="plotly_dark", margin=dict(t=0))
        st.plotly_chart(fig_spec, use_container_width=True)

seismic_scroll()
st.divider()
spectrogram()
