"""Local HA ingress application. Only the supervisor ingress proxy can reach its API."""
import json
import logging
from http.client import HTTPException
from contextlib import closing
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
import food_catalog
import nutrition
from datetime import datetime
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
    return measurements.reading(core("states/" + entity))


def read_state(db, who):
    row = db.execute("SELECT rev, body FROM profile WHERE who=?", (who,)).fetchone()
    return {"rev": row[0], "data": json.loads(row[1])} if row else {"rev": 0, "data": {}}


def write_state(db, who, rev, data):
    db.execute("INSERT OR REPLACE INTO profile VALUES (?,?,?)", (who, rev, json.dumps(data)))


def save(db, who, body):
    db.execute("BEGIN IMMEDIATE")
    old = read_state(db, who)
    if old["rev"] != body["rev"]:
        return None
    rev = old["rev"] + 1
    write_state(db, who, rev, body["data"])
    return rev


def open_diary():
    db = sqlite3.connect(DATA / "sport.db")
    db.execute("CREATE TABLE IF NOT EXISTS profile(who TEXT PRIMARY KEY,rev INTEGER,body TEXT)")
    return db


def append_meal(db, who, body):
    meal = nutrition.make_meal(body)
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
    data.setdefault("meals", []).append(meal)
    nutrition.remember_new_card(data, meal)
    write_state(db, who, current["rev"] + 1, data)
    db.execute("INSERT INTO food_operation VALUES (?,?,?)", (who, body["operationId"], signature))
    db.commit()
    return 201, {"id": meal["id"]}


def profile_scale_rows(settings, who):
    entity, shared = measurements.scale_binding(settings, who)
    if shared:
        return [r for r in measurements.readings(DATA / "sport.db", who) if r["entity"] != entity]
    return measurements.profile_readings(DATA / "sport.db", who, entity, core)


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
            if parts != ["nutrition", "meals"]:
                return self.reply(405, {})
            if self.headers.get("Content-Type") != "application/json":
                return self.reply(415, {})
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 8192:
                return self.reply(413, {})
            try:
                body = json.loads(self.rfile.read(size))
                with closing(open_diary()) as db:
                    return self.reply(*append_meal(db, who, body))
            except (nutrition.BadPortion, json.JSONDecodeError, UnicodeDecodeError) as exc:
                return self.reply(400, {"error": str(exc) if isinstance(exc, nutrition.BadPortion) else "Некорректная запись."})
        if parts == ["nutrition", "context"]:
            now = datetime.now().astimezone()
            return self.reply(200, {"today": now.date().isoformat(), "zone": now.tzname()})
        with closing(open_diary()) as db:
            state = read_state(db, who)["data"]
        if parts == ["nutrition", "cards"]:
            cards = nutrition.personal_cards(state)
            q = query.get("q", [""])[0].strip()[:100]
            if q:
                cards = food_catalog.search_cards(q, cards)
            return self.reply(200, cards)
        if len(parts) == 3 and parts[1] == "meals":
            ident = unquote(parts[2])
            for i, item in nutrition.meals_in(state):
                if (item.get("id") or f"legacy-{i}-{item.get('date', '')}") == ident:
                    return self.reply(200, nutrition.public_meal(item, i))
            return self.reply(404, {})
        if len(parts) == 3 and parts[1] == "days":
            day = parts[2]
            if not nutrition.valid_day(day):
                return self.reply(400, {})
            entity, _ = measurements.scale_binding(settings, who)
            result = nutrition.daily_calculation("day", {"state": state, "day": day, "entity": entity,
                                                       "scale": profile_scale_rows(settings, who)})
            result["meals"] = sorted((nutrition.public_meal(m, i) for i, m in nutrition.meals_in(state)
                                      if str(m.get("date", ""))[:10] == day), key=lambda m: m["date"])
            return self.reply(200, result)
        return self.reply(404, {})

    def handle_request(self):
        if self.client_address[0] not in ("172.30.32.2", "127.0.0.1"):
            return self.reply(403, {})
        url = urlsplit(self.path)
        who = url.path.split("/")[-1]
        if url.path in ("/", "/profiles", "/food") or url.path.startswith(("/profile/", "/weight/", "/weights/", "/scale-info/", "/nutrition/")):
            settings = options()
            user_id = self.headers.get("X-Remote-User-Id") if self.client_address[0] == "172.30.32.2" else None
            allowed = allowed_profiles(settings, user_id)
            assistant = assistant_profile(settings, user_id)
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
                                     "weightEntity": settings.get(p+"_weight") or "",
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
                    return self.reply(200, read_state(db, who))
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
                return self.reply(200 if rev else 409, {"rev": rev})
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
                  "/foods.js": ("foods.js","text/javascript"), "/reports.js": ("reports.js","text/javascript"),
                  "/portions.js": ("portions.js","text/javascript"), "/assistant.js": ("assistant.js","text/javascript"),
                  "/report-view.js": ("report-view.js","text/javascript")}
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
    ThreadingHTTPServer((os.environ.get("SPORT_BIND", "0.0.0.0"), int(os.environ.get("SPORT_PORT","8099"))), Handler).serve_forever()
