const frame = document.getElementById('pageFrame');
const links = [...document.querySelectorAll('.desktop-nav a[data-page]')];
const destinations = {talk:'/?embedded=1',models:'/models?embedded=1',engine:'/engine?embedded=1',latency:'/latency?embedded=1'};
function setPage(page) {
  const target = destinations[page];
  if (!target) return;
  document.body.classList.toggle('talk-active', page === 'talk');
  links.forEach(item => item.classList.toggle('active', item.dataset.page === page));
  frame.src = target;
}
links.forEach(link => link.addEventListener('click', event => {
  const page = link.dataset.page;
  if (!destinations[page]) { event.preventDefault(); return; }
  event.preventDefault(); setPage(page);
}));
window.addEventListener('message', event => { if (event.data?.type === 'pixel:navigate') setPage(event.data.page); });
setPage('talk');
