// Desktop shell: persistent navigation around an iframe. Opens on Setup only when something required is missing.
(async () => {
  const U = PixelUI, frame = document.getElementById('pageFrame');
  const mac = window.desktopApp?.platform === 'darwin';
  const FULL_SCREEN = new Set(['setup', 'talk']);
  document.body.classList.toggle('mac', mac);

  function setPage(page) {
    const href = U.hrefFor(page);
    if (!href) return;
    document.body.classList.toggle('full', FULL_SCREEN.has(page));
    U.markActive(page);
    document.title = `Pixel · ${page === 'setup' ? 'Setup' : U.NAV.find(item => item.id === page).label}`;
    frame.src = `${href}?embedded=1${mac ? '&inset=1' : ''}`;
  }
  U.mountSidebar(null, { onNavigate: setPage });
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === 'pixel:navigate') setPage(event.data.page);
  });

  let start = 'setup';
  try { const { summary } = await U.api('/api/system/status'); if (summary.ready >= summary.required) start = 'talk'; } catch (_) { /* Setup explains the problem */ }
  setPage(start);
})();
