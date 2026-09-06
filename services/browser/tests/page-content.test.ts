import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { readPageContent, SessionClipboard } from '../src/page-content';

test('selection copies from an iframe, pastes after navigation, and is isolated from other sessions', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<iframe srcdoc="<label>Origen<input aria-label=Origen value=900123456></label>"></iframe>',
    );
    const frame = page.frames()[1]!;
    await frame.getByLabel('Origen').click();
    const clipboard = new SessionClipboard(page);
    await clipboard.selectAll();
    assert.equal((await clipboard.copy()).text, '900123456');
    await page.goto('about:blank');
    await page.setContent('<textarea aria-label="Destino"></textarea>');
    await page.getByLabel('Destino').focus();
    await clipboard.paste();
    assert.equal(await page.getByLabel('Destino').inputValue(), '900123456');
    const another = new SessionClipboard(page);
    await assert.rejects(another.paste(), /vacío/);
    await clipboard.paste('X'.repeat(5000));
    assert.equal(
      (await page.getByLabel('Destino').inputValue()).length,
      5009,
      'long paste is not silently clipped',
    );
    clipboard.clear();
    await assert.rejects(clipboard.paste(), /vacío/);
  } finally {
    await browser.close();
  }
});

test('custom editors can handle tabular paste without a duplicate insert', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<textarea aria-label="Hoja"></textarea><script>document.querySelector("textarea").addEventListener("paste",e=>{e.preventDefault();e.target.value="tabla:"+e.clipboardData.getData("text/plain")})</script>',
    );
    await page.getByLabel('Hoja').focus();
    await new SessionClipboard(page).paste('NIT\tNombre\n123\tCliente');
    assert.equal(await page.getByLabel('Hoja').inputValue(), 'tabla:NIT\tNombre\n123\tCliente');
  } finally {
    await browser.close();
  }
});

test('copy blocks password fields and clears any previous selection', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<input aria-label="Normal" value="public"><input aria-label="Password" type="password" value="never-export">',
    );
    const clipboard = new SessionClipboard(page);
    await page.getByLabel('Normal').focus();
    await clipboard.selectAll();
    await clipboard.copy();
    await page.getByLabel('Password').focus();
    await clipboard.selectAll();
    await assert.rejects(clipboard.copy(), /privado/);
    await assert.rejects(clipboard.paste(), /vacío/);
  } finally {
    await browser.close();
  }
});

test('paged reading traverses full loaded documents and frames without exposing password values', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<p>${'Contenido extenso. '.repeat(2200)}</p><input type="password" value="never-export"><iframe srcdoc="<p>FINAL_DEL_IFRAME</p><input name=nit value=900123456>"></iframe>`,
    );
    let offset = 0,
      combined = '',
      pages = 0;
    for (;;) {
      const part = await readPageContent(page, offset, 20000);
      combined += part.text;
      pages++;
      assert.equal(part.sources.length, 2);
      assert(part.text.length <= 20000);
      if (part.nextOffset === null) {
        assert.equal(combined.length, part.totalCharacters);
        break;
      }
      assert(part.nextOffset > offset);
      offset = part.nextOffset;
    }
    assert(pages > 1);
    assert(combined.includes('FINAL_DEL_IFRAME'));
    assert(combined.includes('900123456'));
    assert(!combined.includes('never-export'));
  } finally {
    await browser.close();
  }
});

test('reads open shadow DOM controls and text', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<div id="editor"></div><script>document.querySelector("#editor").attachShadow({mode:"open"}).innerHTML="<p>Contenido del componente</p><input name=cliente value=ACME>"</script>',
    );
    const content = await readPageContent(page);
    assert(content.text.includes('Contenido del componente'));
    assert(content.text.includes('ACME'));
  } finally {
    await browser.close();
  }
});

test('copies partial selections and app-defined clipboard text from custom editors', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<input aria-label="Dato" value="ABC123XYZ"><div tabindex="0" id="grid">Hoja</div><script>document.querySelector("#grid").addEventListener("copy",e=>{e.preventDefault();e.clipboardData.setData("text/plain","NIT\\tCliente\\n123\\tACME")})</script>',
    );
    const clipboard = new SessionClipboard(page);
    await page.getByLabel('Dato').focus();
    await page
      .getByLabel('Dato')
      .evaluate((el) => (el as HTMLInputElement).setSelectionRange(3, 6));
    assert.equal((await clipboard.copy()).text, '123');
    await page.locator('#grid').focus();
    assert.equal((await clipboard.copy()).text, 'NIT\tCliente\n123\tACME');
  } finally {
    await browser.close();
  }
});

test('worker enforces ownership/control for clipboard and allows agent copy/paste actions', async () => {
  const { BrowserWorker } = await import('../src/browser');
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const worker = new BrowserWorker({ serviceToken:'test',port:0,runTimeoutMs:10000,stepTimeoutMs:1000,sessionIdleMs:60000,maxConcurrent:3,viewportWidth:1000,viewportHeight:700,userAgent:null,profilesDir:null,maxProfiles:2 });
  try {
    await page.setContent('<input aria-label="Origen" value="dato"><textarea aria-label="Destino"></textarea>');
    const sessions = (worker as unknown as {sessions:Map<string,unknown>}).sessions;
    sessions.set('s_test',{page,context:page.context(),owner:'alice',touchedAt:Date.now()});
    assert((await worker.act('s_test','copy',{kind:'label',value:'Origen'},'','')).ok);
    assert((await worker.act('s_test','paste',{kind:'label',value:'Destino'},'','')).ok);
    assert.equal(await page.getByLabel('Destino').inputValue(),'dato');
    await assert.rejects(worker.clipboardAction('s_test','bob','copy'));
    await assert.rejects(worker.content('s_test','bob'));
    await assert.rejects(worker.clipboardAction('s_test','alice','paste'),'UI must take control first');
    worker.takeControl('s_test','alice');
    await worker.clipboardAction('s_test','alice','select_all');
    const copied = await worker.clipboardAction('s_test','alice','copy');
    assert('text' in copied && copied.text==='dato');
    await assert.rejects(worker.act('s_test','paste',{kind:'label',value:'Destino'},'',''),'bot must wait for the person');
  } finally { await worker.stop(); await browser.close(); }
});
