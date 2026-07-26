from fastapi.testclient import TestClient

import app


client = TestClient(app.app)


def test_fabric_status_contract_is_available():
    response = client.get("/api/fabric/status")
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == 1
    assert data["intelligence"]["local_ai"]["local_only"] is True
    assert data["provenance"]["algorithm"] == "Ed25519"
    assert data["hydration"]["quota_bytes"] >= 1024 * 1024
    assert data["wireless"]["running"] is False


def test_fabric_search_and_graph_are_read_only():
    search = client.get("/api/fabric/intelligence/search", params={"query": "dark 140 bpm"})
    graph = client.get("/api/fabric/intelligence/graph")
    assert search.status_code == 200
    assert isinstance(search.json()["results"], list)
    assert graph.status_code == 200
    assert set(graph.json()) == {"nodes", "edges", "analyzed"}


def test_vault_rejects_empty_ingest_selection():
    response = client.post("/api/fabric/vault/ingest", json={"paths": []})
    assert response.status_code == 400
