from uuid import uuid4
import unittest
import gzip
import io
from pathlib import Path
import sqlite3
from contextlib import closing
from tempfile import TemporaryDirectory
from unittest.mock import patch

import food_catalog
import nutrition


class OptionalNutrients(unittest.TestCase):
    def test_existing_catalogue_stays_searchable_while_fiber_index_is_rebuilt(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "cached.sqlite"
            cat = food_catalog.Catalog(Path(temp) / "bundled.sqlite", path)
            csv = ("name,brand,barcode,barcodes,country,kcal_100g,protein_100g,fat_100g,carbs_100g,fiber_100g\n"
                   "Бобы,,12345678,,ru,100,5,2,6,3.2\nХлеб,,12345679,,ru,170,5,2,6,0\n"
                   "Сыр,,12345680,,ru,179,12,2,6,\n")
            data = gzip.compress(csv.encode())
            food_catalog.build(io.BytesIO(data), path, expected=3)
            with closing(sqlite3.connect(path)) as db, db:
                fields = [r[1] for r in db.execute("pragma table_info(foods)")]
                if "fiber" in fields:
                    db.execute("alter table foods drop column fiber")
            self.assertEqual(cat.lookup("12345678")["products"][0]["nut"], [100,5,2,6])
            self.assertNotIn("fiber", cat.lookup("12345678")["products"][0])
            original = food_catalog.build
            with patch.object(food_catalog, "urlopen", return_value=io.BytesIO(data)), \
                    patch.object(food_catalog, "build", side_effect=lambda archive,target: original(archive,target,3)):
                cat.prepare()
            self.assertEqual(cat.lookup("бобы")["products"][0]["fiber"], 3.2)
            self.assertEqual(cat.lookup("12345679")["products"][0]["fiber"], 0)
            self.assertNotIn("fiber", cat.lookup("12345680")["products"][0])

    def test_delegated_intake_coverage_and_owner_approval(self):
        from test_assistant import NutritionAssistant

        api = NutritionAssistant()
        api.setUp()
        self.addCleanup(api.doCleanups)
        body = {**api.meal, "oneOff": False, "fiber": 0, "mealGroup": "Завтрак"}
        self.assertEqual(api.helper("/nutrition/meals", body)[0], 201)
        self.assertEqual(api.helper("/nutrition/meals", body)[0], 200)
        unknown = {**api.meal, "operationId": str(uuid4())}
        self.assertEqual(api.helper("/nutrition/meals", unknown)[0], 201)
        path = "/nutrition/days/" + api.meal["date"][:10]
        day = api.helper(path)[1]
        self.assertEqual(day["fiber"], {"known": 0, "knownCount": 1, "count": 2})
        card = api.helper("/nutrition/cards")[1][0]
        self.assertEqual(card["fiber"], 0)
        original = next(row for row in day["meals"] if "mealGroup" in row)
        code, proposal = api.propose("meal", original, {"fiber": 4, "mealGroup": "Обед"})
        self.assertEqual(code, 201)
        self.assertEqual(api.helper(path)[1]["fiber"]["known"], 0)
        self.assertEqual(api.decide(proposal, "approve")[0], 200)
        self.assertEqual(api.helper(path)[1]["fiber"]["known"], 6)
        self.assertEqual(api.helper("/nutrition/cards")[1][0]["fiber"], 0)

    def test_assistant_snapshots_card_and_portion_separately(self):
        source = dict(name="Хлеб", date="2025-01-01T08:00", unit="г", nut=[100, 3, 2, 10],
                      fiber=4, mealGroup="Завтрак", mode="base", count=150, operationId=str(uuid4()))
        meal = nutrition.make_meal(source)
        meal["_foodVersion"] = "v1"
        self.assertEqual(nutrition.public_card(meal)["fiber"], 4)
        self.assertNotIn("mealGroup", nutrition.public_card(meal))
        self.assertEqual(nutrition.public_meal(meal, 0)["fiberTotal"], 6)
        self.assertEqual(nutrition.public_meal(meal, 0)["mealGroup"], "Завтрак")
        corrected = nutrition.corrected_meal(meal, {"count": 50, "fiber": 0, "mealGroup": "Обед"})
        self.assertEqual((corrected["fiberTotal"], corrected["mealGroup"]), (0, "Обед"))
        self.assertIsNone(nutrition.corrected_meal(corrected, {"fiber": None})["fiberTotal"])
        with self.assertRaises(nutrition.BadPortion):
            nutrition.make_meal({**source, "fiber": -1})

    def test_helper_correction_only_invalidates_confirmed_end_when_time_changes(self):
        source = dict(name="Хлеб", date="2025-01-01T08:00", unit="г", nut=[100, 3, 2, 10],
                      mode="base", count=150, operationId=str(uuid4()))
        meal = dict(nutrition.make_meal(source), _foodVersion="v", actualEnd="2025-01-01T08:45+03:00",
                    actualConfirmed=True, sleepMealKind="substantial")
        for change in ({"count": 200}, {"nut": [100, 3, 2, 9]}, {"date": meal["date"]}):
            corrected = nutrition.corrected_meal(meal, change)
            self.assertEqual((corrected["actualEnd"], corrected["actualConfirmed"]), (meal["actualEnd"], True))
        self.assertTrue({"actualEnd", "actualConfirmed", "sleepMealKind"}.isdisjoint(nutrition.public_meal(meal, 0)))
        for stamp in ("2025-01-01T09:00", "2025-01-02T08:00"):
            moved = nutrition.corrected_meal(meal, {"date": stamp})
            self.assertNotIn("actualEnd", moved)
            self.assertNotIn("actualConfirmed", moved)
            self.assertEqual(moved["sleepMealKind"], "substantial")
