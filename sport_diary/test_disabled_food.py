"""Visibility regressions using only the isolated profile and sensor fixtures."""
import json
import unittest
from copy import deepcopy
from uuid import uuid4

import test_assistant
import test_health_sensors
import test_sport
import test_supplement_integration


class DisabledFood(unittest.TestCase):
    call = test_sport.Sport.call
    profile = test_sport.Sport.profile
    setUp = test_assistant.NutritionAssistant.setUp
    configure = test_assistant.NutritionAssistant.configure
    helper = test_assistant.NutritionAssistant.helper
    propose = test_assistant.NutritionAssistant.propose
    decide = test_assistant.NutritionAssistant.decide
    product_state = test_supplement_integration.SupplementIntegration.product_state

    def enable(self, enabled):
        current = self.profile("person1")
        current["data"]["profile"]["supps"] = ["Протеин"] if enabled else []
        self.profile("person1", current)

    def test_hidden_details_keep_totals_receipts_and_owner_approved_corrections(self):
        day = self.meal["date"][:10]
        data = self.product_state()
        data["meals"].append({"id": "legacy", "name": "Старый связанный напиток", "date": day+"T11:00",
                              "amount": 100, "unit": "мл", "nut": [140, 25, 2, 4]})
        data["supps"].extend([
            {"names": ["Протеин"], "mealId": "legacy", "date": day+"T11:00", "servings": 1,
             "perServing": [120, 22, 1, 3]},
            {"names": ["Протеин"], "date": day+"T15:00", "servings": 1, "perServing": [120, 22, 1, 3]}])
        data["products"] = [{"name": "Рецепт порошка", "productKind": "protein", "unit": "г", "nut": [400, 75, 4, 10]}]
        self.profile("person1", {"rev": 0, "data": data})
        context = self.helper("/nutrition/context")[1]
        self.assertEqual(set(context), {"today", "zone", "proteinEnabled"})
        self.assertTrue(context["proteinEnabled"])
        ordinary = {**self.meal, "name": "Протеиновый йогурт без добавки", "oneOff": False}
        self.assertEqual(self.helper("/nutrition/meals", ordinary)[0], 201)
        token = self.helper("/nutrition/protein-doses/"+day)[1][0]["id"]
        saved = self.helper("/nutrition/meals/supp-meal-shake-one")[1]
        legacy = self.helper("/nutrition/meals/legacy")[1]
        self.assertEqual(self.propose("meal", legacy, {"count": 120})[0], 201)
        code, proposal = self.propose("meal", saved, {"count": 2})
        self.assertEqual(code, 201)
        card = next(c for c in self.helper("/nutrition/cards")[1] if c["name"] == "Рецепт порошка")
        code, preference = self.propose("preference", card, {"mode": "base", "count": 30})
        self.assertEqual(code, 201)
        before = self.helper("/nutrition/days/"+day)[1]
        self.assertIn("supplementProtein", before)
        self.enable(False)
        self.assertFalse(self.helper("/nutrition/context")[1]["proteinEnabled"])
        persisted = deepcopy(self.profile("person1")["data"])
        after = self.helper("/nutrition/days/"+day)[1]
        for key in ("known", "totals", "missing", "count"):
            self.assertEqual(after[key], before[key], key)
        self.assertNotIn("supplementProtein", after)
        self.assertEqual([m["name"] for m in after["meals"]], [ordinary["name"]])
        self.assertEqual([c["name"] for c in self.helper("/nutrition/cards")[1]], [ordinary["name"]])
        for ident in ("supp-meal-shake-one", "legacy"):
            self.assertEqual(self.helper("/nutrition/meals/"+ident)[0], 404)
        self.assertEqual(self.helper("/nutrition/protein-doses/"+day)[1], [])
        self.assertEqual(json.loads(self.call("/proposals/person1")[1]), [])
        self.assertEqual(self.propose("meal", saved, {"count": 3})[0], 400)
        self.assertEqual(self.propose("meal", legacy, {"count": 3})[0], 400)
        self.assertEqual(self.decide(proposal, "approve")[0], 400)
        self.assertEqual(self.decide(preference, "approve")[0], 400)
        self.assertEqual(self.decide(proposal, "approve", user="helper")[0], 403)
        new = {**self.meal, "operationId": str(uuid4()), "productKind": "protein_mix"}
        self.assertEqual(self.helper("/nutrition/meals", new)[0], 400)
        self.assertEqual(self.helper("/nutrition/meals", {**new, "linkDoseId": token})[0], 400)
        self.assertEqual(self.helper("/nutrition/meals", ordinary)[0], 200)
        self.assertEqual(self.profile("person1")["data"], persisted)
        self.enable(True)
        self.assertEqual(self.helper("/nutrition/meals/legacy")[1], legacy)
        self.assertEqual(self.helper("/nutrition/meals/supp-meal-shake-one")[1], saved)
        self.assertEqual(len(json.loads(self.call("/proposals/person1")[1])), 3)
        self.assertEqual(self.decide(proposal, "approve")[0], 200)
        self.assertEqual(self.decide(proposal, "approve")[0], 200)
        self.assertEqual(len(self.profile("person1")["data"]["meals"]), 3)
        self.assertEqual(self.profile("person2")["data"], {})

    def test_missing_settings_do_not_enable_protein(self):
        self.assertFalse(self.helper("/nutrition/context")[1]["proteinEnabled"])
        protein = {**self.meal, "productKind": "protein"}
        self.assertEqual(self.helper("/nutrition/meals", protein)[0], 400)
        self.assertEqual(self.profile("person1")["data"], {})
        self.assertEqual(self.helper("/nutrition/meals", self.meal)[0], 201)

    def test_new_recipe_preference_preserves_category_after_owner_approval(self):
        self.profile("person1", {"rev": 0, "data": {"profile": {"supps": ["Протеин"]}}})
        body = {"kind": "preference", "operationId": str(uuid4()), "reason": "Обычная порция",
                "card": {"name": "Новый рецепт", "unit": "г", "nut": [100, 22, 1, 3], "productKind": "protein_mix"},
                "changes": {"mode": "base", "count": 100}}
        status, proposal = self.helper("/nutrition/proposals", body)
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(self.call("/proposals/person1")[1])[0]["after"]["productKind"], "protein_mix")
        invalid = {**body, "operationId": str(uuid4()), "card": {**body["card"], "productKind": "unsupported"}}
        self.assertEqual(self.helper("/nutrition/proposals", invalid)[0], 400)
        self.enable(False)
        self.assertEqual(self.decide(proposal, "approve")[0], 400)
        self.assertEqual(self.helper("/nutrition/proposals", {**body, "operationId": str(uuid4())})[0], 400)
        self.enable(True)
        self.assertEqual(self.decide(proposal, "approve")[0], 200)
        self.assertEqual(self.helper("/nutrition/cards")[1][0]["productKind"], "protein_mix")
        self.enable(False)
        self.assertEqual(self.helper("/nutrition/cards")[1], [])
        self.assertEqual(self.profile("person1")["data"]["products"][0]["productKind"], "protein_mix")


