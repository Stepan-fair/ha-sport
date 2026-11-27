"""Data projections and input validation for the delegated food diary."""
from datetime import date, datetime
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
from threading import BoundedSemaphore
from uuid import UUID, uuid4


RUNNER = Path(__file__).resolve().parent / "web" / "nutrition-summary.js"
CALCULATIONS = BoundedSemaphore(3)
MODES = ("base", "serving", "package", "piece")
FIELDS = {"operationId", "date", "name", "unit", "nut", "basis", "pieceName", "sizes", "mode",
          "count", "oil", "code", "origin", "oneOff", "estimateNote"}


class BadPortion(ValueError):
    pass


PROTEIN_KINDS = ("protein", "protein_mix")
PROTEIN_VALUES = ("servings", "powderGrams", "proteinGrams")
FIELDS.update(("productKind", "proteinDetails", "linkDoseId", "fiber", "mealGroup"))


def optional_fiber(value):
    if value is not None and not bounded_number(value):
        raise BadPortion("Укажите клетчатку в граммах или оставьте поле пустым.")
    return value


def meal_group(value):
    if not safe_text(value, 80):
        raise BadPortion("Укажите название приёма пищи до 80 символов.")
    return value.strip()


def valid_oil(oil, *, allow_unknown=False):
    return (isinstance(oil, dict) and {"grams", "nut"} <= set(oil) <= {"grams", "nut", "fiber"} and
            bounded_number(oil.get("grams"), positive=True) and valid_nutrients(oil.get("nut"), allow_unknown=allow_unknown) and
            (oil.get("fiber") is None or bounded_number(oil["fiber"])))


def protein_names(row):
    return [name for name in row.get("names", []) if isinstance(name, str) and re.search("протеин|protein", name, re.I)]


def protein_enabled(state):
    choices = state.get("profile", {}).get("supps", [])
    return isinstance(choices, list) and bool(protein_names({"names": choices}))


def food_visible(state, item):
    """Hide supplement details without changing the recorded nutrition facts."""
    if not item or protein_enabled(state):
        return True
    if item.get("productKind") in PROTEIN_KINDS or isinstance(item.get("proteinDetails"), dict):
        return False
    return not any(isinstance(row, dict) and protein_names(row) and (
        item.get("id") and row.get("mealId") == item["id"] or
        item.get("supplementEventId") and row.get("id") == item["supplementEventId"])
        for row in state.get("supps", []))


def assert_food_available(state, item):
    if not food_visible(state, item):
        raise BadPortion("Этот продукт отключён в настройках профиля. Включите его перед записью или исправлением.")


def available_protein_doses(state, day):
    if not protein_enabled(state):
        return  # A stale assistant form cannot link an intake hidden by current profile settings.
    meal_ids = {meal.get("id") for _, meal in meals_in(state) if isinstance(meal.get("id"), str)}
    for index, row in enumerate(state.get("supps", [])):
        if (not isinstance(row, dict) or not protein_names(row) or
                (isinstance(row.get("mealId"), str) and row["mealId"] in meal_ids) or
                str(row.get("date", ""))[:10] != day):
            continue
        token = operation_signature([index, row])
        clock = str(row["date"])[11:16]
        period = row.get("period") if row.get("period") in ("Утро", "День", "Вечер", "Ночь") else ""
        count = row.get("servings")
        yield row, {"id": token, "time": clock if re.fullmatch(r"\d\d:\d\d", clock) else period,
                    "servings": count if bounded_number(count, positive=True) else None}


def link_new_meal(state, meal, token):
    if not token:
        return
    for row, candidate in available_protein_doses(state, meal["date"][:10]):
        if candidate["id"] == token:
            names = protein_names(row)
            other = [name for name in row["names"] if name not in names]
            if other:
                state["supps"].insert(next(i for i, entry in enumerate(state["supps"]) if entry is row),
                                      {**row, "names": other})
            row.update(names=names, mealId=meal["id"])
            return
    raise BadPortion("Отметка протеина уже изменилась. Выберите её ещё раз.")


