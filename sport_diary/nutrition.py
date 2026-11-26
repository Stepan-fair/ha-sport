"""Data projections and input validation for the delegated food diary."""
from datetime import date, datetime
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
from threading import BoundedSemaphore
from uuid import UUID


RUNNER = Path(__file__).resolve().parent / "web" / "nutrition-summary.js"
CALCULATIONS = BoundedSemaphore(3)
MODES = ("base", "serving", "package", "piece")
FIELDS = {"operationId", "date", "name", "unit", "nut", "basis", "pieceName", "sizes", "mode",
          "count", "oil", "code", "origin", "oneOff", "estimateNote"}


class BadPortion(ValueError):
    pass


def bounded_number(value, *, positive=False):
    return type(value) in (int, float) and 0 <= value <= 1_000_000 and (not positive or value > 0)


def safe_text(value, limit):
    return isinstance(value, str) and len(value) <= limit and all(c.isprintable() or c in "\u00a0\u202f" for c in value)


def valid_day(value):
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def valid_nutrients(values, *, allow_unknown=False):
    return isinstance(values, list) and len(values) == 4 and all(
        bounded_number(v) or (allow_unknown and v is None) for v in values)


def daily_calculation(action, data):
    # Both screens use the same JS formulas. Private profile inputs travel over stdin only.
    with CALCULATIONS:
        reply = subprocess.run(["node", str(RUNNER), action], input=json.dumps(data, allow_nan=False),
                               encoding="utf8", capture_output=True, timeout=10, check=True)
    return json.loads(reply.stdout)


def make_meal(body):
    if not isinstance(body, dict) or set(body) - FIELDS:
        raise BadPortion("Недопустимые поля записи.")
    op = body.get("operationId")
    try:
        if not isinstance(op, str) or str(UUID(op)) != op:
            raise ValueError
    except ValueError:
        raise BadPortion("Нужен UUID операции.") from None
    stamp = body.get("date")
    try:
        instant = datetime.fromisoformat(stamp)
        if instant.isoformat(timespec="minutes") != stamp or instant.tzinfo or instant > datetime.now():
            raise ValueError
    except (TypeError, ValueError):
        raise BadPortion("Укажите фактические местные дату и время с точностью до минуты.") from None
    name = body.get("name")
    if not safe_text(name, 240) or not name.strip():
        raise BadPortion("Укажите название продукта.")
    unit, nut = body.get("unit"), body.get("nut")
    if unit not in ("г", "мл") or not valid_nutrients(nut):
        raise BadPortion("Укажите единицу и четыре значения КБЖУ на заявленное количество.")
    basis, mode, count = body.get("basis", "100"), body.get("mode", "base"), body.get("count")
    sizes = body.get("sizes", {})
    if basis not in ("100", "piece") or mode not in MODES or not bounded_number(count, positive=True):
        raise BadPortion("Укажите основание КБЖУ и съеденное количество.")
    if not isinstance(sizes, dict) or any(k not in MODES[1:] or not bounded_number(v, positive=True) for k, v in sizes.items()):
        raise BadPortion("Проверьте размеры порции, упаковки или штуки.")
    if mode != "base" and mode not in sizes and not (basis == "piece" and mode == "piece"):
        raise BadPortion("Неизвестен размер выбранной единицы.")
    if basis == "piece" and mode != "piece" and "piece" not in sizes:
        raise BadPortion("Нужна масса или объём одной штуки.")
    code, origin = body.get("code", ""), body.get("origin", "Ведение питания")
    note, piece_name = body.get("estimateNote", ""), body.get("pieceName", "")
    if not safe_text(code, 14) or (code and not re.fullmatch(r"[0-9]{8,14}", code)):
        raise BadPortion("Проверьте штрихкод.")
    if not safe_text(origin, 240) or not safe_text(note, 500) or not safe_text(piece_name, 50):
        raise BadPortion("Проверьте описание источника, оценки и единицы.")
    if type(body.get("oneOff", False)) is not bool:
        raise BadPortion("Проверьте режим сохранения.")
    oil = body.get("oil")
    if oil is not None and (not isinstance(oil, dict) or set(oil) != {"grams", "nut"} or
                            not bounded_number(oil.get("grams"), positive=True) or not valid_nutrients(oil.get("nut"))):
        raise BadPortion("Укажите количество масла и КБЖУ по этикетке.")
    card = {"name": name.strip(), "code": code, "nut": nut, "unit": unit, "basis": basis, "origin": origin}
    if sizes:
        card["sizes"] = sizes
    if piece_name:
        card["pieceName"] = piece_name
    result = daily_calculation("portion", {"card": card, "mode": mode, "count": count, "oil": oil})
    if "error" in result:
        raise BadPortion(result["error"])
    meal = {**card, **result, "date": stamp, "id": "nutrition-" + op, "oneOff": body.get("oneOff", False)}
    if note:
        meal["estimateNote"] = note
    return meal


