/* apex-core.js
   Core APEX engine module (feature/apex-ui)
   - deterministic scoring, factor contributions
   - strict PRIME gating and NO-TRADE override logic
   - cycle-to-cycle state and per-ticker history stored in localStorage
   - data adapter interface: DEMO / LIVE / UNAVAILABLE
   - exposes a small API: init(opts), runScan(), setDataMode(m), addWatch(t), getHistory(t), getCurrentSetups(), on(event, cb)

   Design goals:
   - Keep engine pure and independent from UI rendering
   - All decisions are explainable and returned in evaluation results
   - Robust error handling and input validation
*/
(function(global){
  'use strict';

  const DEFAULT_HISTORY = 50;
  const VALID_MODES = ['DEMO','LIVE','UNAVAILABLE'];

  // Public API object
  const apex = {
    DATA_MODE: 'DEMO',
    historyLength: DEFAULT_HISTORY,
    debug: false,
    _watch: new Set(),
    _currentSetups: [],
    _events: [],
    _listeners: {update:[], feed:[]}
  };

  // Demo dataset (same shape as UI expects)
  const demoData = [
    {ticker:'NVDA', price:695.12, direction:'LONG', sector:'Semiconductors', catalyst:'Earnings beat', catalystCred:0.9, volume:2.8, momentum:0.92, r_r:3.2, liq:0.9, multiTF:2, confSignals:3, entry:680, target:750, stop:665, invalidation:655},
    {ticker:'IREN', price:18.22, direction:'LONG', sector:'Energy', catalyst:'Sector rotation + news', catalystCred:0.7, volume:5.6, momentum:0.8, r_r:2.1, liq:0.4, multiTF:1, confSignals:1, entry:18, target:21, stop:17, invalidation:16},
    {ticker:'HLIT', price:12.5, direction:'LONG', sector:'Tech', catalyst:'None', catalystCred:0.1, volume:1.2, momentum:0.6, r_r:1.4, liq:0.6, multiTF:1, confSignals:1, entry:12.2, target:14.5, stop:11.5, invalidation:11},
    {ticker:'ABCD', price:2.1, direction:'SHORT', sector:'Microcap', catalyst:'PR announcement', catalystCred:0.4, volume:8.2, momentum:0.3, r_r:0.8, liq:0.2, multiTF:0, confSignals:0, entry:2.2, target:1.5, stop:2.5, invalidation:2.8}
  ];

  // Utility safe number
  function safeNum(v, fallback=0){ return (typeof v === 'number' && !isNaN(v)) ? v : fallback; }

  // Persistence: history stored under apex_history_{TICKER}
  function saveHistory(ticker, snapshot){
    try{
      const key = 'apex_history_' + ticker.toUpperCase();
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      arr.unshift(snapshot);
      if(arr.length > apex.historyLength) arr.length = apex.historyLength;
      localStorage.setItem(key, JSON.stringify(arr));
    }catch(e){ console.warn('apex: saveHistory failed', e); }
  }
  function loadHistory(ticker){
    try{
      const key = 'apex_history_' + ticker.toUpperCase();
      return JSON.parse(localStorage.getItem(key) || '[]');
    }catch(e){ console.warn('apex: loadHistory failed', e); return []; }
  }

  // Scoring engine
  function evaluate(item, marketRegime){
    // Normalize inputs safely
    const direction = item.direction || 'LONG';
    const catalystCred = Math.max(0, Math.min(1, safeNum(item.catalystCred, 0)));
    const volume = Math.max(0, safeNum(item.volume, 0)); // relative multiplier (1x baseline)
    const momentum = Math.max(0, Math.min(1, safeNum(item.momentum, 0)));
    const multiTF = Math.max(0, Math.min(3, Math.round(safeNum(item.multiTF, 0))));
    const conf = Math.max(0, Math.min(3, Math.round(safeNum(item.confSignals, 0))));
    const liq = Math.max(0, Math.min(1, safeNum(item.liq, 0)));
    const rr = Math.max(0, safeNum(item.r_r, 0));

    // Weights (sum ~1.0)
    const weights = {regime:0.12, catalyst:0.15, volume:0.12, momentum:0.2, multiTF:0.12, conf:0.12, liq:0.05, rr:0.12};

    // Factor normalizations -> 0..1
    const regimeScore = (marketRegime === 'RISK-ON' && direction === 'LONG') || (marketRegime === 'RISK-OFF' && direction === 'SHORT') ? 1 : (marketRegime === 'NEUTRAL' ? 0.7 : 0.3);
    const catalystScore = catalystCred; // already 0..1
    const volumeScore = Math.min(1, volume / 3); // >3x caps
    const momentumScore = momentum;
    const multiTFScore = multiTF / 3; // 0..1
    const confScore = conf / 3; // 0..1
    const liqScore = liq;
    const rrScore = Math.min(1, rr / 3);

    // Contributions
    const contributions = {
      regime: regimeScore * weights.regime,
      catalyst: catalystScore * weights.catalyst,
      volume: volumeScore * weights.volume,
      momentum: momentumScore * weights.momentum,
      multiTF: multiTFScore * weights.multiTF,
      conf: confScore * weights.conf,
      liq: liqScore * weights.liq,
      rr: rrScore * weights.rr
    };

    // Raw score 0..1 then mapped to 0..100
    const raw = Object.values(contributions).reduce((s,v)=>s+v,0);
    const score = Math.round(raw * 100);

    // Decision reasons and strict rules
    const reasons = [];
    const noTradeReasons = [];

    // NO-TRADE checks (override)
    if(liqScore < 0.25) { noTradeReasons.push('Poor liquidity / wide spread'); }
    if(rr < 1.0) { noTradeReasons.push('Unacceptable risk/reward (<1.0)'); }
    if(catalystScore < 0.2 && confScore < 0.3 && momentumScore < 0.4) { noTradeReasons.push('Weak catalyst and confirmations with low momentum'); }
    if(item.sector && item.sector.toLowerCase().includes('micro') && liqScore < 0.4){ noTradeReasons.push('Microcap with poor liquidity'); }

    // Conflicting evidence detection: e.g., high momentum but very low confirmations or catalyst
    const conflict = (momentumScore >= 0.8 && (confScore < 0.33 || catalystScore < 0.2));
    if(conflict){ reasons.push('Potential conflict: strong momentum without confirmations/catalyst'); }

    // PRIME gating (strict)
    const confirmations = conf; // integer
    const primeConditions = [];
    if(score >= 80) primeConditions.push('APEX score >= 80'); else reasons.push('Score below PRIME threshold');
    if(confirmations >= 2) primeConditions.push('Independent confirmations >= 2'); else noTradeReasons.push('Insufficient independent confirmations for PRIME');
    if(multiTF >= 2) primeConditions.push('Multi-timeframe confirmations >= 2'); else noTradeReasons.push('Insufficient multi-timeframe confirmations for PRIME');
    if(liqScore >= 0.5) primeConditions.push('Liquidity acceptable for PRIME'); else noTradeReasons.push('Liquidity too low for PRIME');
    if(rr >= 1.5) primeConditions.push('R/R meets PRIME minimum'); else noTradeReasons.push('R/R below PRIME minimum');

    const isPrime = (noTradeReasons.length === 0) && score >= 80 && confirmations >=2 && multiTF>=2 && liqScore>=0.5 && rr>=1.5 && !conflict;

    // Final status assignment
    let status = 'WATCH';
    if(noTradeReasons.length > 0) status = 'NO-TRADE';
    else if(isPrime) status = 'PRIME';
    else if(score >= 60) status = 'WATCH';
    else status = 'NO-TRADE';

    // Explain status reasons
    if(status === 'PRIME') reasons.push('Meets PRIME gating: ' + primeConditions.join('; '));
    if(status === 'WATCH') reasons.push('Meets WATCH criteria or requires closer monitoring');
    if(status === 'NO-TRADE') reasons.push('NO-TRADE reasons: ' + noTradeReasons.join('; '));

    // Prepare breakdown percentages (0..100)
    const breakdown = {
      regime: Math.round(regimeScore * 100),
      catalyst: Math.round(catalystScore * 100),
      volume: Math.round(volumeScore * 100),
      momentum: Math.round(momentumScore * 100),
      multiTF: Math.round(multiTFScore * 100),
      confirmations: Math.round(confScore * 100),
      liquidity: Math.round(liqScore * 100),
      rr: Math.round(rrScore * 100),
      contributions: Object.keys(contributions).reduce((acc,k)=>{ acc[k] = Math.round(contributions[k]*100); return acc; }, {}),
      raw: Math.round(raw*100)
    };

    return {
      ticker: item.ticker,
      price: safeNum(item.price, 0),
      direction: direction,
      sector: item.sector || null,
      catalyst: item.catalyst || null,
      catalystCred: catalystCred,
      volume: volume,
      momentum: momentum,
      r_r: rr,
      liq: liq,
      multiTF: multiTF,
      confirmations: confirmations,
      entry: item.entry || null,
      target: item.target || null,
      stop: item.stop || null,
      invalidation: item.invalidation || null,
      score: score,
      breakdown: breakdown,
      status: status,
      reasons: reasons,
      noTradeReasons: noTradeReasons,
      conflict: conflict,
      timestamp: (new Date()).toISOString()
    };
  }

  // Compare snapshot to previous snapshot to derive cycle state
  function compareToPrevious(ticker, current){
    const history = loadHistory(ticker);
    const prev = history.length ? history[0] : null;
    if(!prev) return 'NEW';
    // if previous was PRIME and now NO-TRADE -> INVALIDATED
    if(prev.status === 'PRIME' && current.status === 'NO-TRADE') return 'INVALIDATED';
    if(current.status === 'PRIME' && prev.status !== 'PRIME') return 'CONFIRMED';
    const delta = current.score - (prev.score || 0);
    if(delta >= 8 && (current.status === prev.status || current.status === 'PRIME')) return 'IMPROVING';
    if(delta <= -8) return 'DETERIORATING';
    if(current.status === prev.status && Math.abs(delta) < 5) return 'UNCHANGED';
    
    return 'UNCHANGED';
  }

  // Data adapter
  async function fetchData(){
    if(apex.DATA_MODE === 'LIVE'){
      // Placeholder hook: implement live provider call here.
      logEvent('LIVE mode requested but not configured');
      return [];
    }
    if(apex.DATA_MODE === 'UNAVAILABLE'){
      logEvent('Data unavailable: adapter returned no data');
      return [];
    }
    // DEMO
    return demoData.slice(); // return copy
  }

  function logEvent(text){
    try{
      const ev = {text, time: (new Date()).toISOString()};
      apex._events.unshift(ev);
      if(apex._events.length > 200) apex._events.length = 200;
      apex._listeners.feed.forEach(cb=>{ try{ cb(ev); }catch(e){} });
      if(apex.debug) console.log('APEX event:', text);
    }catch(e){ console.warn('apex logEvent failed', e); }
  }

  // Main scan
  async function runScan(){
    try{
      logEvent('APEX scan started ('+apex.DATA_MODE+')');
      const raw = await fetchData();
      logEvent('Fetched ' + raw.length + ' symbols');

      // determine regime: based on average momentum
      const avgMom = raw.reduce((s,i)=>s+safeNum(i.momentum,0),0) / (raw.length||1);
      const marketRegime = avgMom > 0.7 ? 'RISK-ON' : (avgMom < 0.4 ? 'RISK-OFF' : 'NEUTRAL');

      const evaluated = raw.map(i=>evaluate(i, marketRegime));

      // For each, compute cycle state and save history
      evaluated.forEach(e => {
        const state = compareToPrevious(e.ticker, e);
        e.cycleState = state;
        saveHistory(e.ticker, e);
      });

      // Sort by score
      evaluated.sort((a,b)=>b.score - a.score);

      apex._currentSetups = evaluated;
      apex.marketRegime = marketRegime;

      // Notify listeners
      apex._listeners.update.forEach(cb=>{ try{ cb({setups: evaluated, regime: marketRegime}); }catch(e){} });

      logEvent('APEX scan complete');
      return evaluated;
    }catch(e){ console.error('apex runScan failed', e); logEvent('Scan failed: ' + (e && e.message)); return []; }
  }

  // Public API helpers
  apex.init = function(opts){
    opts = opts || {};
    if(opts.historyLength) apex.historyLength = opts.historyLength;
    if(opts.debug) apex.debug = !!opts.debug;
    if(opts.dataMode && VALID_MODES.includes(opts.dataMode)) apex.DATA_MODE = opts.dataMode;
    if(opts.watch && Array.isArray(opts.watch)) opts.watch.forEach(t=>apex._watch.add(t.toUpperCase()));
    if(apex.debug) console.log('apex.init', {historyLength: apex.historyLength, DATA_MODE: apex.DATA_MODE});
    return apex;
  };

  apex.setDataMode = function(mode){ if(VALID_MODES.includes(mode)){ apex.DATA_MODE = mode; logEvent('Data mode set to '+mode); } else console.warn('apex: invalid data mode', mode); };

  apex.runScan = runScan;
  apex.getCurrentSetups = function(){ return apex._currentSetups.slice(); };
  apex.getHistory = loadHistory;
  apex.addWatch = function(ticker){ if(!ticker) return; apex._watch.add(ticker.toUpperCase()); logEvent('Added '+ticker+' to watch'); };

  apex.on = function(event, cb){ if(!apex._listeners[event]) apex._listeners[event]=[]; apex._listeners[event].push(cb); };

  apex.getEvents = function(){ return apex._events.slice(); };

  // expose to global
  global.apexCore = apex;

})(typeof window !== 'undefined' ? window : globalThis);
