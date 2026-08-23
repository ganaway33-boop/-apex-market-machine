#!/usr/bin/env node
/**
 * test-headless.js
 * Direct Node.js test harness for APEX core
 * 8 deterministic tests for scoring, PRIME gating, NO-TRADE override, and cycle states
 * No browser or Puppeteer required
 */

const fs = require('fs');
const path = require('path');

// Setup: Mock localStorage for Node environment
global.localStorage = (() => {
  const store = {};
  return {
    getItem(key) { return store[key] || null; },
    setItem(key, val) { store[key] = String(val); },
    removeItem(key) { delete store[key]; },
    clear() { Object.keys(store).forEach(k => delete store[k]); },
    key(idx) { return Object.keys(store)[idx] || null; },
    get length() { return Object.keys(store).length; }
  };
})();

// Load apex-core.js
const apexCode = fs.readFileSync(path.join(__dirname, 'apex-core.js'), 'utf8');
eval(apexCode);

// Verify apexCore loaded
const core = global.apexCore;
if (!core) {
  console.error('FATAL: apexCore not loaded into global scope');
  process.exit(1);
}

const SUMMARY = [];

function log(...args) {
  console.log(...args);
}

function addResult(name, ok, msg) {
  SUMMARY.push({ name, ok, msg });
  const status = ok ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${status}: ${msg}`);
}

(async () => {
  try {
    log('\n════════════════════════════════════════');
    log('  APEX Core Headless Test Suite');
    log('════════════════════════════════════════\n');

    // Initialize
    core.init({ historyLength: 50, debug: false, dataMode: 'DEMO' });
    log('✓ apexCore initialized (DEMO mode, historyLength=50)\n');

    // Clear history for deterministic tests
    try {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('apex_history_')) localStorage.removeItem(k);
      });
      log('✓ Cleared prior history\n');
    } catch (e) {
      log('⚠ localStorage clear skipped:', e.message, '\n');
    }

    // TEST 1: Deterministic scoring
    log('TEST 1: Deterministic Scoring');
    log('─────────────────────────────');
    const a = await core.runScan();
    const b = await core.runScan();
    const aScores = a.map(x => ({ t: x.ticker, s: x.score }))
      .sort((p, q) => p.t.localeCompare(q.t))
      .map(x => x.s).join(',');
    const bScores = b.map(x => ({ t: x.ticker, s: x.score }))
      .sort((p, q) => p.t.localeCompare(q.t))
      .map(x => x.s).join(',');
    const detOk = aScores === bScores;
    addResult('Deterministic scoring', detOk, 
      detOk ? 'Scores identical across scans' : `Scores differ: [${aScores}] vs [${bScores}]`);
    log('');

    // TEST 2: Factor breakdown present
    log('TEST 2: Factor Breakdown Presence');
    log('─────────────────────────────────');
    const breakdownOk = a.every(item => 
      item.breakdown && item.breakdown.raw !== undefined && item.breakdown.contributions);
    addResult('Factor breakdown presence', breakdownOk,
      breakdownOk ? 'All items have breakdown' : 'Missing breakdown in some items');
    log('');

    // TEST 3: PRIME gating - NVDA should be PRIME
    log('TEST 3: PRIME Gating (NVDA)');
    log('──────────────────────────');
    const nvda = a.find(it => it.ticker === 'NVDA');
    const nvdaOk = nvda && nvda.status === 'PRIME';
    if (nvda) {
      log(`  Score: ${nvda.score}/100`);
      log(`  Confirmations: ${nvda.confirmations}/3`);
      log(`  MultiTF: ${nvda.multiTF}/3`);
      log(`  Liquidity: ${nvda.liq} (need ≥0.5)`);
      log(`  R/R: ${nvda.r_r} (need ≥1.5)`);
      log(`  NO-TRADE reasons: ${nvda.noTradeReasons.length ? nvda.noTradeReasons.join('; ') : 'none'}`);
    }
    addResult('PRIME gating (NVDA)', nvdaOk, nvda ? `status=${nvda.status}` : 'NVDA not found');
    log('');

    // TEST 4: NO-TRADE override - ABCD should be NO-TRADE
    log('TEST 4: NO-TRADE Override (ABCD)');
    log('─────────────────────────────────');
    const abcd = a.find(it => it.ticker === 'ABCD');
    const abcdOk = abcd && abcd.status === 'NO-TRADE' && abcd.noTradeReasons && abcd.noTradeReasons.length > 0;
    if (abcd) {
      log(`  Score: ${abcd.score}/100`);
      log(`  Confirmations: ${abcd.confirmations}/3`);
      log(`  MultiTF: ${abcd.multiTF}/3`);
      log(`  Liquidity: ${abcd.liq} (need ≥0.5)`);
      log(`  R/R: ${abcd.r_r} (need ≥1.5)`);
      log(`  NO-TRADE reasons:`);
      (abcd.noTradeReasons || []).forEach(reason => log(`    • ${reason}`));
    }
    addResult('NO-TRADE override (ABCD)', abcdOk, 
      abcd ? `status=${abcd.status}, ${abcd.noTradeReasons.length} reasons` : 'ABCD not found');
    log('');

    // TEST 5: Cycle-state CONFIRMED (NVDA: non-PRIME → PRIME)
    log('TEST 5: Cycle-State CONFIRMED (NVDA)');
    log('──────────────────────────────────');
    const priorNVDA = Object.assign({}, nvda, { 
      score: 70, 
      status: 'WATCH', 
      timestamp: new Date(Date.now() - 3600 * 1000).toISOString() 
    });
    localStorage.setItem('apex_history_NVDA', JSON.stringify([priorNVDA]));
    log('  Seeded prior NVDA snapshot (score=70, status=WATCH)');
    const c = await core.runScan();
    const nvda2 = c.find(it => it.ticker === 'NVDA');
    const confirmedOk = nvda2 && nvda2.cycleState === 'CONFIRMED';
    addResult('Cycle-state CONFIRMED (NVDA)', confirmedOk, 
      nvda2 ? `cycleState=${nvda2.cycleState}` : 'NVDA not found after rescan');
    log('');

    // TEST 6: Cycle-state INVALIDATED (ABCD: PRIME → NO-TRADE)
    log('TEST 6: Cycle-State INVALIDATED (ABCD)');
    log('─────────────────────────────────────');
    const priorABCD = Object.assign({}, abcd, { 
      score: 85, 
      status: 'PRIME', 
      timestamp: new Date(Date.now() - 3600 * 1000).toISOString() 
    });
    localStorage.setItem('apex_history_ABCD', JSON.stringify([priorABCD]));
    log('  Seeded prior ABCD snapshot (score=85, status=PRIME)');
    const d = await core.runScan();
    const abcd2 = d.find(it => it.ticker === 'ABCD');
    const invalidatedOk = abcd2 && abcd2.cycleState === 'INVALIDATED';
    addResult('Cycle-state INVALIDATED (ABCD)', invalidatedOk, 
      abcd2 ? `cycleState=${abcd2.cycleState}` : 'ABCD not found after rescan');
    log('');

    // TEST 7: Data mode switchable
    log('TEST 7: Data Mode Switchable');
    log('────────────────────────────');
    const initialMode = core.DATA_MODE === 'DEMO';
    core.setDataMode('UNAVAILABLE');
    const after = core.DATA_MODE === 'UNAVAILABLE';
    core.setDataMode('DEMO');
    const modeOk = initialMode && after && core.DATA_MODE === 'DEMO';
    addResult('Data mode switchable', modeOk, 
      `initial:DEMO → UNAVAILABLE → ${core.DATA_MODE}`);
    log('');

    // TEST 8: PRIME blocked by NO-TRADE
    log('TEST 8: PRIME Blocked by NO-TRADE');
    log('──────────────────────────────────');
    const primeBlocked = abcd2 && abcd2.status !== 'PRIME';
    addResult('PRIME blocked by NO-TRADE', primeBlocked, 
      abcd2 ? `ABCD status=${abcd2.status} (no PRIME override)` : 'ABCD missing');
    log('');

    // Summary Report
    log('\n════════════════════════════════════════');
    log('  TEST SUMMARY');
    log('════════════════════════════════════════\n');
    const passed = SUMMARY.every(s => s.ok);
    const passCount = SUMMARY.filter(s => s.ok).length;
    const failCount = SUMMARY.filter(s => !s.ok).length;
    
    log(`Total Tests: ${SUMMARY.length}`);
    log(`Passed:      ${passCount}`);
    log(`Failed:      ${failCount}\n`);
    
    SUMMARY.forEach((s, i) => {
      const status = s.ok ? '✓' : '✗';
      log(`${i + 1}. ${status} ${s.name}`);
    });

    log(`\n${passed ? '✓✓✓ ALL TESTS PASSED ✓✓✓' : '✗✗✗ SOME TESTS FAILED ✗✗✗'}\n`);
    log('════════════════════════════════════════\n');

    process.exit(passed ? 0 : 1);
  } catch (err) {
    console.error('\n✗ Test harness error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
