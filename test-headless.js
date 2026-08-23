#!/usr/bin/env node
// test-headless.js - Direct Node.js test harness (no browser needed)
const fs = require('fs');
const path = require('path');

// Mock localStorage for Node environment
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

// Load apex-core.js in Node environment
const apexCode = fs.readFileSync(path.join(__dirname, 'apex-core.js'), 'utf8');
eval(apexCode);

// Verify apexCore is loaded
const core = global.apexCore;
if (!core) throw new Error('apexCore not loaded into global scope');

const SUMMARY = [];
function log(...args) {
  console.log(...args);
}

function addResult(name, ok, msg) {
  SUMMARY.push({ name, ok, msg });
  const status = ok ? '✓ PASS' : '✗ FAIL';
  console.log(`${status}: ${name} - ${msg}`);
}

(async () => {
  try {
    log('\n=== APEX Test Suite (Node headless) ===\n');

    // Initialize
    core.init({ historyLength: 50, debug: false, dataMode: 'DEMO' });
    log('✓ apexCore initialized');

    // Clear history for deterministic tests
    try {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('apex_history_')) localStorage.removeItem(k);
      });
      log('✓ cleared history');
    } catch (e) {
      log('⚠ localStorage clear skipped:', e.message);
    }

    // Test 1: Deterministic scoring
    log('\nTest 1: Deterministic scoring...');
    const a = await core.runScan();
    const b = await core.runScan();
    const aScores = a.map(x => ({ t: x.ticker, s: x.score }))
      .sort((p, q) => p.t.localeCompare(q.t))
      .map(x => x.s).join(',');
    const bScores = b.map(x => ({ t: x.ticker, s: x.score }))
      .sort((p, q) => p.t.localeCompare(q.t))
      .map(x => x.s).join(',');
    const detOk = aScores === bScores;
    addResult('Deterministic scoring', detOk, detOk ? 'Scores identical across scans' : `Scores differ: ${aScores} vs ${bScores}`);

    // Test 2: Factor breakdown present
    log('\nTest 2: Factor breakdown presence...');
    const breakdownOk = a.every(item => item.breakdown && item.breakdown.raw !== undefined && item.breakdown.contributions);
    addResult('Factor breakdown presence', breakdownOk, breakdownOk ? 'All items have breakdown' : 'Missing breakdown in some items');

    // Test 3: PRIME gating - NVDA should be PRIME in demo dataset
    log('\nTest 3: PRIME gating (NVDA)...');
    const nvda = a.find(it => it.ticker === 'NVDA');
    const nvdaOk = nvda && nvda.status === 'PRIME';
    addResult('PRIME gating (NVDA)', nvdaOk, nvda ? `status=${nvda.status}` : 'NVDA not found');
    if (nvda) {
      log(`  Score: ${nvda.score}, Confirmations: ${nvda.confirmations}, MultiTF: ${nvda.multiTF}, Liq: ${nvda.liq}, R/R: ${nvda.r_r}`);
      log(`  NO-TRADE reasons: ${nvda.noTradeReasons.length > 0 ? nvda.noTradeReasons.join('; ') : 'none'}`);
    }

    // Test 4: NO-TRADE override - ABCD should be NO-TRADE
    log('\nTest 4: NO-TRADE override (ABCD)...');
    const abcd = a.find(it => it.ticker === 'ABCD');
    const abcdOk = abcd && abcd.status === 'NO-TRADE' && abcd.noTradeReasons && abcd.noTradeReasons.length > 0;
    addResult('NO-TRADE override (ABCD)', abcdOk, abcd ? `status=${abcd.status}, reasons=${(abcd.noTradeReasons || []).join(';')}` : 'ABCD not found');

    // Test 5: Cycle-state CONFIRMED when prior snapshot non-PRIME -> now PRIME
    log('\nTest 5: Cycle-state CONFIRMED (NVDA)...');
    const priorNVDA = Object.assign({}, nvda, { score: 70, status: 'WATCH', timestamp: new Date(Date.now() - 3600 * 1000).toISOString() });
    localStorage.setItem('apex_history_NVDA', JSON.stringify([priorNVDA]));
    log('  seeded NVDA prior snapshot (score=70, status=WATCH)');
    const c = await core.runScan();
    const nvda2 = c.find(it => it.ticker === 'NVDA');
    const confirmedOk = nvda2 && nvda2.cycleState === 'CONFIRMED';
    addResult('Cycle-state CONFIRMED (NVDA)', confirmedOk, nvda2 ? `cycleState=${nvda2.cycleState}` : 'NVDA not found after seeded run');

    // Test 6: Cycle-state INVALIDATED when prior snapshot PRIME then current NO-TRADE (ABCD)
    log('\nTest 6: Cycle-state INVALIDATED (ABCD)...');
    const priorABCD = Object.assign({}, abcd, { score: 85, status: 'PRIME', timestamp: new Date(Date.now() - 3600 * 1000).toISOString() });
    localStorage.setItem('apex_history_ABCD', JSON.stringify([priorABCD]));
    log('  seeded ABCD prior PRIME snapshot');
    const d = await core.runScan();
    const abcd2 = d.find(it => it.ticker === 'ABCD');
    const invalidatedOk = abcd2 && abcd2.cycleState === 'INVALIDATED';
    addResult('Cycle-state INVALIDATED (ABCD)', invalidatedOk, abcd2 ? `cycleState=${abcd2.cycleState}` : 'ABCD not found after seeded run');

    // Test 7: DEMO/LIVE/UNAVAILABLE modes switchable
    log('\nTest 7: Data mode switchable...');
    const initialMode = core.DATA_MODE === 'DEMO';
    core.setDataMode('UNAVAILABLE');
    const after = core.DATA_MODE === 'UNAVAILABLE';
    core.setDataMode('DEMO');
    addResult('Data mode switchable', initialMode && after, `initial:DEMO after:UNAVAILABLE now:${core.DATA_MODE}`);

    // Test 8: PRIME cannot trigger when NO-TRADE exists
    log('\nTest 8: PRIME blocked by NO-TRADE...');
    const primeBlocked = abcd2 && abcd2.status !== 'PRIME';
    addResult('PRIME blocked by NO-TRADE', primeBlocked, abcd2 ? `status=${abcd2.status}` : 'ABCD missing');

    // Summary
    log('\n=== Test Summary ===');
    const passed = SUMMARY.every(s => s.ok);
    const passCount = SUMMARY.filter(s => s.ok).length;
    const failCount = SUMMARY.filter(s => !s.ok).length;
    log(`Total: ${SUMMARY.length} | Passed: ${passCount} | Failed: ${failCount}`);
    
    SUMMARY.forEach(s => {
      const status = s.ok ? '✓' : '✗';
      log(`${status} ${s.name}`);
    });

    log(`\n${passed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}\n`);
    process.exit(passed ? 0 : 1);
  } catch (err) {
    console.error('\n✗ Test harness error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
