"""Build the HA installation archive and an offline interactive preview."""
from pathlib import Path
import json
from zipfile import ZipFile, ZIP_DEFLATED
from photos import CATALOG, PHOTO_SOURCE

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
OUT = ROOT.parent / "artifacts" / "sport"

LOCAL_REQUEST = """
async function request(path, body) {
  if (path === "profiles") return [{id:"person1",name:"Профиль 1"},{id:"person2",name:"Профиль 2"}];
  if (path.startsWith("weights/")) return [];
  if (path.startsWith("weight/")) return null;
  if (path.startsWith("food?")) throw Error("Онлайн-поиск доступен в дополнении HA.");
  const key = "sport-preview:" + path;
  const old = JSON.parse(localStorage.getItem(key) || '{"rev":0,"data":{}}');
  if (!body) return old;
  if (old.rev !== body.rev) throw Error("Обнови страницу.");
  const next = {rev: old.rev + 1, data: body.data};
  localStorage.setItem(key, JSON.stringify(next));
  return next;
}
"""


def build():
    OUT.mkdir(exist_ok=True, parents=True)
    page = (WEB / "index.html").read_text(encoding="utf8")
    js = (WEB / "app.js").read_text(encoding="utf8")
    js = js[:js.index("async function request(")] + LOCAL_REQUEST + js[js.index("async function commit("):]
    page = page.replace('<link rel="stylesheet" href="style.css">', "<style>" + (WEB / "style.css").read_text(encoding="utf8") + "</style>")
    page = page.replace('<section id="content"></section>', '<section id="content"></section><small>Демо на этом устройстве · без синхронизации с HA</small>')
    catalog = "const exerciseCatalog = " + json.dumps(CATALOG) + "; const exercisePhotoBase = " + json.dumps(PHOTO_SOURCE) + ";"
    for name, source in [("catalog", catalog), ("logic", (WEB / "logic.js").read_text(encoding="utf8")), ("app", js)]:
        page = page.replace(f'<script src="{name}.js"></script>', "<script>" + source + "</script>")
    (OUT / "Sport-preview.html").write_text(page, encoding="utf8")
    with ZipFile(OUT / "Sport-HA.zip", "w", ZIP_DEFLATED) as archive:
        for file in [ROOT / name for name in ["config.yaml", "Dockerfile", "README.md", "server.py", "photos.py","measurements.py"]] + sorted(f for f in WEB.iterdir() if f.is_file()):
            archive.write(file, "sport/" + file.relative_to(ROOT).as_posix())


if __name__ == "__main__":
    build()