def move_meal_links(state, before, updated):
    old_day, new_day = before["date"][:10], updated["date"][:10]
    if old_day == new_day:
        return
    rows = []
    for row in state.get("supps", []):
        if row.get("mealId") != updated["id"] or row.get("date", "")[:10] != old_day or not protein_names(row):
            rows.append(row)
            continue
        names = protein_names(row)
        others = [name for name in row["names"] if name not in names]
        if others:
            rest = {**row, "names": others}
            rest.pop("mealId", None)
            rows.append(rest)
        rows.append({**row, "names": names, "date": new_day + row["date"][10:]})
    state["supps"] = rows


def adjust_meal_protein(before, updated):
    info = before.get("proteinDetails")
    if not isinstance(info, dict):
        return
    old, new = before.get("portion", {}), updated.get("portion", {})
    scale = 1
    if old.get("mode", "base") == new.get("mode", "base"):
        was = old.get("count", before.get("amount"))
        now = new.get("count", updated.get("amount"))
        if bounded_number(was, positive=True) and bounded_number(now, positive=True):
            scale = now / was
    updated["proteinDetails"] = {k: v * scale for k, v in info.items() if k in PROTEIN_VALUES and bounded_number(v)}
    if updated.get("productKind") == "protein_mix":
        protein = updated["proteinDetails"].get("proteinGrams")
        total = updated.get("totals", [None]*4)[1]
        if protein is not None and total is not None and protein > total:
            raise BadPortion("Белок порошка превышает белок в исправленной порции.")


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
    if oil is not None and not valid_oil(oil):
        raise BadPortion("Укажите количество масла и КБЖУ по этикетке.")
    card = {"name": name.strip(), "code": code, "nut": nut, "unit": unit, "basis": basis, "origin": origin}
    if "fiber" in body:
        card["fiber"] = optional_fiber(body["fiber"])
    if "productKind" in body:
        if body["productKind"] not in PROTEIN_KINDS:
            raise BadPortion("Проверьте вид продукта.")
        card["productKind"] = body["productKind"]
    if "linkDoseId" in body and (not body.get("productKind") or not isinstance(body["linkDoseId"], str) or
                                 not re.fullmatch("[0-9a-f]{64}", body["linkDoseId"])):
        raise BadPortion("Проверьте связь с отметкой протеина.")
    if sizes:
        card["sizes"] = sizes
    if piece_name:
        card["pieceName"] = piece_name
    result = daily_calculation("portion", {"card": card, "mode": mode, "count": count, "oil": oil})
    if "error" in result:
        raise BadPortion(result["error"])
    meal = {**card, **result, "date": stamp, "id": "nutrition-" + op, "oneOff": body.get("oneOff", False)}
    if "mealGroup" in body:
        meal["mealGroup"] = meal_group(body["mealGroup"])
    info = body.get("proteinDetails")
    if "proteinDetails" in body:
        if (not body.get("productKind") or not isinstance(info, dict) or set(info) - set(PROTEIN_VALUES) or
                any(not bounded_number(value, positive=key != "proteinGrams") for key, value in info.items())):
            raise BadPortion("Проверьте состав порошка в порции.")
        if "proteinGrams" in info and (body["productKind"] != "protein_mix" or info["proteinGrams"] > meal["totals"][1]):
            raise BadPortion("Проверьте белок порошка в составе блюда.")
        meal["proteinDetails"] = dict(info)
    if note:
        meal["estimateNote"] = note
    return meal


