"""Drive the real ingress handler from the Playwright fixture over standard I/O."""
import base64
import json
import sys
from unittest.mock import patch
import server
from test_assistant import NutritionAssistant


def main():
    fixture = NutritionAssistant()
    fixture.setUp()
    try:
        fixture.enterContext(patch.object(server.catalog, "lookup", return_value={"status": "ready", "products": []}))
        fixture.profile("person1", {"rev": 0, "data": {
            "products": [{"name": "Йогурт", "unit": "г", "nut": [80, 4, 3, 9],
                          "sizes": {"package": 125}, "preferred": {"mode": "package", "count": 1}},
                         {"name": "Тестовая яичница", "unit": "г", "basis": "piece", "pieceName": "яйцо",
                          "nut": [70, 6, 5, 0]}],
            "meals": [{"id": "fixture-intake", "date": "2026-02-14T08:00", "name": "Завтрак", "unit": "г",
                       "amount": 100, "nut": [400, 15, 20, 40], "totals": [400, 15, 20, 40]}],
            "energyRules": {"2026-01-01": {"mode": "manual", "kcal": 1950}}}})
        for line in sys.stdin:
            request = json.loads(line)
            user = request.get("user", "helper")
            if user not in {"u1", "u2", "helper"}:
                raise ValueError("Unknown test account")
            status, data = fixture.call(request["path"], request.get("body"), user=user)
            print(json.dumps({"i": request["i"], "status": status, "data": base64.b64encode(data).decode()}), flush=True)
    finally:
        fixture.doCleanups()


if __name__ == "__main__":
    main()
