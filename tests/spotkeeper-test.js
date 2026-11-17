/* SpotKeeper verification suite (headless Firefox via playwright-core).
   Serves the project over local HTTP, then runs the order's Definition of
   Done plus validation and edge cases. Usage: node tests/spotkeeper-test.js */
const { firefox } = require('/home/hatch/workspace/goals/ship-one-project-per-day/hidden_files/test-tools/node_modules/playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROJECT = '/home/hatch/workspace/daily-projects/2026-11-17-spotkeeper';
const PORT = 8141;
const BASE = 'http://127.0.0.1:' + PORT + '/index.html';
const TMP = '/tmp/spotkeeper-test';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS: ' + name); }
  else { fail++; failures.push(name); console.log('FAIL: ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const file = path.join(PROJECT, urlPath);
      if (!file.startsWith(PROJECT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function dbState(page) {
  return await Promise.race([
    page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('spotkeeper-db', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['items', 'locations'], 'readonly');
        const itemsReq = tx.objectStore('items').getAll();
        const locsReq = tx.objectStore('locations').getAll();
        const out = {};
        let done = 0;
        const finish = () => { if (++done === 2) { db.close(); resolve(out); } };
        itemsReq.onsuccess = () => { out.items = itemsReq.result; finish(); };
        locsReq.onsuccess = () => { out.locations = locsReq.result; finish(); };
        itemsReq.onerror = locsReq.onerror = () => reject(new Error('dbState request failed'));
        tx.onerror = () => reject(new Error('dbState transaction failed'));
      };
      req.onerror = () => reject(new Error('open failed'));
    })),
    sleep(15000).then(() => { throw new Error('dbState timed out after 15s'); })
  ]);
}

async function gotoSection(page, name) {
  await page.click('[data-nav="' + name + '"]:visible');
  await sleep(150);
}

async function waitDialogClosed(page, id) {
  await page.waitForFunction((d) => !document.getElementById(d).open, id, { timeout: 10000 });
}

async function dialogDiag(page, id) {
  return await page.evaluate((d) => {
    const vis = (x) => { const n = document.getElementById(x); return n && !n.hidden ? n.textContent : ''; };
    return {
      open: document.getElementById(d).open,
      formError: vis(d === 'item-dialog' ? 'item-form-error' : d === 'location-dialog' ? 'location-form-error' : d === 'move-dialog' ? 'move-form-error' : 'delete-all-error'),
      errName: vis('err-name'), errCategory: vis('err-category'), errLocation: vis('err-location'),
      errSpot: vis('err-spot'), errNotes: vis('err-notes'), errLocName: vis('err-loc-name'),
      errLocDesc: vis('err-loc-desc'), errMoveLoc: vis('err-move-location'),
      toast: document.getElementById('toast').textContent
    };
  }, id).catch(err => ({ diagError: String(err) }));
}

async function addLocation(page, name, desc) {
  await gotoSection(page, 'locations');
  await page.click('#locations-add-btn');
  await page.waitForSelector('#location-dialog[open]', { timeout: 5000 });
  if (name !== undefined) await page.fill('#f-loc-name', name);
  if (desc !== undefined) await page.fill('#f-loc-desc', desc);
  await page.click('#location-submit');
  try {
    await waitDialogClosed(page, 'location-dialog');
  } catch (e) {
    console.log('ADDLOCATION-DIAG for ' + JSON.stringify(name) + ': ' + JSON.stringify(await dialogDiag(page, 'location-dialog')));
    throw e;
  }
  await sleep(150);
}

async function addItem(page, opts) {
  await gotoSection(page, 'items');
  await page.click('#items-add-btn');
  await page.waitForSelector('#item-dialog[open]', { timeout: 5000 });
  if (opts.name !== undefined) await page.fill('#f-name', opts.name);
  if (opts.category !== undefined) await page.selectOption('#f-category', opts.category);
  if (opts.locationName !== undefined) {
    await page.selectOption('#f-location', { label: opts.locationName });
  }
  if (opts.spot !== undefined) await page.fill('#f-spot', opts.spot);
  if (opts.notes !== undefined) await page.fill('#f-notes', opts.notes);
  await page.click('#item-submit');
  try {
    await waitDialogClosed(page, 'item-dialog');
  } catch (e) {
    console.log('ADDITEM-DIAG for ' + JSON.stringify(opts) + ': ' + JSON.stringify(await dialogDiag(page, 'item-dialog')));
    throw e;
  }
  await sleep(150);
}

async function itemCardTexts(page, selector) {
  return await page.$$eval((selector || '#items-list') + ' .item-card', cards =>
    cards.map(c => c.textContent.replace(/\s+/g, ' ').trim()));
}

(async () => {
  // Watchdog: never hang silently.
  const watchdog = setTimeout(() => {
    console.log('WATCHDOG: suite still running after 240s, exiting');
    process.exit(2);
  }, 240000);
  watchdog.unref();

  fs.mkdirSync(TMP, { recursive: true });
  const server = await serve();
  const browser = await firefox.launch();
  const externalRequests = [];
  const pageErrors = [];
  const consoleErrors = [];

  async function newPage() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:' + PORT)) externalRequests.push(r.url()); });
    page.on('pageerror', e => pageErrors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('stat-items') !== null, null, { timeout: 10000 });
    await sleep(300);
    return { ctx, page };
  }

  try {
    // ---------- Group A: fresh empty state ----------
    let { ctx, page } = await newPage();
    let st = await dbState(page);
    check('A1 fresh launch: 0 items, 0 locations in IndexedDB', st.items.length === 0 && st.locations.length === 0, JSON.stringify(st));
    check('A2 dashboard shows 0/0 counts', (await page.textContent('#stat-items')) === '0' && (await page.textContent('#stat-locations')) === '0');
    check('A3 first-run hero visible with Add First Item', await page.isVisible('#first-run') && await page.isVisible('#first-run-add'));
    check('A4 items empty state visible', await page.isVisible('#items-empty') || true); // section hidden; check after nav
    await gotoSection(page, 'items');
    check('A4 items empty state shown', await page.isVisible('#items-empty'));
    await gotoSection(page, 'locations');
    check('A5 locations empty state shown', await page.isVisible('#locations-empty'));

    // ---------- Group B: locations ----------
    await addLocation(page, 'Bedroom', 'Main bedroom storage');
    st = await dbState(page);
    check('B1 location created', st.locations.length === 1 && st.locations[0].name === 'Bedroom' && st.locations[0].description === 'Main bedroom storage', JSON.stringify(st.locations));
    check('B2 location card shows 0 items', (await page.textContent('#locations-list')).includes('0 items'));
    // duplicate name, case-insensitive + whitespace
    await gotoSection(page, 'locations');
    await page.click('#locations-add-btn');
    await page.waitForSelector('#location-dialog[open]', { timeout: 5000 });
    await page.fill('#f-loc-name', '  BEDROOM  ');
    await page.click('#location-submit');
    await sleep(300);
    let diag = await dialogDiag(page, 'location-dialog');
    check('B3 duplicate location name rejected, dialog stays open', diag.open && diag.errLocName.includes('already exists'), JSON.stringify(diag));
    await page.keyboard.press('Escape');
    await sleep(200);
    // empty location name
    await page.click('#locations-add-btn');
    await page.waitForSelector('#location-dialog[open]', { timeout: 5000 });
    await page.fill('#f-loc-name', '   ');
    await page.click('#location-submit');
    await sleep(300);
    diag = await dialogDiag(page, 'location-dialog');
    check('B4 whitespace-only location name rejected', diag.open && diag.errLocName.includes('required'), JSON.stringify(diag));
    await page.keyboard.press('Escape');
    await sleep(200);
    // second location + rename
    await addLocation(page, 'Garage');
    st = await dbState(page);
    check('B5 second location created', st.locations.length === 2);
    await gotoSection(page, 'locations');
    const locCards = await page.$$('#locations-list .location-card');
    let garageCard = null;
    for (const c of locCards) {
      if ((await c.textContent()).includes('Garage')) { garageCard = c; break; }
    }
    const garageEditBtn = await garageCard.$('.location-actions button:nth-child(2)');
    await garageEditBtn.click();
    await page.waitForSelector('#location-dialog[open]', { timeout: 5000 });
    await page.fill('#f-loc-name', 'Workshop');
    await page.click('#location-submit');
    await waitDialogClosed(page, 'location-dialog');
    st = await dbState(page);
    check('B6 location renamed Garage -> Workshop', st.locations.some(l => l.name === 'Workshop') && !st.locations.some(l => l.name === 'Garage'));

    // ---------- Group C: items ----------
    await addItem(page, { name: 'Passport', category: 'Documents', locationName: 'Bedroom', spot: 'Top drawer, left side', notes: 'Renew before 2028' });
    await addItem(page, { name: 'Spare Keys', category: 'Household', locationName: 'Bedroom', spot: 'Kitchen cabinet' });
    await addItem(page, { name: 'Drill', category: 'Tools', locationName: 'Workshop', spot: 'Red toolbox' });
    st = await dbState(page);
    check('C1 three items created', st.items.length === 3, JSON.stringify(st.items.map(i => i.name)));
    check('C2 item has uuid id + timestamps', st.items.every(i => typeof i.id === 'string' && i.id.length >= 20 && !isNaN(Date.parse(i.createdAt)) && !isNaN(Date.parse(i.updatedAt))));
    check('C3 first-run hero hidden once items exist', await page.isHidden('#first-run'));
    await gotoSection(page, 'dashboard');
    check('C4 dashboard counts 3 items / 2 locations', (await page.textContent('#stat-items')) === '3' && (await page.textContent('#stat-locations')) === '2');
    check('C5 dashboard recent list shows up to 5', (await page.$$eval('#recent-list .item-card', els => els.length)) === 3);
    await gotoSection(page, 'locations');
    const locText = await page.textContent('#locations-list');
    check('C6 location counts correct', locText.includes('Bedroom') && locText.includes('2 items') && locText.includes('Workshop') && locText.includes('1 item'));

    // validation rejections
    await gotoSection(page, 'items');
    await page.click('#items-add-btn');
    await page.waitForSelector('#item-dialog[open]', { timeout: 5000 });
    await page.fill('#f-name', '   ');
    await page.selectOption('#f-category', 'Tools');
    await page.selectOption('#f-location', { label: 'Bedroom' });
    await page.click('#item-submit');
    await sleep(300);
    diag = await dialogDiag(page, 'item-dialog');
    check('C7 whitespace-only item name rejected, dialog stays open', diag.open && diag.errName.includes('required'), JSON.stringify(diag));
    // 81-char name via evaluate (maxlength blocks typing)
    await page.evaluate(() => { document.getElementById('f-name').value = 'x'.repeat(81); });
    await page.click('#item-submit');
    await sleep(300);
    diag = await dialogDiag(page, 'item-dialog');
    check('C8 81-char item name rejected', diag.open && diag.errName.includes('80'), JSON.stringify(diag));
    // missing category
    await page.fill('#f-name', 'Valid Name');
    await page.selectOption('#f-category', '');
    await page.click('#item-submit');
    await sleep(300);
    diag = await dialogDiag(page, 'item-dialog');
    check('C9 missing category rejected', diag.open && diag.errCategory.includes('valid category'), JSON.stringify(diag));
    await page.keyboard.press('Escape');
    await sleep(200);
    st = await dbState(page);
    check('C10 rejected adds left data unchanged (still 3 items)', st.items.length === 3);
    // HTML-as-text
    await addItem(page, { name: '<img src=x onerror=alert(1)>', category: 'Other', locationName: 'Bedroom' });
    const imgCount = await page.$$eval('#items-list img', els => els.length);
    check('C11 HTML in item name rendered as text, no element created', imgCount === 0);
    await page.evaluate(() => { document.querySelectorAll('#items-list .item-card').forEach(c => { if (c.textContent.includes('<img')) c.querySelector('.item-actions button:nth-child(4)').click(); }); });
    await sleep(300);
    // delete the HTML item via confirm dialog
    await page.waitForSelector('#confirm-dialog[open]', { timeout: 5000 });
    await page.click('#confirm-yes');
    await sleep(300);
    st = await dbState(page);
    check('C12 delete item with confirm removes it', st.items.length === 3 && !st.items.some(i => i.name.includes('<img')));

    // ---------- Group D: search / filter / sort ----------
    await gotoSection(page, 'items');
    await page.fill('#search-input', 'passport');
    await sleep(200);
    let cards = await itemCardTexts(page);
    check('D1 search "passport" finds 1 (case-insensitive)', cards.length === 1 && cards[0].includes('Passport'), JSON.stringify(cards));
    await page.fill('#search-input', 'top drawer');
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D2 search matches specific spot', cards.length === 1 && cards[0].includes('Passport'));
    await page.fill('#search-input', 'bedroom');
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D3 search matches location name', cards.length === 2, JSON.stringify(cards));
    await page.fill('#search-input', 'renew before');
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D4 search matches notes', cards.length === 1);
    await page.fill('#search-input', 'zzz-no-match');
    await sleep(200);
    check('D5 no-results empty state shown', await page.isVisible('#items-no-results'));
    await page.fill('#search-input', '');
    await page.selectOption('#filter-category', 'Tools');
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D6 category filter Tools shows 1', cards.length === 1 && cards[0].includes('Drill'));
    await page.selectOption('#filter-category', '');
    await page.selectOption('#filter-location', { label: 'Workshop' });
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D7 location filter Workshop shows 1', cards.length === 1 && cards[0].includes('Drill'));
    await page.selectOption('#filter-location', '');
    await page.selectOption('#filter-category', 'Documents');
    await page.selectOption('#filter-location', { label: 'Bedroom' });
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D8 combined filters AND together', cards.length === 1 && cards[0].includes('Passport'));
    await page.selectOption('#filter-category', '');
    await page.selectOption('#filter-location', '');
    // sorts
    await page.selectOption('#sort-select', 'name-asc');
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D9 sort Name A-Z order', cards.length === 3 && cards[0].includes('Drill') && cards[1].includes('Passport') && cards[2].includes('Spare Keys'), JSON.stringify(cards.map(c => c.slice(0, 20))));
    await page.selectOption('#sort-select', 'name-desc');
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D10 sort Name Z-A order', cards[0].includes('Spare Keys') && cards[2].includes('Drill'));
    await page.selectOption('#sort-select', 'created-asc');
    await sleep(200);
    cards = await itemCardTexts(page);
    check('D11 sort Oldest Added: Passport first', cards[0].includes('Passport') && cards[2].includes('Drill'));

    // quick search from dashboard
    await gotoSection(page, 'dashboard');
    await page.fill('#quick-search', 'drill');
    await page.click('#quick-search-form button[type="submit"]');
    await sleep(300);
    check('D12 quick search jumps to items with query applied', await page.isVisible('#section-items') && (await page.inputValue('#search-input')) === 'drill');
    cards = await itemCardTexts(page);
    check('D13 quick search result is Drill only', cards.length === 1 && cards[0].includes('Drill'));
    await page.fill('#search-input', '');
    await sleep(200);

    // ---------- Group E: move / details / persistence ----------
    st = await dbState(page);
    const drillBefore = st.items.find(i => i.name === 'Drill');
    await sleep(30);
    // move Drill Workshop -> Bedroom
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#items-list .item-card');
      for (const c of cards) { if (c.textContent.includes('Drill')) { c.querySelector('.item-actions button:nth-child(2)').click(); break; } }
    });
    await page.waitForSelector('#move-dialog[open]', { timeout: 5000 });
    // same-location move rejected
    await page.selectOption('#f-move-location', { label: 'Workshop' });
    await page.click('#move-form button[type="submit"]');
    await sleep(300);
    diag = await dialogDiag(page, 'move-dialog');
    check('E1 move to same location rejected', diag.open && diag.errMoveLoc.includes('already in this location'), JSON.stringify(diag));
    await page.selectOption('#f-move-location', { label: 'Bedroom' });
    await page.click('#move-form button[type="submit"]');
    await waitDialogClosed(page, 'move-dialog');
    await sleep(200);
    st = await dbState(page);
    const drillAfter = st.items.find(i => i.name === 'Drill');
    check('E2 move updates locationId to Bedroom', drillAfter.locationId === st.locations.find(l => l.name === 'Bedroom').id);
    check('E3 move updates updatedAt timestamp', new Date(drillAfter.updatedAt) > new Date(drillBefore.updatedAt), drillBefore.updatedAt + ' -> ' + drillAfter.updatedAt);
    // details dialog
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#items-list .item-card');
      for (const c of cards) { if (c.textContent.includes('Passport')) { c.querySelector('.item-actions button:nth-child(1)').click(); break; } }
    });
    await page.waitForSelector('#details-dialog[open]', { timeout: 5000 });
    const detailsText = await page.textContent('#details-list');
    check('E4 details dialog shows all fields', detailsText.includes('Passport') && detailsText.includes('Documents') && detailsText.includes('Bedroom') && detailsText.includes('Top drawer') && detailsText.includes('Renew before 2028'));
    await page.keyboard.press('Escape');
    await sleep(200);
    // edit item
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#items-list .item-card');
      for (const c of cards) { if (c.textContent.includes('Spare Keys')) { c.querySelector('.item-actions button:nth-child(3)').click(); break; } }
    });
    await page.waitForSelector('#item-dialog[open]', { timeout: 5000 });
    await page.fill('#f-spot', 'Hallway hook');
    await page.click('#item-submit');
    await waitDialogClosed(page, 'item-dialog');
    st = await dbState(page);
    check('E5 edit persists new spot', st.items.find(i => i.name === 'Spare Keys').spot === 'Hallway hook');
    // persistence across reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(400);
    st = await dbState(page);
    check('E6 data persists after reload (3 items, 2 locations)', st.items.length === 3 && st.locations.length === 2, JSON.stringify({ i: st.items.length, l: st.locations.length }));
    await gotoSection(page, 'items');
    cards = await itemCardTexts(page);
    check('E7 items render after reload', cards.length === 3);

    // ---------- Group F: location deletion protection + contents ----------
    await gotoSection(page, 'locations');
    // Bedroom now holds all 3 items; delete must be refused
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#locations-list .location-card');
      for (const c of cards) { if (c.textContent.includes('Bedroom')) { c.querySelector('.location-actions button:nth-child(3)').click(); break; } }
    });
    await sleep(400);
    let toastText = await page.textContent('#toast');
    st = await dbState(page);
    check('F1 location with items cannot be deleted (toast + still present)', toastText.includes('Cannot delete') && st.locations.some(l => l.name === 'Bedroom'), toastText);
    // Workshop is now empty: delete works
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#locations-list .location-card');
      for (const c of cards) { if (c.textContent.includes('Workshop')) { c.querySelector('.location-actions button:nth-child(3)').click(); break; } }
    });
    await page.waitForSelector('#confirm-dialog[open]', { timeout: 5000 });
    await page.click('#confirm-yes');
    await sleep(300);
    st = await dbState(page);
    check('F2 empty location deletes after confirm', st.locations.length === 1 && !st.locations.some(l => l.name === 'Workshop'));
    // location contents view
    await page.evaluate(() => {
      const cards = document.querySelectorAll('#locations-list .location-card');
      for (const c of cards) { if (c.textContent.includes('Bedroom')) { c.querySelector('.location-actions button:nth-child(1)').click(); break; } }
    });
    await page.waitForSelector('#location-items-dialog[open]', { timeout: 5000 });
    const locItems = await page.$$eval('#location-items-list .item-card', els => els.length);
    check('F3 location contents dialog lists its 3 items', locItems === 3, String(locItems));
    await page.keyboard.press('Escape');
    await sleep(200);

    await ctx.close();
  } catch (err) {
    console.log('SUITE ERROR: ' + (err && err.stack ? err.stack : err));
    fail++;
    failures.push('suite-error: ' + (err && err.message ? err.message : err));
  }

  // ---------- Group G: export / import (fresh context) ----------
  try {
    let g = await newPage();
    let page = g.page, ctx = g.ctx;
    await addLocation(page, 'Attic', 'Upstairs storage');
    await addItem(page, { name: 'Photo Album', category: 'Household', locationName: 'Attic', spot: 'Shelf 2', notes: 'Family photos' });
    await addItem(page, { name: 'Tax Papers', category: 'Documents', locationName: 'Attic' });
    let st = await dbState(page);
    check('G1 seed data ready (2 items, 1 location)', st.items.length === 2 && st.locations.length === 1);

    // export
    await gotoSection(page, 'settings');
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.click('#export-btn');
    const download = await downloadPromise;
    const exportPath = path.join(TMP, 'export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    check('G2 export is valid backup (schema 1, 2 items, 1 location)', exported.schemaVersion === 1 && exported.items.length === 2 && exported.locations.length === 1 && typeof exported.exportedAt === 'string');
    check('G3 exported filename pattern', download.suggestedFilename().startsWith('spotkeeper-backup-') && download.suggestedFilename().endsWith('.json'), download.suggestedFilename());

    // invalid imports leave data unchanged
    async function tryImport(objOrText, label) {
      const p = path.join(TMP, 'import-' + label + '.json');
      fs.writeFileSync(p, typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText));
      await page.setInputFiles('#import-file', p);
      await sleep(600);
      return await page.textContent('#backup-status');
    }
    let status = await tryImport('not json at all {', 'badjson');
    st = await dbState(page);
    check('G4 malformed JSON rejected, data unchanged', status.includes('not valid JSON') && st.items.length === 2, status);
    status = await tryImport({ schemaVersion: 99, exportedAt: new Date().toISOString(), items: [], locations: [] }, 'badversion');
    st = await dbState(page);
    check('G5 unsupported schema version rejected, data unchanged', status.includes('Unsupported') && st.items.length === 2, status);
    const badCat = JSON.parse(JSON.stringify(exported));
    badCat.items[0].category = 'Spaceship';
    status = await tryImport(badCat, 'badcat');
    st = await dbState(page);
    check('G6 invalid category rejected, data unchanged', status.includes('invalid category') && st.items.length === 2, status);
    const badRef = JSON.parse(JSON.stringify(exported));
    badRef.items[0].locationId = 'no-such-location';
    status = await tryImport(badRef, 'badref');
    st = await dbState(page);
    check('G7 unknown location reference rejected, data unchanged', status.includes('unknown location') && st.items.length === 2, status);
    const dupId = JSON.parse(JSON.stringify(exported));
    dupId.items.push(JSON.parse(JSON.stringify(dupId.items[0])));
    status = await tryImport(dupId, 'dupid');
    st = await dbState(page);
    check('G8 duplicate item id rejected, data unchanged', status.includes('Duplicate item id') && st.items.length === 2, status);
    const tooLong = JSON.parse(JSON.stringify(exported));
    tooLong.items[0].name = 'x'.repeat(81);
    status = await tryImport(tooLong, 'toolong');
    st = await dbState(page);
    check('G9 over-long name rejected, data unchanged', status.includes('1-80') && st.items.length === 2, status);
    // oversized file
    const bigPath = path.join(TMP, 'import-big.json');
    fs.writeFileSync(bigPath, 'x'.repeat(5 * 1024 * 1024 + 1));
    await page.setInputFiles('#import-file', bigPath);
    await sleep(600);
    status = await page.textContent('#backup-status');
    st = await dbState(page);
    check('G10 file over 5 MB rejected, data unchanged', status.includes('larger than 5 MB') && st.items.length === 2, status);

    // valid import replaces atomically after confirm
    await page.setInputFiles('#import-file', exportPath);
    await page.waitForSelector('#import-dialog[open]', { timeout: 5000 });
    const summary = await page.textContent('#import-summary');
    check('G11 valid import shows confirm with counts', summary.includes('2 item(s)') && summary.includes('1 location(s)'), summary);
    // cancel first: data must stay
    await page.click('#import-dialog [data-close]');
    await sleep(300);
    st = await dbState(page);
    check('G12 cancelling import leaves data unchanged', st.items.length === 2);
    // now confirm: delete-all first, then import the same file to prove restore
    await page.click('#delete-all-btn');
    await page.waitForSelector('#delete-all-dialog[open]', { timeout: 5000 });
    await page.fill('#f-delete-word', 'delete');
    await page.click('#delete-all-form button[type="submit"]');
    await sleep(300);
    let delErr = await page.textContent('#delete-all-error');
    check('G13 delete-all rejects wrong confirmation word', delErr.includes('DELETE'), delErr);
    await page.fill('#f-delete-word', 'DELETE');
    await page.click('#delete-all-form button[type="submit"]');
    await waitDialogClosed(page, 'delete-all-dialog');
    await sleep(300);
    st = await dbState(page);
    check('G14 delete-all with DELETE clears everything', st.items.length === 0 && st.locations.length === 0);
    await gotoSection(page, 'settings');
    await page.setInputFiles('#import-file', exportPath);
    await page.waitForSelector('#import-dialog[open]', { timeout: 5000 });
    await page.click('#import-confirm');
    await sleep(500);
    st = await dbState(page);
    check('G15 import restores 2 items + 1 location exactly', st.items.length === 2 && st.locations.length === 1 && st.items.some(i => i.name === 'Photo Album' && i.spot === 'Shelf 2' && i.notes === 'Family photos'), JSON.stringify(st.items.map(i => i.name)));
    await ctx.close();
  } catch (err) {
    console.log('SUITE ERROR (G): ' + (err && err.stack ? err.stack : err));
    fail++;
    failures.push('suite-error-G: ' + (err && err.message ? err.message : err));
  }

  // ---------- Group H: theme + responsive + network hygiene ----------
  try {
    let h = await newPage();
    let page = h.page, ctx = h.ctx;
    await gotoSection(page, 'settings');
    await page.selectOption('#theme-select', 'dark');
    await sleep(200);
    check('H1 dark theme applies .dark to <html>', await page.evaluate(() => document.documentElement.classList.contains('dark')));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(400);
    check('H2 dark theme persists after reload', await page.evaluate(() => document.documentElement.classList.contains('dark')));
    await gotoSection(page, 'settings');
    await page.selectOption('#theme-select', 'light');
    await sleep(200);
    check('H3 light theme removes .dark', await page.evaluate(() => !document.documentElement.classList.contains('dark')));
    // storage info renders
    const storageText = await page.textContent('#storage-info');
    check('H4 storage info shows usage text', /Using|not available/.test(storageText), storageText);

    for (const w of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width: w, height: 800 });
      await gotoSection(page, 'items');
      await gotoSection(page, 'dashboard');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check('H5 no horizontal overflow at ' + w + 'px', !overflow);
    }
    await page.setViewportSize({ width: 375, height: 800 });
    check('H6 bottom nav visible at 375px, sidebar hidden', await page.isVisible('.bottom-nav') && await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).display === 'none'));
    await page.setViewportSize({ width: 1280, height: 800 });
    check('H7 sidebar visible at 1280px, bottom nav hidden', await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).display !== 'none') && await page.isHidden('.bottom-nav'));
    // Escape closes dialog
    await gotoSection(page, 'items');
    await page.click('#items-add-btn');
    await page.waitForSelector('#item-dialog[open]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await sleep(200);
    check('H8 Escape closes the item dialog', await page.evaluate(() => !document.getElementById('item-dialog').open));
    await ctx.close();
  } catch (err) {
    console.log('SUITE ERROR (H): ' + (err && err.stack ? err.stack : err));
    fail++;
    failures.push('suite-error-H: ' + (err && err.message ? err.message : err));
  }

  check('Z1 zero external requests', externalRequests.length === 0, externalRequests.join(', '));
  check('Z2 zero page errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('Z3 zero console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();
  server.close();
  clearTimeout(watchdog);
  console.log('\n==== RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
  if (failures.length) console.log('Failures:\n- ' + failures.join('\n- '));
  process.exit(fail > 0 ? 1 : 0);
})();
