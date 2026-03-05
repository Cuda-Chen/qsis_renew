import time
import json
import queue
import paho.mqtt.client as mqtt
from Phidget22.Phidget import *
from Phidget22.Devices.Accelerometer import *

# --- Configuration ---
#BROKER_ADDRESS = "localhost" # Change if using a remote broker
BROKER_ADDRESS = "broker.hivemq.com"
MQTT_PORT = 1883
TOPIC = "telemetry/seismic"

def phidget_seismic_generator():
    """
    Connects to the Phidget accelerometer and yields clean 
    seismic data as a continuous Python generator.
    """
    # Use a queue to bridge the Phidget event handler with our generator
    data_queue = queue.Queue()
    
    def on_acceleration_change(self, acceleration, timestamp):
        # Acceleration is provided as a tuple: (x, y, z) in g-force
        data_queue.put({
            "x_axis": acceleration[0], 
            "y_axis": acceleration[1], 
            "z_axis": acceleration[2], 
            "timestamp": timestamp
        })

    # Initialize the Phidget Accelerometer
    accelerometer = Accelerometer()
    accelerometer.setOnAccelerationChangeHandler(on_acceleration_change)
    
    try:
        # Open connection and wait up to 5 seconds for the sensor
        accelerometer.openWaitForAttachment(5000)
        
        # Set data interval to a fast rate for seismic waves (e.g., 20 milliseconds)
        # Note: Check your specific Phidget model's minimum supported interval
        accelerometer.setDataInterval(20) 
        
        # The generator loop
        while True:
            # Block until a new reading is available, then yield it
            reading = data_queue.get()
            yield reading
            
    finally:
        # Ensure the sensor closes gracefully if the loop breaks
        accelerometer.close()

def main():
    # Setup the MQTT Client
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.connect(BROKER_ADDRESS, MQTT_PORT, 60)
    client.loop_start()

    print(f"Publishing seismic stream to '{TOPIC}'...")
    
    try:
        # Iterate seamlessly through our clean generator stream
        for seismic_data in phidget_seismic_generator():
            # Convert the Python dictionary into a JSON string
            payload = json.dumps(seismic_data)
            
            # Fire it off to the message queue
            client.publish(TOPIC, payload)
            
            # Print to console just so you can see it working
            print(f"Published: {payload}")
            
    except KeyboardInterrupt:
        print("\nStopping seismic stream...")
    finally:
        # Clean up MQTT connection
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
