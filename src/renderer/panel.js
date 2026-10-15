const subtitle = document.getElementById('subtitle');
const refreshButton = document.getElementById('refresh');
const errorRow = document.getElementById('error');
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const panelElement = document.getElementById('panel');
const filterToggle = document.getElementById('filter-toggle');
const filterSection = document.getElementById('filter');
const filterSearch = document.getElementById('filter-search');
const filterList = document.getElementById('filter-list');
const filterStatus = document.getElementById('filter-status');

let lastTrayKey = null;

function measure() {
  requestAnimationFrame(() => window.radar.setPanelHeight(panelElement.getBoundingClientRect().height));
}

function describeCount(count, oldest) {
  if (count === 0) return 'No pull requests';
  const noun = count === 1 ? 'pull request' : 'pull requests';
  return `${count} ${noun} · oldest ${oldest}`;
}

function createRow(row) {
  const item = document.createElement('li');
  item.className = 'row';
  item.tabIndex = 0;
  item.setAttribute('role', 'link');
  item.setAttribute('aria-label', `${row.repo} #${row.number} by ${row.author}: ${row.title}, waiting ${row.age}`);

  const avatar = createAvatar(row.author, row.avatarUrl);
  if (row.isNew) {
    const dot = document.createElement('span');
    dot.className = 'new-dot';
    avatar.append(dot);
  }

  const body = document.createElement('div');
  body.className = 'body';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${row.repo} #${row.number} · ${row.author}`;

  const title = document.createElement('div');
  title.className = row.isDraft ? 'pr-title draft' : 'pr-title';
  title.textContent = row.title;

  body.append(meta, title);

  const chipNames = row.isDraft ? ['Draft', ...row.labels] : row.labels;
  if (chipNames.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const name of chipNames) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = name;
      chips.append(chip);
    }
    body.append(chips);
  }

  const pill = document.createElement('span');
  pill.className = `pill ${row.level}`;
  pill.textContent = row.age;

  item.append(avatar, body, pill);
  item.addEventListener('click', () => window.radar.openUrl(row.url));
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      window.radar.openUrl(row.url);
    }
  });
  return item;
}

function render(state) {
  subtitle.textContent = describeCount(state.rows.length, state.oldest);
  refreshButton.textContent = state.loading ? 'Checking…' : 'Refresh';
  refreshButton.disabled = state.loading;

  errorRow.hidden = !state.error;
  errorRow.textContent = state.error ?? '';

  list.replaceChildren(...state.rows.map(createRow));
  empty.hidden = state.rows.length > 0 || Boolean(state.error);

  const trayKey = JSON.stringify(state.tray);
  if (trayKey !== lastTrayKey) {
    lastTrayKey = trayKey;
    window.radar.setTrayImage(renderTrayImage(state.tray));
  }

  measure();
}

window.radar.onState(render);

const filterPanel = window.mountFilterPanel({
  list: filterList,
  search: filterSearch,
  empty: filterStatus,
  refresh: document.getElementById('filter-refresh'),
  chips: document.getElementById('filter-chips'),
  summary: document.getElementById('filter-summary'),
  clear: document.getElementById('filter-clear'),
  onChange: measure,
});

filterToggle.addEventListener('click', () => {
  const opening = filterSection.hidden;
  filterSection.hidden = !opening;
  filterToggle.setAttribute('aria-expanded', String(opening));
  panelElement.classList.toggle('filter-open', opening);
  if (opening) filterPanel.load(false);
  measure();
});

refreshButton.addEventListener('click', () => window.radar.refresh());
document.getElementById('open-queue').addEventListener('click', () => window.radar.openQueue());
document.getElementById('open-settings').addEventListener('click', () => window.radar.openSettings());
document.getElementById('quit').addEventListener('click', () => window.radar.quit());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.radar.closePanel();
    return;
  }
  if (!event.metaKey) return;
  const actions = { o: window.radar.openQueue, ',': window.radar.openSettings, q: window.radar.quit, r: window.radar.refresh };
  const action = actions[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    action();
  }
});
