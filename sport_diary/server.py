"""Local HA ingress application. Only the supervisor ingress proxy can reach its API."""
import json
import logging
import math
from functools import lru_cache
from http.client import HTTPException
from contextlib import closing
from copy import deepcopy
import os
import sqlite3
import subprocess
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, urlencode, unquote
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from threading import Event, Thread
import measurements
import health_sensors
import food_catalog
import nutrition
from datetime import datetime
from uuid import UUID
from photos import CATALOG, PHOTO_PATHS, PHOTO_SOURCE

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("SPORT_DATA", "/data"))
HEADERS = food_catalog.HEADERS
catalog = food_catalog.Catalog(ROOT / food_catalog.FILENAME, DATA / food_catalog.FILENAME)
PROFILES = ("person1", "person2")


def fetch(url, headers=None):
    with urlopen(Request(url, headers=headers or HEADERS), timeout=7) as response:
        return json.load(response)


def options():
    path = DATA / "options.json"
    return json.loads(path.read_text(encoding="utf8")) if path.exists() else {}


def online_food(q):
    fields = "code,product_name,product_name_ru,brands,quantity,nutriments,nutrition_data_per"
    barcode = bool(food_catalog.BARCODE.fullmatch(q))
    try:
        if barcode:
            data = fetch("https://world.openfoodfacts.org/api/v2/product/" + q + ".json?fields=" + fields)
            if isinstance(data, dict) and data.get("status") == 0:
                return 200, []
            products = [data["product"]]
        else:
            params = urlencode(dict(search_terms=q, search_simple=1, lc="ru", json=1, page_size=15, fields=fields, action="process"))
            products = fetch("https://ru.openfoodfacts.org/cgi/search.pl?" + params)["products"]
        if not isinstance(products, list) or any(not isinstance(p, dict) for p in products):
            raise ValueError("Invalid product response")
        return 200, products
    except (OSError, HTTPException, ValueError, KeyError, TypeError) as error:
        if isinstance(error, HTTPError):
            error.close()
            if barcode and error.code == 404:
                return 200, []
        reason = "bad_data" if isinstance(error, (KeyError, TypeError)) else food_catalog.failure(error)
        logging.warning("Open Food Facts %s: %s", "barcode" if barcode else "search", reason)
        return (429 if reason == "rate_limit" else 504 if reason == "timeout" else 502), {"reason": reason}


def allowed_profiles(settings, user_id):
    if not user_id:
        return ()
    owned = [profile for profile in PROFILES if settings.get(profile + "_user") == user_id]
    if len(owned) != 1:
        return ()
    if owned[0] == "person1" and settings.get("person1_can_open_both") is True:
        return PROFILES
    return owned


def assistant_profile(settings, user_id):
    profile = settings.get("nutrition_assistant_profile")
    owners = [settings.get(p + "_user") for p in PROFILES]
    if (profile in PROFILES and user_id and user_id not in owners and
            user_id == settings.get("nutrition_assistant_user") and settings.get(profile + "_user") and
            owners.count(settings[profile + "_user"]) == 1):
        return profile
    return None


def core(path):
    return fetch("http://supervisor/core/api/" + path, {"Authorization": "Bearer " + os.environ["SUPERVISOR_TOKEN"]})


def profile_name(settings, profile):
    name = settings.get(profile + "_name") or ("Профиль " + profile[-1])
    if profile == "person2" and settings.get("person2_heart", True) and not any(c in name for c in "❤♥💕💖💗💙💚💜🧡🩷🤍🖤💛🤎🩵"):
        name += " ❤️"
    return name


