import { chromium, devices } from 'playwright-core';
const CK=process.env.CK||''; const iPhone=devices['iPhone 13'];
const b=await chromium.launch({channel:'chrome'}).catch(()=>chromium.launch());
const c=await b.newContext({...iPhone}); const eq=CK.indexOf('=');
await c.addCookies([{name:CK.slice(0,eq),value:CK.slice(eq+1),domain:'127.0.0.1',path:'/'}]);
const p=await c.newPage();
const out={};
// warm context
await p.goto('http://127.0.0.1:4200/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2200);
// --- Engine picker ---
const trig=await p.$('[data-test="engine-pill-trigger"]');
if(trig){ await trig.click(); await p.waitForTimeout(600);
  out.engineOptions = await p.$$eval('[data-test^="engine-pill-opt-"]', els=>els.map(e=>e.getAttribute('data-test').replace('engine-pill-opt-','')));
  out.hasUltra = out.engineOptions.includes('ultracoding');
  out.parallelDetail = await p.evaluate(()=>{const o=document.querySelector('[data-test="engine-pill-opt-parallel-all"]'); return o? (o.textContent||'').replace(/\s+/g,' ').trim().slice(0,40):null;});
} else out.engineOptions='(trigger not found)';
// --- Subchat thread: mic count + channel hint ---
await p.goto('http://127.0.0.1:4200/workspaces/testkunde/subchats/SC-01KT6RGPJGSFPKM0T9K6JGHEJE',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2800);
out.subchatUrl = p.url().replace('http://127.0.0.1:4200','');
out.micCount = await p.$$eval('button[aria-label]', els=>els.filter(e=>/diktier|Sprachnachricht|aufnehmen|Mikrofon/i.test(e.getAttribute('aria-label')||'')).length);
out.channelHint = await p.evaluate(()=>/Kundenkanal/.test(document.body.innerText));
out.fragHauptchat = await p.evaluate(()=>/Frag den Hauptchat/.test(document.body.innerText));
await p.screenshot({path:'/tmp/bugfix-subchat.png', fullPage:true});
console.log(JSON.stringify(out,null,2));
await b.close();
