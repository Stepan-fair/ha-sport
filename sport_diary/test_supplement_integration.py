"""Product events through the existing revision-checked profile API; isolated SQLite only."""
import json
import subprocess
import unittest
from pathlib import Path

import test_assistant
import test_sport


class SupplementIntegration(unittest.TestCase):
    call = test_sport.Sport.call
    profile = test_sport.Sport.profile
    setUp = test_assistant.NutritionAssistant.setUp
    configure = test_assistant.NutritionAssistant.configure
    helper = test_assistant.NutritionAssistant.helper
    propose = test_assistant.NutritionAssistant.propose
    decide = test_assistant.NutritionAssistant.decide

    def product_state(self):
        script = '''const p=require('./web/supplement-products');
const s={profile:{supps:['Протеин','Креатин','Железо']},meals:[],supps:[]};
p.saveEvent(s,{id:'shake-one',name:'Протеин',date:'2026-02-14T09:00',period:'Утро'});
p.saveEvent(s,{id:'iron-one',name:'Ферромальт',date:'2026-02-14T09:00',period:'Утро'});
p.saveEvent(s,{id:'iron-one',name:'Ферромальт',date:'2026-02-14T09:00',period:'Утро'});
console.log(JSON.stringify(s));'''
        return json.loads(subprocess.check_output(['node', '-e', script], cwd=Path(__file__).parent, text=True))

    def test_profile_contract_receipt_and_stale_disabled_device(self):
        data = self.product_state()
        self.assertEqual(len(data['supps']), 2)
        self.assertEqual(data['supps'][1]['productSnapshot']['ironMg'], 100)
        self.profile('person1', {'rev': 0, 'data': data})
        self.assertEqual(self.call('/profile/person1', {'rev': 0, 'data': data})[0], 409)
        old = self.profile('person1')
        disabled = json.loads(json.dumps(old['data']))
        disabled['profile']['supps'] = []
        self.profile('person1', {'rev': old['rev'], 'data': disabled})
        self.assertEqual(self.call('/profile/person1', {'rev': old['rev'], 'data': data})[0], 409)
        current = self.profile('person1')['data']
        self.assertEqual(len(current['supps']), 2)
        self.assertEqual(len(current['meals']), 1)
        self.assertEqual(self.profile('person2')['data'], {})
        self.assertEqual(self.call('/profile/person1', user='u2')[0], 403)

    def test_nutrition_assistant_sees_only_enabled_protein_recipe_and_no_private_iron(self):
        self.profile('person1', {'rev': 0, 'data': self.product_state()})
        code, recipe = self.helper('/nutrition/protein-recipe/2026-02-14')
        self.assertEqual(code, 200)
        self.assertEqual(recipe['oneServing']['milkMl'], 300)
        self.assertAlmostEqual(recipe['oneServing']['totals'][0], 289.52)
        self.assertNotIn('Ферромальт', json.dumps(recipe, ensure_ascii=False))
        self.assertEqual(self.call('/nutrition/protein-recipe/2026-02-14', user='u2')[0], 403)
        current = self.profile('person1')
        current['data']['profile']['supps'] = ['Железо']
        self.profile('person1', {'rev': current['rev'], 'data': current['data']})
        self.assertEqual(self.helper('/nutrition/protein-recipe/2026-02-14'), (200, None))

    def test_owner_approved_meal_correction_updates_snapshot_and_both_dates_once(self):
        self.profile('person1', {'rev': 0, 'data': self.product_state()})
        saved = self.helper('/nutrition/meals/supp-meal-shake-one')[1]
        code, proposal = self.propose('meal', saved, {'count': 2, 'date': '2026-02-15T19:00'})
        self.assertEqual(code, 201)
        self.assertEqual(self.decide(proposal, 'approve')[0], 200)
        self.assertEqual(self.decide(proposal, 'approve')[0], 200)
        actual = self.helper('/nutrition/days/2026-02-15')[1]
        self.assertAlmostEqual(actual['totals'][0], 579.04)
        current = self.profile('person1')['data']
        shake = next(e for e in current['supps'] if e['id'] == 'shake-one')
        self.assertEqual(shake['date'], '2026-02-15T19:00')
        self.assertEqual(shake['productSnapshot']['milkMl'], 600)
        self.assertEqual(shake['productSnapshot']['powderGrams'], 60)
        self.assertEqual(shake['productSnapshot']['recipe']['milk']['ml'], 300)
        self.assertEqual(self.helper('/nutrition/days/2026-02-14')[1]['count'], 0)