def operation_signature(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def card_key(card):
    return card.get("code") or str(card.get("name", "")).strip().casefold()


def version_targets(data, previous):
    """Preserve meal identity across list edits and invalidate proposals after any target change."""
    for collection, key in (("meals", "id"), ("products", "_cardId")):
        old = {row.get(key): row for row in previous.get(collection, []) if isinstance(row, dict) and row.get(key)}
        old_cards = {card_key(row): row for row in old.values()} if collection == "products" else {}
        seen = set()
        for index, row in enumerate(data.get(collection, [])):
            if not isinstance(row, dict):
                continue
            ident = row.get(key)
            if not ident and collection == "products":
                ident = old_cards.get(card_key(row), {}).get(key)
            if not safe_text(ident, 160) or not ident or ident in seen:
                ident = str(uuid4())
                if collection == "meals" and not row.get(key):
                    alias = f"legacy-{index}-{row.get('date', '')}"
                    for dose in data.get("supps", []):
                        if isinstance(dose, dict) and dose.get("mealId") == alias:
                            dose["mealId"] = ident
            row[key] = ident
            seen.add(ident)
            prev = old.get(ident)
            if prev and prev.get("_foodVersion"):
                row["_foodVersion"] = prev["_foodVersion"]
                if row == prev:
                    continue
            row["_foodVersion"] = str(uuid4())


def needs_target_ids(data):
    return any(not row.get(key) or not row.get("_foodVersion") for collection, key in
               (("meals", "id"), ("products", "_cardId")) for row in data.get(collection, []) if isinstance(row, dict))


def public_card(item):
    # Whitelist nested fields as well as the outer object; owners may store arbitrary private metadata.
    result = {k: item[k] for k, limit in (("name", 240), ("origin", 240), ("pieceName", 50), ("code", 14),
                                           ("aliases", 240), ("quantity", 100))
              if safe_text(item.get(k), limit)}
    for k, options in (("unit", ("г", "мл")), ("basis", ("100", "piece"))):
        if item.get(k) in options:
            result[k] = item[k]
    nut = item.get("nut")
    if item.get("productKind") in PROTEIN_KINDS:
        result["productKind"] = item["productKind"]
    if bounded_number(item.get("fiber")):
        result["fiber"] = item["fiber"]
    result["nut"] = [v if bounded_number(v) else None for v in nut] if isinstance(nut, list) and len(nut) == 4 else [None]*4
    sizes = item.get("sizes")
    if isinstance(sizes, dict):
        result["sizes"] = {k: v for k, v in sizes.items() if k in MODES[1:] and bounded_number(v, positive=True)}
    preferred = item.get("preferred")
    if isinstance(preferred, dict) and preferred.get("mode") in MODES:
        result["preferred"] = {"mode": preferred["mode"]}
        if bounded_number(preferred.get("count"), positive=True):
            result["preferred"]["count"] = preferred["count"]
    if item.get("_cardId") and item.get("_foodVersion"):
        result.update(id=item["_cardId"], version=item["_foodVersion"])
    return result


def personal_cards(state):
    cards, seen = [], set()
    history = reversed(state.get("meals", []))
    for item in [*state.get("products", []), *(m for m in history if isinstance(m, dict) and not m.get("oneOff"))]:
        if not isinstance(item, dict) or item.get("oneOff") or not food_visible(state, item):
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
                return saved
        elif meal["name"].casefold() == str(saved.get("name", "")).strip().casefold():
            return saved
    card = public_card(meal)
    cards.insert(0, card)
    return card


def public_meal(item, index, totals=None):
    card = public_card(item)
    card.pop("preferred", None)
    stamp = item.get("date")
    card["date"] = stamp if safe_text(stamp, 40) else ""
    card["id"] = item["id"]
    card["version"] = item["_foodVersion"]
    try:
        amount = float(item.get("amount"))
    except (TypeError, ValueError, OverflowError):
        amount = None
    card["amount"] = amount if amount is not None and math.isfinite(amount) and amount > 0 else None
    card["totals"] = totals if totals is not None else daily_calculation("mealTotals", [item])[0]
    if bounded_number(item.get("fiberTotal")):
        card["fiberTotal"] = item["fiberTotal"]
    if safe_text(item.get("mealGroup"), 80):
        card["mealGroup"] = item["mealGroup"]
    info = item.get("proteinDetails")
    if card.get("productKind") and isinstance(info, dict):
        card["proteinDetails"] = {k: info[k] for k in PROTEIN_VALUES if bounded_number(info.get(k))}
    portion, oil = item.get("portion"), item.get("oil")
    if isinstance(portion, dict) and portion.get("mode") in MODES and bounded_number(portion.get("count"), positive=True):
        size = portion.get("size")
        card["portion"] = {"mode": portion["mode"], "count": portion["count"], "size": size if bounded_number(size, positive=True) else None}
    if isinstance(oil, dict) and bounded_number(oil.get("grams"), positive=True) and valid_nutrients(oil.get("nut"), allow_unknown=True):
        card["oil"] = {"grams": oil["grams"], "nut": oil["nut"]}
        if bounded_number(oil.get("fiber")):
            card["oil"]["fiber"] = oil["fiber"]
    if safe_text(item.get("estimateNote"), 500):
        card["estimateNote"] = item["estimateNote"]
    card["oneOff"] = item.get("oneOff") is True
    return card


def meals_in(state):
    return ((i, m) for i, m in enumerate(state.get("meals", [])) if isinstance(m, dict))


def validate_preference(card, change):
    if not isinstance(change, dict) or set(change) - {"mode", "count"} or change.get("mode") not in MODES:
        raise BadPortion("Выберите обычную единицу.")
    if "count" in change and not bounded_number(change["count"], positive=True):
        raise BadPortion("Оставьте обычное количество пустым или укажите положительное число.")
    mode = change["mode"]
    if ((mode == "piece" and not card.get("pieceName")) or
            (mode != "base" and not card.get("sizes", {}).get(mode) and not (mode == "piece" and card.get("basis") == "piece")) or
            (mode != "piece" and card.get("basis") == "piece" and not card.get("sizes", {}).get("piece"))):
        raise BadPortion("Для выбранной единицы нужны название штуки или размер единицы в карточке.")


def proposed_card(card):
    allowed = {"name", "unit", "nut", "basis", "pieceName", "sizes", "code", "origin", "fiber"}
    if not isinstance(card, dict) or set(card) - allowed:
        raise BadPortion("Недопустимые поля новой карточки.")
    basis = card.get("basis", "100")
    # Reuse the intake validator for the label without creating a diary entry.
    sample = make_meal({**card, "mode": "piece" if basis == "piece" else "base", "count": 1,
                        "date": datetime.now().isoformat(timespec="minutes"), "operationId": str(uuid4())})
    return public_card(sample)


def corrected_meal(meal, change):
    if not isinstance(change, dict) or not change or set(change) - {"count", "date", "nut", "oil", "fiber", "mealGroup"}:
        raise BadPortion("Проверьте предложенные изменения порции.")
    updated = dict(meal)
    if "mealGroup" in change:
        updated["mealGroup"] = meal_group(change["mealGroup"])
    if "date" in change:
        stamp = change["date"]
        try:
            instant = datetime.fromisoformat(stamp)
            if instant.isoformat(timespec="minutes") != stamp or instant.tzinfo or instant > datetime.now():
                raise ValueError
        except (TypeError, ValueError):
            raise BadPortion("Укажите фактическую местную дату и время.") from None
        if stamp != meal.get("date"):
            updated.pop("actualConfirmed", None)
            updated.pop("actualEnd", None)
        updated["date"] = stamp
    if change.keys() - {"date", "mealGroup"}:
        card = public_card(meal)
        if "fiber" in change:
            card["fiber"] = updated["fiber"] = optional_fiber(change["fiber"])
        if "nut" in change:
            if not valid_nutrients(change["nut"], allow_unknown=True):
                raise BadPortion("Проверьте КБЖУ этикетки.")
            card["nut"] = updated["nut"] = change["nut"]
        portion = meal.get("portion") or {}
        mode = portion.get("mode", "base")
        count = change.get("count", portion.get("count", meal.get("amount")))
        if not bounded_number(count, positive=True):
            raise BadPortion("Укажите фактически съеденное количество.")
        if mode != "base" and bounded_number(portion.get("size"), positive=True):
            card.setdefault("sizes", {}).setdefault(mode, portion["size"])
        oil = change.get("oil", meal.get("oil"))
        if oil is not None and not valid_oil(oil, allow_unknown=True):
            raise BadPortion("Проверьте количество и КБЖУ масла.")
        result = daily_calculation("portion", {"card": card, "mode": mode, "count": count, "oil": oil, "original": meal})
        if "error" in result:
            raise BadPortion(result["error"])
        updated.pop("oil", None)
        updated.update(result)
        adjust_meal_protein(meal, updated)
    return updated
