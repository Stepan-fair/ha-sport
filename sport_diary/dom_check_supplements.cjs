// Real forms in jsdom; no claim of browser layout, iOS or a live HA check.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM,VirtualConsole}=require(process.env.SPORT_DOM_MODULE||'jsdom');
const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const html=fs.readFileSync(process.env.SPORT_PREVIEW||path.join(__dirname,'../artifacts/sport/Sport-preview.html'),'utf8');
const dom=new JSDOM(html,{url:'https://sport.test/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.structuredClone=structuredClone;w.confirm=()=>true;w.scrollTo=()=>{};w.CSS={escape:s=>s};w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))}}});
const w=dom.window,d=w.document,el=s=>{const n=d.querySelector(s);assert.ok(n,'Missing '+s);return n};
const run=s=>w.eval(s),sleep=()=>new Promise(r=>setTimeout(r,10));
async function until(f,label){const start=Date.now();while(!f()){if(Date.now()-start>3000)throw Error('Timeout '+label+'; '+d.querySelector('#message')?.textContent);await sleep()}}
async function click(s){el(s).click();await sleep();await until(()=>!run('busy'),'action '+s)}
function change(s,v){const n=el(s);if(n.type==='checkbox')n.checked=v;else n.value=v;n.dispatchEvent(new w.Event('input',{bubbles:true}));n.dispatchEvent(new w.Event('change',{bubbles:true}))}
(async()=>{try{
 await until(()=>d.querySelector('.calDay'),'load');
 await click('[data-tab="3"]');if(d.querySelector('[data-action="settings"]'))await click('[data-action="settings"]');
 for(const name of ['Протеин','Креатин','Железо','Омега-3'])change('[name="uses"][value="'+name+'"]',true);
 await click('[data-action="save-supps"]');
 const recipe='[data-recipe-settings="Протеин"]';assert.equal(el(recipe+' [data-action="save-supplement-recipe"]').hidden,true);
 change(recipe+' [data-recipe-field="milk.ml"]','250');assert.equal(el(recipe+' [data-action="save-supplement-recipe"]').hidden,false);
 change(recipe+' [data-recipe-field="milk.ml"]','300');assert.equal(el(recipe+' [data-action="save-supplement-recipe"]').hidden,true);
 // UI changes of unit convert the actual current numbers through the known density.
 change(recipe+' [data-recipe-field="milk.basis"]','100ml');assert.equal(Number(el(recipe+' [data-recipe-field="milk.label.0"]').value),54.59);
 await click(recipe+' [data-action="save-supplement-recipe"]');assert.equal(el(recipe+' [data-action="save-supplement-recipe"]').hidden,true);
 await click('[data-tab="0"]');run('selectDay(shiftDay(selectedDay,-1));render()');
 for(let i=0;i<3;i++){change('[name="supp"][value="Протеин"]',true);await click('[data-action="supp"]')}
 assert.equal(run('state.supps.length'),3,el("#message").textContent);assert.equal(run('state.meals.length'),3);assert.ok(Math.abs(run('nutritionForDay(state,selectedDay).totals[0]')-868.56)<1e-8);
 // Editing only the middle event to water leaves its neighbours unchanged.
 await click('[data-history-index="1"] [data-action^="edit-dose-"]');change('dialog [data-recipe-field="milk.ml"]','0');await click('dialog button[type="submit"]');
 assert.equal(d.querySelector('dialog'),null);assert.ok(Math.abs(run('nutritionForDay(state,selectedDay).totals[0]')-704.79)<1e-8);
 // A failed network response is safe to replay: the same pending ID is reused.
 run('realRequest=request;failAfterWrite=true;request=async function(path,body){const result=await realRequest(path,body);if(body&&failAfterWrite){failAfterWrite=false;throw Error("network reply lost")}return result}');
 change('[name="supp"][value="Протеин"]',true);await click('[data-action="supp"]');assert.match(el('#message').textContent,/network reply lost/);
 await click('[data-action="supp"]'); // revision conflict refreshes the already-saved event
 await click('[data-action="supp"]'); // same receipt becomes a no-op
 assert.equal(run('state.supps.length'),4);assert.equal(run('state.meals.length'),4);run('request=realRequest');
 // Ferromalt normal confirmation and a one-off 20-drop event use separate IDs.
 change('[name="supp"][value="Железо"]',true);await sleep();
 if(d.querySelector('dialog'))await click('dialog button[type="submit"]');
 await click('[data-action="supp"]');assert.equal(run('state.supps.at(-1).productSnapshot.ironMg'),100);
 change('[data-dose-controls="Железо"] [name="drops"]','20');change('[name="supp"][value="Железо"]',true);await click('[data-action="supp"]');
 assert.equal(run('state.supps.at(-1).productSnapshot.ironMg'),50);assert.equal(run('SportSupplementProducts.recipeFor(state,"Железо",selectedDay).drops'),40);
 // A legacy unknown mark stays unknown until its explicit composition preview is accepted.
 await run('commit(s=>s.supps.push({names:["Протеин"],date:selectedDay+"T10:00",period:"Утро"}))');run('render()');
 await click('[data-history-index="6"] [data-action^="edit-dose-"]');change('dialog [name="applyProduct"]',true);
 await click('dialog button[type="submit"]');assert.equal(d.querySelector('dialog'),null);assert.equal(run('state.supps.at(-1).productSnapshot.milkMl'),300);
 await click('[data-tab="3"]');if(d.querySelector('[data-action="settings"]'))await click('[data-action="settings"]');
 change(recipe+' [data-recipe-field="milk.ml"]','200');await click(recipe+' [data-action="save-supplement-recipe"]');assert.equal(run('state.supps[0].productSnapshot.milkMl'),300);
 for(const name of ['Протеин','Креатин','Железо','Омега-3'])change('[name="uses"][value="'+name+'"]',false);await click('[data-action="save-supps"]');
 await click('[data-tab="0"]');assert.equal(d.querySelector('#planPanel'),null);assert.equal(d.querySelector('#doseStatus'),null);assert.equal(run('state.meals.length'),5);
 assert.deepEqual(errors,[]);console.log('PASS supplement DOM: dirty recipe saves, unit conversion, repeated events, editing, lost response replay, historical snapshots and hidden empty cards');
}finally{w.close()}})().catch(e=>{console.error(e);process.exitCode=1});
