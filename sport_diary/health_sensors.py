"""Optional profile-scoped Apple Health readings from administrator-assigned HA entities."""
import hashlib
import json
import logging
import math
import re
import sqlite3
import subprocess
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from http.client import HTTPException
from urllib.error import HTTPError
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


PROFILES = ("person1", "person2")
ENTITY = re.compile(r"sensor\.[a-z0-9_]{1,240}")
# Canonical unit, conversions and maximum in the diary's unit (web/health.js).
MINUTES = {"min": 1, "minutes": 1, "h": 60, "hr": 60, "s": 1 / 60}
KCAL = {"kcal": 1, "kj": 1 / 4.184}
METRICS = {
    "sleep": ("min", MINUTES, 1440), "steps": ("steps", {"steps": 1}, 300000),
    "distance": ("km", {"km": 1, "m": .001, "mi": 1.609344}, 1000),
    "exercise": ("min", MINUTES, 1440), "active": ("kcal", KCAL, 30000),
    "resting": ("kcal", KCAL, 15000), "restingPulse": ("bpm", {"bpm": 1, "beats/min": 1}, 300),
}


def configured(settings, who):
    group = settings.get(who + "_health")
    if not isinstance(group, dict):
        return {}
    return {k: v.strip() for k, v in group.items() if k in METRICS and
            isinstance(v, str) and ENTITY.fullmatch(v.strip())}


def bindings(settings, who):
    own = configured(settings, who)
    all_entities = [v for p in PROFILES for v in configured(settings, p).values()]
    return {k: v for k, v in own.items() if all_entities.count(v) == 1}


def install(db):
    db.execute("""CREATE TABLE IF NOT EXISTS health_binding(
        who TEXT, metric TEXT, entity TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL,
        status TEXT, seen_at TEXT, last_value REAL, candidate TEXT, PRIMARY KEY (who,metric))""")
    db.execute("""CREATE TABLE IF NOT EXISTS health_day(
        who TEXT, metric TEXT, entity TEXT, day TEXT, stamp TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (who,metric,entity,day))""")


def grants(db, who, settings):
    allowed = bindings(settings, who)
    rows = db.execute("""SELECT metric,entity,token,status,candidate FROM health_binding
                         WHERE who=? AND owner=? ORDER BY metric""", (who, settings.get(who + "_user")))
    return {metric: (entity, token, status, candidate) for metric, entity, token, status, candidate in rows
            if allowed.get(metric) == entity}


def imported(db, who, settings):
    result = {"daily": [], "sleep": []}
    # Reassigned/shared entities must not expose the other profile's readings.
    foreign = {v for p in PROFILES if p != who for v in configured(settings, p).values()}
    rows = db.execute("""SELECT metric,entity,body FROM health_day WHERE who=?
                         ORDER BY day,metric,stamp,entity""", (who,))
    for metric, entity, body in rows:
        if entity not in foreign:
            result["sleep" if metric == "sleep" else "daily"].append(json.loads(body))
    return result


def snapshot(db, who, settings, manage):
    active = grants(db, who, settings)
    return {"bindings": bindings(settings, who), "enabled": list(active),
            "healthImported": imported(db, who, settings), "canManage": manage,
            "status": {k: status for k, (_, _, status, _) in active.items() if status},
            "candidates": [json.loads(item[3]) for item in active.values() if item[3]]}


def stamp(value):
    if isinstance(value, str):
        try:
            result = datetime.fromisoformat(value)
            if result.tzinfo:
                return result
        except (OverflowError, ValueError):
            pass
    return None


def iso_day(value):
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    return None


@lru_cache(maxsize=256)
def local_time(moment, zone):
    if zone in ("UTC", "Etc/UTC", "GMT"):
        return moment.astimezone(timezone.utc)
    try:
        return moment.astimezone(ZoneInfo(zone))
    except ZoneInfoNotFoundError:
        # The add-on includes IANA tzdata. Direct Windows runs can use the same
        # Intl timezone database as the diary's Node report engine.
        script = ("process.stdout.write(new Intl.DateTimeFormat('en-US',"
                  "{timeZone:process.argv[1],timeZoneName:'longOffset'}).formatToParts("
                  "new Date(process.argv[2])).find(p=>p.type==='timeZoneName').value)")
        try:
            raw = subprocess.check_output(["node", "-e", script, zone, moment.isoformat()],
                                          text=True, timeout=4, stderr=subprocess.DEVNULL)
            offset = datetime.fromisoformat("2000-01-01T00:00:00" + (raw.removeprefix("GMT") or "+00:00")).tzinfo
            return moment.astimezone(offset)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError("Некорректный часовой пояс дневника.") from exc