def scale_features():
    # Ask Core for capabilities only. Keep readings and entity identifiers inside HA.
    template = """
    {%- set ns = namespace(rows=[]) -%}
    {%- for e in integration_entities('xiaomi_ble') + integration_entities('ble_monitor') + integration_entities('esphome') -%}
      {%- if e.startswith(('sensor.','binary_sensor.')) -%}
        {%- set model = device_attr(e,'model') or '' -%}
        {%- set key = (model ~ ' ' ~ e)|lower -%}
        {%- if 'scale' in key or 'xmtzc' in key or 'весы' in key or 'весы' in (state_attr(e,'friendly_name') or '')|lower -%}
          {%- set unit = (state_attr(e,'unit_of_measurement') or '')|lower -%}
          {%- set kind = 'impedance' if unit in ['ω','ohm','ом'] or 'impedance' in e else
                         'removed' if 'weight_removed' in e else
                         'unstable' if 'non_stabilized' in e or 'non_stabilised' in e else
                         'stable' if 'stabilized_weight' in e or 'stabilised_weight' in e else
                         'signal' if 'rssi' in e or unit == 'dbm' else
                         'weight' if unit in ['kg','кг','g','lb','lbs'] or 'weight' in e else '' -%}
          {%- if kind -%}
            {%- set item = [model,kind] -%}
            {%- if item not in ns.rows -%}{%- set ns.rows = ns.rows + [item] -%}{%- endif -%}
          {%- endif -%}
        {%- endif -%}
      {%- endif -%}
    {%- endfor -%}
    {{ ns.rows | to_json }}
    """
    req = Request("http://supervisor/core/api/template", json.dumps({"template":template}).encode(),
                  {"Authorization":"Bearer "+os.environ["SUPERVISOR_TOKEN"], "Content-Type":"application/json"})
    with urlopen(req,timeout=7) as response:
        rows = json.load(response)
    if not isinstance(rows, list):
        raise ValueError("Invalid scale discovery response")
    return {"sensors":[{"model":model[:80], "kind":kind} for model,kind in rows
                       if isinstance(model,str) and kind in ("weight","stable","unstable","impedance","removed","signal")]}


def weight(profile):
    entity, shared = measurements.scale_binding(options(), profile)
    if not entity or shared:
        return None
    return measurements.current_reading(DATA / "sport.db", profile, entity, core("states/" + entity))


@lru_cache(maxsize=1)
def diary_zone():
    # Node also runs the assistant's report; both views follow the add-on timezone.
    return os.environ.get("TZ") or subprocess.check_output(
        ["node", "-p", "Intl.DateTimeFormat().resolvedOptions().timeZone"], text=True, timeout=5).strip()


def first_diary_day(data):
    days = []
    markers = data.get("workoutDrafts")
    sources = [data.get(key) for key in ("meals", "workouts", "supps", "weights")]
    if isinstance(markers, dict):
        sources.append(list(markers.values()))
    for rows in sources:
        if not isinstance(rows, list):
            continue
        for row in rows:
            value = row.get("date") if isinstance(row, dict) else None
            if not isinstance(value, str):
                continue
            try:
                stamp = datetime.fromisoformat(value)
                if stamp.tzinfo:
                    stamp = stamp.astimezone()
                days.append(stamp.date().isoformat())
            except (ValueError, OverflowError):
                continue
    return min(days) if days else None


def read_state(db, who):
    row = db.execute("SELECT rev, body FROM profile WHERE who=?", (who,)).fetchone()
    state = {"rev": row[0], "data": json.loads(row[1])} if row else {"rev": 0, "data": {}}
    if row and ("diaryStartedOn" not in state["data"] or nutrition.needs_target_ids(state["data"])):
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
            state = read_state(db, who)
            db.commit()
        else:
            previous = deepcopy(state["data"])
            nutrition.version_targets(state["data"], previous)
            state["rev"] += 1
            write_state(db, who, state["rev"], state["data"])
    return state


def write_state(db, who, rev, data):
    stored = db.execute("SELECT body FROM profile WHERE who=?", (who,)).fetchone()
    previous = json.loads(stored[0]) if stored else {}
    origin = previous.get("diaryStartedOn") or first_diary_day(previous)
    dates = [day for day in (origin, first_diary_day(data), datetime.now().date().isoformat()) if day]
    data["diaryStartedOn"] = min(dates)
    db.execute("INSERT OR REPLACE INTO profile VALUES (?,?,?)", (who, rev, json.dumps(data)))


def save(db, who, body):
    db.execute("BEGIN IMMEDIATE")
    old = read_state(db, who)
    if old["rev"] != body["rev"]:
        return None
    rev = old["rev"] + 1
    body["data"].pop("healthImported", None)
    nutrition.version_targets(body["data"], old["data"])
    write_state(db, who, rev, body["data"])
    return rev


