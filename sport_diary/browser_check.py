"""Exercise the packaged diary in Edge with a private handler and SQLite database."""
from contextlib import ExitStack
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from threading import Thread
from unittest.mock import patch

from package import LOCAL_REQUEST
from test_sport import Sport
import server

ROOT = Path(__file__).resolve().parent
EDGE = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft/Edge/Application/msedge.exe"


def catalogue(query):
    products = [{"name": "Творог фермерский", "catalogItem": True, "unit": "г",
                 "code": "00001000", "nut": [106, 16, 2, 6]}] if query.lower() == "творог" else []
    return {"status": "ready", "products": products}


def host_handler(fixture, user, document):
    class Host(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                status, content, kind = 200, document["html"].encode(), "text/html; charset=utf-8"
            else:
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length)) if length else None
                status, content = fixture.call(self.path, body, user=user)
                kind = "application/json"
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

        do_POST = do_GET

        def log_message(self, *args):
            pass
    return Host


def check(width, height, pointer, limited=False):
    page = (ROOT.parent / "artifacts/sport/Sport-preview.html").read_text(encoding="utf8")
    scenario = (ROOT / "browser_check.js").read_text(encoding="utf8")
    assert page.count(LOCAL_REQUEST) == 1
    page = page.replace(LOCAL_REQUEST, "", 1)
    fallback = width in (375, 1000)
    setup = "<script>const limitedAccount=" + json.dumps(limited) + ";const noNativeUUID=" + json.dumps(fallback) + ";"
    setup += "if(noNativeUUID)Object.defineProperty(crypto,'randomUUID',{value:undefined});</script>"
    page = page.replace("</head>", setup + "</head>")
    role = "person2" if limited else "person1"

    with ExitStack() as stack:
        fixture = Sport()
        fixture.setUp()
        stack.callback(fixture.doCleanups)
        settings = {**fixture.settings, "person1_weight": "sensor.test_scale_one"}
        (server.DATA / "options.json").write_text(json.dumps(settings), encoding="utf8")
        sample = {"state":"78.5", "last_changed":"2001-01-01T09:00:00Z", "last_updated":"2001-01-01T10:00:00Z",
                  "attributes":{"unit_of_measurement":"kg"}}
        stack.enter_context(patch("server.core", return_value=sample))
        stack.enter_context(patch("server.scale_features", return_value={"sensors":[{"model":"QA scale","kind":"impedance"}]}))
        stack.enter_context(patch.object(server.catalog, "lookup", side_effect=catalogue))
        stack.enter_context(patch("server.online_food", return_value=(429, {"reason":"rate_limit"})))
        document = {}
        host = stack.enter_context(ThreadingHTTPServer(("127.0.0.1", 0), host_handler(fixture, "u2" if limited else "u1", document)))
        thread = Thread(target=host.serve_forever, daemon=True)
        thread.start()
        stack.callback(thread.join)
        stack.callback(host.shutdown)
        profile = stack.enter_context(tempfile.TemporaryDirectory(ignore_cleanup_errors=True))
        url = f"http://127.0.0.1:{host.server_port}/"

        def run(script):
            frame = page.replace("</body>", "<script>" + script + "</script></body>")
            document["html"] = ('<meta charset="utf-8"><output id="out"></output>'
                                f'<iframe style="border:0;width:{width}px;height:{height}px" srcdoc="'
                                + html.escape(frame, quote=True) + '"></iframe>')
            proc = subprocess.run([str(EDGE), "--headless", "--disable-gpu", "--no-first-run",
                                   "--user-data-dir=" + profile, "--virtual-time-budget=20000", "--dump-dom", url],
                                  capture_output=True, input=b"", timeout=45)
            if proc.returncode or not proc.stdout.strip():
                detail = proc.stderr.decode("utf8", "replace").strip()[-600:]
                raise SystemExit(f"{EDGE.name} не вернул DOM страницы (код 0x{proc.returncode & 0xffffffff:08x}). "
                                 + (detail or "Диагностика браузера пуста."))
            result = re.search(r'<output id="out">(.*?)</output>', proc.stdout.decode("utf8", "replace"), re.S)
            return html.unescape(result[1]) if result else "missing result"

        result = run("const inputDevice=" + json.dumps(pointer) + ";\n" + scenario)
        print(width, pointer, role, "UUID fallback" if fallback else "native UUID", result, flush=True)
        assert result.startswith("PASS "), result
        saved = fixture.profile(role)["data"]
        assert len(saved["workouts"]) == 1 and len(saved["meals"]) == 1 and len(saved["supps"]) == 2
        assert len(saved["weights"]) == 1 and saved["weights"][0]["kg"] == 74.5
        assert not saved.get("workoutDrafts")
        other = "person1" if limited else "person2"
        assert fixture.profile(other)["data"] == {}
        if limited:
            assert fixture.call("/profile/" + other, user="u2")[0] == 403
            assert fixture.call("/profile/" + other, {"rev":0,"data":{}}, user="u2")[0] == 403
        reload_test = """const poll = setInterval(() => {
          if (!state?.meals.length) return;
          clearInterval(poll);
          const ok=selectedDay===local().slice(0,10)&&!expanded&&!manualTime
              &&state.meals.length===1&&state.supps.length===2&&state.workouts.length===1&&state.weights[0]?.kg===74.5
              &&(limitedAccount?who==="person2"&&$("who").hidden:who==="person1"&&!$("who").hidden);
          parent.document.getElementById("out").textContent=ok?"reload passed":"reload failed";
        },50)"""
        assert run(reload_test) == "reload passed"


if __name__ == "__main__":
    for width, height, device in [(1000,850,"mouse"), (768,1024,"touch"), (390,844,"touch"), (375,667,"touch")]:
        for limited in (False, True):
            check(width, height, device, limited)
