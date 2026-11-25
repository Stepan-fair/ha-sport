import json
import csv
import gzip
import socket
import ssl
import food_catalog
import tempfile
import io
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone, timedelta
import shutil
import measurements
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from threading import Thread
import unittest
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import urlencode, urlsplit, parse_qs
from urllib.error import HTTPError, URLError
import server


class Sport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.old = server.DATA
        server.DATA = Path(self.temp.name)
        self.addCleanup(setattr, server, "DATA", self.old)
        self.settings = {"person1_user": "u1", "person2_user": "u2", "person1_can_open_both": True,
                         "person1_name": "Первый", "person2_name": "Второй ❤️"}
        (server.DATA / "options.json").write_text(json.dumps(self.settings), encoding="utf8")

    def call(self, path, body=None, *, client="172.30.32.2", user="u1"):
        payload = json.dumps(body).encode() if body is not None else b""
        method = "POST" if body is not None else "GET"
        headers = f"{method} {path} HTTP/1.0\r\nX-Remote-User-Id: {user}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n"
        sock = MagicMock()
        sock.makefile.return_value = io.BytesIO(headers.encode() + payload)
        server.Handler(sock, (client, 12345), None)
        raw = b"".join(call.args[0] for call in sock.sendall.call_args_list)
        head, content = raw.split(b"\r\n\r\n", 1)
        return int(head.split()[1]), content

    def profile(self, who, update=None):
        code, result = self.call("/profile/" + who, update)
        if code != 200:
            raise HTTPError(who, code, "", {}, None)
        return json.loads(result)

    def test_isolation_conflict_and_restore(self):
        body = {"rev": 0, "data": {"workouts": [{"id": "first"}]}}
        self.assertEqual(self.profile("person1", body)["rev"], 1)
        self.assertEqual(self.call("/profile/person1", body)[0], 409)
        self.assertEqual(self.profile("person2")["data"], {})
        self.assertEqual(self.profile("person1")["data"], body["data"])

    def test_web_entry_points(self):
        for path in ["/", "/app.js", "/logic.js", "/catalog.js", "/foods.js", "/reports.js", "/report-view.js", "/style.css"]:
            self.assertEqual(self.call(path)[0], 200)
        self.assertEqual(self.call("/weight/person2"), (200, b"null"))

    def test_ingress_profile_permissions(self):
        settings = {**self.settings, "person1_weight": "sensor.test_first", "person2_weight": "input_number.test_second"}
        (server.DATA / "options.json").write_text(json.dumps(settings), encoding="utf8")
        with patch.object(server, "core", return_value={}):
            self.check_profile_permissions(settings)

    def test_food_text_barcode_and_unavailable_provider(self):
        path = "/food?" + urlencode({"q": "творог"})
        item = {"code": "4600000000008", "product_name_ru": "Творог"}
        with patch.object(server, "fetch", return_value={"products": [item]}) as fetch:
            self.assertEqual(self.call(path, user="other")[0], 403)
            fetch.assert_not_called()
            self.assertEqual(json.loads(self.call(path, user="u2")[1]), [item])
            query = parse_qs(urlsplit(fetch.call_args.args[0]).query)
            self.assertEqual(query["search_terms"], ["творог"])
            self.assertIn("product_name_ru", query["fields"][0])
        with patch.object(server, "fetch", return_value={"product": item}) as fetch:
            self.assertEqual(json.loads(self.call("/food?q=4600000000008")[1]), [item])
            self.assertIn("/api/v2/product/4600000000008.json", fetch.call_args.args[0])
        with patch.object(server, "fetch", side_effect=HTTPError("fixture", 404, "", {}, None)):
            self.assertEqual(self.call("/food?q=4600000000008"), (200, b"[]"))
        with patch.object(server, "fetch", side_effect=TimeoutError()):
            self.assertEqual(self.call(path), (504, b'{"reason": "timeout"}'))
        for error, reason, status in [
            (HTTPError("test", 429, "", {}, None), "rate_limit", 429),
            (HTTPError("test", 403, "", {}, None), "blocked", 502),
            (HTTPError("test", 502, "", {}, None), "http_502", 502),
            (URLError(socket.gaierror()), "dns", 502),
            (URLError(ssl.SSLError()), "tls", 502),
            (ValueError("not JSON"), "bad_data", 502)
        ]:
            with self.subTest(reason=reason), patch.object(server, "fetch", side_effect=error):
                code, reply = self.call(path)
                self.assertEqual((code, json.loads(reply)["reason"]), (status, reason))

    def test_catalog_offline_import_search_permissions_and_recovery(self):
        fields = ["name","brand","barcode","barcodes","country",*food_catalog.NUTRIENTS]
        raw = io.StringIO(newline="")
        writer = csv.writer(raw)
        writer.writerow(fields)
        writer.writerows([
            ["Йогурт с мёдом","Север","0012345678905","0012345678905;00001234","ru",110,7,2,16],
            ["Йогурт с медом","East","12345678","12345678","de",105,6,3,13],
            ["Творог мягкий","","23456789","","ru",90,10,0,""],
        ])
        packed = gzip.compress(raw.getvalue().encode())
        path = server.DATA / food_catalog.FILENAME
        cat = food_catalog.Catalog(server.DATA / "bundle.sqlite", path)
        def search(q, user="u1"):
            status, data = self.call("/food?" + urlencode({"source":"catalog", "q":q}),user=user)
            self.assertEqual(status, 200)
            return json.loads(data)
        with patch.object(server,"catalog",cat), patch.object(server, "fetch", side_effect=AssertionError("Online lookup")):
            self.assertEqual(search("творог")["status"], "loading")
            original = food_catalog.build
            with patch.object(food_catalog,"urlopen",side_effect=[URLError(socket.gaierror()),io.BytesIO(packed)]), \
                    patch.object(food_catalog,"build",wraps=lambda archive,target: original(archive,target,3)), \
                    patch.object(food_catalog.time,"sleep",side_effect=lambda delay: self.assertEqual(search("творог")["reason"],"dns")):
                cat.prepare()
            for user in ("u1","u2"):
                result = search("МЕД йог",user)["products"]
                self.assertEqual([p["code"] for p in result],["0012345678905","12345678"])
                self.assertEqual(search("00001234",user)["products"][0]["nut"],[110,7,2,16])
            self.assertEqual(search("0012345678905")["products"][0]["code"],"0012345678905")
            self.assertEqual(search("23456789")["products"][0]["nut"],[90,10,0,None])
            self.assertEqual(search("87654321"),{"status":"ready","products":[]})
            self.assertEqual(search('"" * OR')["products"],[])
            self.assertEqual(self.call("/food?q=test&source=catalog",user="other")[0],403)
            for bad, count in [(packed,4),(packed[:-6],3),(gzip.compress(b"wrong,header\n"),3)]:
                with self.assertRaises((ValueError,EOFError)):
                    food_catalog.build(io.BytesIO(bad),path,count)
                self.assertEqual(len(search("йогурт")["products"]),2)
            path.rename(cat.bundled)
            with patch.object(food_catalog,"urlopen",side_effect=AssertionError("Download on restart")):
                cat.prepare()
                self.assertEqual(len(search("йогурт")["products"]),2)

    def test_weight_entity_normalization(self):
        self.assertEqual(measurements.weight_entity("  input_number.scale_1 "), "input_number.scale_1")
        for invalid in ("person.someone", "Весы", "", None):
            self.assertEqual(measurements.weight_entity(invalid), "")

    def test_first_open_reads_configured_scale_before_poll_and_retains_it(self):
        settings = {**self.settings, "person2_weight": "input_number.weight_b"}
        sample = {"last_updated":"2020-01-02T10:00:00Z","state":"60","attributes":{"unit_of_measurement":"kg"}}
        with patch.object(server, "options", return_value=settings), patch.object(server, "core", return_value=sample) as core:
            saved = json.loads(self.call("/weights/person2", user="u2")[1])
            core.assert_called_once_with("states/input_number.weight_b")
            self.assertEqual([(row["kg"], row["source"]) for row in saved], [(60, "ha")])
            core.side_effect = TimeoutError()
            self.assertEqual(json.loads(self.call("/weights/person2", user="u2")[1]), saved)
            self.assertEqual(json.loads(self.call("/weights/person1")[1]), [])
            core.assert_called_once()

    def check_profile_permissions(self, settings):
        for user, permitted in [("u1", ["person1", "person2"]), ("u2", ["person2"]), ("other", []), ("", [])]:
            with self.subTest(user=user):
                profiles = json.loads(self.call("/profiles", user=user)[1])
                self.assertEqual([p["id"] for p in profiles], permitted)
                self.assertEqual([p["weightEntity"] for p in profiles], [settings[p + "_weight"] for p in permitted])
                if "person2" in permitted:
                    self.assertEqual(profiles[-1]["name"], "Второй ❤️")
                for who in server.PROFILES:
                    expected = 200 if who in permitted else 403
                    for route in ("profile", "weight", "weights"):
                        self.assertEqual(self.call(f"/{route}/{who}", user=user)[0], expected)
                    data = {"rev": 1 if user == "u2" else 0, "data": {"marker": user}}
                    self.assertEqual(self.call("/profile/" + who, data, user=user)[0], expected)
        self.assertEqual(self.profile("person1")["data"], {"marker": "u1"})
        self.assertEqual(self.profile("person2")["data"], {"marker": "u2"})

    def test_profile_access_after_upgrade_or_misconfiguration(self):
        def listed(settings, user):
            with patch.object(server, "options", return_value=settings):
                return [p["id"] for p in json.loads(self.call("/profiles", user=user)[1])]
        legacy = {"person1_user": "u1", "person2_user": "u2", "shared_diaries": True}
        self.assertEqual(listed(legacy, "u2"), ["person2"])
        self.assertEqual(listed({**legacy, "person1_can_open_both": False}, "u1"), ["person1"])
        self.assertEqual(listed({**self.settings, "person2_user": "u1"}, "u1"), [])
        self.assertEqual(listed({}, "u1"), [])
        self.assertEqual(self.call("/profile/person1", client="127.0.0.1", user="u2")[0], 403)

    def test_scale_poll_retains_infrequent_values_history_units_and_isolation(self):
        path=server.DATA/"sport.db"
        now=datetime(2026,6,15,tzinfo=timezone.utc)
        def sample(when,kg,unit="kg"):
            return {"entity_id":"sensor.scale","last_updated":when.isoformat(),"state":str(kg),
                    "attributes":{"unit_of_measurement":unit}}
        old=sample(now-timedelta(days=75),94000,"g")
        recent=sample(now-timedelta(days=2),200,"lb")
        api=lambda p: old if p.startswith("states/") else [[recent,sample(now,"unavailable")]]
        measurements.collect(path,"person1","sensor.scale",api,now)
        measurements.collect(path,"person1","sensor.scale",api,now)
        saved=json.loads(self.call("/weights/person1")[1])
        self.assertEqual([r["kg"] for r in saved],[94,90.718])
        self.assertEqual(json.loads(self.call("/weights/person2")[1]),[])
        measurements.collect(path,"person1","sensor.scale",lambda p:sample(now,"unknown") if p.startswith("states/") else [],now+timedelta(days=70))
        self.assertEqual(json.loads(self.call("/weights/person1")[1]),saved)
        self.profile("person1",{"rev":0,"data":{"weights":[{"kg":88,"source":"manual","date":now.isoformat()}]}})
        backup=server.DATA/"backup.db"
        shutil.copy2(path,backup)
        with tempfile.TemporaryDirectory() as restored,patch.object(server,"DATA",Path(restored)):
            shutil.copy2(backup,server.DATA/"sport.db")
            (server.DATA / "options.json").write_text(json.dumps(self.settings), encoding="utf8")
            self.assertEqual(json.loads(self.call("/weights/person1")[1]),saved)
            self.assertEqual(self.profile("person1")["data"]["weights"][0]["kg"],88)

    def test_current_measurement_survives_unavailable_recorder(self):
        now=datetime.now(timezone.utc)
        def core(path):
            if path.startswith("history/"):raise OSError("recorder unavailable")
            return {"state":"72.5","last_updated":now.isoformat(),"attributes":{"unit_of_measurement":"kg"}}
        with self.assertRaises(OSError):
            measurements.collect(server.DATA/"sport.db","person2","sensor.scale",core,now)
        self.assertEqual(json.loads(self.call("/weights/person2")[1])[0]["kg"],72.5)

    def test_scale_discovery_returns_capabilities_without_any_readings(self):
        kinds = ("weight", "stable", "unstable", "impedance", "removed", "signal")
        fields = [["Mi Scale V2", kind] for kind in (*kinds, "unrecognized")]
        response = io.BytesIO(json.dumps(fields).encode())
        with patch.dict(server.os.environ, {"SUPERVISOR_TOKEN": "fixture"}), patch.object(server, "urlopen", return_value=response):
            rows = server.scale_features()["sensors"]
        self.assertEqual(rows, [{"model": "Mi Scale V2", "kind": kind} for kind in kinds])

    def test_scale_inspection_and_shared_source(self):
        same={**self.settings, "person1_weight":"sensor.scale", "person2_weight":"sensor.scale"}
        with patch.object(server,"options",return_value=same), patch.object(server,"core") as core:
            self.assertTrue(json.loads(self.call("/profiles",user="u2")[1])[0]["scaleConflict"])
            self.assertEqual(self.call("/weight/person2",user="u2"),(200,b"null"))
            self.assertEqual(self.call("/weights/person2",user="u2"),(200,b"[]"))
            core.assert_not_called()
        with patch.object(server,"scale_features",return_value={"sensors":[{"kind":"weight","model":"Mi Scale"}]}) as discovery:
            self.assertEqual(self.call("/scale-info/person1",user="u2")[0],403)
            self.assertEqual(self.call("/scale-info/person2",user="other")[0],403)
            discovery.assert_not_called()
            self.assertEqual(self.call("/scale-info/person2",user="u2")[0],200)
        with closing(measurements.open_history(server.DATA/"sport.db")) as db, db:
            for who in server.PROFILES:
                db.execute("INSERT INTO scale VALUES(?,?,?,?)",(who,"sensor.shared","2026-01-01",70))
            db.execute("INSERT INTO scale VALUES(?,?,?,?)",("person1","sensor.personal","2026-01-01",60))
        self.assertEqual(len(measurements.readings(server.DATA/"sport.db","person1")),1)
        self.assertEqual(measurements.readings(server.DATA/"sport.db","person2"),[])

    def test_photo_routes(self):
        from unittest.mock import patch
        with patch.object(server, "ROOT", Path(self.temp.name)):
            name = next(iter(server.PHOTO_PATHS))
            self.assertEqual(self.call("/photos/" + name)[0], 302)
            target = server.ROOT / "web" / "photos" / name
            target.parent.mkdir(parents=True)
            target.write_bytes(b"photo-fixture")
            self.assertEqual(self.call("/photos/" + name), (200, b"photo-fixture"))
            self.assertEqual(self.call("/photos/nonexistent.jpg")[0], 404)

    def test_invalid_notes_and_shape_preserve_previous_state(self):
        initial = {"profile": {"exerciseNotes": {"exercise:жим": "Сиденье 2"}}}
        self.profile("person1", {"data":initial,"rev":0})
        for invalid in (["oops"], {}, {"rev":"1","data":initial},
                        {"rev":1,"data":{"profile":{"exerciseNotes":[]}}},
                        {"rev":1,"data":{"profile":{"exerciseNotes":{"exercise:жим":"x"*501}}}}):
            with self.subTest(invalid=invalid):
                self.assertEqual(self.call("/profile/person1",invalid)[0],400)
        self.assertEqual(self.profile("person1"), {"rev":1,"data":initial})

    def test_live_http_concurrent_writes_and_restart(self):
        class TestIngress(server.Handler):
            def handle_request(self):
                self.client_address = ("172.30.32.2", self.client_address[1])
                self.headers["X-Remote-User-Id"] = "u1"
                return super().handle_request()

        def start():
            http = server.ThreadingHTTPServer(("127.0.0.1",0),TestIngress)
            thread=Thread(target=http.serve_forever,daemon=True)
            thread.start()
            return http,"http://127.0.0.1:" + str(http.server_port)
        def post(value):
            data={"rev":0,"data":{"profile":{"exerciseNotes":{"exercise:тяга":value}}}}
            req=Request(base+"/profile/person1",json.dumps(data).encode(),{"Content-Type":"application/json"})
            try:
                with urlopen(req,timeout=5) as response:
                    return response.status,value
            except HTTPError as error:
                return error.code,value
        http,base=start()
        try:
            try:
                urlopen(base+"/",timeout=5).close()
            except URLError as error:
                if getattr(error.reason, "winerror", None) == 10013:
                    self.skipTest("Windows environment denies local TCP connections (10013)")
                raise
            with ThreadPoolExecutor(max_workers=2) as pool:
                results=dict(pool.map(post,["Сиденье 4","Сиденье 7"]))
            self.assertEqual(set(results),{200,409})
        finally:
            http.shutdown()
            http.server_close()

        http,base=start()
        try:
            with urlopen(base+"/profile/person1",timeout=5) as response:
                self.assertEqual(json.load(response)["data"]["profile"]["exerciseNotes"]["exercise:тяга"],results[200])
            with urlopen(base+"/profile/person2",timeout=5) as response:
                self.assertEqual(json.load(response)["data"],{})
        finally:
            http.shutdown()
            http.server_close()

    def test_concurrent_handlers_keep_winner_after_reopening_database(self):
        self.profile("person1")
        def update(value):
            body={"rev":0,"data":{"profile":{"exerciseNotes":{"exercise:тяга":value}}}}
            return self.call("/profile/person1",body)[0],value
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=dict(pool.map(update,["Сиденье 4","Сиденье 7"]))
        self.assertEqual(set(results),{200,409})
        self.assertEqual(self.profile("person1")["data"]["profile"]["exerciseNotes"]["exercise:тяга"],results[200])
        self.assertEqual(self.profile("person2"),{"rev":0,"data":{}})


if __name__ == "__main__":
    unittest.main()
