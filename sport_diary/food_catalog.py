"""Build and search a local index of the versioned Lethio Open Food Facts export."""
import csv
import gzip
import io
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
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import zlib

ASSET = "https://github.com/TerjeRu/lethio-food-db/releases/download/off-derived-build19/lethio-off-derived-build19.csv.gz"
FILENAME = "food-build19.sqlite"
EXPECTED = 520432
NUTRIENTS = ("kcal_100g", "protein_100g", "fat_100g", "carbs_100g")
HEADERS = {"User-Agent": "SportDiary/0.5.6 (+https://github.com/Stepan-fair/ha-sport/issues)"}
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


def build(archive, target, expected=EXPECTED):
    # A failed download, import or restart must never expose a partial index.
    with tempfile.TemporaryDirectory(dir=target.parent) as staging:
        path = Path(staging) / "index.sqlite"
        with closing(sqlite3.connect(path)) as db, gzip.GzipFile(fileobj=archive) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
            db.executescript("""
                CREATE TABLE foods(name TEXT, code TEXT, kcal REAL, protein REAL, fat REAL, carbs REAL, local INTEGER);
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
                nut = [float(row[key]) if row[key] else None for key in NUTRIENTS]
                if not name or any(n is not None and (not math.isfinite(n) or n < 0) for n in nut):
                    raise ValueError("Invalid catalogue record")
                db.execute("INSERT INTO foods VALUES (?,?,?,?,?,?,?)",
                           (title, codes[0] if codes else "", *nut, row["country"].lower() == "ru"))
                db.executemany("INSERT INTO codes VALUES (?,?)", ((code, count) for code in codes))
                db.execute("INSERT INTO names(rowid,words) VALUES (?,?)", (count, fold(title)))
            if count != expected:
                raise ValueError("Incomplete catalogue")
            db.execute("INSERT INTO names(names) VALUES ('optimize')")
            db.commit()
        os.replace(path, target)


def install(target):
    if target.is_file():
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
        self.status = "loading"
        self.reason = ""

    def path(self):
        return self.bundled if self.bundled.is_file() else self.cached

    def prepare(self):
        delay = 60
        while not self.path().is_file():
            self.status = "loading"
            try:
                install(self.cached)
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
            if BARCODE.fullmatch(query):
                rows = db.execute("SELECT f.name,c.code,kcal,protein,fat,carbs FROM codes c JOIN foods f ON f.rowid=c.food WHERE c.code=?", (query,))
            else:
                tokens = re.findall(r"[^\W_]+", fold(query))
                match = " AND ".join('"' + word + '"' + ("" if word.isdigit() else "*") for word in tokens)
                rows = []
                if match:
                    rows = db.execute("""SELECT f.name,f.code,kcal,protein,fat,carbs FROM names
                                     JOIN foods f ON f.rowid=names.rowid WHERE names MATCH ?
                                     ORDER BY f.local DESC, rank, f.rowid LIMIT 20""", (match,))
            products = [{"name": name, "code": code, "nut": values, "unit": "г", "catalogItem": True}
                        for name, code, *values in rows]
        return {"status": "ready", "products": products}


if __name__ == "__main__":
    try:
        install(Path(__file__).resolve().with_name(FILENAME))
    except DOWNLOAD_ERRORS as error:
        logging.warning("Food catalogue preload: %s; will retry after startup", failure(error))
