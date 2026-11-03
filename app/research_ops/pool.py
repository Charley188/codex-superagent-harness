"""Finite multi-worker batch. No watcher, daemon, model delegation or unbounded drain."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import threading
import time
import uuid

from .codex_adapter import atomic_json
from .contracts import require
from .host import Host
from .roles import definition


def run_batch(host, workers, max_tasks, selected_roles=None, stop_event=None):
    require(type(workers) is int and 1 <= workers <= host.config["max_workers"], "Worker count exceeds configured capacity")
    require(type(max_tasks) is int and 1 <= max_tasks <= 20, "Batch task limit must be 1..20")
    if selected_roles is not None:
        require(bool(selected_roles), "At least one role is required")
        for role in selected_roles:
            definition(role)
    host.gate()
    rows = host.store.db.execute("SELECT id,generation,payload FROM tasks WHERE state='queued' ORDER BY created,rowid").fetchall()
    eligible = [r for r in rows if selected_roles is None or json.loads(r["payload"]).get("role", "general") in selected_roles][:max_tasks]
    expected = {r["id"]: r["generation"] for r in eligible}
    batch_id = str(uuid.uuid4())
    stop = stop_event if stop_event is not None else threading.Event()
    result = {"batch_id": batch_id, "started_unix": time.time(), "workers": workers,
              "max_tasks": max_tasks, "snapshot_generations": expected, "roles": selected_roles,
              "results": [], "errors": []}
    destination = host.state / "batches" / (batch_id + ".json")
    atomic_json(destination, result)

    def worker(index):
        local = Host(host.config, host.base)
        completed = []
        try:
            for _ in range(len(expected)):
                if stop.is_set():
                    break
                item = local.run_once(expected, selected_roles, stop, batch_id + ":" + str(index))
                if "task_id" not in item:
                    break
                completed.append(item)
            return completed
        finally:
            local.close()

    executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="research-worker")
    futures = [executor.submit(worker, i) for i in range(min(workers, len(expected)))]
    try:
        for future in as_completed(futures):
            try:
                result["results"].extend(future.result())
            except Exception as exc:
                result["errors"].append(str(exc))
                stop.set()
    except KeyboardInterrupt:
        stop.set()
        result["errors"].append("Batch interrupted; active attempts asked to stop, unclaimed tasks preserved")
    finally:
        executor.shutdown(wait=True)
        # Collect completed results even when the main loop was interrupted.
        seen = {r["task_id"] for r in result["results"]}
        for future in futures:
            if future.done() and not future.cancelled() and future.exception() is None:
                for row in future.result():
                    if row["task_id"] not in seen:
                        result["results"].append(row)
                        seen.add(row["task_id"])
        result["finished_unix"] = time.time()
        result["stopped"] = stop.is_set()
        result["task_states"] = {task: host.store.get(task)["state"] for task in expected}
        if result["errors"] or any(r["state"] == "failed" for r in result["results"]):
            result["status"] = "failed"
        elif stop.is_set():
            result["status"] = "stopped"
        elif any(state in ("queued", "running", "waiting-human", "cancel_requested", "interrupted") for state in result["task_states"].values()):
            result["status"] = "incomplete"
        else:
            result["status"] = "finished"
        atomic_json(destination, result)
    return result
