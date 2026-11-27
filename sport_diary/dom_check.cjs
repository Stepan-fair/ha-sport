// Actual DOM form interactions in jsdom. This does not emulate layout or iOS Safari.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require(process.env.SPORT_DOM_MODULE||'jsdom');
const errors=[];
const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
const html=fs.readFileSync(path.join(__dirname,'../artifacts/sport/Sport-preview.html'),'utf8');
const dom=new JSDOM(html,{url:'https://sport.test/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,
 beforeParse(w){w.structuredClone=structuredClone;w.confirm=()=>true;w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=function(){};
   w.HTMLDialogElement.prototype.showModal=function(){this.open=true};
   w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))};
 }});
const w=dom.window,d=w.document;
const el=s=>{const e=d.querySelector(s);assert.ok(e,'Missing '+s);return e};
async function until(f,label){const start=Date.now();while(!f()){if(Date.now()-start>2000)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,5))}}
async function click(s){el(s).click();await new Promise(r=>setTimeout(r,10))}
function change(s,v){const e=el(s);if(e.type==='checkbox')e.checked=v;else e.value=v;e.dispatchEvent(new w.Event('input',{bubbles:true}));e.dispatchEvent(new w.Event('change',{bubbles:true}))}
(async()=>{
 try{
  await until(()=>d.querySelector('.calDay'),'initial load');
  await click('[data-tab="3"]');await click('[data-action="settings"]');
  await click('[data-health="visibility"]');
  assert.equal(el('dialog button[type="submit"]').hidden,true);
  change('dialog [name="visible_sleep"]',false);
  change('dialog [name="visible_watch"]',false);
  change('dialog [name="metric_steps"]',false);
  assert.equal(el('dialog button[type="submit"]').hidden,false);
  await click('dialog button[type="submit"]');await until(()=>!d.querySelector('dialog'),'save and close');
  await click('[data-tab="0"]');assert.equal(d.querySelector('[data-disclosure="health-sleep"]'),null);
  await click('[data-tab="1"]');assert.equal(d.querySelector('[data-disclosure="health-watch"]'),null);
  change('#who','person2');await until(()=>el('#who').value==='person2'&&d.querySelector('[data-disclosure="health-sleep"]'),'second profile');
  assert.ok(d.querySelector('[data-disclosure="health-sleep"]'));
  assert.deepEqual(errors,[]);
  console.log('PASS DOM: clean load, dirty save button, persistent section visibility, profile isolation');
 }finally{w.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
