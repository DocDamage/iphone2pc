"""Native Windows PnP notifications with a bounded polling fallback."""

from __future__ import annotations

import ctypes
import os
import threading
from ctypes import wintypes
from typing import Callable


CR_SUCCESS = 0
CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE = 0
CM_ACTION_ARRIVAL = 0
CM_ACTION_REMOVAL = 1
MAX_DEVICE_ID_LEN = 200


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]


USB_DEVICE_INTERFACE = GUID(
    0xA5DCBF10, 0x6530, 0x11D2, (ctypes.c_ubyte * 8)(0x90, 0x1F, 0x00, 0xC0, 0x4F, 0xB9, 0x51, 0xED)
)


class FilterDeviceInterface(ctypes.Structure):
    _fields_ = [("ClassGuid", GUID)]


class FilterDeviceInstance(ctypes.Structure):
    _fields_ = [("InstanceId", wintypes.WCHAR * MAX_DEVICE_ID_LEN)]


class FilterDeviceHandle(ctypes.Structure):
    _fields_ = [("hTarget", wintypes.HANDLE)]


class FilterUnion(ctypes.Union):
    _fields_ = [("DeviceInterface", FilterDeviceInterface), ("DeviceHandle", FilterDeviceHandle),
                ("DeviceInstance", FilterDeviceInstance)]


class CMNotifyFilter(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("cbSize", wintypes.DWORD), ("Flags", wintypes.DWORD), ("FilterType", ctypes.c_int),
                ("Reserved", wintypes.DWORD), ("u", FilterUnion)]


CALLBACK = ctypes.WINFUNCTYPE(
    wintypes.DWORD, wintypes.HANDLE, wintypes.LPVOID, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD
) if os.name == "nt" else None


class DeviceEventEngine:
    def __init__(self, probe: Callable[[], bool], callback: Callable[[str], None], poll_seconds: float = 2.0):
        self.probe = probe
        self.callback = callback
        self.poll_seconds = max(0.25, float(poll_seconds))
        self.mode = "stopped"
        self.last_present: bool | None = None
        self.last_error: str | None = None
        self._notification = wintypes.HANDLE() if os.name == "nt" else None
        self._native_callback = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _emit_from_probe(self):
        present = bool(self.probe())
        if self.last_present is None or present != self.last_present:
            self.last_present = present
            self.callback("arrival" if present else "removal")

    def _register_native(self) -> bool:
        if os.name != "nt":
            return False
        cfgmgr = ctypes.WinDLL("CfgMgr32.dll")
        filter_value = CMNotifyFilter()
        filter_value.cbSize = ctypes.sizeof(filter_value)
        filter_value.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE
        filter_value.DeviceInterface.ClassGuid = USB_DEVICE_INTERFACE

        @CALLBACK
        def native_callback(_handle, _context, action, _event_data, _event_size):
            if action in {CM_ACTION_ARRIVAL, CM_ACTION_REMOVAL}:
                threading.Thread(target=self._emit_from_probe, name="idrivepulse-pnp-probe", daemon=True).start()
            return CR_SUCCESS

        result = cfgmgr.CM_Register_Notification(
            ctypes.byref(filter_value), None, native_callback, ctypes.byref(self._notification)
        )
        if result != CR_SUCCESS:
            self.last_error = f"CM_Register_Notification returned {result}."
            return False
        self._native_callback = native_callback
        self.mode = "native-cm-notification"
        return True

    def _poll(self):
        while not self._stop.wait(self.poll_seconds):
            try:
                self._emit_from_probe()
            except Exception as exc:
                self.last_error = str(exc)[:1000]

    def start(self) -> dict:
        if self.mode != "stopped":
            return self.status()
        self._stop.clear()
        try:
            native = self._register_native()
        except Exception as exc:
            native = False
            self.last_error = str(exc)[:1000]
        if not native:
            self.mode = "polling-fallback"
            self._thread = threading.Thread(target=self._poll, name="idrivepulse-device-poll", daemon=True)
            self._thread.start()
        self._emit_from_probe()
        return self.status()

    def stop(self) -> dict:
        self._stop.set()
        if self._notification and self._notification.value:
            try:
                ctypes.WinDLL("CfgMgr32.dll").CM_Unregister_Notification(self._notification)
            except Exception as exc:
                self.last_error = str(exc)[:1000]
        if self._thread:
            self._thread.join(timeout=5)
        self._thread = None
        self._native_callback = None
        self.mode = "stopped"
        return self.status()

    def status(self) -> dict:
        return {"running": self.mode != "stopped", "mode": self.mode, "present": self.last_present,
                "last_error": self.last_error, "poll_seconds": self.poll_seconds}
