from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app as idrive
try:
    import iphone_mount
    from winfspy import NTStatusMediaWriteProtected
except (ImportError, OSError, RuntimeError):
    iphone_mount = None
    NTStatusMediaWriteProtected = RuntimeError
mount_test = pytest.mark.skipif(iphone_mount is None, reason="WinFsp is unavailable")


class FakeAFC:
    def __init__(self, files):
        self.files = files
        self.handles = {}
        self.next_handle = 1
        self.read_sizes = []

    def exists(self, path):
        path = idrive.normalize_afc_path(path)
        return path in self.files or any(name.startswith(path.rstrip("/") + "/") for name in self.files)

    def listdir(self, path):
        path = idrive.normalize_afc_path(path)
        prefix = "/" if path == "/" else path + "/"
        children = set()
        for name in self.files:
            if name.startswith(prefix):
                remainder = name[len(prefix):]
                if remainder:
                    children.add(remainder.split("/", 1)[0])
        return sorted(children)

    def stat(self, path):
        path = idrive.normalize_afc_path(path)
        if path in self.files:
            return {
                "st_ifmt": "S_IFREG",
                "st_size": len(self.files[path]),
                "st_mtime": datetime(2026, 1, 2, 3, 4, 5),
            }
        if self.exists(path):
            return {"st_ifmt": "S_IFDIR", "st_size": 0, "st_mtime": 0}
        raise FileNotFoundError(path)

    def fopen(self, path, mode="r"):
        path = idrive.normalize_afc_path(path)
        handle = self.next_handle
        self.next_handle += 1
        self.handles[handle] = [path, 0]
        return handle

    def fread(self, handle, size):
        self.read_sizes.append(size)
        path, offset = self.handles[handle]
        chunk = self.files[path][offset:offset + size]
        self.handles[handle][1] += len(chunk)
        return chunk

    def fseek(self, handle, offset, whence=0):
        assert whence == 0
        self.handles[handle][1] = offset

    def fclose(self, handle):
        self.handles.pop(handle, None)


class FakeBridge:
    def __init__(self, files):
        self.afc = FakeAFC(files)
        self.connected = True
        self.device_info = {"UniqueDeviceID": "test-device", "DeviceName": "Test iPhone"}

    def connect(self, force=False):
        return True, "connected"


def test_current_pymobiledevice_dependency_is_detected():
    assert idrive.HAS_PYMOBILEDEVICE is True


def test_scan_inventories_audio_without_downloading_files():
    fake = FakeBridge({
        "/iTunes_Control/Music/F00/ABCD.mp3": b"music-one",
        "/Downloads/original beat.wav": b"music-two",
        "/Downloads/notes.txt": b"not audio",
    })

    events = list(idrive.iter_audio_scan(device_bridge=fake))
    tracks = [data for event, data in events if event == "track_found"]

    assert {track["iphone_path"] for track in tracks} == {
        "/iTunes_Control/Music/F00/ABCD.mp3",
        "/Downloads/original beat.wav",
    }
    assert all(track["metadata_pending"] for track in tracks)
    assert not hasattr(fake.afc, "get_file_contents")


def test_copy_uses_bounded_chunks_and_publishes_atomically(tmp_path):
    payload = b"a" * (idrive.TRANSFER_CHUNK_SIZE * 2 + 123)
    fake = FakeBridge({"/Downloads/large.wav": payload})
    destination = tmp_path / "large.wav"

    copied = idrive.copy_afc_file(
        "/Downloads/large.wav",
        str(destination),
        len(payload),
        device_bridge=fake,
    )

    assert copied == len(payload)
    assert destination.read_bytes() == payload
    assert max(fake.afc.read_sizes) <= idrive.TRANSFER_CHUNK_SIZE
    assert not Path(f"{destination}.part").exists()


def test_copy_resumes_an_existing_partial_file(tmp_path):
    payload = b"0123456789" * 100
    fake = FakeBridge({"/Downloads/large.wav": payload})
    destination = tmp_path / "large.wav"
    partial = Path(f"{destination}.part")
    partial.write_bytes(payload[:317])

    copied = idrive.copy_afc_file(
        "/Downloads/large.wav",
        str(destination),
        len(payload),
        device_bridge=fake,
    )

    assert copied == len(payload)
    assert destination.read_bytes() == payload
    assert fake.afc.read_sizes[0] == len(payload) - 317
    assert not partial.exists()


