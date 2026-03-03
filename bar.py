from Phidget22.Devices.VoltageRatioInput import *
ch = VoltageRatioInput()
ch.openWaitForAttachment(5000)
print(f"Attached: {ch.getAttached()}")
ch.close()
