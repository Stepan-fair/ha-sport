import json
import tempfile
import io
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone, timedelta
import shutil
import measurements
from concurrent.futures import ThreadPoolExecutor
from threading import Thread
import unittest
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError
import server


class Sport(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.old = server.DATA
        server.DATA = Path(self.temp.name)
        self.addCleanup(setattr, server, "DATA", self.old)
    def call(self, path, body=None, *, client="127.0.0.1", user=""):
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
        for path in ["/", "/app.js", "/logic.js", "/catalog.js", "/style.css"]:
            self.assertEqual(self.call(path)[0], 200)
        self.assertEqual(self.call("/weight/person2"), (200, b"null"))

    def test_ingress_profile_permissions(self):
        proxied={"client":"172.30.32.2","user":"u1"}
        self.assertEqual(self.call("/profile/person1",**proxied)[0],403)
        with patch.object(server,"options",return_value={"person1_user":"u1","person2_user":"u2"}):
            self.assertEqual(json.loads(self.call("/profiles",**proxied)[1])[0]["id"],"person1")
            self.assertEqual(self.call("/profile/person1",**proxied)[0],200)
            self.assertEqual(self.call("/weights/person2",**proxied)[0],403)
            self.assertEqual(self.call("/profile/person2",{"rev":0,"data":{}},**proxied)[0],403)
        with patch.object(server,"options",return_value={"person1_user":"u1","shared_diaries":True}):
            self.assertEqual(self.call("/profile/person2",**proxied)[0],200)
            self.assertEqual(self.call("/profile/person2",client="172.30.32.2",user="u3")[0],403)

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
        def start():
            http = server.ThreadingHTTPServer(("127.0.0.1",0),server.Handler)
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
