import plistlib
import sqlite3

import pytest

from backup_fusion import BackupFusion


def build_backup(root, encrypted=False):
    backup = root / "device-backup"
    backup.mkdir(parents=True)
    (backup / "Manifest.plist").write_bytes(plistlib.dumps({"IsEncrypted": encrypted}))
    (backup / "Info.plist").write_bytes(plistlib.dumps({"Device Name": "Studio iPhone", "Product Version": "26.0"}))
    database = sqlite3.connect(backup / "Manifest.db")
    database.execute("CREATE TABLE Files(fileID TEXT, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
    records = [("a" * 40, "MediaDomain", "Downloads/beat.wav", 1, None), ("b" * 40, "HomeDomain", "notes.txt", 1, None)]
    database.executemany("INSERT INTO Files VALUES (?,?,?,?,?)", records)
    database.commit()
    database.close()
    for file_id, _domain, _path, _flags, _blob in records:
        folder = backup / file_id[:2]
        folder.mkdir(exist_ok=True)
        (folder / file_id).write_bytes(file_id.encode())
    return backup


def test_backup_fusion_discovers_scans_and_extracts_selected_audio(tmp_path):
    build_backup(tmp_path)
    fusion = BackupFusion([str(tmp_path)])
    discovered = fusion.discover()
    assets = fusion.scan(discovered[0]["id"])
    output = tmp_path / "output"
    recovered = fusion.extract(discovered[0]["id"], [assets[0]["file_id"]], str(output))
    assert discovered[0]["state"] == "ready"
    assert [asset["name"] for asset in assets] == ["beat.wav"]
    assert recovered[0]["path"].endswith("beat.wav")


def test_encrypted_backup_is_reported_as_locked(tmp_path):
    build_backup(tmp_path, encrypted=True)
    fusion = BackupFusion([str(tmp_path)])
    assert fusion.discover()[0]["state"] == "locked"
    with pytest.raises(PermissionError):
        fusion.scan("device-backup")
