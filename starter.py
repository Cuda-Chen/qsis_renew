import time
import json
import queue
import numpy as np
from scipy.signal import butter, sosfilt, sosfilt_zi
import paho.mqtt.client as mqtt
from Phidget22.Phidget import *
from Phidget22.Devices.Accelerometer import *
from collections import deque

# --- Configuration ---
BROKER_ADDRESS = "localhost"
MQTT_PORT = 1883
TOPIC = "telemetry/seismic"
SPECTROGRAM_TOPIC = "telemetry/spectrogram"
#DATA_INTERVAL_MS = 20  # 20ms = 50Hz Sampling Rate
DATA_INTERVAL_MS = 10 # 10ms -> 100Hz Sampling Rate

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

class SpectrogramCalculator:
    def __init__(self, fs=50.0, window_sec=5.0, publish_rate=5.0):
        self.fs = fs
        # A 5-second window at 50Hz gives us 250 samples.
        # This provides a frequency resolution of exactly 0.2 Hz per bin.
        self.window_size = int(fs * window_sec)
        self.buffer = deque(maxlen=self.window_size)
        
        # We throttle the output so we don't crash the MQTT broker.
        # Publishing a heavy JSON object at 5Hz is plenty fast for a heatmap.
        self.publish_interval = int(fs / publish_rate)
        self.sample_count = 0
        
        # Pre-compute the Hanning window array to save CPU cycles during the live stream
        self.window = np.hanning(self.window_size)

    def process(self, z_value, timestamp):
        """Adds a sample to the buffer and returns a spectrum payload if it's time."""
        self.buffer.append(z_value)
        self.sample_count += 1
        
        # Only calculate and publish if the buffer is full AND it is time to publish
        if len(self.buffer) == self.window_size and self.sample_count % self.publish_interval == 0:
            return self._calculate_spectrum(timestamp)
        
        return None

    def _calculate_spectrum(self, timestamp):
        # 1. Convert the rolling buffer to a numpy array
        data = np.array(self.buffer)
        
        # 2. Apply the Hanning window to smooth the edges to zero
        windowed_data = data * self.window
        
        # 3. Compute the Fast Fourier Transform (FFT)
        # rfft is highly optimized for purely real-valued inputs (like our sensor data)
        fft_values = np.fft.rfft(windowed_data)
        
        # Normalize the magnitudes based on the window size
        fft_magnitudes = np.abs(fft_values) / self.window_size
        
        # 4. Get the corresponding frequency labels for our FFT bins
        frequencies = np.fft.rfftfreq(self.window_size, d=1.0/self.fs)
        
        # 5. Build the JSON payload for Grafana
        payload = {"timestamp": timestamp}
        
        for freq, mag in zip(frequencies, fft_magnitudes):
            # Strictly filter out the noise below 0.5Hz and above 20.0Hz
            if 0.5 <= freq <= 20.0:
                # Grafana requires string keys for JSON extraction.
                # We format to 1 decimal place (e.g., "4.2Hz") to create stable columns.
                key = f"{freq:.1f}Hz"
                payload[key] = float(mag)
                
        return payload

def phidget_seismic_generator():
    data_queue = queue.Queue()
    fs = 1000.0 / DATA_INTERVAL_MS 
    
    # Instantiate both processors
    dsp = SeismicFilter(fs=fs, lowcut=0.5, highcut=20.0, order=4)
    spectro = SpectrogramCalculator(fs=fs, window_sec=2.0, publish_rate=2.0)
    
    def on_acceleration_change(self, acceleration, timestamp):
        # 1. Process the waveform
        fx, fy, fz = dsp.process(acceleration[0], acceleration[1], acceleration[2])
        
        seismic_data = {
            "x_axis": fx, 
            "y_axis": fy, 
            "z_axis": fz,
            "status": "online",
            "timestamp": timestamp
        }

        # 2. Process the spectrogram (focusing on the Z-axis)
        spectrogram_data = spectro.process(fz, timestamp)
        
        # 3. Put BOTH payloads in the queue as a tuple
        data_queue.put((seismic_data, spectrogram_data))

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

    # --- LWT Setup for BOTH topics ---
    offline_waveform = json.dumps({
        "x_axis": None, "y_axis": None, "z_axis": None, "status": "offline"
    })
    offline_spectro = json.dumps({"status": "offline"}) # Simple break signal

    client.will_set(TOPIC, payload=offline_waveform, qos=1, retain=False)
    # Note: paho-mqtt only supports one LWT per client. To have two,
    # the cleanest way is to just rely on the waveform LWT to signal the overall offline state,
    # but we will manually publish the spectro offline signal on a graceful exit.
    # ---------------------------------

    client.connect(BROKER_ADDRESS, MQTT_PORT, 60)
    client.loop_start()

    print(f"Publishing waveform to '{TOPIC}'...")
    print(f"Publishing spectrogram to '{SPECTROGRAM_TOPIC}'...")

    try:
        # Unpack the tuple yielded by the generator
        for seismic_data, spectrogram_data in phidget_seismic_generator():

            # 1. Always publish the high-speed waveform
            client.publish(TOPIC, json.dumps(seismic_data))

            # 2. Only publish the spectrogram if the calculator returned a payload
            if spectrogram_data is not None:
                client.publish(SPECTROGRAM_TOPIC, json.dumps(spectrogram_data))

    except KeyboardInterrupt:
        print("\nStopping seismic stream gracefully...")
        # Manually break both Grafana panels on exit
        client.publish(TOPIC, offline_waveform).wait_for_publish()
        client.publish(SPECTROGRAM_TOPIC, offline_spectro).wait_for_publish()

    finally:
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
