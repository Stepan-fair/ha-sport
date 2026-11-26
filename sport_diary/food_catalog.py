"""Build and search a local index of the versioned Lethio Open Food Facts export."""
import csv
import gzip
import io
import json
import logging
import math
import os
import re
import socket
import sqlite3
import ssl
import tempfile
import time
from contextlib import closing
from functools import lru_cache
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import zlib

ASSET = "https://github.com/TerjeRu/lethio-food-db/releases/download/off-derived-build19/lethio-off-derived-build19.csv.gz"
FILENAME = "food-build19.sqlite"
EXPECTED = 520432
NUTRIENTS = ("kcal_100g", "protein_100g", "fat_100g", "carbs_100g")
HEADERS = {"User-Agent": "SportDiary/0.6.0 (+https://github.com/Stepan-fair/ha-sport/issues)"}
BARCODE = re.compile(r"[0-9]{8,14}")
DOWNLOAD_ERRORS = (OSError, EOFError, HTTPException, ValueError, csv.Error, sqlite3.Error, zlib.error)


def failure(error):
    if isinstance(error, HTTPError):
        return {429: "rate_limit", 403: "blocked"}.get(error.code, "http_" + str(error.code))
    if isinstance(error, URLError):
        error = error.reason
    if isinstance(error, socket.gaierror):
        return "dns"
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, ssl.SSLError):
        return "tls"
    if isinstance(error, (ValueError, EOFError, csv.Error, gzip.BadGzipFile, zlib.error)):
        return "bad_data"
    return "unavailable"


def fold(text):
    return text.casefold().replace("ё", "е")


@lru_cache(maxsize=1)
def word_groups():
    groups = json.loads((Path(__file__).parent / "web" / "food-words.json").read_text(encoding="utf-8"))
    return {word: group for group in groups for word in group}


STOP_WORDS = {"и", "с", "со", "на", "по", "из", "для", "жирности"}
UNITS = {"kg": "кг", "ml": "мл", "l": "л", "g": "г", "гр": "г"}


def food_tokens(text):
    def quantity(match):
        amount, unit = match.groups()
        unit = UNITS.get(unit, unit)
        value = float(amount)
        if unit in ("кг", "л"):
            value = round(value * 1000, 3)
            unit = "г" if unit == "кг" else "мл"
        return f"{value:g}{unit}"

    text = re.sub(r"(?<=\d),(?=\d)", ".", fold(text))
    text = re.sub(r"(\d+(?:\.\d+)?)\s*(%|кг|гр|мл|г|л|kg|ml|g|l)(?![^\W\d_])", quantity, text)
    return [w for w in re.findall(r"\d+(?:\.\d+)?(?:%|г|мл)?|[^\W\d_]+", text) if w not in STOP_WORDS]


def one_edit(a, b):
    if min(len(a), len(b)) < 4 or abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    i = next((index for index, (x, y) in enumerate(zip(a, b)) if x != y), len(a))
    if len(a) != len(b):
        return a[i:] == b[i+1:]
    return a[i+1:] == b[i+1:] or (a[i:i+2] == b[i:i+2][::-1] and a[i+2:] == b[i+2:])


def term_score(word, candidate):
    if word == candidate:
        return 6
    if word[0].isdigit():
        return 5 if candidate == word + "%" else 0
    groups = word_groups()
    if word in groups and candidate in groups[word]:
        return 5
    if len(word) >= 2 and candidate.startswith(word):
        return 4
    if one_edit(word, candidate):
        return 2
    if candidate in groups and one_edit(word, groups[candidate][0]):
        return 1
    return 0


def search_cards(query, cards):
    """Search profile-owned cards without exposing another profile's history."""
    query = query.strip()
    cards = [c for c in cards if isinstance(c, dict) and c.get("name") and not c.get("oneOff")]
    if BARCODE.fullmatch(query):
        return [card for card in cards if str(card.get("code", "")) == query]
    words = food_tokens(query)
    hits = []
    for card in cards:
        tokens = food_tokens(" ".join(str(card.get(k) or "") for k in ("name", "aliases", "quantity")))
        scores = [max((term_score(word, token) for token in tokens), default=0) for word in words]
        if scores and all(scores):
            hits.append((sum(scores), card))
    return [card for _, card in sorted(hits, key=lambda hit: hit[0], reverse=True)]


def name_match(db, word):
    groups = word_groups()
    variants = set(groups.get(word, [word]))
    if word not in groups and len(word) >= 4:
        for alias, group in groups.items():
            if one_edit(word, alias):
                variants.update(group)
        # A bounded vocabulary lookup also covers misspellings of unknown brands.
        prefix = word[:2]
        nearby = db.execute("SELECT term FROM catalogue_terms WHERE term >= ? AND term < ? LIMIT 600",
                            (prefix, prefix + "\U0010ffff"))
        variants.update(term for term, in nearby if one_edit(word, term))
    return "(" + " OR ".join('"' + v + '"*' for v in sorted(variants)) + ")"


