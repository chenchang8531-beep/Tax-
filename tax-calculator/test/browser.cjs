// Uses preinstalled workspace browser tools only. No product dependency.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
(async()=>{
 const html=fs.readFileSync(path.resolve(__dirname,'../index.html'));
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 let checks=0;
 const screenshotDir=path.resolve(__dirname,'../verification/screenshots');fs.mkdirSync(screenshotDir,{recursive:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(address))requests.push(r.url());});
  await page.goto(address);
  await page.context().setOffline(true);
  const check=async(id,expected)=>{assert.equal((await page.locator('#'+id).innerText()).trim(),expected);checks++;};
  await check('total','$22,788.00');
  await page.locator('#payg').fill('25000');
  await check('balance','预计可退差额 $2,212.00');
  await check('remaining','$77,212.00');
  await page.screenshot({path:path.join(screenshotDir,'desktop.png'),fullPage:true});
  await page.locator('#income').fill('29000');
  await check('medicare','$98.90');await check('total','$1,126.90');
  for (const invalid of ['','-1','123.45','NaN','Infinity','1e5']) {
    await page.locator('#income').fill(invalid);
    assert.equal(await page.locator('#income').getAttribute('aria-invalid'),'true');
    assert.equal(await page.locator('#results').isVisible(),false);
    assert.ok((await page.locator('#income-error').innerText()).length>0);checks++;
  }
  await page.locator('[data-income="100000"]').click();await check('total','$22,788.00');
  assert.equal(await page.locator('#income').getAttribute('aria-invalid'),null);checks++;
  await page.locator('#payg').fill('');await check('balance','未提供 PAYG，暂不估算补退税。');
  await page.locator('#payg').fill('0');await check('balance','预计需补差额 $22,788.00');
  await page.locator('#payg').fill('22788');await check('balance','预计补退税差额 $0.00（刚好抵足）');
  await page.locator('#payg').fill('22787.99');await check('balance','预计需补差额 $0.01');
  await page.locator('#payg').fill('1.001');assert.equal(await page.locator('#payg').getAttribute('aria-invalid'),'true');checks++;
  await page.locator('#payg').fill('25000');await check('balance','预计可退差额 $2,212.00');
  await page.locator('#income').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'$29,000');checks++;
  await page.keyboard.press('Enter');await check('total','$1,126.90');
  await page.locator('summary').first().click();assert.ok((await page.locator('details').first().getAttribute('open'))!==null);checks++;
  for (const width of [1440,390,320]) {
   await page.setViewportSize({width,height:900});
   const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
   assert.ok(sizes.scroll<=sizes.viewport,JSON.stringify(sizes));
   console.log(`PASS overflow ${width}px: scrollWidth=${sizes.scroll}, viewport=${sizes.viewport}`);checks++;
  }
  await page.setViewportSize({width:390,height:844});await page.locator('summary').first().click();
  await page.locator('#payg').fill('');await page.locator('[data-income="29000"]').click();
  await page.screenshot({path:path.join(screenshotDir,'mobile.png'),fullPage:true});
  await check('medicare','$98.90');await check('total','$1,126.90');
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('#results').isVisible(),true);checks++;
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);checks+=2;
  console.log(`PASS browser: ${checks} checks; built HTML over loopback HTTP then offline; no external requests; no page errors; keyboard, invalid recovery, PAYG, print, desktop/mobile.`);
  console.log(`Screenshots: ${screenshotDir}/desktop.png and mobile.png`);
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