def open_diary():
    db = sqlite3.connect(DATA / "sport.db")
    db.execute("CREATE TABLE IF NOT EXISTS profile(who TEXT PRIMARY KEY,rev INTEGER,body TEXT)")
    db.execute("""CREATE TABLE IF NOT EXISTS food_proposal(
               who TEXT, id TEXT, signature TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL,
               PRIMARY KEY (who, id))""")
    health_sensors.install(db)
    return db


def profile_with_health(db, who, settings):
    state = read_state(db, who)
    observations = health_sensors.imported(db, who, settings)
    state["data"].pop("healthImported", None)
    if any(observations.values()):
        state["data"]["healthImported"] = observations
    return state


def append_meal(db, who, body):
    preference = body.get("preferenceProposal") if isinstance(body, dict) else None
    if preference is not None and (not isinstance(preference, dict) or
            set(preference) - {"changes", "reason", "targetId", "version"} or
            not nutrition.safe_text(preference.get("reason"), 500) or not preference["reason"].strip() or body.get("oneOff")):
        raise nutrition.BadPortion("Укажите пожелание для личной карточки. Разовая запись сохраняет только приём.")
    meal = nutrition.make_meal({k: v for k, v in body.items() if k != "preferenceProposal"} if isinstance(body, dict) else body)
    signature = nutrition.operation_signature(body)
    # The revision and the operation receipt commit together, including when an owner writes concurrently.
    db.execute("BEGIN IMMEDIATE")
    db.execute("""CREATE TABLE IF NOT EXISTS food_operation(
               who TEXT, operation TEXT, signature TEXT NOT NULL, PRIMARY KEY (who, operation))""")
    receipt = db.execute("SELECT signature FROM food_operation WHERE who=? AND operation=?",
                         (who, body["operationId"])).fetchone()
    current = read_state(db, who)
    data = current["data"]
    if receipt:
        if receipt[0] != signature:
            return 409, {"error": "Этот ID операции уже использован с другими данными."}
        if not any(m.get("id") == meal["id"] for _, m in nutrition.meals_in(data)):
            return 410, {"error": "Владелец удалил эту порцию."}
        return 200, {"id": meal["id"]}
    if any(m.get("id") == meal["id"] for _, m in nutrition.meals_in(data)):
        return 409, {"error": "Идентификатор записи уже занят."}
    nutrition.assert_food_available(data, meal)
    previous = deepcopy(data)
    data.setdefault("meals", []).append(meal)
    nutrition.link_new_meal(data, meal, body.get("linkDoseId"))
    card = nutrition.remember_new_card(data, meal)
    nutrition.version_targets(data, previous)
    if preference is not None:
        was_saved = target_for(previous, "preference", card["_cardId"])
        if was_saved and (card["_cardId"] != preference.get("targetId") or card["_foodVersion"] != preference.get("version")):
            return 409, {"error": "Карточка уже существует или изменена. Выберите её из поиска и повторите сохранение."}
        if not was_saved and ("targetId" in preference or "version" in preference):
            return 409, {"error": CONFLICT}
        proposal = preference_preview(card, preference.get("changes"), preference["reason"])
        proposal_id = body["operationId"]
        if db.execute("SELECT 1 FROM food_proposal WHERE who=? AND id=?", (who, proposal_id)).fetchone():
            return 409, {"error": "ID предложения уже использован."}
        store_proposal(db, who, proposal_id, signature, proposal)
    write_state(db, who, current["rev"] + 1, data)
    db.execute("INSERT INTO food_operation VALUES (?,?,?)", (who, body["operationId"], signature))
    db.commit()
    return 201, {"id": meal["id"]}


CONFLICT = "Запись изменилась или была удалена. Сверьте данные и отправьте новое предложение."


def target_for(data, kind, ident):
    collection, key = ("meals", "id") if kind == "meal" else ("products", "_cardId")
    return next((row for row in data.get(collection, []) if isinstance(row, dict) and row.get(key) == ident), None)


