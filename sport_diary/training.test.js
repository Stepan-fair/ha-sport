const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const L=require('./web/logic'),catalog=require('./web/catalog.json');
const smith='Ягодичный мост в тренажёре Смита',barbell='Хип-траст со штангой';
const profile={equipment:[smith,barbell,'Жим ногами под 45°','Скручивания на полу'],minutes:60,step:2.5,workingSets:3,goal:'Общая форма'};
const date='2026-01-12T10:00';
function completed(day,name,kg,n=3){return {date:`2026-01-${day}T10:00`,exercises:[{name,plannedSets:n,sets:Array.from({length:n},()=>({kg,reps:12,done:true}))}]}}
test('Hip thrust variants preserve Smith identity and separate actual weights, notes and progress',()=>{
 assert.equal(catalog[smith].group,'Ягодицы');assert.equal(L.exerciseLabel(smith),'Хип-траст в тренажёре Смита');
 assert.equal(catalog[barbell].equipment,'barbell');assert.notEqual(catalog[smith].equipment,catalog[barbell].equipment);
 const history=[completed('09',smith,50),completed('06',smith,50)];
 const before=JSON.stringify(history);
 assert.equal(L.exerciseFor(smith,profile,history,date).prescription[0].kg,52.5);
 assert.equal(L.exerciseFor(barbell,profile,history,date).prescription[0].kg,0);
 assert.equal(JSON.stringify(history),before);
 assert.equal(new Set(Object.values(catalog).filter(g=>g.group!=='Кардио').map(g=>g.group)).size,7);
});
test('New sets have blank facts and an explicit preparation role; deleting it never retypes working rows',()=>{
 const e=L.exerciseFor(barbell,profile,[],date);
 assert.equal(e.plannedSets,3);assert.equal(e.prescription.length,3);assert.equal(e.sets.length,4);
 assert.equal(e.sets[0].warmup,true);assert.ok(e.sets.slice(1).every(t=>t.warmup===false));
 assert.ok(e.sets.every(t=>t.kg===null&&t.reps===null&&!t.done));
 e.sets.shift();assert.ok(e.sets.every(t=>!t.warmup));assert.equal(e.plannedSets,3);
 const old={name:smith,sets:[{kg:50,reps:12,done:true},{kg:50,reps:12,done:true},{kg:50,reps:12,done:true}]};
 assert.deepEqual(L.confirmedSets(old,{showSetDone:true}),old.sets);assert.equal(old.sets[0].warmup,undefined);
});
test('Automatic completion accepts real zero kg, rejects partial input, ignores untouched hints and legacy draft prefills',()=>{
 const e=L.exerciseFor(barbell,profile,[],date);
 assert.equal(L.confirmedSets(e,{showSetDone:false}).filter(t=>t.done).length,0);
 Object.assign(e.sets[1],{kg:0,reps:10});Object.assign(e.sets[2],{kg:20,reps:8});
 assert.equal(L.confirmedSets(e,{showSetDone:false}).filter(t=>t.done).length,2);
 assert.equal(L.confirmedSets(e,{showSetDone:true}).filter(t=>t.done).length,0);
 e.sets[1].done=true;assert.equal(L.confirmedSets(e,{showSetDone:true}).filter(t=>t.done).length,1);
 e.sets[3].kg=10;assert.throws(()=>L.confirmedSets(e,{showSetDone:false}),/неполном/);
 const legacy={sets:[{kg:50,reps:10,done:false}]};assert.equal(L.confirmedSets(legacy,{showSetDone:false})[0].done,false);
 legacy.sets[0].factInput=true;assert.equal(L.confirmedSets(legacy,{showSetDone:false})[0].done,true);
});
test('Each cardio preference is profile-local; disabling all machines retains equipment-free warm-up and budget',()=>{
 for(const activity of L.cardioMachines){
  const p={...profile,cardioEquipment:[activity],warmupActivity:activity};
  const d=L.buildWorkoutPlan({profile:p,workouts:[]},date);
  assert.equal(d.timing.cardio[0].activity,activity);assert.ok(L.estimateWorkout(d.exercises,d.timing).total<=60);
  assert.ok(d.exercises.length<=2);assert.ok(d.exercises.every(e=>e.sets.filter(t=>t.warmup).length===1));
 }
 const a={...profile,cardioEquipment:[],warmupActivity:'Дорожка'},b={...profile,cardioEquipment:['Велотренажёр'],warmupActivity:'Велотренажёр'};
 assert.equal(L.warmupChoice(a).activity,'Разминка без тренажёров');assert.match(L.warmupChoice(a).notice,/отключена/);
 assert.equal(L.warmupChoice(b).activity,'Велотренажёр');assert.deepEqual(a.cardioEquipment,[]);
});
test('Stair, cycle, elliptical and movement estimates use their own MET; skip ignores stale duration and calories',()=>{
 const base={date:'2026-01-01T10:00',end:'2026-01-01T10:10',kg:80,exercises:[]};
 for(const [activity,met] of [['Лестница',9.3],['Велотренажёр',6.8],['Эллипсоид',5],['Гребной тренажёр',5],['Динамическая разминка',3.5]]){
  const c={activity,seconds:600,speed:25,incline:25};assert.equal(L.cardioMet(c),met);
  assert.ok(Math.abs(L.workoutEnergy({...base,cardio:[c]}).gross-met*14)<.00001);
  assert.equal(L.workoutEnergy({...base,cardio:[{...c,kcal:50}]}).gross,50);
 }
 const skipped={...base,cardio:[{activity:'Дорожка',skipped:true,seconds:9999,kcal:500}]};
 assert.equal(L.total(skipped).consoleKcal,0);assert.equal(L.workoutEnergy(skipped).minutes,0);
 assert.equal(L.workoutEnergy(skipped).gross,null);
 assert.deepEqual(L.cardioFields['Лестница'],['stairs','floors','cadence']);assert.equal(L.cardioFields['Суставная разминка'],undefined);
});
test('Disabled new input is excluded while saved disabled facts survive unrelated edits and totals',()=>{
 const saved={exercises:[{name:smith,sets:[{kg:50,reps:12,done:true}]}],cardio:[{role:'Разминка',activity:'Дорожка',seconds:300,kcal:30}]};
 const next={exercises:[{name:smith,sets:[{kg:90,reps:15,done:true}]},{name:barbell,sets:[{kg:20,reps:10,done:true}]}],cardio:[{role:'Разминка',activity:'Дорожка',seconds:600,kcal:60},{role:'Заминка',skipped:true}]};
 const p={equipment:[barbell],cardioEquipment:[]};
 const filtered=L.applyWorkoutVisibility(next,p,saved);
 assert.deepEqual(filtered.exercises.find(e=>e.name===smith),saved.exercises[0]);assert.deepEqual(filtered.cardio.find(c=>c.activity==='Дорожка'),saved.cardio[0]);
 assert.equal(L.applyWorkoutVisibility(next,p).exercises.length,1);assert.equal(L.applyWorkoutVisibility(next,p).cardio.length,1);
 assert.equal(next.exercises[0].sets[0].kg,90);
});
function harness(p={}){
 const storage=new Map(),nodes=new Map(),entries=new Map(),listeners={};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',dataset:{}});return nodes.get(id)};
 entries.set('profile/person1',{rev:1,data:{profile:{...profile,...p},workouts:[],weights:[],meals:[],supps:[]}});
 const ctx=vm.createContext({document:{getElementById:node,querySelector:node,querySelectorAll:()=>[],addEventListener(t,fn){(listeners[t]||=[]).push(fn)}},crypto:require('crypto'),structuredClone,confirm:()=>true,
 localStorage:{get length(){return storage.size},key:i=>[...storage.keys()][i],removeItem:k=>storage.delete(k),getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
 fetch:async(url,options)=>({ok:true,json:async()=>{if(url==='profiles')return [{id:'person1',name:'Первый'}];if(url.startsWith('weight'))return [];if(options?.body){const b=JSON.parse(options.body);entries.set(url,{data:b.data,rev:b.rev+1})}return entries.get(url)||{data:{},rev:0}}})});
 ctx.exerciseCatalog=catalog;ctx.foodWords=require('./web/food-words.json');ctx.exercisePhotoBase='photos/';
 for(const f of ['logic','foods','portions','goals','health','reports','goals-view','health-view','report-view','app'])vm.runInContext(fs.readFileSync(path.join(__dirname,'web',f+'.js'),'utf8'),ctx);
 const run=s=>vm.runInContext(s,ctx);
 return {run,node,entries,listeners,async start(){await run('load()');run('selectDay("2026-01-01")');node('start').value='2026-01-01T10:00';await run('action("start")');node('end').value='2026-01-01T11:00';run('draft.end="2026-01-01T11:00";tab=1')}};
}
test('UI separates plan from fact, hides done/warmup toggles, saves exactly entered rows and explicit cardio skip',async()=>{
 const h=harness({showSetDone:false});await h.start();const {run,node,listeners}=h;
 assert.doesNotMatch(run('workout()'),/data-k="done"|data-k="warmup"/);assert.match(run('workout()'),/Подводящий подход/);
 assert.match(run('workout()'),/id="k0_1"[^>]*value=""[^>]*placeholder="0"/);
 run('Object.assign(draft.exercises[0].sets[1],{kg:0,reps:10});Object.assign(draft.exercises[0].sets[2],{kg:20,reps:9});draft.cardio[0]={activity:"Дорожка",time:"8:00",kcal:80}');
 const select={id:'',dataset:{c:'0',f:'activity'},value:'skipped',closest:()=>null,matches:()=>false};
 for(const fn of listeners.input)fn({target:select});assert.equal(run('draft.cardio[0].skipped'),true);assert.doesNotMatch(run('cardioBlock(0)'),/id="sec0"/);
 select.value='Дорожка';for(const fn of listeners.input)fn({target:select});assert.equal(run('draft.cardio[0].time'),'8:00');
 select.value='';for(const fn of listeners.input)fn({target:select});assert.equal(run('hasCardioResult(draft.cardio[0])'),false);
 select.value='Дорожка';for(const fn of listeners.input)fn({target:select});assert.equal(run('draft.cardio[0].time'),'8:00');
 select.value='skipped';for(const fn of listeners.input)fn({target:select});
 await run('action("finish")');const w=h.entries.get('profile/person1').data.workouts[0];
 assert.equal(w.exercises.flatMap(e=>e.sets).filter(t=>t.done).length,2);assert.deepEqual(w.cardio,[{role:'Разминка',skipped:true}]);
 assert.equal(w.exercises[0].sets[1].kg,0);assert.equal(w.exercises[0].prescription[1].kg,0);
});
test('Fresh settings at finish prevent hidden facts, and historical legacy first row is never reclassified',async()=>{
 const h=harness({showSetDone:false});await h.start();const {run,entries}=h;
 const hidden=run('draft.exercises[0].name');
 run('draft.exercises.forEach(e=>Object.assign(e.sets[1],{kg:10,reps:10}));retain()');
 entries.get('profile/person1').data.profile.equipment=entries.get('profile/person1').data.profile.equipment.filter(n=>n!==hidden);
 await assert.rejects(()=>run('action("finish")'),/незаписанный ввод/);
 assert.equal(run('draft.exercises[0].sets[1].kg'),10);
 entries.get('profile/person1').data.profile.equipment.push(hidden);await run('load()');await run('action("remove-0")');
 await run('action("finish")');assert.ok(entries.get('profile/person1').data.workouts[0].exercises.every(e=>e.name!==hidden));
 const old={id:'legacy',date:'2026-01-02T10:00',end:'2026-01-02T11:00',exercises:[{name:barbell,sets:[{kg:30,reps:8,done:true},{kg:30,reps:8,done:true},{kg:30,reps:8,done:true}]}],cardio:[]};
 entries.get('profile/person1').data.profile.equipment=[barbell];entries.get('profile/person1').data.workouts.push(old);
 await run('load()');await run('action("edit-workout-legacy")');
 h.node('start').value=old.date;h.node('end').value=old.end;run('draft.exercises[0].sets[0].reps=9');await run('action("finish")');
 const edited=entries.get('profile/person1').data.workouts.find(w=>w.id==='legacy');
 assert.equal(edited.exercises[0].sets.length,3);assert.equal(edited.exercises[0].sets[0].warmup,undefined);assert.equal(edited.exercises[0].sets[0].reps,9);
});
test('Separate cardio keeps its role, equipment fields and elapsed time, then survives edit',async()=>{
 const h=harness({showSetDone:false,cardioEquipment:['Лестница'],warmupActivity:'Суставная разминка'});await h.start();
 const {run}=h;
 await run('action("add-cardio")');
 assert.match(run('cardioBlock(2)'),/Кардио/);assert.doesNotMatch(run('cardioBlock(2)'),/id="speed2"/);
 run('draft.cardio[2]={role:"Кардио",activity:"Лестница",time:"10:30",stairs:"350",floors:"20",cadence:"33",speed:"25",incline:"20"}');
 assert.match(run('cardioBlock(2)'),/id="stairs2"/);assert.doesNotMatch(run('cardioBlock(2)'),/id="speed2"|id="power2"/);
 assert.match(run('planOverview(draft)'),/Отдельное кардио/);
 await run('action("finish")');
 const saved=h.entries.get('profile/person1').data.workouts[0];
 assert.equal(saved.cardio.length,1);assert.equal(saved.cardio[0].role,'Кардио');assert.equal(saved.cardio[0].seconds,630);
 assert.equal(saved.cardio[0].stairs,350);assert.equal(saved.cardio[0].speed,undefined);assert.equal(saved.cardio[0].incline,undefined);
 await run('action("edit-workout-"+state.workouts[0].id)');assert.equal(run('draft.cardio[2].role'),'Кардио');assert.equal(run('draft.cardio[2].time'),'10:30');
});
test('Deleting a new preparation row reduces time without implicitly adding another preparation',()=>{
 const e=L.exerciseFor(barbell,profile,[],date),timing={budget:60,pace:1,cardio:[]};
 const before=L.estimateWorkout([e],timing);e.sets.shift();const after=L.estimateWorkout([e],timing);
 assert.equal(before.blocks[0].ramp,1);assert.equal(after.blocks[0].ramp,0);assert.ok(after.total<before.total);
});

test('Switching to automatic confirmation does not promote an untouched unconfirmed historical row',()=>{
 const e={entrySchema:2,editingSaved:true,sets:[{kg:20,reps:10,done:false,factInput:false},{kg:20,reps:10,done:true,factInput:false}]};
 assert.deepEqual(L.confirmedSets(e,{showSetDone:false}).map(t=>t.done),[false,true]);
 e.sets[0].factInput=true;assert.deepEqual(L.confirmedSets(e,{showSetDone:false}).map(t=>t.done),[true,true]);
});

test('Hidden cardio input blocks completion and remains recoverable, unchanged saved hidden facts do not block',async()=>{
 const h=harness({showSetDone:false});await h.start();const {run,entries}=h;
 run('Object.assign(draft.exercises[0].sets[1],{kg:0,reps:10});draft.cardio[0]={activity:"Дорожка",time:"5:00",kcal:40}');
 entries.get('profile/person1').data.profile.cardioEquipment=[];
 await assert.rejects(()=>run('action("finish")'),/незаписанный ввод/);assert.equal(run('draft.cardio[0].kcal'),40);
 assert.equal(run('hiddenDraftInput({exercises:[],cardio:[{activity:"Дорожка",time:"5:00",kcal:40}]},state.profile,{exercises:[],cardio:[{activity:"Дорожка",seconds:300,kcal:40}]})'),false);
});
