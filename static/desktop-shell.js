const frame = document.getElementById('pageFrame');
const links = [...document.querySelectorAll('.desktop-nav a[data-page]')];
const destinations = {talk:'/?embedded=1',models:'/models?embedded=1',engine:'/engine?embedded=1',latency:'/latency?embedded=1'};
links.forEach(link => link.addEventListener('click', event => {
  const page = link.dataset.page;
  if (!destinations[page]) { event.preventDefault(); return; }
  event.preventDefault(); links.forEach(item => item.classList.toggle('active', item === link));
  frame.src = destinations[page];
}));
