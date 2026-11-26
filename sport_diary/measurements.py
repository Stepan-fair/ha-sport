"""Persistent scale readings, independent of browser sessions and profile revisions."""
from datetime import datetime, timedelta, timezone
from contextlib import closing
import logging
import math
import re
import sqlite3
from urllib.parse import quote, urlencode


def utc_stamp(value):
    if not isinstance(value, str):
        return None
    try:
        instant = datetime.fromisoformat(value)
        return instant.astimezone(timezone.utc).isoformat() if instant.tzinfo else None
    except (ValueError, OverflowError):
        return None


def reading(state):
    if not isinstance(state, dict) or not isinstance(state.get("attributes"), dict):
        return None
    attrs = state["attributes"]
    unit = attrs.get("unit_of_measurement")
    factor = {"kg": 1, "кг": 1, "g": 0.001, "lb": 0.45359237, "lbs": 0.45359237}.get(unit)
    # last_updated also advances for a friendly name or another attribute.
    # Integrations may expose a device measurement timestamp even at the same mass.
    updated = utc_stamp(state.get("last_updated"))
    if "measured_at" in attrs:
        basis, date = "measured_at", utc_stamp(attrs["measured_at"])
    elif state.get("last_changed"):
        basis, date = "last_changed", utc_stamp(state["last_changed"])
    else:
        basis, date = "legacy", updated
    try:
        kg = float(state.get("state")) * factor
    except (TypeError, ValueError):
        return None
    if not date or (updated and date > updated) or not math.isfinite(kg) or not 0 < kg < 700:
        return None
    return {"kg": round(kg, 3), "date": date, "source": "ha", "timeBasis": basis}


def open_history(path):
    db = sqlite3.connect(path, timeout=10)
    db.execute("CREATE TABLE IF NOT EXISTS scale(who TEXT, entity TEXT, date TEXT, kg REAL NOT NULL, PRIMARY KEY(who,entity,date))")
    # Preserve 0.6.0 readings and cursor. A separate cursor replays the available
    # Recorder window on upgrade without discarding older or offline sources.
    db.execute("CREATE TABLE IF NOT EXISTS scale_event_cursor(who TEXT, entity TEXT, date TEXT, PRIMARY KEY(who,entity))")
    db.execute("""CREATE TABLE IF NOT EXISTS scale_evidence(
        who TEXT, entity TEXT, date TEXT, basis TEXT NOT NULL, PRIMARY KEY(who,entity,date))""")
    db.execute("CREATE INDEX IF NOT EXISTS scale_source_time ON scale(entity,date,who)")
    return db


def readings(path, who):
    with closing(open_history(path)) as db:
        rows = db.execute("""
            WITH observations AS (
                SELECT a.date, a.kg, a.entity, e.basis,
                       lag(a.kg) OVER (PARTITION BY a.entity ORDER BY a.date) AS previous_kg
                FROM scale a LEFT JOIN scale_evidence e USING(who,entity,date)
                WHERE a.who=? AND NOT EXISTS (
                    SELECT 1 FROM scale b WHERE b.who<>a.who AND b.entity=a.entity AND b.date=a.date)
            )
            SELECT date,kg,entity,coalesce(basis,'legacy') FROM observations
            WHERE basis IS NOT NULL OR kg IS NOT previous_kg ORDER BY date,entity
        """, (who,))
        return [{"date": date, "kg": kg, "source": "ha", "entity": entity, "timeBasis": basis}
                for date, kg, entity, basis in rows]


def weight_entity(value):
    entity = value.strip() if isinstance(value, str) else ""
    return entity if re.fullmatch(r"(?:sensor|input_number)\.[a-z0-9_]+", entity) else ""


def scale_binding(settings, who):
    entity = weight_entity(settings.get(who + "_weight"))
    other = "person2" if who == "person1" else "person1"
    shared = bool(entity and entity == weight_entity(settings.get(other + "_weight")))
    return entity, shared


def store_readings(db, who, entity, states, now, boundary=None):
    for state in states:
        item = reading(state)
        if item and item["date"] <= now.isoformat() and item["date"] != boundary:
            # Recorder can return the original event after the current, renamed
            # state. Only the original attributes can correct the mass at that time.
            original = item["timeBasis"] != "legacy" and item["date"] == utc_stamp(state.get("last_updated"))
            db.execute("""INSERT INTO scale VALUES(?,?,?,?) ON CONFLICT(who,entity,date)
                       DO UPDATE SET kg=excluded.kg WHERE ?""", (who, entity, item["date"], item["kg"], original))
            if item["timeBasis"] != "legacy":
                db.execute("""INSERT INTO scale_evidence VALUES(?,?,?,?)
                    ON CONFLICT(who,entity,date) DO UPDATE SET basis=excluded.basis
                    WHERE excluded.basis='measured_at'""", (who, entity, item["date"], item["timeBasis"]))


def profile_readings(path, who, configured_entity, core):
    saved = readings(path, who)
    entity = weight_entity(configured_entity)
    if not entity or any(row["entity"] == entity for row in saved):
        return saved
    # A newly bound sensor may already have a reading before the next poll.
    try:
        current = core("states/" + entity)
    except (OSError, ValueError, TypeError, KeyError):
        return saved
    with closing(open_history(path)) as db, db:
        store_readings(db, who, entity, [current], datetime.now(timezone.utc))
    return readings(path, who)


def current_reading(path, who, entity, state):
    now = datetime.now(timezone.utc)
    item = reading(state)
    if not item or item["date"] > now.isoformat():
        return None
    with closing(open_history(path)) as db, db:
        store_readings(db, who, entity, [state], now)
    candidates = (row for row in readings(path, who) if row["entity"] == entity)
    return max(candidates, key=lambda r: (r["timeBasis"] != "legacy", r["date"]), default=None)


def collect(path, who, entity, core, now=None):
    entity = weight_entity(entity)
    if not entity:
        return
    now = now or datetime.now(timezone.utc)
    with closing(open_history(path)) as db:
        current = core("states/" + entity)
        with db:
            store_readings(db, who, entity, [current], now)
        cursor = db.execute("SELECT date FROM scale_event_cursor WHERE who=? AND entity=?", (who,entity)).fetchone()
        start = datetime.fromisoformat(cursor[0]) if cursor else now - timedelta(days=30)
        if now-start < timedelta(minutes=10):
            return
        while start < now:
            end = min(start + timedelta(days=7), now)
            # Overlap windows: a real observation at a boundary is recovered on the next pass.
            lower = (start-timedelta(seconds=1)).isoformat()
            query = urlencode({"filter_entity_id":entity,"end_time":end.isoformat(),"skip_initial_state":"1"})
            history = core("history/period/" + quote(lower, safe="") + "?" + query)
            with db:
                for series in history:
                    store_readings(db, who, entity, (s for s in series if s.get("entity_id")==entity), now, lower)
                db.execute("INSERT OR REPLACE INTO scale_event_cursor VALUES(?,?,?)", (who,entity,end.isoformat()))
            start = end


def poll(stop, path, profiles, options, core):
    while not stop.is_set():
        for who in profiles:
            try:
                entity, shared = scale_binding(options(), who)
                if not shared:
                    collect(path, who, entity, core)
            except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
                logging.warning("Scale synchronization unavailable for %s; saved readings retained", who)
        stop.wait(60)