def matches_card(data, card):
    def matches(other):
        if card.get("code") and other.get("code"):
            return card["code"] == other["code"]
        return card["name"].strip().casefold() == str(other.get("name", "")).strip().casefold()
    return any(isinstance(old, dict) and matches(old) for old in data.get("products", []))


def apply_meal_change(data, target, updated):
    nutrition.assert_food_available(data, target)
    nutrition.assert_food_available(data, updated)
    nutrition.move_meal_links(data, target, updated)
    data["meals"][data["meals"].index(target)] = updated
    if any(row.get("mealId") == updated.get("id") and row.get("productSnapshot") for row in data.get("supps", [])):
        data["supps"] = nutrition.daily_calculation("syncSupplementMeal", {"state": data, "meal": updated})


def proposal_deltas(data, target, updated):
    preview = deepcopy(data)
    apply_meal_change(preview, target, updated)
    changes = []
    for day in sorted({target["date"][:10], updated["date"][:10]}):
        before, after = (nutrition.daily_calculation("day", {"state": s, "day": day, "entity": "", "scale": []})
                         for s in (data, preview))
        changes.append({"day": day, "change": [b-a for a, b in zip(before["known"], after["known"])],
                        "missingBefore": before["missing"], "missingAfter": after["missing"]})
    return changes


def same_day_changes(old, new):
    for a, b in zip(old, new, strict=True):
        if any(not math.isclose(x, y, abs_tol=1e-8) for x, y in zip(a["change"], b["change"])):
            return False
        for i in range(4):
            if a["missingAfter"][i] - a["missingBefore"][i] != b["missingAfter"][i] - b["missingBefore"][i]:
                return False
    return True


def preference_preview(target, change, reason, *, new_card=False):
    nutrition.validate_preference(target, change)
    before = nutrition.public_card(target)
    if before.get("preferred") == change:
        raise nutrition.BadPortion("Эта настройка уже сохранена.")
    return {"kind": "preference", "targetId": before.get("id"), "version": before.get("version"),
            "reason": reason.strip(), "changes": change, "before": None if new_card else before,
            "after": {**before, "preferred": change}}


def store_proposal(db, who, ident, signature, proposal):
    proposal["createdAt"] = datetime.now().isoformat(timespec="seconds")
    db.execute("INSERT INTO food_proposal VALUES (?,?,?,?,?)", (who, ident, signature, "pending", json.dumps(proposal)))


def create_proposal(db, who, body):
    if not isinstance(body, dict) or set(body) - {"kind", "operationId", "reason", "targetId", "version", "card", "changes"}:
        raise nutrition.BadPortion("Недопустимые поля предложения.")
    kind, ident, reason = (body.get(k) for k in ("kind", "operationId", "reason"))
    try:
        if not isinstance(ident, str) or str(UUID(ident)) != ident:
            raise ValueError
    except ValueError:
        raise nutrition.BadPortion("Нужен UUID операции.") from None
    if kind not in ("meal", "preference") or not nutrition.safe_text(reason, 500) or not reason.strip():
        raise nutrition.BadPortion("Выберите вид изменения и укажите причину.")
    target_id, change = body.get("targetId"), body.get("changes")
    new_card = "card" in body
    if new_card and (kind != "preference" or "targetId" in body or "version" in body):
        raise nutrition.BadPortion("Новая карточка не может заменять существующую.")
    if not new_card and (not nutrition.safe_text(target_id, 160) or not target_id or not nutrition.safe_text(body.get("version"), 64)):
        raise nutrition.BadPortion("Заново выберите запись из дневника.")
    db.execute("BEGIN IMMEDIATE")
    sig = nutrition.operation_signature(body)
    receipt = db.execute("SELECT signature FROM food_proposal WHERE who=? AND id=?", (who, ident)).fetchone()
    if receipt:
        return (200, {"id": ident}) if receipt[0] == sig else (409, {"error": "ID предложения уже использован."})
    current = read_state(db, who)
    data = current["data"]
    target = nutrition.proposed_card(body["card"]) if new_card else target_for(data, kind, target_id)
    if target is None:
        return 404, {"error": CONFLICT}
    nutrition.assert_food_available(data, target)
    if (new_card and matches_card(data, target)) or (not new_card and target["_foodVersion"] != body["version"]):
        return 409, {"error": CONFLICT}
    proposal = {"kind": kind, "targetId": target_id, "version": body.get("version"), "reason": reason.strip(), "changes": change}
    if kind == "meal":
        updated = nutrition.corrected_meal(target, change)
        before, after = (nutrition.public_meal(row, 0) for row in (target, updated))
        if before == after:
            raise nutrition.BadPortion("Предложение совпадает с сохранённой записью.")
        proposal.update(before=before, after=after, days=proposal_deltas(data, target, updated))
    else:
        proposal = preference_preview(target, change, reason, new_card=new_card)
    store_proposal(db, who, ident, sig, proposal)
    write_state(db, who, current["rev"] + 1, data)
    db.commit()
    return 201, {"id": ident}


