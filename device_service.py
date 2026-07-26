"""Optional Windows service that forwards iPhone PnP changes to iDrivePulse."""

import os
import urllib.request

import win32event
import win32service
import win32serviceutil

from device_events import DeviceEventEngine


def iphone_present() -> bool:
    import subprocess
    command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
               "[bool](Get-PnpDevice -PresentOnly | Where-Object InstanceId -like '*VID_05AC*')"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=15)
    return result.stdout.strip().casefold() == "true"


def notify_app(event: str):
    request = urllib.request.Request(
        os.environ.get("IDRIVEPULSE_EVENT_URL", "http://127.0.0.1:8765/api/fabric/device-event"),
        data=(f'{{"event":"{event}"}}').encode(), headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=10).read()
    except OSError:
        pass


class IdrivePulseDeviceService(win32serviceutil.ServiceFramework):
    _svc_name_ = "iDrivePulseDeviceService"
    _svc_display_name_ = "iDrivePulse Device Recovery Service"
    _svc_description_ = "Observes Apple USB device changes and resumes authorized iDrivePulse recovery work."

    def __init__(self, args):
        super().__init__(args)
        self.stop_handle = win32event.CreateEvent(None, 0, 0, None)
        self.engine = DeviceEventEngine(iphone_present, notify_app)

    def SvcStop(self):
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        self.engine.stop()
        win32event.SetEvent(self.stop_handle)

    def SvcDoRun(self):
        self.engine.start()
        win32event.WaitForSingleObject(self.stop_handle, win32event.INFINITE)


if __name__ == "__main__":
    win32serviceutil.HandleCommandLine(IdrivePulseDeviceService)
