"""Drive the real ingress handler from the Playwright fixture over standard I/O."""
import base64
import json
import sys
from test_assistant import NutritionAssistant


def main():
    fixture = NutritionAssistant()
    fixture.setUp()
    try:
        fixture.profile("person1", {"rev": 0, "data": {
            "products": [{"name": "Йогурт", "unit": "г", "nut": [80, 4, 3, 9],
                          "sizes": {"package": 125}, "preferred": {"mode": "package", "count": 1}}],
            "energyRules": {"2026-01-01": {"mode": "manual", "kcal": 1950}}}})
        for line in sys.stdin:
            request = json.loads(line)
            status, data = fixture.call(request["path"], request.get("body"), user="helper")
            print(json.dumps({"i": request["i"], "status": status, "data": base64.b64encode(data).decode()}), flush=True)
    finally:
        fixture.doCleanups()


if __name__ == "__main__":
    main()