def decide_proposal(db, who, body):
    if not isinstance(body, dict) or set(body) != {"id", "decision"} or body["decision"] not in ("approve", "reject") or not isinstance(body["id"], str):
        raise nutrition.BadPortion("Выберите предложение и действие.")
    ident = body["id"]
    status = "approved" if body["decision"] == "approve" else "rejected"
    db.execute("BEGIN IMMEDIATE")
    row = db.execute("SELECT status, body FROM food_proposal WHERE who=? AND id=?", (who, ident)).fetchone()
    if not row:
        return 404, {"error": "Предложение не найдено."}
    receipt = {"id": ident, "status": status}
    if row[0] != "pending":
        return (200, receipt) if row[0] == status else (409, {"error": "По предложению уже принято решение."})
    proposal = json.loads(row[1])
    current = read_state(db, who)
    data = current["data"]
    if status == "approved":
        previous = deepcopy(data)
        target = target_for(data, proposal["kind"], proposal["targetId"]) if proposal["targetId"] else None
        if proposal["targetId"]:
            if target is None or target["_foodVersion"] != proposal["version"]:
                return 409, {"error": CONFLICT}
            nutrition.assert_food_available(data, target)
            if proposal["kind"] == "meal":
                updated = nutrition.corrected_meal(target, proposal["changes"])
                days = proposal_deltas(data, target, updated)
                if not same_day_changes(proposal["days"], days):
                    return 409, {"error": CONFLICT}
                proposal["days"] = days
                apply_meal_change(data, target, updated)
            else:
                target["preferred"] = proposal["changes"]
        else:
            nutrition.assert_food_available(data, proposal["after"])
            if matches_card(data, proposal["after"]):
                return 409, {"error": CONFLICT}
            data.setdefault("products", []).insert(0, dict(proposal["after"]))
        nutrition.version_targets(data, previous)
    proposal["decidedAt"] = datetime.now().isoformat(timespec="seconds")
    db.execute("UPDATE food_proposal SET status=?,body=? WHERE who=? AND id=?", (status, json.dumps(proposal), who, ident))
    write_state(db, who, current["rev"] + 1, data)
    db.commit()
    return 200, receipt


def profile_scale_rows(settings, who):
    entity, shared = measurements.scale_binding(settings, who)
    if shared:
        return [r for r in measurements.readings(DATA / "sport.db", who) if r["entity"] != entity]
    return measurements.profile_readings(DATA / "sport.db", who, entity, core)


def proposal_visible(data, proposal):
    target = target_for(data, proposal["kind"], proposal.get("targetId"))
    return all(nutrition.food_visible(data, item) for item in (target, proposal.get("before"), proposal.get("after")))


