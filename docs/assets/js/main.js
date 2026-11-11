/* App bootstrap: tabs, theme, wiring */
(function (A) {
  'use strict';
  const $ = A.$;

  function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    const show = (name) => {
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
      Object.values(A.charts).forEach((c) => c?.resize());
      if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    };
    tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
    const h = location.hash.slice(1);
    if ([...tabs].some((t) => t.dataset.tab === h)) show(h);
    window.addEventListener('hashchange', () => { const n = location.hash.slice(1); if ([...tabs].some((t) => t.dataset.tab === n)) show(n); });
  }

  function initTheme() {
    const saved = A.store.get('theme', null);
    if (saved) document.documentElement.dataset.theme = saved;
    $('themeBtn').addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      A.store.set('theme', document.documentElement.dataset.theme);
      rerender();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', rerender);
  }
  // charts read CSS variables at creation time -> rebuild after a theme change
  function rerender() {
    if (A.data) A.forecast.render();
    if (A.trading.last) A.trading.run().catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!window.Chart) A.toast('Chart library could not load (offline?). Numbers still work; charts are hidden.', 'warn', 10000);
    initTheme(); initTabs();
    // start each module on its own, so one failing tab cannot stop the others
    const failed = [];
    for (const name of ['site', 'combine', 'warnings', 'curtail', 'trading', 'storage', 'evaluate', 'assess']) {
      try { if (!A[name]) throw new Error(`assets/js/${name}.js not loaded`); A[name].init(); }
      catch (e) { console.error(`[${name}]`, e); failed.push(`${name}: ${e.message}`); }
    }
    if (failed.length) A.toast('Some parts failed to start (old or missing file?) — ' + failed.join(' | ') + '. Re-upload docs/assets and press Ctrl+F5.', 'error', 15000);
    $('runBtn').addEventListener('click', (e) => A.busy(e.target, A.forecast.run));
    $('csvBtn').addEventListener('click', A.forecast.csv);
    // keep dependent tabs in sync after each forecast
    document.addEventListener('forecast:ready', () => {
      if (A.trading.last) A.trading.run().catch(() => {});
    });
    try { A.storage.runMdp(); } catch (e) { console.error(e); }   // lecture example renders instantly
  });
})(window.App);