def local_day(moment, zone):
    return local_time(moment, zone).date()


def measurement_day(metric, attrs, zone, updated, date_attribute):
    # Sleep duration describes the last available night; a HA state timestamp is never
    # a wake time. Resting pulse is the latest sample, not a midnight-to-midnight total.
    if date_attribute is not None:
        # An admin may map a provider-specific wake date or sample date attribute.
        if not isinstance(date_attribute, str) or not date_attribute.strip() or len(date_attribute) > 120 or (
                date_attribute.lower() in ("last_changed", "last_updated", "last_reported", "received_at")):
            raise ValueError
        if date_attribute not in attrs:
            return None
        raw = attrs[date_attribute]
        day = iso_day(raw)
        moment = stamp(raw)
        if day:
            return day
        if moment and moment <= updated:
            return local_day(moment, zone)
        raise ValueError
    day_fields = ("wake_date",) if metric == "sleep" else ("measurement_date", "sample_date", "date")
    time_fields = ("wake_time", "sleep_end") if metric == "sleep" else ("measured_at", "sample_end")
    for key in day_fields:
        if key in attrs:
            day = iso_day(attrs[key])
            if not day:
                raise ValueError
            return day
    for key in time_fields:
        if key in attrs:
            moment = stamp(attrs[key])
            if not moment or moment > updated:
                raise ValueError
            return local_day(moment, zone)
    return None


def quantity(metric, state, attrs):
    unit, factors, maximum = METRICS[metric]
    supplied = attrs.get("unit_of_measurement")
    if not isinstance(supplied, str) or isinstance(state, bool):
        raise ValueError
    factor = factors.get(supplied.strip().lower())
    if factor is None:
        raise ValueError
    value = float(state) * factor
    if not math.isfinite(value) or not 0 <= value <= maximum:
        raise ValueError
    if (metric == "steps" and not value.is_integer()) or (metric == "restingPulse" and value < 1):
        raise ValueError
    normalized = round(value, 4)
    if metric == "sleep" and normalized == 0:
        raise ValueError
    return normalized, unit


def write_day(db, who, metric, day, reading):
    row = dict(reading, date=day.isoformat())
    if metric == "sleep":
        row.update(kind="main", id="ha-sleep-" + hashlib.sha256(
            (row["entity"] + ":" + row["date"]).encode()).hexdigest()[:24])
    db.execute("""INSERT INTO health_day VALUES (?,?,?,?,?,?)
        ON CONFLICT(who,metric,entity,day) DO UPDATE SET stamp=excluded.stamp,body=excluded.body
        WHERE excluded.stamp >= health_day.stamp""",
        (who, metric, row["entity"], row["date"], row["receivedAt"], json.dumps(row)))


def observe(db, who, metric, entity, token, response, zone, date_attribute):
    # Consent tokens invalidate in-flight reads if the owner disables/re-enables or clears a metric.
    current = db.execute("""SELECT seen_at,last_value,candidate FROM health_binding
                            WHERE who=? AND metric=? AND token=?""", (who, metric, token)).fetchone()
    if not current:
        return
    seen, previous, candidate = current
    args = (who, metric, token)
    if response is None or isinstance(response, dict) and response.get("state") in ("unavailable", "unknown", None):
        db.execute("UPDATE health_binding SET status='unavailable' WHERE who=? AND metric=? AND token=?", args)
        return
    try:
        if not isinstance(response, dict) or response.get("entity_id") != entity:
            raise ValueError
        attrs = response["attributes"]
        if not isinstance(attrs, dict):
            raise ValueError
        updated = stamp(response.get("last_updated"))
        if not updated or updated > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError
        received = updated.astimezone(timezone.utc).isoformat(timespec="microseconds")
        if seen and received < seen:
            return
        value, unit = quantity(metric, response["state"], attrs)
        day = measurement_day(metric, attrs, zone, updated, date_attribute)
        if day and day > local_day(min(updated, datetime.now(timezone.utc)), zone):
            raise ValueError
        device = attrs.get("source_device")
        source = device.strip()[:120] if isinstance(device, str) and device.strip() else entity
        row = {"metric": metric, "unit": unit, "source": source, "entity": entity, "receivedAt": received}
        if metric == "sleep":
            row["minutes"] = value
            if "sleep_start" in attrs and ("sleep_end" in attrs or "wake_time" in attrs):
                start = stamp(attrs["sleep_start"])
                end = stamp(attrs.get("sleep_end", attrs.get("wake_time")))
                if not start or not end or end > min(updated, datetime.now(timezone.utc)):
                    raise ValueError
                duration = (end - start).total_seconds() / 60
                wake_day = local_day(end, zone)
                if not 0 < duration <= 1440 or value > duration + .00001 or (day and day != wake_day):
                    raise ValueError
                day = wake_day
                row.update(start=start.isoformat(timespec="milliseconds" if start.microsecond else "seconds"),
                           end=end.isoformat(timespec="milliseconds" if end.microsecond else "seconds"))
        else:
            row.update(value=value, complete=False)
        status = "ok"
        if day:
            if metric != "sleep":
                row["complete"] = attrs.get("coverage_complete") is True and day < local_day(updated, zone)
            write_day(db, who, metric, day, dict(row, dateBasis="source"))
            candidate = None
        else:
            # An unchanged cached value can survive a locked phone, a day boundary or
            # a HA restart. A new numeric value alone cannot date a delayed delivery.
            if value != previous:
                candidate = json.dumps(dict(row, id=uuid4().hex))
            status = "needs_date" if candidate else "ok"
        db.execute("""UPDATE health_binding SET status=?,seen_at=?,last_value=?,candidate=?
                      WHERE who=? AND metric=? AND token=?""", (status, received, value, candidate, *args))
    except (KeyError, TypeError, ValueError, OverflowError):
        db.execute("UPDATE health_binding SET status='invalid' WHERE who=? AND metric=? AND token=?", args)


