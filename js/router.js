// router.js — hash routes.
//   #/projects                      home (project list)
//   #/account/:tab                  personal center (settings | privacy | projects | about)
//   #/p/:id/:module/:a?/:b?         project modules: overview | basics | design | slides | assessments | videos | audit
export function parse(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length || parts[0] === 'projects') return { name: 'projects' };
  if (parts[0] === 'account') return { name: 'account', tab: parts[1] || 'settings' };
  if (parts[0] === 'p' && parts[1]) return { name: 'project', id: parts[1], module: parts[2] || 'overview', a: parts[3] || null, b: parts[4] || null };
  return { name: 'projects' };
}

export function href(...parts) { return '#/' + parts.filter(p => p !== null && p !== undefined && p !== '').map(encodeURIComponent).join('/'); }
export function go(...parts) { const h = href(...parts); if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; }
export function onRoute(fn) { window.addEventListener('hashchange', () => fn(parse())); }
