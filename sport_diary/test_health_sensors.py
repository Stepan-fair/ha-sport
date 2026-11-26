import json
import unittest
from unittest.mock import patch

import server
import test_sport


class HealthSensors(unittest.TestCase):
    call = test_sport.Sport.call
    profile = test_sport.Sport.profile

    def setUp(self):
        test_sport.Sport.setUp(self)
        self.settings.update(person1_health={
            "steps": "sensor.phone_steps", "sleep": "sensor.phone_sleep",
            "active": "sensor.active", "resting": "sensor.resting",
            "distance": "sensor.distance", "restingPulse": "sensor.pulse"},
            person2_health={"steps": "sensor.other_steps"},
            nutrition_assistant_user="helper", nutrition_assistant_profile="person1")
        self.configure()
        self.states = {}
        def core(path):
            return self.states.get(path.removeprefix("states/"))
        for obj, name, replacement in [(server, "core", core), (server, "diary_zone", lambda: "UTC")]:
            mock = patch.object(obj, name, replacement)
            mock.start()
            self.addCleanup(mock.stop)

    def configure(self):
        (server.DATA / "options.json").write_text(json.dumps(self.settings), encoding="utf8")

    def health(self, body=None, who="person1", user="u1", expected=200):
        code, raw = self.call("/health/" + who, body, user=user)
        self.assertEqual(code, expected, raw)
        return json.loads(raw)

    def sample(self, entity, value, unit, stamp="2026-02-15T01:00:00+00:00", **attrs):
        self.states[entity] = {"entity_id": entity, "state": value,
            "attributes": {"unit_of_measurement": unit, **attrs},
            "last_changed": stamp, "last_updated": stamp}

    def test_allowlist_consent_and_private_reads(self):
        self.assertEqual(self.health()["enabled"], [])
        for who, user in [("person1","helper"), ("person1","u2"), ("person2","helper")]:
            self.health(who=who, user=user, expected=403)
            self.health({"refresh":True}, who=who, user=user, expected=403)
        self.assertFalse(self.health(who="person2")["canManage"])
        self.health({"enabled":["steps"]}, who="person2", expected=403)
        self.health({"enabled":["sensor.other_steps"]}, expected=400)
        self.health({"bindings":{"steps":"sensor.other_steps"}}, expected=400)
        self.settings["person2_health"] = {"steps":"sensor.phone_steps", "sleep":"../bad"}
        self.configure()
        self.assertNotIn("steps", self.health()["bindings"])
        self.assertEqual(self.health(who="person2",user="u2")["bindings"], {})
        self.health({"enabled":["steps"]}, expected=400)
        self.settings["person2_health"] = []
        self.configure()
        self.assertEqual(self.health(who="person2",user="u2")["bindings"], {})

    def test_dated_counter_corrects_down_and_preserves_actual_date_on_failure(self):
        self.health({"enabled":["steps", "distance"]})
        self.sample("sensor.phone_steps","8000","steps", date="2026-02-14")
        self.sample("sensor.distance","3200","m", date="2026-02-14")
        self.health({"refresh":True})
        self.sample("sensor.phone_steps","7200","steps","2026-02-17T08:00:00Z", date="2026-02-14")
        self.sample("sensor.distance","unavailable","m")
        current = self.health({"refresh":True})
        self.assertEqual(current["status"]["distance"], "unavailable")
        rows = current["healthImported"]["daily"]
        self.assertEqual([(r["metric"],r["date"],r["value"],r["unit"]) for r in rows],
                         [("distance","2026-02-14",3.2,"km"), ("steps","2026-02-14",7200,"steps")])
        self.assertEqual(self.health({"refresh":True})["healthImported"]["daily"],rows)
        self.profile("person1", {"rev":0,"data":{"healthImported":{"sleep":[{"minutes":999}]},
                                "health":{"daily":{"2026-02-14":{"steps":{"value":10,"manual":True}}}}}})
        state = self.profile("person1")["data"]
        self.assertEqual(state["healthImported"],current["healthImported"])
        self.assertEqual(state["health"]["daily"]["2026-02-14"]["steps"]["value"],10)
        self.assertNotIn("healthImported",self.profile("person2")["data"])
        self.assertEqual(self.health({"enabled":[]})["healthImported"]["daily"],rows)
        self.assertEqual(self.health({"clear":["steps","distance"]})["healthImported"]["daily"],[])

    def test_dated_energy_requires_explicit_full_day_and_separate_source(self):
        self.health({"enabled":["active","resting"]})
        self.sample("sensor.active","1255.2","kJ",date="2026-02-14", source_device="watch A", coverage_complete=True)
        self.sample("sensor.resting","1500","kcal",date="2026-02-14", source_device="watch A")
        rows = self.health({"refresh":True})["healthImported"]["daily"]
        self.assertEqual([(r["source"],r["value"],r["complete"]) for r in rows],
                         [("watch A",300,True),("watch A",1500,False)])
        self.sample("sensor.resting","1500","kcal","2026-02-16T10:00:00Z",date="2026-02-14",
                    source_device="watch B", coverage_complete=True)
        self.assertNotEqual(*[r["source"] for r in self.health({"refresh":True})["healthImported"]["daily"]])

    def test_undated_sleep_needs_confirmation_once_and_stale_candidates_cannot_be_confirmed(self):
        self.health({"enabled":["sleep"]})
        self.sample("sensor.phone_sleep","7.5","h")
        snapshot = self.health({"refresh":True})
        self.assertEqual(snapshot["healthImported"]["sleep"],[])
        candidate = snapshot["candidates"][0]
        self.assertEqual(candidate["minutes"],450)
        self.health({"confirmSleep":candidate["id"],"date":"2026-02-27"},expected=400)
        self.assertEqual(self.health({"refresh":True})["candidates"],[candidate])
        saved = self.health({"confirmSleep":candidate["id"],"date":"2026-02-12"})
        night = saved["healthImported"]["sleep"][0]
        self.assertEqual((night["date"],night["minutes"],night["kind"]),("2026-02-12",450,"main"))
        self.assertNotIn("start",night)
        self.assertEqual(self.health({"refresh":True})["candidates"],[])
        self.health({"confirmSleep":candidate["id"],"date":"2026-02-13"},expected=409)
        self.sample("sensor.phone_sleep","440","min","2026-02-17T08:00:00Z",wake_date="2026-02-12")
        revised = self.health({"refresh":True})["healthImported"]["sleep"]
        self.assertEqual([(r["id"],r["minutes"]) for r in revised],[(night["id"],440)])

    def test_cached_activity_cannot_roll_over_and_recent_pulse_requires_sample_time(self):
        self.health({"enabled":["steps","restingPulse"]})
        self.sample("sensor.phone_steps",42,"steps")
        self.sample("sensor.pulse",56,"bpm")
        undated = self.health({"refresh":True})
        self.assertEqual(undated["healthImported"]["daily"],[])
        steps = next(row for row in undated["candidates"] if row["metric"] == "steps")
        self.assertEqual((steps["value"],steps["unit"]), (42,"steps"))
        self.health({"dismissReading":steps["id"]})
        self.sample("sensor.phone_steps",43,"steps","2026-02-15T23:55:00Z")
        self.sample("sensor.pulse",56,"bpm","2026-02-15T23:55:00Z",measured_at="2026-02-13T14:00:00Z")
        latest = self.health({"refresh":True})
        self.assertEqual(len(latest["candidates"]),1)
        self.health({"confirmReading":latest["candidates"][0]["id"],"date":"2026-02-14"})
        self.sample("sensor.phone_steps",43,"steps","2026-02-16T03:00:00Z")
        rows = self.health({"refresh":True})["healthImported"]["daily"]
        self.assertEqual([(r["date"],r["value"]) for r in rows],[("2026-02-13",56),("2026-02-14",43)])
        self.sample("sensor.phone_steps",3,"steps","2026-02-16T08:00:00Z")
        self.assertEqual(self.health({"refresh":True})["healthImported"]["daily"],rows)

    def test_in_flight_response_cannot_repopulate_cleared_consent(self):
        self.health({"enabled":["steps"]})
        self.sample("sensor.phone_steps",340,"steps",date="2026-02-14")
        def late(_path):
            self.health({"clear":["steps"]})
            self.health({"enabled":["steps"]})
            return self.states["sensor.phone_steps"]
        with patch.object(server,"core",late):
            self.assertEqual(self.health({"refresh":True})["healthImported"]["daily"],[])

    def test_in_flight_access_revocation_hides_private_snapshot(self):
        self.health({"enabled":["steps"]})
        self.sample("sensor.phone_steps",340,"steps",date="2026-02-14")
        self.health({"refresh":True})
        def revoked(_path):
            self.settings["person1_user"]="new-owner"
            self.configure()
            return self.states["sensor.phone_steps"]
        with patch.object(server,"core",revoked):
            self.assertEqual(self.health({"refresh":True},expected=403),{})

    def test_distinct_dates_with_identical_sleep_and_explicit_measurement_time(self):
        self.health({"enabled":["sleep","restingPulse"]})
        self.sample("sensor.pulse",55,"bpm",measured_at="2026-02-15T22:30:00Z")
        self.sample("sensor.phone_sleep",420,"min",wake_date="2026-02-14")
        self.assertEqual(self.health({"refresh":True})["status"]["restingPulse"],"invalid")
        self.sample("sensor.phone_sleep",420,"min","2026-02-16T08:00:00Z",wake_time="2026-02-16T01:50:00+03:00")
        rows = self.health({"refresh":True})["healthImported"]["sleep"]
        self.assertEqual([(r["date"],r["minutes"]) for r in rows],[("2026-02-14",420),("2026-02-15",420)])

    def test_rebinding_requires_new_consent_and_wrong_entity_or_unit_cannot_write(self):
        self.health({"enabled":["steps"]})
        self.settings["person1_health"]["steps"]="sensor.new"
        self.configure()
        self.assertEqual(self.health({"refresh":True})["enabled"],[])
        self.health({"enabled":["steps"]})
        self.sample("sensor.new",30,"kg",date="2026-02-14")
        self.assertEqual(self.health({"refresh":True})["status"]["steps"],"invalid")
        self.sample("sensor.new",30,"steps",date="2026-02-14")
        self.states["sensor.new"]["entity_id"]="sensor.wrong"
        self.assertEqual(self.health({"refresh":True})["healthImported"]["daily"],[])

    def test_sensor_ranges_match_day_and_sleep_model_at_both_limits(self):
        cases = {
            "steps": ("steps", [0, 300000], [-1, 1.5, 340000]),
            "distance": ("km", [0, 1000], [-1, 1001]),
            "exercise": ("min", [0, 1440], [-1, 1441]),
            "active": ("kcal", [0, 30000], [-1, 30001]),
            "resting": ("kcal", [0, 15000], [-1, 15001]),
            "restingPulse": ("bpm", [1, 300], [0, .5, 301]),
            "sleep": ("min", [1, 1440], [-1, 0, 1441])}
        self.settings["person1_health"] = {k: "sensor.test_"+k.lower() for k in cases}
        self.configure()
        for metric,(unit,valid,invalid) in cases.items():
            with self.subTest(metric=metric):
                self.health({"enabled":[metric]})
                entity = self.settings["person1_health"][metric]
                for value in valid:
                    self.sample(entity,value,unit,date="2026-02-14",wake_date="2026-02-14")
                    self.assertEqual(self.health({"refresh":True})["status"][metric],"ok")
                saved = self.health()["healthImported"]
                for value in invalid:
                    self.sample(entity,value,unit,date="2026-02-14",wake_date="2026-02-14")
                    snapshot = self.health({"refresh":True})
                    self.assertEqual(snapshot["status"][metric],"invalid",value)
                    self.assertEqual(snapshot["healthImported"],saved)

    def test_admin_selects_provider_date_attribute_for_sleep(self):
        self.settings["person1_health_dates"] = {"sleep":"Actual wake time"}
        self.configure()
        self.health({"enabled":["sleep"]})
        self.sample("sensor.phone_sleep",410,"min",**{"Actual wake time":"2026-02-14T08:00:00+03:00"})
        snap = self.health({"refresh":True})
        self.assertEqual(snap["healthImported"]["sleep"][0]["date"],"2026-02-14")
        self.assertEqual(snap["candidates"],[])

    def test_day_uses_configured_diary_timezone_at_midnight(self):
        self.health({"enabled":["sleep"]})
        self.sample("sensor.phone_sleep",402,"min",wake_time="2026-02-14T02:50:00Z")
        with patch.object(server, "diary_zone", lambda:"America/New_York"):
            snap = self.health({"refresh":True})
        self.assertEqual(snap["healthImported"]["sleep"][0]["date"],"2026-02-13")
        self.sample("sensor.phone_sleep",360,"min","2026-02-15T08:00:00Z",
                    sleep_start="2026-02-14T17:30:00-08:00",sleep_end="2026-02-14T23:30:00-08:00")
        self.health({"refresh":True})
        row = self.profile("person1")["data"]["healthImported"]["sleep"][-1]
        self.assertEqual((row["date"],row["start"],row["end"]),
                         ("2026-02-15","2026-02-14T17:30:00-08:00","2026-02-14T23:30:00-08:00"))

    def test_only_real_sleep_boundaries_can_accompany_duration(self):
        self.health({"enabled":["sleep"]})
        self.sample("sensor.phone_sleep",330,"min","2026-02-15T11:00:00Z",
                    sleep_start="2026-02-14T23:00:00-05:00",sleep_end="2026-02-15T05:00:00-05:00")
        rows = self.health({"refresh":True})["healthImported"]["sleep"]
        self.assertEqual((rows[0]["start"],rows[0]["end"]),("2026-02-14T23:00:00-05:00","2026-02-15T05:00:00-05:00"))
        self.sample("sensor.phone_sleep",600,"min","2026-02-15T11:05:00Z",
                    sleep_start="2026-02-15T04:00:00Z",sleep_end="2026-02-15T10:00:00Z")
        snap = self.health({"refresh":True})
        self.assertEqual(snap["status"]["sleep"],"invalid")
        self.assertEqual(snap["healthImported"]["sleep"],rows)

    def test_helper_gets_maintenance_without_private_sensor_data(self):
        self.health({"enabled":["active","resting","sleep"]})
        for metric, value in (("active",440),("resting",1520)):
            self.sample("sensor."+metric, value, "kcal",date="2026-02-14",
                        source_device="private watch",coverage_complete=True)
        self.sample("sensor.phone_sleep",444,"min",wake_date="2026-02-14")
        self.health({"refresh":True})
        self.profile("person1", {"rev":0,"data":{"energyRules":{"2026-02-01":{"mode":"auto"}}}})
        status, raw = self.call("/nutrition/days/2026-02-14",user="helper")
        self.assertEqual(status,200,raw)
        data = json.loads(raw)
        self.assertEqual(data["maintenance"],1960)
        for private in (b"private watch",b"sensor.",b"sleep",b"healthImported",b"resting"):
            self.assertNotIn(private,raw)
