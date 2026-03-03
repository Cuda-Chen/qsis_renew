from Phidget22.Devices.Manager import Manager
from Phidget22.Phidget import Phidget
from Phidget22.Devices.Accelerometer import Accelerometer
from Phidget22.Devices.Spatial import Spatial
import time
import sys

def on_attach(self, device):
    print(f"✨ MANAGER FOUND DEVICE: {device.getDeviceName()} (Serial: {device.getDeviceSerialNumber()})")

def main():
    print("--- Phidget Python Debugger ---")
    
    # 1. Test Manager (This tells us if the Python-to-C bridge is actually working)
    try:
        man = Manager()
        man.setOnAttachHandler(on_attach)
        man.open()
        print("Checking for devices via Manager (waiting 2s)...")
        time.sleep(2)
        man.close()
    except Exception as e:
        print(f"❌ Manager failed to open. Library is NOT linked correctly: {e}")
        return

    # 2. Test specific classes based on your HelloWorld output
    # HelloWorld saw a "Spatial Precision 0/0/3"
    classes_to_try = [Spatial, Accelerometer]
    
    for p_class in classes_to_try:
        try:
            ch = p_class()
            ch.setDeviceSerialNumber(372690)
            ch.setIsLocal(True) # Force check for local USB
            print(f"Trying to open as {p_class.__name__}...")
            ch.openWaitForAttachment(2000)
            print(f"✅ SUCCESS! Opened as {p_class.__name__}")
            print(f"Acceleration: {ch.getAcceleration() if hasattr(ch, 'getAcceleration') else 'N/A'}")
            ch.close()
            return
        except Exception:
            print(f"   ... not {p_class.__name__}")

    print("❌ All specific classes timed out.")

if __name__ == "__main__":
    main()