def build(archive, target, expected=EXPECTED):
    # A failed download, import or restart must never expose a partial index.
    with tempfile.TemporaryDirectory(dir=target.parent) as staging:
        path = Path(staging) / "index.sqlite"
        with closing(sqlite3.connect(path)) as db, gzip.GzipFile(fileobj=archive) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
            db.executescript("""
                CREATE TABLE foods(name TEXT, code TEXT, kcal REAL, protein REAL, fat REAL, carbs REAL, fiber REAL, local INTEGER);
                CREATE TABLE codes(code TEXT PRIMARY KEY, food INTEGER) WITHOUT ROWID;
                CREATE VIRTUAL TABLE names USING fts5(words, content='');
            """)
            rows = csv.DictReader(stream)
            required = {"name", "brand", "barcode", "barcodes", "country", *NUTRIENTS}
            if not required.issubset(rows.fieldnames or []):
                raise ValueError("Unexpected catalogue header")
            count = 0
            for count, row in enumerate(rows, 1):
                if count > expected or None in row or any(row[k] is None for k in required):
                    raise ValueError("Unexpected catalogue length or row")
                name, brand = row["name"].strip(), row["brand"].strip()
                title = f"{name} · {brand}" if brand and fold(brand) not in fold(name) else name
                codes = list(dict.fromkeys(filter(BARCODE.fullmatch, [row["barcode"], *row["barcodes"].split(";")])))
                nut = [float(row[key]) if row.get(key) else None for key in (*NUTRIENTS, "fiber_100g")]
                if not name or any(n is not None and (not math.isfinite(n) or n < 0) for n in nut):
                    raise ValueError("Invalid catalogue record")
                db.execute("INSERT INTO foods VALUES (?,?,?,?,?,?,?,?)",
                           (title, codes[0] if codes else "", *nut, row["country"].lower() == "ru"))
                db.executemany("INSERT INTO codes VALUES (?,?)", ((code, count) for code in codes))
                db.execute("INSERT INTO names(rowid,words) VALUES (?,?)", (count, fold(title)))
            if count != expected:
                raise ValueError("Incomplete catalogue")
            db.execute("INSERT INTO names(names) VALUES ('optimize')")
            db.commit()
        os.replace(path, target)


def has_fiber_column(db):
    return any(column[1] == "fiber" for column in db.execute("PRAGMA table_info(foods)"))


def current_index(path):
    if not path.is_file():
        return False
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            return has_fiber_column(db)
    except sqlite3.Error:
        return False


def install(target):
    if current_index(target):
        return
    with tempfile.TemporaryFile(dir=target.parent) as archive:
        with urlopen(Request(ASSET, headers=HEADERS), timeout=30) as response:
            while chunk := response.read(256 * 1024):
                if archive.tell() + len(chunk) > 32 * 1024 * 1024:
                    raise ValueError("Unexpected catalogue download size")
                archive.write(chunk)
        archive.seek(0)
        build(archive, target)


class Catalog:
    def __init__(self, bundled, cached):
        self.bundled, self.cached = bundled, cached
        self.prepared = None
        self.status = "loading"
        self.reason = ""

    def path(self):
        if self.prepared and self.prepared.is_file():
            return self.prepared
        return self.bundled if self.bundled.is_file() else self.cached

    def prepare(self):
        for candidate in (self.bundled, self.cached):
            if current_index(candidate):
                self.prepared = candidate
                return
        delay = 60
        while True:
            self.status = "loading"
            try:
                install(self.cached)
                self.prepared = self.cached
                return
            except DOWNLOAD_ERRORS as error:
                self.reason = failure(error)
                self.status = "unavailable"
                logging.warning("Food catalogue download: %s; retry in %s s", self.reason, delay)
                time.sleep(delay)
                delay = min(delay * 2, 3600)

    def lookup(self, query):
        path = self.path()
        if not path.is_file():
            return {"status": self.status, "reason": self.reason, "products": []}
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            # Old indexes remain readable while the new index downloads and is built atomically.
            fiber = "f.fiber" if has_fiber_column(db) else "NULL"
            if BARCODE.fullmatch(query):
                rows = db.execute(f"SELECT f.name,c.code,{fiber},kcal,protein,fat,carbs FROM codes c JOIN foods f ON f.rowid=c.food WHERE c.code=?", (query,))
            else:
                tokens = food_tokens(query)
                numbers = [t for t in tokens if t[0].isdigit()]
                words = [t for t in tokens if not t[0].isdigit()]
                rows = []
                if tokens:
                    db.execute("CREATE VIRTUAL TABLE temp.catalogue_terms USING fts5vocab(main, names, row)")
                    if words:
                        match = " AND ".join(name_match(db, word) for word in words)
                    else:
                        # Preserve searches such as "5%" on the existing raw-text FTS index.
                        digits = re.findall(r"[0-9]+", query)
                        match = " AND ".join('"' + part + '"*' for part in digits)
                        if not match:
                            return {"status": "ready", "products": []}
                    sql = f"""SELECT f.name,f.code,{fiber},kcal,protein,fat,carbs FROM names
                             JOIN foods f ON f.rowid=names.rowid WHERE names MATCH ?"""
                    if numbers:
                        def matching_numbers(title):
                            tokens = food_tokens(title)
                            return all(any(term_score(n, token) for token in tokens) for n in numbers)
                        db.create_function("matching_numbers", 1, matching_numbers)
                        sql += " AND matching_numbers(f.name)"
                    rows = db.execute(sql + " ORDER BY f.local DESC, rank, f.rowid LIMIT 20", (match,))
            products = [{"name": name, "code": code, "nut": values, "unit": "г", "catalogItem": True,
                         **({"fiber": value} if value is not None else {})}
                        for name, code, value, *values in rows]
        return {"status": "ready", "products": products}


if __name__ == "__main__":
    try:
        install(Path(__file__).resolve().with_name(FILENAME))
    except DOWNLOAD_ERRORS as error:
        logging.warning("Food catalogue preload: %s; will retry after startup", failure(error))