def operation_signature(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def public_card(item):
    # Whitelist nested fields as well as the outer object; owners may store arbitrary private metadata.
    result = {k: item[k] for k, limit in (("name", 240), ("origin", 240), ("pieceName", 50), ("code", 14),
                                           ("aliases", 240), ("quantity", 100))
              if safe_text(item.get(k), limit)}
    for k, options in (("unit", ("г", "мл")), ("basis", ("100", "piece"))):
        if item.get(k) in options:
            result[k] = item[k]
    nut = item.get("nut")
    result["nut"] = [v if bounded_number(v) else None for v in nut] if isinstance(nut, list) and len(nut) == 4 else [None]*4
    sizes = item.get("sizes")
    if isinstance(sizes, dict):
        result["sizes"] = {k: v for k, v in sizes.items() if k in MODES[1:] and bounded_number(v, positive=True)}
    preferred = item.get("preferred")
    if isinstance(preferred, dict) and preferred.get("mode") in MODES and bounded_number(preferred.get("count"), positive=True):
        result["preferred"] = {"mode": preferred["mode"], "count": preferred["count"]}
    return result


def personal_cards(state):
    cards, seen = [], set()
    history = reversed(state.get("meals", []))
    for item in [*state.get("products", []), *(m for m in history if isinstance(m, dict) and not m.get("oneOff"))]:
        if not isinstance(item, dict) or item.get("oneOff"):
            continue
        card = public_card(item)
        key = card.get("code") or card.get("name", "").casefold()
        if key and card.get("name") and key not in seen:
            cards.append(card)
            seen.add(key)
    return cards


def remember_new_card(data, meal):
    if meal["oneOff"]:
        return
    cards = data.setdefault("products", [])
    for saved in cards:
        if not isinstance(saved, dict):
            continue
        if meal["code"] and saved.get("code"):
            if meal["code"] == saved["code"]:
                return
        elif meal["name"].casefold() == str(saved.get("name", "")).strip().casefold():
            return
    cards.insert(0, public_card(meal))


def public_meal(item, index):
    card = public_card(item)
    card.pop("preferred", None)
    stamp = item.get("date")
    card["date"] = stamp if safe_text(stamp, 40) else ""
    card["id"] = item.get("id") if safe_text(item.get("id"), 160) else f"legacy-{index}-{card['date']}"
    try:
        amount = float(item.get("amount"))
    except (TypeError, ValueError, OverflowError):
        amount = None
    card["amount"] = amount if amount is not None and math.isfinite(amount) and amount > 0 else None
    stored = item.get("totals")
    if isinstance(stored, list) and len(stored) == 4:
        card["totals"] = [v if type(v) in (int, float) and math.isfinite(v) and v >= 0 else None for v in stored]
    else:
        card["totals"] = [v * card["amount"] / 100 if v is not None and card["amount"] is not None else None for v in card["nut"]]
    portion, oil = item.get("portion"), item.get("oil")
    if isinstance(portion, dict) and portion.get("mode") in MODES and bounded_number(portion.get("count"), positive=True):
        size = portion.get("size")
        card["portion"] = {"mode": portion["mode"], "count": portion["count"], "size": size if bounded_number(size, positive=True) else None}
    if isinstance(oil, dict) and bounded_number(oil.get("grams"), positive=True) and valid_nutrients(oil.get("nut"), allow_unknown=True):
        card["oil"] = {"grams": oil["grams"], "nut": oil["nut"]}
    if safe_text(item.get("estimateNote"), 500):
        card["estimateNote"] = item["estimateNote"]
    card["oneOff"] = item.get("oneOff") is True
    return card


def meals_in(state):
    return ((i, m) for i, m in enumerate(state.get("meals", [])) if isinstance(m, dict))
