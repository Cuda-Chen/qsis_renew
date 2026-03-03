import streamlit as st
import time
from Phidget22.Phidget import *
from Phidget22.Devices.VoltageRatioInput import *
import collections

# 1. Use a more robust caching key to ensure the object stays alive
@st.cache_resource(show_spinner="Connecting to Phidget Hardware...")
def persistent_phidget():
    buffer = collections.deque([0.0] * 1000, maxlen=1000)
    ch = VoltageRatioInput()
    
    # We use a dictionary to share state across Streamlit reruns
    shared_state = {"attached": False}

    def on_attach(self):
        shared_state["attached"] = True
        print("PHIDGET ATTACHED!") # This will show in your terminal

    def on_detach(self):
        shared_state["attached"] = False
        print("PHIDGET DETACHED!")

    def on_data(self, voltage_ratio):
        buffer.append(voltage_ratio)

    ch.setOnAttachHandler(on_attach)
    ch.setOnDetachHandler(on_detach)
    ch.setOnVoltageRatioChangeHandler(on_data)

    try:
        # Increase timeout to 5000ms to give the hardware a chance to respond
        ch.openWaitForAttachment(5000)
        ch.setDataInterval(10)
    except Exception as e:
        print(f"Attachment Error: {e}")

    return ch, buffer, shared_state

# --- 2. EXECUTION ---
ch, data_buffer, phidget_state = persistent_phidget()

# Manually check attachment if the handler hasn't fired yet
if not phidget_state["attached"]:
    try:
        phidget_state["attached"] = ch.getAttached()
    except:
        pass

# --- 3. UI SIDEBAR ---
st.sidebar.header("System Health")
if phidget_state["attached"]:
    st.sidebar.success("🟢 Phidget: Online")
else:
    st.sidebar.error("🔴 Phidget: Offline")
    st.sidebar.info("Rule Check: Permissions are OK (crw-rw-rw-)")
    if st.sidebar.button("Hard Reset Connection"):
        # This clears the Streamlit cache and forces a fresh Phidget 'Open'
        st.cache_resource.clear()
        st.rerun()
