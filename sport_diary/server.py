"""Local HA ingress application. Only the supervisor ingress proxy can reach its API."""
import json
import logging
from http.client import HTTPException
from contextlib import closing
import os
import sqlite3
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs, urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from threading import Event, Thread
import measurements
import food_catalog
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
    fields = "code,product_name,product_name_ru,brands,nutriments,nutrition_data_per"
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


def core(path):
    return fetch("http://supervisor/core/api/" + path, {"Authorization": "Bearer " + os.environ["SUPERVISOR_TOKEN"]})


def weight(profile):
    entity = measurements.weight_entity(options().get(profile + "_weight"))
    if not entity:
        return None
    return measurements.reading(core("states/" + entity))


def read_state(db, who):
    row = db.execute("SELECT rev, body FROM profile WHERE who=?", (who,)).fetchone()
    return {"rev": row[0], "data": json.loads(row[1])} if row else {"rev": 0, "data": {}}


def save(db, who, body):
    db.execute("BEGIN IMMEDIATE")
    old = read_state(db, who)
    if old["rev"] != body["rev"]:
        return None
    rev = old["rev"] + 1
    db.execute("INSERT OR REPLACE INTO profile VALUES (?,?,?)", (who, rev, json.dumps(body["data"])))
    return rev


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

    def handle_request(self):
        if self.client_address[0] not in ("172.30.32.2", "127.0.0.1"):
            return self.reply(403, {})
        url = urlsplit(self.path)
        who = url.path.split("/")[-1]
        if url.path == "/profiles" or url.path.startswith(("/profile/", "/weight/", "/weights/", "/food")):
            settings = options()
            user_id = self.headers.get("X-Remote-User-Id") if self.client_address[0] == "172.30.32.2" else None
            allowed = allowed_profiles(settings, user_id)
            if (who in PROFILES and who not in allowed) or (url.path == "/food" and not allowed):
                return self.reply(403, {})
        if url.path == "/profiles" and self.command == "GET":
            return self.reply(200, [{"id": p, "name": settings.get(p+"_name") or ("Профиль "+str(i+1)),
                                     "weightEntity": settings.get(p+"_weight") or ""}
                                    for i,p in enumerate(PROFILES)
                                    if p in allowed])
        if url.path == "/weights/"+who and who in PROFILES and self.command == "GET":
            return self.reply(200, measurements.profile_readings(DATA/"sport.db", who, settings.get(who+"_weight"), core))
        if url.path == "/profile/" + who and who in ("person1", "person2"):
            with closing(sqlite3.connect(DATA / "sport.db")) as db:
                db.execute("CREATE TABLE IF NOT EXISTS profile(who TEXT PRIMARY KEY,rev INTEGER,body TEXT)")
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
                  "/foods.js": ("foods.js","text/javascript")}
        if url.path in static:
            name, mime = static[url.path]
            return self.reply(200, (ROOT / "web" / name).read_bytes(), mime)
        return self.reply(404, {})

    def do_GET(self):
        try:
            self.handle_request()
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
            self.reply(503, {"error": "Данные временно недоступны"})

    do_POST = do_GET


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    Thread(target=catalog.prepare,daemon=True).start()
    Thread(target=measurements.poll,args=(Event(), DATA/"sport.db",PROFILES,options,core),daemon=True).start()
    ThreadingHTTPServer((os.environ.get("SPORT_BIND", "0.0.0.0"), int(os.environ.get("SPORT_PORT","8099"))), Handler).serve_forever()
