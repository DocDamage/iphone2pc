import sqlite3

from catalog import MediaCatalog, decode_media_library


def build_media_library(path):
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE item (
            item_pid INTEGER PRIMARY KEY,
            item_artist_pid INTEGER,
            album_pid INTEGER,
            base_location_id INTEGER
        );
        CREATE TABLE item_extra (
            item_pid INTEGER PRIMARY KEY,
            title TEXT,
            location TEXT,
            file_size INTEGER,
            total_time_ms INTEGER,
            filetype TEXT,
            date_added INTEGER
        );
        CREATE TABLE item_artist (item_artist_pid INTEGER PRIMARY KEY, item_artist TEXT);
        CREATE TABLE album (album_pid INTEGER PRIMARY KEY, album TEXT);
        CREATE TABLE base_location (base_location_id INTEGER PRIMARY KEY, path TEXT);
        """
    )
    connection.execute("INSERT INTO item_artist VALUES (1, 'Doc Beats')")
    connection.execute("INSERT INTO album VALUES (2, 'Lost Sessions')")
    connection.execute("INSERT INTO base_location VALUES (3, 'iTunes_Control/Music')")
    connection.execute("INSERT INTO item VALUES (10, 1, 2, 3)")
    connection.execute(
        "INSERT INTO item_extra VALUES (10, 'Midnight Draft', 'F00/ABCD.mp3', 1234, 90500, 'mp3', 700000000)"
    )
    connection.commit()
    connection.close()


def test_media_library_decoder_maps_hashed_files_to_metadata(tmp_path):
    database = tmp_path / "MediaLibrary.sqlitedb"
    build_media_library(database)

    decoded = decode_media_library(str(database))

    assert len(decoded) == 1
    assert decoded[0]["iphone_path"] == "/iTunes_Control/Music/F00/ABCD.mp3"
    assert decoded[0]["title"] == "Midnight Draft"
    assert decoded[0]["artist"] == "Doc Beats"
    assert decoded[0]["album"] == "Lost Sessions"
    assert decoded[0]["duration"] == 90.5
    assert decoded[0]["size_bytes"] == 1234


def test_catalog_persists_tracks_and_supports_mystery_filters(tmp_path):
    catalog = MediaCatalog(str(tmp_path / "catalog.sqlite3"))
    catalog.upsert_tracks(
        [
            {
                "id": "known",
                "iphone_path": "/Music/known.wav",
                "title": "Final Beat",
                "artist": "Doc Beats",
                "album": "Album",
                "original_filename": "known.wav",
                "extension": ".wav",
                "size_bytes": 100,
                "modified": "2026-01-01 12:00:00",
                "metadata_pending": False,
            },
            {
                "id": "mystery",
                "iphone_path": "/Music/F00/ABCD.mp3",
                "title": "ABCD",
                "artist": "Unknown Artist",
                "album": "Unknown Album / Original Beats",
                "original_filename": "ABCD.mp3",
                "extension": ".mp3",
                "size_bytes": 200,
                "modified": "2025-01-01 12:00:00",
                "metadata_pending": True,
            },
        ]
    )

    assert {track["id"] for track in catalog.query_tracks()} == {"known", "mystery"}
    assert [track["id"] for track in catalog.query_tracks(mystery_only=True)] == ["mystery"]
    assert [track["id"] for track in catalog.query_tracks(extension=".wav")] == ["known"]


def test_catalog_records_analysis_and_version_groups(tmp_path):
    catalog = MediaCatalog(str(tmp_path / "catalog.sqlite3"))
    catalog.upsert_tracks(
        [
            {"id": "a", "iphone_path": "/a.wav", "title": "Beat v1", "size_bytes": 10},
            {"id": "b", "iphone_path": "/b.wav", "title": "Beat final", "size_bytes": 11},
        ]
    )
    catalog.save_analysis("a", {"content_sha256": "same", "duration": 10.0, "bpm": 92.0})
    catalog.save_analysis("b", {"content_sha256": "same", "duration": 10.0, "bpm": 92.0})

    groups = catalog.version_groups()

    assert len(groups) == 1
    assert {item["id"] for item in groups[0]["tracks"]} == {"a", "b"}
