import csv
import gzip
import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import food_catalog


class FoodSearchTest(unittest.TestCase):
    def test_index_handles_russian_aliases_typos_units_and_precise_numbers_before_limit(self):
        fields = ["name", "brand", "barcode", "barcodes", "country", *food_catalog.NUTRIENTS]
        rows = [[f"Творог {i},5% 200 г", "Марка", "", "", "ru", 80, 5, 2, 4] for i in range(25)]
        rows.extend([
            ["Творог 5% 180 г", "Северный", "00012345", "", "ru", 121, 16, 5, 3],
            ["Картофель отварной", "", "", "", "ru", 75, 2, 0.4, 15.8],
            ["Йогурт", "Марсель", "00012346", "", "fr", 61, 6, 2, 4],
        ])
        raw = io.StringIO()
        writer = csv.writer(raw)
        writer.writerow(fields)
        writer.writerows(rows)
        with TemporaryDirectory() as directory:
            cache = Path(directory) / "foods.sqlite"
            food_catalog.build(io.BytesIO(gzip.compress(raw.getvalue().encode())), cache, len(rows))
            cat = food_catalog.Catalog(cache, cache)
            find = lambda q: cat.lookup(q)["products"]
            for q in ["тварог 5%", "5% Тврог", "180 г северный творог", "творог 0,18 кг", "00012345"]:
                with self.subTest(query=q):
                    self.assertEqual([i["code"] for i in find(q)], ["00012345"])
            self.assertFalse(find("творог 5% 180 мл"))
            self.assertFalse(find("творог 5% 200 г"))
            self.assertEqual([i["code"] for i in find("5%")], ["00012345"])
            self.assertFalse(find("00012347"))
            self.assertEqual(find("варёная картошка")[0]["name"], "Картофель отварной")
            self.assertEqual(find("марселль йогурт")[0]["code"], "00012346")

    def test_profile_cards_keep_exact_identity_and_ignore_one_offs(self):
        normal = {"name": "Творог 5%", "code": "00123456", "quantity": "180 г"}
        hidden = {**normal, "oneOff": True}
        wrong = {"name": "Творог 0,5%", "code": "00123457"}
        for q in ["5% тврог", "тварог 0,18 кг", "00123456"]:
            with self.subTest(query=q):
                self.assertEqual(food_catalog.search_cards(q, [hidden, wrong, normal]), [normal])
        self.assertEqual(food_catalog.search_cards("00123458", [normal]), [])


if __name__ == "__main__":
    unittest.main()