class DisabledHealthConfirmation(unittest.TestCase):
    call = test_sport.Sport.call
    profile = test_sport.Sport.profile
    setUp = test_health_sensors.HealthSensors.setUp
    configure = test_health_sensors.HealthSensors.configure
    health = test_health_sensors.HealthSensors.health
    sample = test_health_sensors.HealthSensors.sample

    def set_visibility(self, visibility):
        current = self.profile("person1")
        current["data"].setdefault("profile", {})["visibility"] = visibility
        self.profile("person1", current)

    def test_second_device_cannot_confirm_disabled_activity_metric_or_sleep(self):
        self.health({"enabled": ["steps", "sleep"]})
        self.sample("sensor.phone_steps", 41, "steps", date="2026-02-14")
        self.sample("sensor.phone_sleep", 420, "min", wake_date="2026-02-14")
        historical = self.health({"refresh": True})["healthImported"]
        self.sample("sensor.phone_steps", 42, "steps", "2026-02-15T02:00:00Z")
        self.sample("sensor.phone_sleep", 450, "min", "2026-02-15T02:00:00Z")
        candidates = self.health({"refresh": True})["candidates"]
        steps = next(row for row in candidates if row["metric"] == "steps")
        sleep = next(row for row in candidates if row["metric"] == "sleep")
        for visibility, action, candidate in [
            ({"activity": False}, "confirmReading", steps),
            ({"dailyMetrics": {"steps": False}}, "confirmReading", steps),
            ({"sleep": False}, "confirmSleep", sleep),
            ({"sleep": False}, "confirmReading", sleep)]:
            with self.subTest(visibility=visibility, action=action):
                self.set_visibility(visibility)
                reply = self.health({action: candidate["id"], "date": "2026-02-15"}, expected=400)
                self.assertIn("отключён", reply["error"])
                self.assertEqual(self.health()["healthImported"], historical)
                self.assertEqual(self.health()["candidates"], candidates)
        self.set_visibility({})
        self.health({"confirmReading": steps["id"], "date": "2026-02-15"})
        restored = self.health({"confirmSleep": sleep["id"], "date": "2026-02-15"})
        self.assertEqual(len(restored["healthImported"]["daily"]), 2)
        self.assertEqual(len(restored["healthImported"]["sleep"]), 2)
        self.assertEqual(restored["candidates"], [])
