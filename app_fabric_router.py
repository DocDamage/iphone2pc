"""Recovery Fabric APIs: backup fusion, vault, intelligence, and automation."""

from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, HTTPException, Query, Request

from app_afc_transfer import get_registered_track
from app_core import default_export_directory
from app_media_router import cache_track
from fabric_runtime import (
    BACKUP_FUSION, BEAT_GRAPH, CHUNK_VAULT, DEVICE_EVENTS, DIAGNOSTIC_ANALYTICS,
    HYDRATION_CACHE, LOCAL_AI, PROVENANCE, device_key, fabric_status,
    handle_device_event,
)
from wireless_exchange import WIRELESS_SERVER


router = APIRouter(prefix="/api/fabric", tags=["recovery-fabric"])


async def _body(request: Request) -> dict:
    try:
        value = await request.json()
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


@router.get("/status")
async def status():
    return await asyncio.to_thread(fabric_status)


@router.get("/backups")
async def backups():
    items = await asyncio.to_thread(BACKUP_FUSION.discover)
    return {"count": len(items), "backups": items}


@router.post("/backups/{backup_id}/scan")
async def scan_backup(backup_id: str, request: Request):
    data = await _body(request)
    try:
        assets = await asyncio.to_thread(
            BACKUP_FUSION.scan, backup_id, bool(data.get("include_all", False)), int(data.get("limit", 100_000))
        )
        return {"count": len(assets), "assets": assets}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=423, detail=str(exc)) from exc


@router.post("/backups/{backup_id}/extract")
async def extract_backup(backup_id: str, request: Request):
    data = await _body(request)
    file_ids = [str(item) for item in data.get("file_ids", [])]
    if not file_ids:
        raise HTTPException(status_code=400, detail="Choose at least one backup file.")
    output = os.path.abspath(data.get("output_directory") or default_export_directory())
    try:
        files = await asyncio.to_thread(BACKUP_FUSION.extract, backup_id, file_ids, output)
        manifests = []
        if data.get("ingest_vault", True):
            for item in files:
                manifests.append(await asyncio.to_thread(
                    CHUNK_VAULT.ingest, item["path"], "apple_backup", {"backup_id": backup_id, "file_id": item["file_id"]}
                ))
        return {"count": len(files), "files": files, "vault_manifests": manifests}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=423, detail=str(exc)) from exc


@router.post("/vault/ingest")
async def vault_ingest(request: Request):
    data = await _body(request)
    paths = [os.path.abspath(str(path)) for path in data.get("paths", [])]
    if not paths:
        raise HTTPException(status_code=400, detail="Choose one or more files to preserve.")
    try:
        manifests = [await asyncio.to_thread(
            CHUNK_VAULT.ingest, path, str(data.get("source_kind", "pc")), data.get("metadata") or {}
        ) for path in paths]
        return {"count": len(manifests), "manifests": manifests}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/vault/manifests")
async def vault_manifests(limit: int = Query(500, ge=1, le=5000)):
    items = await asyncio.to_thread(CHUNK_VAULT.list_manifests, limit)
    return {"count": len(items), "manifests": items}


@router.get("/vault/stats")
async def vault_stats():
    return await asyncio.to_thread(CHUNK_VAULT.stats)


@router.get("/vault/verify/{manifest_id}")
async def vault_verify(manifest_id: str, deep: bool = True):
    try:
        return await asyncio.to_thread(CHUNK_VAULT.verify, manifest_id, deep)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Vault manifest not found.") from exc


@router.post("/vault/reconstruct/{manifest_id}")
async def vault_reconstruct(manifest_id: str, request: Request):
    data = await _body(request)
    destination = data.get("destination")
    if not destination:
        raise HTTPException(status_code=400, detail="A destination path is required.")
    try:
        return await asyncio.to_thread(CHUNK_VAULT.reconstruct, manifest_id, os.path.abspath(destination))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Vault manifest not found.") from exc
    except IOError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/intelligence/search")
async def semantic_search(query: str = "", limit: int = Query(50, ge=1, le=200)):
    results = await asyncio.to_thread(BEAT_GRAPH.semantic_search, query, limit)
    return {"query": query, "count": len(results), "results": results}


