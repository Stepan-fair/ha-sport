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
    unit = state.get("attributes", {}).get("unit_of_measurement")
    factor = {"kg": 1, "кг": 1, "g": 0.001, "lb": 0.45359237, "lbs": 0.45359237}.get(unit)
    date = utc_stamp(state.get("last_updated") or state.get("last_changed"))
    try:
        kg = float(state.get("state")) * factor
    except (TypeError, ValueError):
        return None
    if not date or not math.isfinite(kg) or not 0 < kg < 700:
        return None
    return {"kg": round(kg, 3), "date": date, "source": "ha"}


def open_history(path):
    db = sqlite3.connect(path, timeout=10)
    db.execute("CREATE TABLE IF NOT EXISTS scale(who TEXT, entity TEXT, date TEXT, kg REAL NOT NULL, PRIMARY KEY(who,entity,date))")
    db.execute("CREATE TABLE IF NOT EXISTS scale_cursor(who TEXT, entity TEXT, date TEXT, PRIMARY KEY(who,entity))")
    return db


def readings(path, who):
    with closing(open_history(path)) as db:
        rows = db.execute("SELECT date,kg,entity FROM scale WHERE who=? ORDER BY date,entity", (who,))
        return [{"date": date, "kg": kg, "source": "ha", "entity": entity} for date, kg, entity in rows]


def collect(path, who, entity, core, now=None):
    if not isinstance(entity,str) or not re.fullmatch(r"(?:sensor|input_number)\.[a-z0-9_]+", entity):
        return
    now = now or datetime.now(timezone.utc)
    def store(db, states, start=None):
        for state in states:
            item = reading(state)
            if not item or item["date"] > now.isoformat() or item["date"] == start:
                continue
            db.execute("INSERT INTO scale VALUES(?,?,?,?) ON CONFLICT(who,entity,date) DO UPDATE SET kg=excluded.kg",
                       (who,entity,item["date"],item["kg"]))
    with closing(open_history(path)) as db:
        current = core("states/" + entity)
        with db:
            store(db, [current])
        cursor = db.execute("SELECT date FROM scale_cursor WHERE who=? AND entity=?", (who,entity)).fetchone()
        start = datetime.fromisoformat(cursor[0]) if cursor else now - timedelta(days=30)
        if now-start < timedelta(minutes=10):
            return
        while start < now:
            end = min(start + timedelta(days=7), now)
            # Overlap windows: a real observation at a boundary is recovered on the next pass.
            lower = (start-timedelta(seconds=1)).isoformat()
            query = urlencode({"filter_entity_id":entity,"end_time":end.isoformat()})
            history = core("history/period/" + quote(lower, safe="") + "?" + query)
            with db:
                for series in history:
                    store(db, (s for s in series if s.get("entity_id")==entity), lower)
                db.execute("INSERT OR REPLACE INTO scale_cursor VALUES(?,?,?)", (who,entity,end.isoformat()))
            start = end


def poll(stop, path, profiles, options, core):
    while not stop.is_set():
        for who in profiles:
            try:
                collect(path, who, options().get(who+"_weight"), core)
            except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
                logging.warning("Scale synchronization unavailable for %s; saved readings retained", who)
        stop.wait(60)
