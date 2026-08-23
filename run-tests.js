// run-tests.js
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const url = process.argv[2] || 'http://localhost:8080/tests.html';
  const outDir = process.env.TEST_OUTPUT_DIR || '.';
  const logs = [];
  let pageError = null;

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    page.on('console', msg => {
      const text = msg.text();
      logs.push(`[console] ${text}`);
      console.log('PAGE:', text);
    });
    page.on('pageerror', err => {
      pageError = err;
      logs.push(`[pageerror] ${err && err.stack ? err.stack : err}`);
      console.error('PAGE ERROR:', err);
    });
    page.on('error', err => {
      logs.push(`[error] ${err && err.stack ? err.stack : err}`);
      console.error('ERROR:', err);
    });

    console.log('Opening', url);
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (!resp || resp.status() >= 400) {
      const msg = `Failed to load ${url} (status ${resp ? resp.status() : 'no response'})`;
      logs.push(msg);
      throw new Error(msg);
    }

    // Wait for the test harness to indicate completion
    await page.waitForFunction('window.TEST_COMPLETE === true', { timeout: 30000 });

    // Read result flags
    const passed = await page.evaluate(() => window.TEST_PASSED === true);
    const summary = await page.evaluate(() => window.TEST_SUMMARY || []);

    console.log('TEST PASSED:', passed);
    console.log('SUMMARY:', JSON.stringify(summary, null, 2));
    logs.push('TEST_PASSED: ' + passed);
    logs.push('SUMMARY: ' + JSON.stringify(summary, null, 2));

    if (!passed) {
      // Save screenshot and logs for debugging
      const screenshotPath = path.join(outDir, 'failure.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const logPath = path.join(outDir, 'page.log');
      fs.writeFileSync(logPath, logs.join('\n'), 'utf8');
      console.error('Tests failed. Artifacts written:', screenshotPath, logPath);
      await browser.close();
      process.exit(1);
    }

    // all good
    const logPath = path.join(outDir, 'page.log');
    fs.writeFileSync(logPath, logs.join('\n'), 'utf8');
    console.log('Tests passed. Logs written to', logPath);
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('Run-tests error:', err);
    try {
      const logPath = path.join(outDir, 'page.log');
      fs.writeFileSync(logPath, logs.join('\n') + '\nERROR: ' + (err.stack || err), 'utf8');
    } catch (e) {}
    await browser.close();
    process.exit(1);
  }
})();