@router.get("/intelligence/graph")
async def intelligence_graph(threshold: float = Query(0.92, ge=0.5, le=1.0)):
    return await asyncio.to_thread(BEAT_GRAPH.graph, threshold)


@router.get("/intelligence/similar/{track_id}")
async def similar_tracks(track_id: str, limit: int = Query(20, ge=1, le=100)):
    results = await asyncio.to_thread(BEAT_GRAPH.similar, track_id, limit)
    return {"track_id": track_id, "count": len(results), "results": results}


@router.get("/ai/status")
async def ai_status():
    return await asyncio.to_thread(LOCAL_AI.status)


@router.post("/ai/stems/{track_id}")
async def separate_stems(track_id: str, request: Request):
    track = get_registered_track(track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track is not in the active catalog.")
    data = await _body(request)
    try:
        source, _updated = await asyncio.to_thread(cache_track, track)
        output = os.path.abspath(data.get("output_directory") or os.path.join(default_export_directory(), "Stems"))
        return await asyncio.to_thread(LOCAL_AI.separate_stems, source, output, data.get("mode", "four"))
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/provenance/status")
async def provenance_status():
    return await asyncio.to_thread(PROVENANCE.status)


@router.post("/provenance/create")
async def create_provenance(request: Request):
    data = await _body(request)
    paths = [os.path.abspath(str(path)) for path in data.get("paths", [])]
    if not paths:
        raise HTTPException(status_code=400, detail="Choose provenance ingredients.")
    output = os.path.abspath(data.get("output_path") or os.path.join(default_export_directory(), "beat-provenance.json"))
    try:
        return await asyncio.to_thread(
            PROVENANCE.create, paths, output, data.get("assertions") or {}, bool(data.get("include_paths", False))
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/provenance/verify")
async def verify_provenance(request: Request):
    data = await _body(request)
    if not data.get("path"):
        raise HTTPException(status_code=400, detail="A provenance document path is required.")
    try:
        return await asyncio.to_thread(PROVENANCE.verify, os.path.abspath(data["path"]), data.get("ingredient_root"))
    except (FileNotFoundError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/diagnostics/prediction")
async def diagnostic_prediction():
    return await asyncio.to_thread(DIAGNOSTIC_ANALYTICS.prediction, device_key())


@router.get("/diagnostics/history")
async def diagnostic_history(limit: int = Query(100, ge=1, le=5000)):
    items = await asyncio.to_thread(DIAGNOSTIC_ANALYTICS.history, device_key(), limit)
    return {"count": len(items), "samples": items}


@router.get("/hydration/status")
async def hydration_status():
    return await asyncio.to_thread(HYDRATION_CACHE.status)


@router.post("/hydration/clear")
async def hydration_clear():
    removed = await asyncio.to_thread(HYDRATION_CACHE.clear)
    return {"success": True, "blocks_removed": removed, **HYDRATION_CACHE.status()}


@router.get("/device-events")
async def device_event_status():
    return DEVICE_EVENTS.status()


@router.post("/device-events/{action}")
async def device_event_control(action: str):
    if action == "start":
        return await asyncio.to_thread(DEVICE_EVENTS.start)
    if action == "stop":
        return await asyncio.to_thread(DEVICE_EVENTS.stop)
    raise HTTPException(status_code=400, detail="Action must be start or stop.")


@router.post("/device-event")
async def device_event_ingress(request: Request):
    data = await _body(request)
    try:
        await asyncio.to_thread(handle_device_event, data.get("event", ""))
        return {"success": True, "event": data.get("event")}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/wireless")
async def wireless_status():
    return WIRELESS_SERVER.status()


@router.post("/wireless/{action}")
async def wireless_control(action: str):
    try:
        if action == "start":
            return await asyncio.to_thread(WIRELESS_SERVER.start)
        if action == "stop":
            return await asyncio.to_thread(WIRELESS_SERVER.stop)
        raise HTTPException(status_code=400, detail="Action must be start or stop.")
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
