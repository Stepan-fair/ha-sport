"""Prepare the reference photos for an HA image. Run once at build time."""
import json
from pathlib import Path
from urllib.request import urlopen

WEB = Path(__file__).resolve().parent / "web"
PHOTO_SOURCE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/"
CATALOG = json.loads((WEB / "catalog.json").read_text(encoding="utf8"))
PHOTO_PATHS = {
    f"{item['photo']}/{frame}.jpg" for item in CATALOG.values() for frame in (0, 1)
}


def download():
    for name in sorted(PHOTO_PATHS):
        with urlopen(PHOTO_SOURCE + name, timeout=25) as response:
            data = response.read(3_000_001)
        if len(data) > 3_000_000 or not data.startswith(b"\xff\xd8") or not data.endswith(b"\xff\xd9"):
            raise ValueError(f"Expected a JPEG for {name}")
        dest = WEB / "photos" / name
        dest.parent.mkdir(exist_ok=True, parents=True)
        dest.write_bytes(data)


if __name__ == "__main__":
    download()
