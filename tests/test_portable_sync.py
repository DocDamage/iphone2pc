from datetime import datetime
from pathlib import Path

from portable_sync import PortableSyncStore, sync_once


class SyncAFC:
    def __init__(self, files):
        self.files = dict(files)

    def listdir(self, path):
        prefix = path.rstrip("/") + "/"
        return sorted({name[len(prefix):].split("/", 1)[0] for name in self.files if name.startswith(prefix)})

    def stat(self, path):
        if path in self.files:
            return {"st_ifmt": "S_IFREG", "st_size": len(self.files[path]), "st_mtime": datetime(2026, 1, 1)}
        if any(name.startswith(path.rstrip("/") + "/") for name in self.files):
            return {"st_ifmt": "S_IFDIR", "st_size": 0, "st_mtime": datetime(2026, 1, 1)}
        raise FileNotFoundError(path)

    def exists(self, path):
        try:
            self.stat(path)
            return True
        except FileNotFoundError:
            return False

    def makedirs(self, path):
        return None

    def push(self, local, remote, progress_bar=False):
        self.files[remote] = Path(local).read_bytes()

    def rm(self, remote):
        self.files.pop(remote, None)


def transfer_callbacks(afc):
    def download(remote, local, size):
        Path(local).parent.mkdir(parents=True, exist_ok=True)
        Path(local).write_bytes(afc.files[remote])

    return download, lambda local, remote: afc.push(local, remote), lambda remote: afc.rm(remote)


def test_sync_moves_unique_files_both_directions(tmp_path):
    local = tmp_path / "portable"
    local.mkdir()
    (local / "from-pc.txt").write_text("pc", encoding="utf-8")
    afc = SyncAFC({"/Portable/from-phone.txt": b"phone"})
    store = PortableSyncStore(str(tmp_path / "sync.sqlite3"), str(tmp_path / "versions"))
    profile = store.create_profile(str(local), "/Portable")
    download, upload, remove = transfer_callbacks(afc)

    result = sync_once(store, profile, afc, download, upload, remove)

    assert afc.files["/Portable/from-pc.txt"] == b"pc"
    assert (local / "from-phone.txt").read_bytes() == b"phone"
    assert result["uploaded"] == 1
    assert result["downloaded"] == 1


def test_sync_reports_first_run_conflict_without_overwriting(tmp_path):
    local = tmp_path / "portable"
    local.mkdir()
    (local / "beat.txt").write_text("PC version", encoding="utf-8")
    afc = SyncAFC({"/Portable/beat.txt": b"phone version"})
    store = PortableSyncStore(str(tmp_path / "sync.sqlite3"), str(tmp_path / "versions"))
    profile = store.create_profile(str(local), "/Portable")
    download, upload, remove = transfer_callbacks(afc)

    result = sync_once(store, profile, afc, download, upload, remove)

    assert result["conflicts"] == 1
    assert (local / "beat.txt").read_text(encoding="utf-8") == "PC version"
    assert afc.files["/Portable/beat.txt"] == b"phone version"
