import argparse
import json
from pathlib import Path
import sys

from .host import BASE, Host, config_load
from .compatibility import certify
from .pool import run_batch
from .roles import ROLES


def main(argv=None):
    parser = argparse.ArgumentParser(description="Research Ops: explicit finite local task execution")
    parser.add_argument("--config", type=Path, default=BASE / "config.local.json")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("doctor", "certify", "run-once", "status", "pause", "unpause", "recover"):
        sub.add_parser(name)
    sub.add_parser("roles")
    batch = sub.add_parser("run-batch")
    batch.add_argument("--workers", type=int, default=2)
    batch.add_argument("--max-tasks", type=int, default=4)
    batch.add_argument("--roles", nargs="+", choices=tuple(ROLES))
    submit = sub.add_parser("submit")
    submit.add_argument("card", type=Path)
    for name in ("cancel", "retry", "accept", "reject"):
        sub.add_parser(name).add_argument("task_id")
    reconcile = sub.add_parser("reconcile")
    reconcile.add_argument("task_id")
    reconcile.add_argument("--confirmed-stopped", action="store_true")
    sub.add_parser("backup").add_argument("destination", type=Path)
    args = parser.parse_args(argv)
    host = None
    try:
        host = Host(config_load(args.config))
        result = None
        if args.command == "doctor":
            result = host.doctor()
        elif args.command == "certify":
            result = certify(host)
        elif args.command == "submit":
            task, created = host.submit(args.card)
            result = {"task_id": task, "created": created}
        elif args.command == "run-once":
            result = host.run_once()
        elif args.command == "run-batch":
            result = run_batch(host, args.workers, args.max_tasks, args.roles)
        elif args.command == "roles":
            result = ROLES
        elif args.command == "status":
            result = {"tasks": host.store.list(), "html": str(host.status_html())}
        elif args.command in ("pause", "unpause"):
            host.store.paused(args.command == "pause")
            result = {"paused": args.command == "pause"}
        elif args.command == "recover":
            result = {"quarantined_attempts": host.store.recover()}
        elif args.command == "reconcile":
            host.store.reconcile(args.task_id, args.confirmed_stopped)
        elif args.command == "retry":
            host.store.retry(args.task_id, host.config["max_attempts"])
        elif args.command == "cancel":
            result = {"state": host.store.cancel(args.task_id)}
        elif args.command in ("accept", "reject"):
            host.store.review(args.task_id, args.command == "accept")
        elif args.command == "backup":
            host.store.backup(args.destination)
        print(json.dumps(result if result is not None else {"ok": True}, ensure_ascii=False, indent=2))
        if isinstance(result, dict) and (result.get("status") in ("failed", "stopped", "incomplete") or result.get("state") == "failed"):
            return 1
        return 0
    except (ValueError, OSError, RuntimeError) as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        return 1
    finally:
        if host:
            host.close()


if __name__ == "__main__":
    sys.exit(main())
