# NTP Synchronization & Pre-launch Setup

For professional seismic monitoring, the **System Clock** is the absolute source of truth. You must ensure your host operating system is synchronized with an NTP server *before* launching the QSIS dashboard.

## 1. Recommended Setup: Chrony
`chrony` is the industry standard for high-precision time synchronization on Linux.

### Installation
```bash
sudo apt update
sudo apt install chrony -y
```

### Configuration
Edit `/etc/chrony/chrony.conf` to add your preferred servers:
```text
pool pool.ntp.org iburst
# Or for local network servers:
# server 192.168.1.100 iburst
```

### Start & Enable
```bash
sudo systemctl restart chrony
sudo systemctl enable chrony
```

## 2. Verification (Pre-launch)
Before running `server.py`, verify the sync status:
```bash
timedatectl status
```
Ensure `System clock synchronized: yes` and `NTP service: active`.

## 3. How the Dashboard Monitors Time
The QSIS dashboard automatically monitors your system's NTP health:
1. **API Check**: The backend periodically runs a lightweight system check.
2. **UI Indicator**: A status dot in the header shows the health of your clock sync.
3. **Accuracy**: All data timestamps are pulled directly from the synchronized system clock.

## Troubleshooting
If the "Time Sync" indicator is Red:
- Ensure the `chrony` or `systemd-timesyncd` service is running.
- Check if your server has internet access to reach the NTP pool.
- Verify that UDP Port 123 is open in your firewall.
