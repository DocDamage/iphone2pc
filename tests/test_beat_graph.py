from beat_graph import BeatGraph
from catalog import MediaCatalog


def test_beat_graph_search_similarity_and_project_edges(tmp_path):
    catalog = MediaCatalog(str(tmp_path / "catalog.sqlite3"))
    catalog.upsert_tracks([
        {"id": "a", "iphone_path": "/a.wav", "title": "Midnight Mix v1", "artist": "Doc"},
        {"id": "b", "iphone_path": "/b.wav", "title": "Midnight Mix final", "artist": "Doc"},
        {"id": "c", "iphone_path": "/c.wav", "title": "Sunny Day", "artist": "Doc"},
    ])
    base = {"duration": 180, "bpm": 140, "key": "C minor", "loudness": -12, "waveform": [0.1, 0.8] * 16}
    catalog.save_analysis("a", {**base, "content_sha256": "1", "acoustic_fingerprint": "same"})
    catalog.save_analysis("b", {**base, "bpm": 142, "content_sha256": "2", "acoustic_fingerprint": "same"})
    catalog.save_analysis("c", {**base, "bpm": 80, "key": "C major", "content_sha256": "3", "acoustic_fingerprint": "other"})
    graph = BeatGraph(catalog.database_path)

    assert graph.semantic_search("dark 140 bpm")[0]["track"]["id"] in {"a", "b"}
    assert graph.similar("a")[0]["track"]["id"] == "b"
    relationships = graph.graph()["edges"]
    assert any(edge["kind"] == "acoustic-version" for edge in relationships)
