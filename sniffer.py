import paho.mqtt.client as mqtt
import json

# --- Configuration ---
BROKER_ADDRESS = "localhost"
MQTT_PORT = 1883
TOPIC = "telemetry/seismic"

def on_message(client, userdata, message):
    raw_payload = message.payload.decode("utf-8")
    print("-" * 30)
    print(f"RAW STRING: {raw_payload}")
    
    try:
        parsed_json = json.loads(raw_payload)
        print(f"PARSED KEYS: {list(parsed_json.keys())}")
        # Print with indentation to see if there is nesting
        print(f"FORMATTED:\n{json.dumps(parsed_json, indent=2)}")
    except Exception as e:
        print(f"ERROR: Payload is not valid JSON! ({e})")

# Setup Client
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
client.on_message = on_message
client.connect(BROKER_ADDRESS, MQTT_PORT)
client.subscribe(TOPIC)

print(f"Listening for seismic data on '{TOPIC}'...")
client.loop_forever()
