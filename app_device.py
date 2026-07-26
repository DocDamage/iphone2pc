"""USB lockdown and AFC compatibility bridge."""

from app_core import *

class AsyncAFCSession:
    """Blocking adapter for pymobiledevice3's modern async Lockdown/AFC API.

    FastAPI uses the same bridge from synchronous routes, worker threads, and the SSE
    scanner. A dedicated loop keeps the device connection on one event loop while this
    adapter presents the stable blocking interface used by the rest of the application.
    """

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="idrivepulse-afc", daemon=True)
        self._thread.start()
        self._lockdown = None
        self._afc = None
        try:
            self._submit(self._connect(), timeout=180)
        except Exception:
            self.close()
            raise

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _submit(self, awaitable, timeout=300):
        if not self._loop.is_running():
            if inspect.iscoroutine(awaitable):
                awaitable.close()
            raise RuntimeError("The iPhone connection is closed.")
        future = asyncio.run_coroutine_threadsafe(awaitable, self._loop)
        return future.result(timeout=timeout)

    async def _connect(self):
        self._lockdown = await create_using_usbmux()
        self._afc = AFCService(self._lockdown)
        await self._afc.__aenter__()

    def get_value(self, domain=None, key=None):
        return self._submit(self._lockdown.get_value(domain=domain, key=key), timeout=30)

    def fseek(self, handle: int, offset: int, whence: int = 0):
        """Expose AFC FileRefSeek, which pymobiledevice3 10.x does not wrap."""
        from pymobiledevice3.services.afc import AfcOpcode

        payload = struct.pack("<QQq", int(handle), int(whence), int(offset))
        return self._submit(self._afc._do_operation(AfcOpcode.FILE_SEEK, payload), timeout=30)

    def open_app_documents(self, bundle_id: str):
        if HouseArrestService is None:
            raise RuntimeError("House Arrest support is not installed.")
        service = self._submit(HouseArrestService.create(self._lockdown, bundle_id, documents_only=True), timeout=60)
        return AsyncAFCProxy(self, service)

    @property
    def udid(self):
        return getattr(self._lockdown, "udid", None) or getattr(self._lockdown, "identifier", None)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        attr = getattr(self._afc, name)
        if not callable(attr):
            return attr

        def blocking_call(*args, **kwargs):
            result = attr(*args, **kwargs)
            return self._submit(result) if inspect.isawaitable(result) else result

        return blocking_call

    def close(self):
        if not self._loop.is_running():
            return

        async def cleanup():
            if self._afc is not None:
                try:
                    await self._afc.aclose()
                except Exception:
                    pass
            if self._lockdown is not None:
                try:
                    result = self._lockdown.close()
                    if inspect.isawaitable(result):
                        await result
                except Exception:
                    pass

        try:
            self._submit(cleanup(), timeout=15)
        except Exception:
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        if threading.current_thread() is not self._thread:
            self._thread.join(timeout=5)


class AsyncAFCProxy:
    """Blocking proxy for an extra AFC-compatible service on the main device loop."""

    def __init__(self, owner: AsyncAFCSession, service):
        self.owner = owner
        self.service = service

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        attribute = getattr(self.service, name)
        if not callable(attribute):
            return attribute

        def blocking(*args, **kwargs):
            result = attribute(*args, **kwargs)
            return self.owner._submit(result) if inspect.isawaitable(result) else result

        return blocking

    def close(self):
        close = getattr(self.service, "aclose", None) or getattr(self.service, "close", None)
        if close:
            result = close()
            if inspect.isawaitable(result):
                return self.owner._submit(result, timeout=30)


class IPhoneBridge:
    """Manages connection to iOS Device via AFC (Apple File Conduit) over USB.

    Connection is cached — we only re-attempt on explicit connect() calls,
    not on every status poll.
    """
    def __init__(self):
        self.lockdown = None
        self.afc = None
        self.device_info = {}
        self.connected = False
        self.connection_mode = "Disconnected"  # "USB_AFC", "Disconnected"
        self._last_connect_attempt = 0
        self._last_error_message = ""

    def disconnect(self):
        session = self.afc if isinstance(self.afc, AsyncAFCSession) else None
        if session:
            session.close()
        else:
            close = getattr(self.lockdown, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
        self.connected = False
        self.connection_mode = "Disconnected"
        self.afc = None
        self.lockdown = None

    def probe(self) -> bool:
        """Verify cached AFC state so device removal is reflected immediately."""
        if not self.connected or not self.afc:
            return False
        try:
            self.afc.listdir("/")
            return True
        except Exception as exc:
            diagnostic = type(exc).__name__
            self.disconnect()
            self._last_error_message = f"iPhone connection was lost ({diagnostic}). Reconnect to resume recovery."
            return False

    def connect(self, force=False):
        """Attempt USB connection. If already connected and not forced, returns cached state."""
        # If already connected and not forced, just verify the connection is alive
        if self.connected and self.afc and not force:
            try:
                # Quick heartbeat — try listing root to verify AFC is still alive
                self.afc.listdir("/")
                return True, f"Connected to {self.device_info.get('DeviceName', 'iPhone')} via USB (AFC Protocol)."
            except Exception:
                # Connection went stale — fall through to reconnect
                self.disconnect()

        if not HAS_PYMOBILEDEVICE:
            self._last_error_message = "pymobiledevice3 library not installed. Please install requirements."
            return False, self._last_error_message

        # Rate-limit reconnect attempts to avoid hammering USB stack
        now = time.time()
        if not force and (now - self._last_connect_attempt) < 3:
            return self.connected, self._last_error_message or "Reconnect cooldown — try again shortly."
        self._last_connect_attempt = now

        try:
            if PYMOBILEDEVICE_ASYNC:
                session = AsyncAFCSession()
                self.lockdown = session
                self.afc = session
            else:
                self.lockdown = create_using_usbmux()
                self.afc = AFCService(self.lockdown)
            self.connected = True
            self.connection_mode = "USB_AFC"

            # Fetch device info
            self.device_info = {
                "DeviceName": self.lockdown.get_value(key="DeviceName") or "iPhone",
                "ProductType": self.lockdown.get_value(key="ProductType") or "iPhone",
                "ProductVersion": self.lockdown.get_value(key="ProductVersion") or "iOS",
                "UniqueDeviceID": self.lockdown.udid or "N/A",
                "SerialNumber": self.lockdown.get_value(key="SerialNumber") or "N/A",
            }
            self._last_error_message = ""
            return True, f"Successfully connected to {self.device_info['DeviceName']} via USB (AFC Protocol)."
        except Exception as e:
            self.disconnect()
            err_msg = str(e).strip()
            error_name = type(e).__name__
            diagnostic = f"{error_name}: {err_msg}" if err_msg else error_name
            if error_name in {"ConnectionFailedToUsbmuxdError", "MuxException"}:
                self._last_error_message = "Apple Mobile Device USB service is unavailable. Install or repair Apple Devices/iTunes, then reconnect the iPhone."
            elif error_name in {"NoDeviceConnectedError", "DeviceNotFoundError"} or "No device" in err_msg:
                self._last_error_message = "No iPhone detected over USB. Ensure your iPhone is plugged into PC via USB cable, unlocked, and tap 'Trust This Computer'."
            elif "Pair" in error_name or "Pairing" in err_msg or "lockdown" in err_msg:
                self._last_error_message = "Pairing error: Please unlock your iPhone and tap 'Trust This Computer' when prompted."
            else:
                self._last_error_message = f"USB connection error ({diagnostic})."
            return False, self._last_error_message


bridge = IPhoneBridge()

# =================--- API ENDPOINTS ---===================
