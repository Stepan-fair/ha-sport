"""Exercise the packaged page in real Edge frames with scripted input events."""
import html
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
EDGE = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft/Edge/Application/msedge.exe"


def check(width, height, pointer):
    page = (ROOT.parent / "artifacts/sport/Sport-preview.html").read_text(encoding="utf8")
    scenario = (ROOT / "browser_check.js").read_text(encoding="utf8")
    base_page=page
    page = page.replace("</body>", "<script>const inputDevice=" + json.dumps(pointer) + ";\n" + scenario + "</script></body>")
    with tempfile.TemporaryDirectory(dir=ROOT.parent / "artifacts",ignore_cleanup_errors=True) as folder, tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile:
        host = Path(folder) / "test.html"
        def write_host(page):
            host.write_text('<meta charset="utf-8"><output id="out"></output><iframe style="border:0;width:'
                        + str(width) + 'px;height:' + str(height) + 'px" srcdoc="' + html.escape(page, quote=True)
                        + '"></iframe>', encoding="utf8")
        write_host(page)
        def launch():
            run=subprocess.run([str(EDGE),"--headless","--disable-gpu","--no-first-run",
                                "--user-data-dir="+profile,"--virtual-time-budget=8500","--dump-dom",host.as_uri()],
                               capture_output=True,input=b"",timeout=15)
            return run.stdout.decode("utf8","replace")
        dumped=launch()
        from re import search
        output = search(r'<output id="out">(.*?)</output>', dumped)
        result = html.unescape(output[1]) if output else "missing result"
        print(width, pointer, result, flush=True)
        if not result.startswith("PASS "):
            raise SystemExit(1)
        reload_test="""<script>setTimeout(()=>{
          const ok=selectedDay===local().slice(0,10)&&!expanded&&!manualTime&&!manualPeriod
              &&state.meals.length===1&&state.supps.length===2&&state.workouts.length===1;
          parent.document.getElementById("out").textContent=ok?"reload passed":"reload failed";
        },100)</script>"""
        write_host(base_page.replace("</body>",reload_test+"</body>"))
        assert '<output id="out">reload passed</output>' in launch()


if __name__ == "__main__":
    for width,height,device in [(1000,850,"mouse"), (768,1024,"touch"), (390,844,"touch"), (375,667,"touch")]:
        check(width,height,device)