def health_confirmation_visible(db, who, body, settings):
    if not isinstance(body, dict) or set(body) not in ({"confirmReading", "date"}, {"confirmSleep", "date"}):
        return True
    action = "confirmSleep" if "confirmSleep" in body else "confirmReading"
    for metric, (_, _, _, pending) in health_sensors.grants(db, who, settings).items():
        if not pending or json.loads(pending).get("id") != body[action] or (action == "confirmSleep" and metric != "sleep"):
            continue
        visibility = read_state(db, who)["data"].get("profile", {}).get("visibility") or {}
        if metric == "sleep":
            return visibility.get("sleep") is not False
        return visibility.get("activity") is not False and (visibility.get("dailyMetrics") or {}).get(metric) is not False
    return True  # Unknown or stale candidates are rejected by health_sensors.update.


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, value, mime="application/json"):
        raw = json.dumps(value, allow_nan=False).encode() if mime == "application/json" else value
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "private, max-age=86400" if mime == "image/jpeg" else "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def nutrition_request(self, url, who, settings):
        parts = url.path.strip("/").split("/")
        query = parse_qs(url.query, keep_blank_values=True)
        if query and (parts != ["nutrition", "cards"] or set(query) - {"q"}):
            return self.reply(400, {})
        if self.command == "POST":
            if parts not in (["nutrition", "meals"], ["nutrition", "proposals"]):
                return self.reply(405, {})
            return self.food_post(who, append_meal if parts[1] == "meals" else create_proposal)
        if parts == ["nutrition", "context"]:
            now = datetime.now().astimezone()
            with closing(open_diary()) as db:
                enabled = nutrition.protein_enabled(read_state(db, who)["data"])
            return self.reply(200, {"today": now.date().isoformat(), "zone": now.tzname(), "proteinEnabled": enabled})
        with closing(open_diary()) as db:
            state = (profile_with_health(db, who, settings) if len(parts) == 3 and parts[1] == "days"
                     else read_state(db, who))["data"]
        if parts == ["nutrition", "cards"]:
            cards = nutrition.personal_cards(state)
            q = query.get("q", [""])[0].strip()[:100]
            if q:
                cards = food_catalog.search_cards(q, cards)
            return self.reply(200, cards)
        if len(parts) == 3 and parts[1] == "meals":
            ident = unquote(parts[2])
            for i, item in nutrition.meals_in(state):
                if item.get("id") == ident and nutrition.food_visible(state, item):
                    return self.reply(200, nutrition.public_meal(item, i))
            return self.reply(404, {})
        if len(parts) == 3 and parts[1] == "protein-recipe":
            day = parts[2]
            if not nutrition.valid_day(day):
                return self.reply(400, {})
            return self.reply(200, nutrition.daily_calculation("proteinRecipe", {"state": state, "day": day}))
        if len(parts) == 3 and parts[1] == "protein-doses":
            day = parts[2]
            if not nutrition.valid_day(day):
                return self.reply(400, {})
            return self.reply(200, [candidate for _, candidate in nutrition.available_protein_doses(state, day)])
        if len(parts) == 3 and parts[1] == "days":
            day = parts[2]
            if not nutrition.valid_day(day):
                return self.reply(400, {})
            entity, _ = measurements.scale_binding(settings, who)
            result = nutrition.daily_calculation("day", {"state": state, "day": day, "entity": entity,
                                                       "scale": profile_scale_rows(settings, who)})
            rows = [(i,m) for i,m in nutrition.meals_in(state)
                    if str(m.get("date", ""))[:10] == day and nutrition.food_visible(state, m)]
            totals = nutrition.daily_calculation("mealTotals", [m for _,m in rows]) if rows else []
            result["meals"] = sorted((nutrition.public_meal(m, i, nut) for (i,m),nut in zip(rows, totals)),
                                     key=lambda m: m["date"])
            return self.reply(200, result)
        return self.reply(404, {})

    def food_post(self, who, operation):
        if self.headers.get("Content-Type") != "application/json":
            return self.reply(415, {})
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 8192:
            return self.reply(413, {})
        try:
            body = json.loads(self.rfile.read(size))
            with closing(open_diary()) as db:
                return self.reply(*operation(db, who, body))
        except (nutrition.BadPortion, json.JSONDecodeError, UnicodeDecodeError) as exc:
            return self.reply(400, {"error": str(exc) if isinstance(exc, nutrition.BadPortion) else "Некорректная запись."})

    def health_request(self, who, settings, user_id):
        with closing(open_diary()) as db:
            if self.command == "POST":
                if settings.get(who + "_user") != user_id:
                    return self.reply(403, {})
                if self.headers.get("Content-Type") != "application/json":
                    return self.reply(415, {})
                size = int(self.headers.get("Content-Length") or 0)
                if not 0 < size <= 8192:
                    return self.reply(413, {})
                try:
                    body = json.loads(self.rfile.read(size))
                except (ValueError, UnicodeDecodeError):
                    return self.reply(400, {})
                if isinstance(body, dict) and set(body) == {"refresh"} and body["refresh"] is True:
                    health_sensors.refresh(db, who, options, core, diary_zone())
                else:
                    with db:
                        db.execute("BEGIN IMMEDIATE")
                        settings = options()
                        if who not in allowed_profiles(settings, user_id) or settings.get(who + "_user") != user_id:
                            return self.reply(403, {})
                        if not health_confirmation_visible(db, who, body, settings):
                            return self.reply(400, {"error": "Этот показатель отключён в настройках профиля. Включите его перед записью."})
                        status = health_sensors.update(db, who, body, settings, diary_zone())
                    if status != 200:
                        return self.reply(status, {"error": "Предложение уже изменилось." if status == 409
                                               else "Проверьте выбранные показатели и дату измерения."})
                settings = options()
                if who not in allowed_profiles(settings, user_id):
                    return self.reply(403, {})
            return self.reply(200, health_sensors.snapshot(db, who, settings, settings.get(who + "_user") == user_id))

    def handle_request(self):
        if self.client_address[0] not in ("172.30.32.2", "127.0.0.1"):
            return self.reply(403, {})
        url = urlsplit(self.path)
        who = url.path.split("/")[-1]
        if url.path in ("/", "/profiles", "/food") or url.path.startswith(("/profile/", "/weight/", "/weights/", "/scale-info/", "/nutrition/", "/proposals/", "/health/")):
            settings = options()
            user_id = self.headers.get("X-Remote-User-Id") if self.client_address[0] == "172.30.32.2" else None
            allowed = allowed_profiles(settings, user_id)
            assistant = assistant_profile(settings, user_id)
            if url.path.startswith("/health/"):
                if url.path != "/health/" + who or who not in allowed:
                    return self.reply(403, {})
                if url.query:
                    return self.reply(400, {})
                return self.health_request(who, settings, user_id)
            if url.path.startswith("/proposals/"):
                if who not in allowed or not user_id or settings.get(who + "_user") != user_id or url.path != "/proposals/" + who:
                    return self.reply(403, {})
                if self.command == "POST":
                    return self.food_post(who, decide_proposal)
                with closing(open_diary()) as db:
                    data = read_state(db, who)["data"]
                    rows = db.execute("""SELECT id,status,body FROM food_proposal WHERE who=?
                                      ORDER BY (status='pending') DESC,rowid DESC""", (who,))
                    proposals = [{**json.loads(body), "id": ident, "status": status} for ident, status, body in rows]
                    return self.reply(200, [proposal for proposal in proposals if proposal_visible(data, proposal)])
            if url.path.startswith("/nutrition/"):
                if not assistant:
                    return self.reply(403, {})
                return self.nutrition_request(url, assistant, settings)
            if url.path == "/" and assistant and self.command == "GET":
                return self.reply(200, (ROOT / "web" / "assistant.html").read_bytes(), "text/html; charset=utf-8")
            if (who in PROFILES and who not in allowed) or (url.path == "/food" and not (allowed or assistant)):
                return self.reply(403, {})
        if url.path == "/profiles" and self.command == "GET":
            return self.reply(200, [{"id": p, "name": profile_name(settings, p),
                                     "reviewProposals": settings.get(p+"_user") == user_id,
                                     "weightEntity": settings.get(p+"_weight") or "", "timeZone": diary_zone(),
                                     **({"scaleConflict": True} if measurements.scale_binding(settings, p)[1] else {})}
                                    for p in PROFILES
                                    if p in allowed])
        if url.path == "/weights/"+who and who in PROFILES and self.command == "GET":
            return self.reply(200, profile_scale_rows(settings, who))
        if url.path == "/scale-info/"+who and who in PROFILES and self.command == "GET":
            return self.reply(200, scale_features())
        if url.path == "/profile/" + who and who in ("person1", "person2"):
            with closing(open_diary()) as db:
                if self.command == "GET":
                    return self.reply(200, profile_with_health(db, who, settings))
                if self.headers.get("Content-Type") != "application/json":
                    return self.reply(415, {})
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8000000:
                    return self.reply(413, {})
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or not isinstance(body.get("data"), dict) or type(body.get("rev")) is not int:
                    return self.reply(400, {})
                profile = body["data"].get("profile", {})
                if not isinstance(profile, dict):
                    return self.reply(400, {})
                notes = profile.get("exerciseNotes", {})
                if not isinstance(notes, dict) or any(
                    not key.startswith("exercise:") or not isinstance(value, str) or len(value) > 500
                    for key, value in notes.items()
                ):
                    return self.reply(400, {})
                rev = save(db, who, body)
                db.commit()
                return self.reply(200 if rev else 409, {"rev": rev, "diaryStartedOn": body["data"].get("diaryStartedOn")})
        if self.command != "GET":
            return self.reply(405, {})
        if url.path == "/weight/" + who and who in ("person1", "person2"):
            return self.reply(200, weight(who))
        if url.path == "/food":
            q = parse_qs(url.query).get("q", [""])[0].strip()[:100]
            if parse_qs(url.query).get("source") == ["catalog"]:
                return self.reply(200, catalog.lookup(q) if len(q) >= 2 else {"status": "ready", "products": []})
            if len(q) < 2:
                return self.reply(200, [])
            return self.reply(*online_food(q))
        if url.path == "/catalog.js":
            script = "const exerciseCatalog = " + json.dumps(CATALOG) + "; const exercisePhotoBase = 'photos/';"
            return self.reply(200, script.encode(), "text/javascript")
        if url.path == "/food-words.js":
            words = (ROOT / "web" / "food-words.json").read_text(encoding="utf8")
            return self.reply(200, ("const foodWords = " + words + ";").encode(), "text/javascript")
        if url.path.startswith("/photos/"):
            name = url.path.removeprefix("/photos/")
            if name not in PHOTO_PATHS:
                return self.reply(404, {})
            photo = ROOT / "web" / "photos" / name
            if photo.is_file():
                return self.reply(200, photo.read_bytes(), "image/jpeg")
            # Running the Python server directly, outside the prebuilt image.
            self.send_response(302)
            self.send_header("Location", PHOTO_SOURCE + name)
            self.end_headers()
            return
        static = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js","text/javascript"),
                  "/style.css": ("style.css","text/css"), "/logic.js": ("logic.js","text/javascript"),
                  "/visibility.js": ("visibility.js","text/javascript"),
                  "/foods.js": ("foods.js","text/javascript"), "/reports.js": ("reports.js","text/javascript"),
                  "/portions.js": ("portions.js","text/javascript"), "/assistant.js": ("assistant.js","text/javascript"),
                  "/report-view.js": ("report-view.js","text/javascript"),
                  "/supplement-products.js": ("supplement-products.js","text/javascript"), "/supplement-view.js": ("supplement-view.js","text/javascript"),
                  "/goals.js": ("goals.js","text/javascript"), "/goals-view.js": ("goals-view.js","text/javascript"),
                  "/health.js": ("health.js","text/javascript"), "/health-view.js": ("health-view.js","text/javascript"),
                  "/health.css": ("health.css","text/css")}
        if url.path in static:
            name, mime = static[url.path]
            return self.reply(200, (ROOT / "web" / name).read_bytes(), mime)
        return self.reply(404, {})

    def do_GET(self):
        try:
            self.handle_request()
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError):
            self.reply(503, {"error": "Данные временно недоступны"})

    do_POST = do_GET


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    Thread(target=catalog.prepare,daemon=True).start()
    Thread(target=measurements.poll,args=(Event(), DATA/"sport.db",PROFILES,options,core),daemon=True).start()
    Thread(target=health_sensors.poll,args=(Event(),open_diary,options,core,diary_zone),daemon=True).start()
    ThreadingHTTPServer((os.environ.get("SPORT_BIND", "0.0.0.0"), int(os.environ.get("SPORT_PORT","8099"))), Handler).serve_forever()
