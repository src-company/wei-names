// zFi shared theme — dark mode toggle
// FOUC prevention: call inline before any <style> — see each page's <head>

function toggleDark() {
  const on = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('dark', on ? '1' : '0'); } catch (_) {}
}

// Render the dark-mode toggle into <div id="z-nav">
function _zfiRenderNav() {
  const el = document.getElementById('z-nav');
  if (!el) return;
  el.outerHTML = `<button type="button" class="dark-toggle" onclick="toggleDark()" title="Toggle dark mode" aria-label="Toggle dark mode"></button>`;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _zfiRenderNav);
else _zfiRenderNav();