def refresh(db, who, get_settings, core, zone):
    for metric, (entity, token, _, _) in grants(db, who, get_settings()).items():
        try:
            response = core("states/" + entity)
        except (OSError, HTTPException, KeyError, ValueError) as error:
            if isinstance(error, HTTPError):
                error.close()
            response = None
        with db:
            db.execute("BEGIN IMMEDIATE")
            settings = get_settings()
            allowed = grants(db, who, settings).get(metric)
            if allowed and allowed[:2] == (entity, token):
                fields = settings.get(who + "_health_dates")
                custom = fields.get(metric) if isinstance(fields, dict) else None
                observe(db, who, metric, entity, token, response, zone, custom or None)


def update(db, who, body, settings, zone):
    if not isinstance(body, dict):
        return 400
    fields = set(body)
    active = grants(db, who, settings)
    allowed = bindings(settings, who)
    owner = settings[who + "_user"]
    if fields in ({"enabled"}, {"clear"}):
        key = next(iter(fields))
        items = body[key]
        valid = allowed if key == "enabled" else METRICS
        if not isinstance(items, list) or len(items) > len(METRICS) or any(
                not isinstance(k, str) or k not in valid for k in items):
            return 400
        if key == "enabled":
            for metric in METRICS:
                if metric not in items:
                    db.execute("DELETE FROM health_binding WHERE who=? AND metric=?", (who, metric))
                elif metric not in active:
                    db.execute("""INSERT OR REPLACE INTO health_binding (who,metric,entity,owner,token)
                                  VALUES (?,?,?,?,?)""", (who, metric, allowed[metric], owner, uuid4().hex))
        else:
            for metric in items:
                db.execute("DELETE FROM health_binding WHERE who=? AND metric=?", (who, metric))
                db.execute("DELETE FROM health_day WHERE who=? AND metric=?", (who, metric))
        return 200
    if fields not in ({"confirmSleep", "date"}, {"dismissSleep"}, {"confirmReading", "date"}, {"dismissReading"}):
        return 400
    action = next(k for k in body if k != "date")
    for metric, (_, _, _, pending) in active.items():
        if not pending or (action.endswith("Sleep") and metric != "sleep"):
            continue
        candidate = json.loads(pending)
        if candidate.pop("id") != body[action]:
            continue
        if "date" in body:
            day = iso_day(body["date"])
            reported = local_day(stamp(candidate["receivedAt"]), zone)
            if not day or day > reported or (metric == "sleep" and day < reported - timedelta(days=7)):
                return 400
            write_day(db, who, metric, day, dict(candidate, dateBasis="confirmed"))
        db.execute("UPDATE health_binding SET candidate=NULL,status='ok' WHERE who=? AND metric=?", (who, metric))
        return 200
    return 409


def poll(stop, open_db, get_settings, core, get_zone):
    while not stop.is_set():
        for who in PROFILES:
            try:
                with closing(open_db()) as db:
                    refresh(db, who, get_settings, core, get_zone())
            except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
                logging.warning("Health sensor synchronization unavailable for %s", who)
        stop.wait(300)
