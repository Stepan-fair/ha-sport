import json
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from uuid import uuid4

import server
import test_sport


class NutritionAssistant(unittest.TestCase):
    call = test_sport.Sport.call
    profile = test_sport.Sport.profile

    def test_linked_shake_receipt_history_projection_and_profile_boundaries(self):
        day = self.meal["date"][:10]
        date = self.meal["date"]
        self.profile("person1", {"rev": 0, "data": {"profile": {"supps": ["Протеин"]}, "supps": [{"date": day, "period": "Утро", "names": ["Протеин", "PRIVATE"],
                            "servings": 1, "perServing": [120, 22, 1, 4], "powderPerServing": 30}],
                        "meals": [{"date": date, "name": "Творог", "unit": "г", "amount": 90,
                                   "nut": [100, 16, 0, 2], "totals": [95, None, 0, None]}]}})
        candidates = self.helper("/nutrition/protein-doses/" + day)[1]
        self.assertEqual(len(candidates), 1)
        self.assertNotIn("PRIVATE", str(candidates))
        forbidden = self.call("/nutrition/protein-doses/"+day, user="u2")
        self.assertEqual(forbidden[0], 403)
        body = {**self.meal, "name": "Шейк на молоке", "productKind": "protein_mix", "count": 100,
                "nut": [180, 30, 2, 8], "linkDoseId": candidates[0]["id"],
                "proteinDetails": {"proteinGrams": 22, "powderGrams": 30, "servings": 1}}
        code, receipt = self.helper("/nutrition/meals", body)
        self.assertEqual((code, self.helper("/nutrition/meals", body)[0]), (201, 200))
        self.assertEqual(self.helper("/nutrition/protein-doses/"+day)[1], [])
        stale = {**body, "operationId": str(uuid4())}
        self.assertEqual(self.helper("/nutrition/meals", stale)[0], 400)
        actual = self.helper("/nutrition/days/"+day)[1]
        self.assertEqual(actual["totals"][1], 44.4)
        self.assertEqual(actual["meals"][0]["totals"], [95, 14.4, 0, 1.8])
        saved = self.helper("/nutrition/meals/"+receipt["id"])[1]
        self.assertEqual(saved["proteinDetails"], body["proteinDetails"])
        code, proposal = self.propose("meal", saved, {"count": 50, "date": "2026-02-15T09:45"})
        self.assertEqual(code, 201)
        self.assertEqual(self.decide(proposal, "approve")[0], 200)
        moved = self.helper("/nutrition/days/2026-02-15")[1]
        self.assertEqual((moved["totals"][1], moved["meals"][0]["proteinDetails"]["proteinGrams"]), (15, 11))
        self.assertEqual(self.helper("/nutrition/days/"+day)[1]["totals"][1], 14.4)

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

    def propose(self, kind, target, changes, **extra):
        body = {"operationId": str(uuid4()), "kind": kind, "targetId": target["id"],
                "version": target["version"], "reason": "Сверено с этикеткой", "changes": changes, **extra}
        return self.helper("/nutrition/proposals", body)

    def decide(self, proposal, decision, who="person1", user="u1"):
        status, raw = self.call("/proposals/" + who, {"id": proposal["id"], "decision": decision}, user=user)
        return status, json.loads(raw)

    def test_legacy_meals_keep_stable_targets_and_correction_moves_only_selected_meal(self):
        egg = {"name": "Блюдо", "nut": [70, 6, 5, 0], "unit": "г", "date": self.meal["date"],
               "pieceName": "яйцо", "basis": "piece", "portion": {"count": 4, "mode": "piece"},
               "amount": None, "oil": {"grams": 5, "nut": [900, 0, 100, 0]}, "totals": [325, 24, 25, 0]}
        # A database written by the previous release, before either entry has an ID.
        with closing(server.open_diary()) as db:
            db.execute("INSERT INTO profile VALUES (?,?,?)", ("person1", 4, json.dumps({"meals": [egg, egg]})))
            db.commit()
        meals = self.helper("/nutrition/days/2026-02-14")[1]["meals"]
        self.assertNotEqual(meals[0]["id"], meals[1]["id"])
        self.assertFalse(meals[1]["id"].startswith("legacy-"))
        status, proposal = self.propose("meal", meals[1], {"count": 2, "date": "2026-02-15T00:05"})
        self.assertEqual(status, 201)
        self.assertEqual(self.helper("/nutrition/days/2026-02-14")[1]["known"][0], 650)
        owner = self.profile("person1")
        owner["data"]["meals"].reverse()
        owner["data"]["meals"].append({"name":"Тестовая неполная порция","date":"2026-02-14T11:00",
                                       "unit":"г","amount":50,"nut":[None,0,0,0]})
        self.assertEqual(self.call("/profile/person1", owner)[0], 200)
        queue = json.loads(self.call("/proposals/person1")[1])
        self.assertEqual((queue[0]["before"]["totals"], queue[0]["after"]["totals"]),
                         ([325, 24, 25, 0], [185, 12, 15, 0]))
        self.assertEqual([d["change"][0] for d in queue[0]["days"]], [-325, 185])
        self.assertEqual(self.decide(proposal, "approve", user="helper")[0], 403)
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual([code for code, _ in pool.map(lambda _: self.decide(proposal, "approve"), range(2))], [200, 200])
        self.assertEqual(self.decide(proposal, "reject")[0], 409)
        first = self.helper("/nutrition/days/2026-02-14")[1]
        second = self.helper("/nutrition/days/2026-02-15")[1]
        self.assertEqual((first["known"][0], first["meals"][0]["id"]), (325, meals[0]["id"]))
        self.assertEqual((second["known"][0], second["meals"][0]["id"]), (185, meals[1]["id"]))
        self.assertEqual(json.loads(self.call("/proposals/person1")[1])[0]["status"], "approved")

    def test_unit_only_preference_existing_card_and_stale_or_rejected_target(self):
        dish = {**self.meal, "oneOff": False, "pieceName": "яйцо", "basis": "piece", "count": 4, "mode": "piece"}
        self.assertEqual(self.helper("/nutrition/meals", dish)[0], 201)
        card = self.helper("/nutrition/cards")[1][0]
        status, proposal = self.propose("preference", card, {"mode": "piece"})
        self.assertEqual(status, 201)
        self.assertNotIn("preferred", self.helper("/nutrition/cards")[1][0])
        self.assertEqual(self.decide(proposal, "approve")[0], 200)
        card = self.helper("/nutrition/cards")[1][0]
        self.assertEqual(card["preferred"], {"mode": "piece"})
        change = self.propose("preference", card, {"mode": "piece", "count": 2})[1]
        reject = self.propose("preference", card, {"mode": "piece", "count": 1})[1]
        stale = self.propose("preference", card, {"mode": "piece", "count": 3})[1]
        self.assertEqual(self.decide(reject, "reject")[0], 200)
        self.assertEqual(self.decide(change, "approve")[0], 200)
        self.assertEqual(self.decide(stale, "approve")[0], 409)
        self.assertEqual(self.helper("/nutrition/cards")[1][0]["preferred"]["count"], 2)
        self.assertEqual(self.profile("person1")["data"]["meals"][0]["portion"]["count"], 4)
        self.configure(nutrition_assistant_user="helper", nutrition_assistant_profile="person2")
        self.assertEqual(self.propose("preference", card, {"mode": "base"})[0], 404)
        self.assertEqual(self.call("/proposals/person2", user="u1")[0], 403)
        self.assertEqual(self.call("/proposals/person2", user="u2")[0], 200)

    def test_preference_on_new_card_idempotency_and_deleted_meal_conflict(self):
        body = {"kind": "preference", "operationId": str(uuid4()), "reason": "Обычная единица",
                "card": {"name": "Блюдо", "basis": "piece", "pieceName": "яйцо", "unit": "г", "nut": [1, 2, 3, 4]},
                "changes": {"mode": "piece", "count": 2}}
        status, proposal = self.helper("/nutrition/proposals", body)
        self.assertEqual(status, 201)
        self.assertEqual(self.helper("/nutrition/proposals", body), (200, proposal))
        self.assertEqual(self.helper("/nutrition/proposals", {**body, "reason": "Другая причина"})[0], 409)
        self.assertEqual(self.helper("/nutrition/cards")[1], [])
        self.assertEqual(self.decide(proposal, "approve")[0], 200)
        self.assertEqual(self.helper("/nutrition/cards")[1][0]["preferred"]["count"], 2)
        self.assertEqual(self.helper("/nutrition/meals", self.meal)[0], 201)
        meal = self.helper("/nutrition/days/2026-02-14")[1]["meals"][0]
        for bad in [{"private": "no"}, {"count": False}, {"date":"2099-04-03T02:00"}]:
            self.assertEqual(self.propose("meal", meal, bad)[0], 400)
        p = self.propose("meal", meal, {"count": 100})[1]
        owner = self.profile("person1")
        owner["data"]["meals"].clear()
        self.profile("person1", owner)
        self.assertEqual(self.decide(p, "approve")[0], 409)
        self.assertFalse(self.profile("person1")["data"]["meals"])

    def test_new_intake_and_pending_preference_commit_once_without_changing_ordinary_count(self):
        body = {**self.meal, "oneOff": False, "count": 4, "mode": "piece", "basis": "piece", "pieceName": "яйцо",
                "preferenceProposal": {"changes": {"mode": "piece"}, "reason": "Всегда записывать в яйцах"}}
        with ThreadPoolExecutor(2) as pool:
            replies = list(pool.map(lambda _: self.helper("/nutrition/meals", body), range(2)))
        self.assertEqual(sorted(status for status, _ in replies), [200, 201])
        self.assertEqual(replies[0][1], replies[1][1])
        state = self.profile("person1")["data"]
        self.assertEqual(len(state["meals"]), 1)
        self.assertNotIn("preferred", state["products"][0])
        proposals = json.loads(self.call("/proposals/person1")[1])
        self.assertEqual(len(proposals), 1)
        self.assertEqual(self.decide(proposals[0], "approve")[0], 200)
        self.assertEqual(self.helper("/nutrition/cards")[1][0]["preferred"], {"mode": "piece"})
        self.assertEqual(self.profile("person1")["data"]["meals"][0]["portion"]["count"], 4)
        invalid = {**body, "operationId": str(uuid4()), "oneOff": True}
        self.assertEqual(self.helper("/nutrition/meals", invalid)[0], 400)

    def test_reverted_owner_edit_still_invalidates_old_meal_version(self):
        _, created = self.helper("/nutrition/meals", self.meal)
        meal = self.helper("/nutrition/meals/" + created["id"])[1]
        proposal = self.propose("meal", meal, {"count": 210})[1]
        for label in ("Другое название", self.meal["name"]):
            owner = self.profile("person1")
            owner["data"]["meals"][0]["name"] = label
            self.profile("person1", owner)
        fresh = self.helper("/nutrition/meals/" + created["id"])[1]
        self.assertNotEqual(fresh["version"], meal["version"])
        self.assertEqual(self.decide(proposal, "approve")[0], 409)
        self.assertEqual(self.propose("meal", meal, {"count": 220})[0], 409)
        self.assertEqual(self.decide(proposal, "reject")[0], 200)
        self.assertEqual(self.decide(proposal, "reject")[0], 200)
        self.assertEqual(self.helper("/nutrition/meals/" + created["id"])[1]["portion"]["count"], 150)

    def test_readback_totals_and_single_append_under_concurrent_retries(self):
        self.profile("person2", {"rev": 0, "data": {"products": [{"name": "Invisible"}]}})
        data = {"profile": {"private": "HIDDEN"}, "workouts": [], "supps": [], "weights": [],
                "energyRules": {"2026-01-01": {"mode": "manual", "kcal": 1980}},
                "foodComplete": {"2026-02-14": True}, "products": [],
                "meals": [{"name": "Хлеб", "unit": "г", "date": "2026-02-14T08:00",
                           "nut": [250, 8, 2, 50], "amount": 40, "private": "HIDDEN"}]}
        self.profile("person1", {"rev": 0, "data": data})
        status, day = self.helper("/nutrition/days/2026-02-14")
        self.assertEqual((status, day["totals"], day["maintenance"], day["balance"]), (200, [100, 3.2, .8, 20], 1980, -1880))
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
        self.assertEqual((day["totals"], day["maintenance"], day["balance"]), ([190, 7.7, 5.3, 27.5], 1980, -1790))
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
            "profile": {"sex": "Мужской", "height": 180, "age": 30, "supps": ["Протеин"]},
            "weights": [{"kg": 80, "source": "manual", "date": day + "T07:00"}],
            "supps": [{"date": day, "names": ["Протеин"], "servings": 1, "perServing": [None, 22, None, None]}],
            "workouts": [{"date": day + "T12:00", "end": day + "T12:30", "kg": 80,
                          "cardio": [{"seconds": 1800, "kcal": 200}], "exercises": []}]}})
        # 2136 baseline plus 200 measured minus 44.5 baseline minutes, rounded by the owner report.
        code, summary = self.helper("/nutrition/days/" + day)
        self.assertEqual((code, summary["maintenance"], summary["totals"]), (200, 2292, [None, 22, None, None]))
        self.assertEqual(set(summary), {"day", "totals", "missing", "known", "count", "supplementProtein", "balance", "partialCalories", "meals", "maintenance"})
        self.assertEqual(summary["supplementProtein"], {"grams": 22, "incomplete": False})
        body = {**self.meal, "name": "Омлет", "unit": "г", "count": 2, "mode": "piece", "basis": "piece",
                "pieceName": "яйцо", "nut": [70, 6, 5, 0], "oil": {"grams": 5, "nut": [900, 0, 100, 0]}}
        status, receipt = self.helper("/nutrition/meals", body)
        self.assertEqual(status, 201)
        result = self.helper("/nutrition/meals/" + receipt["id"])[1]
        self.assertEqual((result["amount"], result["totals"], result["portion"]["count"]), (None, [185, 12, 15, 0], 2))
        day_data = self.helper("/nutrition/days/" + day)[1]
        self.assertEqual((day_data["totals"], day_data["known"], day_data["maintenance"]), ([None, 34, None, None], [185, 34, 15, 0], 2292))
        self.assertEqual((day_data["count"], day_data["balance"], day_data["partialCalories"]), (2, -2107, True))
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
