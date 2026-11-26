import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from uuid import uuid4

import server
import test_sport


class NutritionAssistant(unittest.TestCase):
    call = test_sport.Sport.call
    profile = test_sport.Sport.profile

    def setUp(self):
        test_sport.Sport.setUp(self)
        self.configure(nutrition_assistant_user="helper", nutrition_assistant_profile="person1")
        self.meal = {"operationId": str(uuid4()), "name": "Кефир", "date": "2026-02-14T09:45",
                     "unit": "мл", "mode": "base", "count": 150, "nut": [60, 3, 3, 5],
                     "oneOff": True, "estimateNote": "Объём оценён по фото"}

    def configure(self, **changes):
        settings = {**self.settings, **changes}
        (server.DATA / "options.json").write_text(json.dumps(settings), encoding="utf8")

    def helper(self, path, body=None):
        status, raw = self.call(path, body, user="helper")
        return status, json.loads(raw)

    def test_grant_and_revoke(self):
        self.assertIn(b'assistant-form', self.call("/", user="helper")[1])
        self.assertEqual(self.helper("/nutrition/cards"), (200, []))
        self.assertEqual(self.call("/nutrition/cards", user="unknown")[0], 403)
        self.assertEqual(self.call("/nutrition/cards", user="helper", client="127.0.0.1")[0], 403)
        self.assertEqual(self.call("/nutrition/cards", user="helper", client="192.0.2.3")[0], 403)
        for path in ["/profile/person1", "/profile/person2", "/weights/person1", "/weight/person1", "/scale-info/person1"]:
            self.assertEqual(self.helper(path)[0], 403, path)
        self.assertEqual(self.helper("/profiles"), (200, []))
        self.assertEqual(self.helper("/profile/person1", {"rev": 0, "data": {}})[0], 403)
        self.assertEqual(self.helper("/nutrition/days/2026-02-14", {"complete": True})[0], 405)
        self.assertEqual(self.helper("/nutrition/cards", {"preferred": {"count": 3}})[0], 405)
        self.assertEqual(self.call("/profile/person1", user="u1")[0], 200)
        self.assertEqual(self.call("/profile/person2", user="u1")[0], 200)
        self.assertEqual(self.call("/profile/person1", user="u2")[0], 403)
        for changes in [{}, {"nutrition_assistant_user": "helper"},
                        {"nutrition_assistant_user": "helper", "nutrition_assistant_profile": "other"},
                        {"nutrition_assistant_user": "u2", "nutrition_assistant_profile": "person1"}]:
            self.configure(**changes)
            self.assertEqual(self.helper("/nutrition/cards")[0], 403)
            self.assertEqual(self.call("/nutrition/cards", user="u2")[0], 403)
            self.assertEqual(self.call("/profile/person2", user="u2")[0], 200)

    def test_readback_totals_and_single_append_under_concurrent_retries(self):
        self.profile("person2", {"rev": 0, "data": {"products": [{"name": "Invisible"}]}})
        data = {"profile": {"private": "HIDDEN"}, "workouts": [], "supps": [], "weights": [],
                "energyRules": {"2026-01-01": {"mode": "manual", "kcal": 1980}},
                "foodComplete": {"2026-02-14": True}, "products": [],
                "meals": [{"name": "Хлеб", "unit": "г", "date": "2026-02-14T08:00",
                           "nut": [250, 8, 2, 50], "amount": 40, "private": "HIDDEN"}]}
        self.profile("person1", {"rev": 0, "data": data})
        status, day = self.helper("/nutrition/days/2026-02-14")
        self.assertEqual((status, day["totals"], day["maintenance"], day["complete"]), (200, [100, 3.2, .8, 20], 1980, True))
        self.assertNotIn("HIDDEN", str(day))
        with ThreadPoolExecutor(4) as pool:
            replies = list(pool.map(lambda _: self.helper("/nutrition/meals", self.meal), range(4)))
        self.assertEqual(sorted(status for status, _ in replies), [200, 200, 200, 201])
        meal_id = replies[0][1]["id"]
        self.assertEqual({r["id"] for _, r in replies}, {meal_id})
        status, saved = self.helper("/nutrition/meals/" + meal_id)
        self.assertEqual((status, saved["date"], saved["amount"], saved["totals"]), (200, self.meal["date"], 150, [90, 4.5, 4.5, 7.5]))
        self.assertEqual(saved["estimateNote"], self.meal["estimateNote"])
        self.assertEqual(self.helper("/nutrition/meals", {**self.meal, "count": 180})[0], 409)
        self.assertEqual(self.call("/profile/person1", {"rev": 1, "data": data})[0], 409)
        day = self.helper("/nutrition/days/2026-02-14")[1]
        self.assertEqual((day["totals"], day["maintenance"], day["complete"]), ([190, 7.7, 5.3, 27.5], 1980, True))
        self.assertEqual([x["name"] for x in day["meals"]], ["Хлеб", "Кефир"])
        self.assertEqual(self.helper("/nutrition/cards?" + urlencode({"q": "кефир"}))[1], [])
        self.assertEqual(self.profile("person1")["rev"], 2)
        self.assertEqual(self.profile("person1")["data"]["products"], [])
        self.configure(nutrition_assistant_user="helper", nutrition_assistant_profile="person2")
        self.assertEqual(self.helper("/nutrition/meals/" + meal_id)[0], 404)
        self.assertEqual(self.helper("/nutrition/days/2026-02-14")[1]["maintenance"], None)

    def test_cards_allowlist_and_invalid_portions(self):
        self.profile("person1", {"rev": 0, "data": {"products": [
            {"name": "Йогурт", "code": "12345678", "nut": [67, 3, 3, 7],
             "preferred": {"mode": "package", "count": 1, "hidden": "PRIVATE"}, "unit": "г",
             "sizes": {"package": 125, "secret": "PRIVATE"}, "privateNote": "PRIVATE"}]}})
        for q in ["ЙОГУРТ", "12345678"]:
            code, cards = self.helper("/nutrition/cards?" + urlencode({"q": q}))
            self.assertEqual((code, [c["name"] for c in cards]), (200, ["Йогурт"]))
            self.assertNotIn("PRIVATE", str(cards))
            self.assertEqual(cards[0]["sizes"], {"package": 125})
        for invalid in [{"date": "2026-02-31T12:15"}, {"date": "2026-02-28"}, {"date": "2099-01-01T12:00"},
                        {"count": 0}, {"count": True}, {"unit": "ложка"}, {"nut": [1]},
                        {"profile": "person2"}, {"preferred": {"mode": "base", "count": 2}},
                        {"operationId": ""}, {"oneOff": "false"}, {"mode": "package"}]:
            self.assertEqual(self.helper("/nutrition/meals", {**self.meal, **invalid})[0], 400, invalid)
        self.assertEqual(self.profile("person1")["rev"], 1)

    def test_owner_and_assistant_both_keep_their_changes(self):
        def owner():
            for _ in range(3):
                state = self.profile("person1")
                state["data"]["profile"] = {"exerciseNotes": {"exercise:row": "Закрепить сиденье"}}
                if self.call("/profile/person1", state)[0] == 200:
                    return
            self.fail("Owner could not save after refreshing the revision")

        with ThreadPoolExecutor(2) as pool:
            owner_write = pool.submit(owner)
            append = pool.submit(self.helper, "/nutrition/meals", self.meal)
            owner_write.result()
            self.assertEqual(append.result()[0], 201)
        state = self.profile("person1")
        self.assertEqual(state["data"]["profile"]["exerciseNotes"]["exercise:row"], "Закрепить сиденье")
        self.assertEqual(len(state["data"]["meals"]), 1)
        state["data"]["meals"].clear()
        self.assertEqual(self.call("/profile/person1", state)[0], 200)
        self.assertEqual(self.helper("/nutrition/meals", self.meal)[0], 410)
        self.assertEqual(self.profile("person1")["data"]["meals"], [])

    def test_energy_protein_and_portion_units_use_owner_report(self):
        day = self.meal["date"][:10]
        self.profile("person1", {"rev": 0, "data": {
            "profile": {"sex": "Мужской", "height": 180, "age": 30},
            "weights": [{"kg": 80, "source": "manual", "date": day + "T07:00"}],
            "supps": [{"date": day, "names": ["Протеин"], "servings": 1, "perServing": [None, 22, None, None]}],
            "workouts": [{"date": day + "T12:00", "end": day + "T12:30", "kg": 80,
                          "cardio": [{"seconds": 1800, "kcal": 200}], "exercises": []}]}})
        # 2136 baseline plus 200 measured minus 44.5 baseline minutes, rounded by the owner report.
        code, summary = self.helper("/nutrition/days/" + day)
        self.assertEqual((code, summary["maintenance"], summary["totals"]), (200, 2292, [None, 22, None, None]))
        self.assertEqual(set(summary), {"day", "totals", "missing", "known", "count", "supplementProtein", "complete", "meals", "maintenance"})
        self.assertEqual(summary["supplementProtein"], {"grams": 22, "incomplete": False})
        body = {**self.meal, "name": "Омлет", "unit": "г", "count": 2, "mode": "piece", "basis": "piece",
                "pieceName": "яйцо", "nut": [70, 6, 5, 0], "oil": {"grams": 5, "nut": [900, 0, 100, 0]}}
        status, receipt = self.helper("/nutrition/meals", body)
        self.assertEqual(status, 201)
        result = self.helper("/nutrition/meals/" + receipt["id"])[1]
        self.assertEqual((result["amount"], result["totals"], result["portion"]["count"]), (None, [185, 12, 15, 0], 2))
        day_data = self.helper("/nutrition/days/" + day)[1]
        self.assertEqual((day_data["totals"], day_data["known"], day_data["maintenance"]), ([None, 34, None, None], [185, 34, 15, 0], 2292))
        self.assertEqual(day_data["count"], 2)
        owner_data = self.profile("person1")
        owner_data["data"]["supps"][0]["mealId"] = receipt["id"]
        self.assertEqual(self.call("/profile/person1", owner_data)[0], 200)
        linked = self.helper("/nutrition/days/" + day)[1]
        self.assertNotIn("supplementProtein", linked)
        self.assertEqual(linked["totals"], [185, 12, 15, 0])

    def test_ordinary_new_food_is_searchable_after_owner_removes_meal(self):
        first = {**self.meal, "oneOff": False, "code": "12345678"}
        self.assertEqual(self.helper("/nutrition/meals", first)[0], 201)
        state = self.profile("person1")
        state["data"]["meals"].clear()
        self.assertEqual(self.call("/profile/person1", state)[0], 200)
        query = "/nutrition/cards?" + urlencode({"q": "кефир"})
        self.assertEqual([c["name"] for c in self.helper(query)[1]], ["Кефир"])
        previous = self.profile("person1")["data"]["products"]
        for changes in [{"name": "Другое название с тем же кодом"}, {"code": "", "name": "КЕФИР"}]:
            another = {**first, "operationId": str(uuid4()), "nut": [0, 0, 0, 0], **changes}
            self.assertEqual(self.helper("/nutrition/meals", another)[0], 201)
            self.assertEqual(self.profile("person1")["data"]["products"], previous)


if __name__ == "__main__":
    unittest.main()
