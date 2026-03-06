import time
import json
import queue
import numpy as np
from scipy.signal import butter, sosfilt, sosfilt_zi
import paho.mqtt.client as mqtt
from Phidget22.Phidget import *
from Phidget22.Devices.Accelerometer import *

# --- Configuration ---
BROKER_ADDRESS = "localhost"
MQTT_PORT = 1883
TOPIC = "telemetry/seismic"
DATA_INTERVAL_MS = 20  # 20ms = 50Hz Sampling Rate

class SeismicFilter:
    def __init__(self, fs=50.0, lowcut=0.5, highcut=20.0, order=4):
        # 1. Design the Butterworth band-pass filter (using Second-Order Sections for stability)
        self.sos = butter(order, [lowcut, highcut], btype='bandpass', fs=fs, output='sos')
        
        # 2. Initialize the filter states for continuous streaming
        self.zi_x = sosfilt_zi(self.sos)
        self.zi_y = sosfilt_zi(self.sos)
        self.zi_z = sosfilt_zi(self.sos)
        
        # 3. State variables for the Exponential Moving Average (EMA) Demean
        self.alpha = 0.05 # Smoothing factor. Lower = slower adaptation to gravity shifts
        self.mean_x = None
        self.mean_y = None
        self.mean_z = None

    def process(self, x, y, z):
        # Initialize the demean baseline on the very first sample to avoid a massive spike
        if self.mean_x is None:
            self.mean_x, self.mean_y, self.mean_z = x, y, z
            
            # Scale the initial filter states to 0 since we are demeaning first
            self.zi_x *= 0
            self.zi_y *= 0
            self.zi_z *= 0

        # --- Step A: Demean (Remove gravity/DC offset) ---
        self.mean_x = self.alpha * x + (1 - self.alpha) * self.mean_x
        self.mean_y = self.alpha * y + (1 - self.alpha) * self.mean_y
        self.mean_z = self.alpha * z + (1 - self.alpha) * self.mean_z

        dm_x = x - self.mean_x
        dm_y = y - self.mean_y
        dm_z = z - self.mean_z

        # --- Step B: Band-pass Filter (0.5Hz - 20Hz) ---
        # sosfilt takes an array, so we wrap our single sample in a list, then extract it
        fx, self.zi_x = sosfilt(self.sos, [dm_x], zi=self.zi_x)
        fy, self.zi_y = sosfilt(self.sos, [dm_y], zi=self.zi_y)
        fz, self.zi_z = sosfilt(self.sos, [dm_z], zi=self.zi_z)

        return fx[0], fy[0], fz[0]

def phidget_seismic_generator():
    data_queue = queue.Queue()
    
    # Calculate sampling frequency Fs based on the Phidget interval
    fs = 1000.0 / DATA_INTERVAL_MS 
    
    # Instantiate our continuous filter
    dsp = SeismicFilter(fs=fs, lowcut=0.5, highcut=20.0, order=4)
    
    def on_acceleration_change(self, acceleration, timestamp):
        # Pass the raw hardware data through our DSP filter pipeline
        fx, fy, fz = dsp.process(acceleration[0], acceleration[1], acceleration[2])
        
        data_queue.put({
            "x_axis": fx, 
            "y_axis": fy, 
            "z_axis": fz,
            "status": "online", # <-- Add this line
            "timestamp": timestamp
        })

    accelerometer = Accelerometer()
    accelerometer.setOnAccelerationChangeHandler(on_acceleration_change)
    
    try:
        accelerometer.openWaitForAttachment(5000)
        accelerometer.setDataInterval(DATA_INTERVAL_MS) 
        
        while True:
            yield data_queue.get()
            
    finally:
        accelerometer.close()

def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    # --- 1. Define the Last Will and Testament ---
    # We send explicit 'None' (which becomes 'null' in JSON) for all axes.
    # Grafana's time-series panel recognizes 'null' as a command to break the line.
    offline_payload = json.dumps({
        "x_axis": None, 
        "y_axis": None, 
        "z_axis": None,
        "status": "offline" # Optional: useful if you want to trigger a text alert
    })
    
    # Register the Will with the broker BEFORE connecting
    client.will_set(TOPIC, payload=offline_payload, qos=1, retain=False)
    # ---------------------------------------------

    # 2. Connect and Start
    client.connect(BROKER_ADDRESS, MQTT_PORT, 60)
    client.loop_start()

    print(f"Publishing FILTERED seismic stream to '{TOPIC}'...")
    
    try:
        for seismic_data in phidget_seismic_generator():
            payload = json.dumps(seismic_data)
            client.publish(TOPIC, payload)
            
    except KeyboardInterrupt:
        print("\nStopping seismic stream gracefully...")
        # Guarantee the final 'null' packet leaves the machine before tearing down
        publish_info = client.publish(TOPIC, offline_payload)
        publish_info.wait_for_publish() # <-- This is the bulletproof fix
        
    finally:
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