def test_export_uses_server_scan_registry_and_preserves_bytes(tmp_path, monkeypatch):
    payload = b"original-beat-bytes"
    fake = FakeBridge({"/Downloads/ABCD.mp3": payload})
    track = idrive._track_from_stat(
        "/Downloads/ABCD.mp3",
        "ABCD.mp3",
        fake.afc.stat("/Downloads/ABCD.mp3"),
    )
    monkeypatch.setattr(idrive, "bridge", fake)
    with idrive.TRACK_REGISTRY_LOCK:
        idrive.TRACK_REGISTRY.clear()
        idrive.TRACK_REGISTRY[track["id"]] = track

    response = TestClient(idrive.app).post(
        "/api/music/export",
        json={
            "track_ids": [track["id"]],
            "tracks": [{"id": track["id"], "iphone_path": "/should/not/be/trusted"}],
            "output_dir": str(tmp_path),
            "structure": "flat",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["exported_count"] == 1
    exported_path = Path(body["exported"][0]["destination"])
    assert exported_path.read_bytes() == payload
    assert body["exported"][0]["source"] == "/Downloads/ABCD.mp3"


def test_cross_site_mutation_is_rejected():
    response = TestClient(idrive.app).post(
        "/api/connect",
        headers={"Origin": "https://malicious.example", "Sec-Fetch-Site": "cross-site"},
    )
    assert response.status_code == 403


def test_safe_filename_removes_paths_and_reserved_characters():
    assert idrive.safe_filename(r"..\folder\my:beat?.wav") == "my_beat_.wav"
    assert idrive.safe_filename("CON.mp3") == "_CON.mp3"


def test_portable_write_scope_only_allows_dedicated_folder():
    assert idrive.require_portable_write_path(idrive.PORTABLE_FILES_ROOT) == idrive.PORTABLE_FILES_ROOT
    assert idrive.require_portable_write_path(f"{idrive.PORTABLE_FILES_ROOT}/Beats/demo.wav").endswith("/Beats/demo.wav")

    for unsafe in ("/Downloads/demo.wav", "/iTunes_Control/Music/F00/demo.mp3", "/"):
        try:
            idrive.require_portable_write_path(unsafe)
        except ValueError as exc:
            assert "Portable Files" in str(exc)
        else:
            raise AssertionError(f"Expected write scope rejection for {unsafe}")


def test_upload_rejects_destination_outside_portable_folder(tmp_path, monkeypatch):
    fake = FakeBridge({})
    monkeypatch.setattr(idrive, "bridge", fake)

    response = TestClient(idrive.app).post(
        "/api/drive/upload",
        data={"destination_path": "/Downloads"},
        files={"file": ("demo.wav", b"beat")},
    )

    assert response.status_code == 403
    assert "Portable Files" in response.json()["detail"]


def test_export_preflight_uses_only_selected_track_sizes(tmp_path, monkeypatch):
    fake = FakeBridge({
        "/Downloads/one.wav": b"a" * 10,
        "/Downloads/two.wav": b"b" * 20,
    })
    monkeypatch.setattr(idrive, "bridge", fake)
    one = idrive._track_from_stat("/Downloads/one.wav", "one.wav", fake.afc.stat("/Downloads/one.wav"))
    two = idrive._track_from_stat("/Downloads/two.wav", "two.wav", fake.afc.stat("/Downloads/two.wav"))
    with idrive.TRACK_REGISTRY_LOCK:
        idrive.TRACK_REGISTRY.clear()
        idrive.TRACK_REGISTRY[one["id"]] = one
        idrive.TRACK_REGISTRY[two["id"]] = two

    response = TestClient(idrive.app).post(
        "/api/music/preflight",
        json={"track_ids": [two["id"]], "output_dir": str(tmp_path)},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["selected_count"] == 1
    assert body["selected_bytes"] == 20
    assert body["can_export"] is True


@mount_test
def test_mountpoint_and_windows_path_validation():
    assert iphone_mount.validate_mountpoint("i") == "I:"
    assert iphone_mount.windows_to_afc_path(r"\Downloads\demo.wav") == "/Downloads/demo.wav"

    try:
        iphone_mount.validate_mountpoint("C:")
    except ValueError:
        pass
    else:
        raise AssertionError("The system drive must never be accepted as a mount point")


@mount_test
def test_mount_reads_remote_bytes_with_afc_seek(tmp_path):
    fake = FakeBridge({"/Downloads/demo.wav": b"0123456789"})
    operations = iphone_mount.IPhoneFileSystemOperations(fake, str(tmp_path))
    context = operations.open(r"\Downloads\demo.wav", 0, 0)

    assert operations.read(context, 3, 4) == b"3456"
    operations.close(context)


@mount_test
def test_mount_exposes_decoded_virtual_music_library(tmp_path):
    fake = FakeBridge({"/iTunes_Control/Music/F00/ABCD.wav": b"decoded beat"})
    operations = iphone_mount.IPhoneFileSystemOperations(
        fake,
        str(tmp_path),
        virtual_tracks=[
            {
                "id": "decoded",
                "iphone_path": "/iTunes_Control/Music/F00/ABCD.wav",
                "title": "Midnight Draft",
                "artist": "Doc Beats",
                "album": "Lost Sessions",
                "original_filename": "ABCD.wav",
                "extension": ".wav",
                "playlists": ["Originals"],
            }
        ],
    )
    context = operations.open(
        r"\iDrivePulse Music Library\Artists\Doc Beats\Midnight Draft.wav", 0, 0
    )

    assert operations.read(context, 0, 100) == b"decoded beat"
    operations.close(context)


@mount_test
def test_mount_rejects_creates_outside_portable_files(tmp_path):
    fake = FakeBridge({"/Downloads/placeholder.txt": b"x"})
    operations = iphone_mount.IPhoneFileSystemOperations(fake, str(tmp_path))

    try:
        operations.create(r"\Downloads\unsafe.wav", 0, 0, 0, None, 0)
    except NTStatusMediaWriteProtected:
        pass
    else:
        raise AssertionError("Mounted writes must stay inside Portable Files")
