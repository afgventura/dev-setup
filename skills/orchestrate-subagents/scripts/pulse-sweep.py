#!/usr/bin/env python3
"""Turn a saved `pulse_list_tickets` response into the free/held sweep table.

`pulse_list_tickets` always blows the MCP token limit on this queue, so the
orchestrator saves the response to a file and parses it. That parsing was
hand-written python retyped every tick, which is how a `custom_field_filters`
mistake survived several sweeps and how closed rows kept reaching briefs.

Usage:
    pulse-sweep.py <file.json> [<file.json> ...] [--live-sessions <name> ...]
                   [--all] [--json]

Reads one or more saved responses (pages), applies the queue selector, and
prints one row per candidate ticket. Pass the live tmux session names so a
`worked_by` holder can be classified: a holder with a live session is off
limits, a holder with none is a reclaimable tombstone.

Exit status is 0 even when nothing is free; an empty table is a real answer.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Iterable

BUSINESS_ID = "019951bc-7de0-75df-a3bc-c915e5837fe3"
DIVISION = "Tribe Support"
SCOPE = "tenant"

# Statuses that mean the ticket is off the queue. Names, not ids: the ids are
# stable but the response carries the name, and a renamed status should surface
# as an unexpected row rather than silently pass the filter.
CLOSED_STATUSES = {"Done, To Notify Cust", "Resolved", "Cancelled"}

# `ai-behaviour` is the research team's, and a pure feature request is not ours.
SKIP_ROOT_CAUSES = {"ai-behaviour"}
FEATURE_ISSUE_TYPES = {
    "Feature Request - Triage",
    "Feature Request - In Scope",
    "Feature Request - Out Scope",
}


def load_tickets(paths: Iterable[str]) -> list[dict[str, Any]]:
    """Collect ticket dicts from saved responses, tolerating the shapes seen.

    A saved page is sometimes the raw response object, sometimes the `tickets`
    array on its own, and sometimes the MCP envelope with the payload as a JSON
    string in `content[0].text`.
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in paths:
        with open(path, encoding="utf-8") as handle:
            raw = handle.read()
        doc = json.loads(raw)
        for ticket in _extract(doc):
            tid = str(ticket.get("id", ""))
            if tid and tid in seen:
                continue  # pages overlap when the queue moves under pagination
            seen.add(tid)
            out.append(ticket)
    return out


def _extract(doc: Any) -> list[dict[str, Any]]:
    if isinstance(doc, list):
        return [t for t in doc if isinstance(t, dict)]
    if not isinstance(doc, dict):
        return []
    for key in ("tickets", "items", "data", "results"):
        value = doc.get(key)
        if isinstance(value, list):
            return [t for t in value if isinstance(t, dict)]
    content = doc.get("content")
    if isinstance(content, list) and content:
        text = content[0].get("text") if isinstance(content[0], dict) else None
        if isinstance(text, str):
            return _extract(json.loads(text))
    return []


def field(ticket: dict[str, Any], key: str) -> str:
    """Read a custom field, whichever of the two shapes the response uses."""
    fields = ticket.get("custom_fields")
    if isinstance(fields, dict):
        value = fields.get(key)
        if isinstance(value, dict):
            value = value.get("value")
        if value is not None:
            return str(value)
    if isinstance(fields, list):
        for entry in fields:
            if isinstance(entry, dict) and entry.get("field_key") == key:
                return str(entry.get("value") or "")
    value = ticket.get(key)
    return str(value) if value is not None else ""


def status_name(ticket: dict[str, Any]) -> str:
    status = ticket.get("status")
    if isinstance(status, dict):
        return str(status.get("name") or "")
    return str(status or "")


def issue_type_name(ticket: dict[str, Any]) -> str:
    it = ticket.get("issue_type")
    if isinstance(it, dict):
        return str(it.get("name") or "")
    return str(it or "")


def in_queue(ticket: dict[str, Any]) -> tuple[bool, str]:
    """The four selector conditions. Returns (kept, reason-when-dropped)."""
    if str(ticket.get("business_id") or BUSINESS_ID) != BUSINESS_ID:
        return False, "other business"
    if field(ticket, "division") != DIVISION:
        return False, f"division={field(ticket, 'division') or '-'}"
    if field(ticket, "scope") != SCOPE:
        return False, f"scope={field(ticket, 'scope') or '-'}"
    name = status_name(ticket)
    if name in CLOSED_STATUSES:
        return False, f"status={name}"
    if field(ticket, "root_cause") in SKIP_ROOT_CAUSES:
        return False, "root_cause=ai-behaviour"
    if issue_type_name(ticket) in FEATURE_ISSUE_TYPES:
        return False, "feature request"
    return True, ""


def claim_state(worked_by: str, live: list[str]) -> str:
    """Classify a `worked_by` holder against the live tmux sessions.

    Substring both ways: `worked_by` is free text and is often a truncated or
    decorated form of the session name (`claude-main (applied)`), and a session
    name often extends the holder (`codex-wt-f-igdm` holds `f-igdm`).
    """
    holder = worked_by.strip()
    if not holder:
        return "FREE"
    for session in live:
        if holder in session or session in holder:
            return "HELD"
    return "TOMBSTONE"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="saved pulse_list_tickets JSON")
    parser.add_argument(
        "--live-sessions",
        nargs="*",
        default=[],
        help="live tmux session names (from `tmux ls -F '#S'`)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="also print rows the selector dropped, with the reason",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON")
    args = parser.parse_args()

    tickets = load_tickets(args.files)
    kept: list[dict[str, Any]] = []
    dropped: list[tuple[str, str, str]] = []

    for ticket in tickets:
        ok, reason = in_queue(ticket)
        tid = str(ticket.get("id", ""))
        title = str(ticket.get("title", ""))
        if not ok:
            dropped.append((tid[:12], title[:60], reason))
            continue
        worked_by = field(ticket, "worked_by")
        kept.append(
            {
                "id": tid,
                "short": tid[:12],
                "title": title,
                "status": status_name(ticket),
                "issue_type": issue_type_name(ticket),
                "root_cause": field(ticket, "root_cause"),
                "worked_by": worked_by,
                "claim": claim_state(worked_by, args.live_sessions),
            }
        )

    # Free first, then reclaimable tombstones, then held — the order you work in.
    order = {"FREE": 0, "TOMBSTONE": 1, "HELD": 2}
    kept.sort(key=lambda r: (order[r["claim"]], r["status"], r["short"]))

    if args.json:
        json.dump(kept, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    print(f"# {len(tickets)} row(s) read, {len(kept)} in queue, {len(dropped)} dropped")
    counts: dict[str, int] = {}
    for row in kept:
        counts[row["claim"]] = counts.get(row["claim"], 0) + 1
    print("# " + (", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none"))
    print()
    print(f"{'CLAIM':10} {'ID':14} {'STATUS':22} {'WORKED_BY':24} TITLE")
    for row in kept:
        print(
            f"{row['claim']:10} {row['short']:14} {row['status'][:22]:22} "
            f"{row['worked_by'][:24]:24} {row['title'][:70]}"
        )

    if args.all and dropped:
        print()
        print("# dropped")
        for short, title, reason in dropped:
            print(f"{'-':10} {short:14} {reason[:22]:22} {'':24} {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
