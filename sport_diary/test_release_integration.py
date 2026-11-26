"""Cross-check the ingress API, stored observations, report periods and assistant projection."""

import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import test_health_sensors


ROOT = Path(__file__).resolve().parent
REPORT = """
const {diaryReport} = require('./web/reports');
const {state, day} = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const periods = ['day', 'week', 'month', 'year'].map(period => {
  const result = diaryReport(state, [], '', day, period);
  const row = result.rows.find(row => row.day === day);
  const goal = result.nutritionGoals.rows.find(row => row.day === day);
  return {period, maintenance:row.maintenance, balance:row.balance, points:result.periodPoints,
    sleep:row.health?.sleepPoints || 0, pause:row.health?.mealPoints || 0,
    nights:result.health.nights, target:goal.protein.target, protein:goal.protein.known,
    creatine:goal.creatine.actual, sessions:row.workouts, minutes:row.minutes,
    active:row.active, base:row.base, method:row.energyMethod};
});
process.stdout.write(JSON.stringify(periods));
"""


class ReleaseIntegration(unittest.TestCase):
    setup_source = test_health_sensors.HealthSensors
    call = setup_source.call
    configure = setup_source.configure
    profile = setup_source.profile
    health = setup_source.health
    sample = setup_source.sample

    def setUp(self):
        self.enterContext(patch.dict("os.environ", {"TZ": "UTC"}))
        self.setup_source.setUp(self)

    def node(self, program, payload):
        result = subprocess.run(["node", "-e", program], cwd=ROOT,
                                input=json.dumps(payload), encoding="utf8",
                                capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def reports(self, day):
        return self.node(REPORT, {"state": self.profile("person1")["data"], "day": day})

    def helper_day(self, day):
        code, raw = self.call("/nutrition/days/" + day, user="helper")
        self.assertEqual(code, 200, raw)
        return json.loads(raw)

    def test_date_confirmation_and_complete_energy_reach_only_the_permitted_views(self):
        day = "2026-02-14"
        food = {"date": day + "T12:00", "name": "Food", "id": "m",
                "unit": "г", "amount": 100, "totals": [400, 22, 10, 30]}
        self.profile("person1", {"rev": 0, "data": {
            "meals": [food], "health": {"settings": {"sleepBonus": True, "sleepGoalMinutes": 420}}}})
        self.health({"enabled": ["sleep", "active", "resting"]})
        self.sample("sensor.phone_sleep", 420, "min")
        for metric, value in (("active", 500), ("resting", 1700)):
            self.sample("sensor." + metric, value, "kcal", date=day,
                        source_device="private-watch", coverage_complete=True)
        watch = self.health({"refresh": True})
        candidate = watch["candidates"][0]["id"]
        self.assertEqual(watch["healthImported"]["sleep"], [])
        # An unchanged last-night sensor can be delivered on a later day without
        # establishing the measured night. Only the owner's confirmation creates it.
        self.sample("sensor.phone_sleep", 420, "min", "2026-02-16T11:00:00Z")
        self.assertEqual(self.health({"refresh": True})["candidates"][0]["id"], candidate)
        self.health({"confirmSleep": candidate, "date": day})
        self.health({"confirmSleep": candidate, "date": "2026-02-15"}, expected=409)
        self.assertEqual(self.health({"refresh": True})["candidates"], [])
        for row in self.reports(day):
            self.assertEqual((row["nights"], row["sleep"], row["pause"]), (1, 2, 0), row)
            self.assertEqual((row["maintenance"], row["balance"]), (2200, -1800), row)
        helper = self.helper_day(day)
        self.assertEqual((helper["maintenance"], helper["balance"]), (2200, -1800))
        self.assertFalse({"sleep", "health", "healthImported", "daily", "steps", "restingPulse"} & helper.keys())
        self.assertNotIn("private-watch", json.dumps(helper))
        self.assertNotIn("healthImported", self.profile("person2")["data"])
        for user in ("u2", "helper"):
            for path in ("/health/person1", "/profile/person1"):
                self.assertEqual(self.call(path, user=user)[0], 403, (user, path))
        self.sample("sensor.active", 450, "kcal", "2026-02-17T09:00:00Z",
                    date=day, source_device="private-watch", coverage_complete=False)
        self.health({"refresh": True})
        self.assertIsNone(self.helper_day(day)["maintenance"])
        self.assertTrue(all(row["maintenance"] is None for row in self.reports(day)))

    def test_past_meal_correction_recalculates_all_periods_and_rejects_a_stale_owner(self):
        day = "2026-02-14"
        meal = {"id": "dinner", "name": "Dinner", "unit": "г", "amount": 100,
                "totals": [400, 30, 10, 20], "date": "2026-02-13T20:30",
                "sleepMealKind": "substantial", "actualConfirmed": True,
                "actualEnd": "2026-02-13T21:15:00+03:00"}
        episode = {"id": "main", "kind": "main", "source": "manual", "date": day, "minutes": 420,
                   "start": "2026-02-13T23:45:00+03:00", "end": day + "T07:15:00+03:00",
                   "awakeMinutes": 30, "mealsComplete": True}
        self.profile("person1", {"rev": 0, "data": {"meals": [meal],
            "health": {"sleep": [episode], "settings": {"sleepBonus": True, "mealBonus": True}}}})
        stale = self.profile("person1")
        before = self.reports(day)
        self.assertTrue(all((row["pause"], row["sleep"]) == (1, 2) for row in before))
        current = self.profile("person1")
        current["data"]["meals"][0]["sleepMealKind"] = "light"
        self.profile("person1", current)
        self.assertEqual(self.call("/profile/person1", stale)[0], 409)
        after = self.reports(day)
        for old, new in zip(before, after, strict=True):
            self.assertEqual((new["pause"], new["sleep"], new["nights"]), (0, 2, 1), new)
            self.assertEqual(new["points"], old["points"] - 1, new["period"])
        self.assertEqual(self.profile("person2")["data"], {})

    def test_corrected_weight_respects_next_measurement_and_preserves_recorded_nutrients(self):
        first, second = "2026-02-10", "2026-02-14"
        auto = {"mode": "auto", "birth": "1990-01-01", "strength": True}
        state = {"proteinGoals": {first: auto},
                 "weights": [{"date": first + "T08:00", "source": "manual", "kg": 80},
                             {"date": second + "T08:00", "source": "manual", "kg": 90}],
                 "meals": [], "supps": []}
        for day in (first, second):
            state["meals"].append({"date": day + "T13:00", "id": "m" + day, "name": "Food",
                                   "amount": 100, "unit": "г", "totals": [200, 30, 5, 9]})
            state["supps"].append({"date": day + "T13:00", "names": ["Креатин"],
                                   "servings": 2, "creatinePerServing": 3})
        self.profile("person1", {"rev": 0, "data": state})
        for day, target in ((first, 128), (second, 144)):
            self.assertTrue(all(row["target"] == target for row in self.reports(day)))
        current = self.profile("person1")
        current["data"]["weights"][0]["kg"] = 70
        self.profile("person1", current)
        for day, target in ((first, 112), (second, 144)):
            for row in self.reports(day):
                self.assertEqual((row["target"], row["protein"], row["creatine"]), (target, 30, 6), row)
            self.assertEqual(self.helper_day(day)["known"][1], 30)

    def test_repeated_import_and_treadmill_do_not_add_to_full_daily_energy(self):
        day = "2026-02-14"
        gym = {"id": "gym", "type": "strength", "date": day + "T18:00Z", "end": day + "T19:00Z",
               "exercises": [{"name": "A", "sets": [{"kg": 40, "reps": 10, "done": True}]}],
               "cardio": [{"activity": "Дорожка", "seconds": 600, "kcal": 55}]}
        state = {"profile": {"height": 180, "birth": "1990-01-01", "sex": "Мужской"},
                 "weights": [{"date": day + "T08:00", "source": "manual", "kg": 80}],
                 "workouts": [gym]}
        state = self.node("""
const H = require('./web/health');
const {state, day} = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const watch = {id:'workout',name:'strength',source:'Watch',
  start:day+'T18:00Z',end:day+'T19:00Z',activeKcal:300,totalKcal:390};
const treadmill = {id:'treadmill',name:'running',source:'Watch',
  start:day+'T18:00Z',end:day+'T18:10Z',activeKcal:55};
const [whole] = H.importWorkouts(state, [watch,treadmill]);
H.linkWorkout(state, whole.id, 'gym');
H.importWorkouts(state, [treadmill,watch]);
process.stdout.write(JSON.stringify(state));
""", {"state": state, "day": day})
        self.profile("person1", {"rev": 0, "data": state})
        for row in self.reports(day):
            self.assertEqual((row["sessions"], row["minutes"], row["active"], row["method"]),
                             (1, 60, 300, "workout"), row)
            self.assertEqual(row["maintenance"], row["base"] + 300, row)
            self.assertEqual(self.helper_day(day)["maintenance"], row["maintenance"])
        self.health({"enabled": ["active", "resting"]})
        for metric, value in (("active", 500), ("resting", 1700)):
            self.sample("sensor." + metric, value, "kcal", date=day,
                        source_device="Watch", coverage_complete=True)
        self.health({"refresh": True})
        for row in self.reports(day):
            self.assertEqual((row["sessions"], row["minutes"], row["active"], row["maintenance"], row["method"]),
                             (1, 60, 500, 2200, "daily"), row)
        self.assertEqual(self.helper_day(day)["maintenance"], 2200)
