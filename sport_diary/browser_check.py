"""Exercise the packaged page in real Edge frames with scripted input events."""
import html
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from package import LOCAL_REQUEST
from test_sport import Sport
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
EDGE = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft/Edge/Application/msedge.exe"

# Run the production fetch wrapper in the browser. Record its HTTP exchanges so
# the same requests can also be checked against the real handler and a new SQLite DB.
FETCH = """
const exchanges = [];
window.fetch = async function(path, options={}) {
  const body = options.body ? JSON.parse(options.body) : null;
  const profiles = [{id:"person1",name:"Первый",weightEntity:"sensor.test_scale_one"}, {id:"person2",name:"Второй ❤️",weightEntity:""}];
  const visible = limitedAccount ? profiles.slice(1) : profiles;
  let status=200, reply;
  if(path==="profiles") reply=visible;
  else if(path.startsWith("food?source=catalog")){
    const q=new URLSearchParams(path.split("?")[1]).get("q").toLowerCase();
    const rows=q==="творог"?[{name:"Творог фермерский",catalogItem:true,unit:"г",code:"00001000",nut:[106,16,2,6]}]:[];
    return new Response(JSON.stringify({status:"ready",products:rows}));
  }
  else if(path.startsWith("food?")) return new Response('{"reason":"rate_limit"}',{status:429});
  else if(!visible.some(p=>path.split("/")[1]===p.id)){status=403;reply={}}
  else if(path.startsWith("scale-info/")) reply={sensors:[{model:"QA scale",kind:"impedance"}]};
  else if(path.startsWith("weights/")) reply=path==="weights/person1"?
    [{kg:78.5,date:"2001-01-01T09:00:00+00:00",source:"ha",entity:"sensor.test_scale_one"}]:[];
  else {
    const key="qa:"+path;
    const old=JSON.parse(localStorage.getItem(key)||'{"rev":0,"data":{}}');
    if(!body)reply=old;
    else if(body.rev!==old.rev){status=409;reply={rev:null}}
    else {reply={rev:old.rev+1};localStorage.setItem(key,JSON.stringify({...reply,data:body.data}))}
  }
  exchanges.push({path,body,status,reply});
  return new Response(JSON.stringify(reply),{status});
};
"""


def check_exchanges(rows, limited):
    fixture = Sport()
    fixture.setUp()
    try:
        from server import DATA
        settings = {**fixture.settings, "person1_weight": "sensor.test_scale_one"}
        (DATA / "options.json").write_text(json.dumps(settings), encoding="utf8")
        user = "u2" if limited else "u1"
        sample = {"state":"78.5","last_updated":"2001-01-01T09:00:00Z","attributes":{"unit_of_measurement":"kg"}}
        with patch("server.core", return_value=sample), patch("server.scale_features", return_value={"sensors":[{"model":"QA scale","kind":"impedance"}]}):
            for i, row in enumerate(rows):
                status, content = fixture.call("/"+row["path"], row["body"], user=user)
                assert (status, json.loads(content)) == (row["status"], row["reply"]), (i,row["path"],status)
        who = "person2" if limited else "person1"
        saved = fixture.profile(who)["data"]
        assert len(saved["workouts"])==1 and len(saved["meals"])==1 and len(saved["supps"])==2
        assert len(saved["weights"])==1 and saved["weights"][0]["kg"]==74.5
        other = "person1" if limited else "person2"
        assert fixture.profile(other)["data"]=={}
        if limited:
            assert fixture.call("/profile/"+other, user=user)[0]==403
            assert fixture.call("/profile/"+other, {"rev":0,"data":{}}, user=user)[0]==403
    finally:
        fixture.doCleanups()


def check(width, height, pointer, limited=False):
    page = (ROOT.parent / "artifacts/sport/Sport-preview.html").read_text(encoding="utf8")
    scenario = (ROOT / "browser_check.js").read_text(encoding="utf8")
    role = "person2" if limited else "person1"
    source = (ROOT / "web/app.js").read_text(encoding="utf8")
    request = source[source.index("async function request("):source.index("async function commit(")]
    assert LOCAL_REQUEST in page
    page = page.replace(LOCAL_REQUEST, request, 1)
    page = page.replace("</head>", "<script>const limitedAccount=" + json.dumps(limited) +
                        ";const noNativeUUID=" + json.dumps(width in (375,1000)) + ";" +
                        "if(noNativeUUID)Object.defineProperty(crypto,'randomUUID',{value:undefined});" +
                        FETCH + "</script></head>")
    base_page=page
    page = page.replace("</body>", "<script>const inputDevice=" + json.dumps(pointer) + ";\n" + scenario + "</script></body>")
    with tempfile.TemporaryDirectory(dir=ROOT.parent / "artifacts",ignore_cleanup_errors=True) as folder, tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile:
        host = Path(folder) / "test.html"
        def write_host(page):
            host.write_text('<meta charset="utf-8"><output id="out"></output><pre id="requests"></pre><iframe style="border:0;width:'
                        + str(width) + 'px;height:' + str(height) + 'px" srcdoc="' + html.escape(page, quote=True)
                        + '"></iframe>', encoding="utf8")
        write_host(page)
        def launch():
            run=subprocess.run([str(EDGE),"--headless","--disable-gpu","--no-first-run",
                                "--user-data-dir="+profile,"--virtual-time-budget=20000","--dump-dom",host.as_uri()],
                               capture_output=True,input=b"",timeout=45)
            if run.returncode or not run.stdout.strip():
                detail = run.stderr.decode("utf8", "replace").strip()[-600:]
                raise SystemExit(f"{EDGE.name} не вернул DOM страницы "
                                 f"(код 0x{run.returncode & 0xffffffff:08x}). "
                                 + (detail or "Диагностика браузера пуста."))
            return run.stdout.decode("utf8","replace")
        dumped=launch()
        output = re.search(r'<output id="out">(.*?)</output>', dumped)
        result = html.unescape(output[1]) if output else "missing result"
        print(width, pointer, role, "UUID fallback" if width in (375,1000) else "native UUID", result, flush=True)
        if not result.startswith("PASS "):
            raise SystemExit(1)
        recorded = re.search(r'<pre id="requests" hidden="">(.*?)</pre>',dumped,re.S)
        assert recorded, "No browser HTTP transcript"
        rows=json.loads(html.unescape(recorded[1]))
        check_exchanges(rows, limited)
        print("Verified",len(rows),"browser requests against handler and SQLite",flush=True)
        reload_test="""<script>setTimeout(()=>{
          const ok=selectedDay===local().slice(0,10)&&!expanded&&!manualTime
              &&state.meals.length===1&&state.supps.length===2&&state.workouts.length===1&&state.weights[0]?.kg===74.5
              &&(limitedAccount?who==="person2"&&$("who").hidden:who==="person1"&&!$("who").hidden);
          parent.document.getElementById("out").textContent=ok?"reload passed":"reload failed";
        },100)</script>"""
        write_host(base_page.replace("</body>",reload_test+"</body>"))
        assert '<output id="out">reload passed</output>' in launch()


if __name__ == "__main__":
    for width,height,device in [(1000,850,"mouse"), (768,1024,"touch"), (390,844,"touch"), (375,667,"touch")]:
        for limited in (False, True):
            check(width,height,device,limited)
