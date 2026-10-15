window.mountFilterPanel = function mountFilterPanel({ list, search, empty, refresh, chips, summary, clear, onChange }) {
  let view = { groups: [], missing: [], truncated: false };
  let seq = 0;
  let rendered = 0;
  let lastShape = '';
  const overrides = new Map();

  function selectedNames() {
    const names = [...view.missing];
    for (const group of view.groups) {
      for (const repo of group.repos) if (repo.selected) names.push(repo.nameWithOwner);
    }
    return names;
  }

  function matches(text, query) {
    return !query || text.toLowerCase().includes(query);
  }

  function setError(message) {
    if (!empty) return;
    empty.hidden = false;
    empty.textContent = message ?? 'Could not save the filter.';
  }

  function apply(next) {
    if (!next || !Array.isArray(next.groups)) return;
    view = next;
    draw();
  }

  function save(pending) {
    const mine = ++seq;
    return pending.then(
      (next) => {
        if (mine !== seq) return;
        if (next && Array.isArray(next.groups)) apply(next);
        else setError(next?.error);
      },
      (error) => {
        if (mine !== seq) return;
        setError(error?.message);
      },
    );
  }

  function toggleRepo(name, selected) {
    return save(window.radar.toggleRepo(name, selected));
  }

  function toggleOwner(group) {
    overrides.delete(group.owner);
    return save(window.radar.toggleOwner(group.owner, group.state !== 'all'));
  }

  function repoRow(repo, className) {
    rendered += 1;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = repo.selected;
    box.addEventListener('change', () => toggleRepo(repo.nameWithOwner, box.checked));
    const label = document.createElement('label');
    label.className = className ? `filter-row ${className}` : 'filter-row';
    const text = document.createElement('span');
    text.className = 'filter-name';
    text.textContent = repo.name ?? repo.nameWithOwner;
    label.append(box, text);
    return label;
  }

  function heading(text) {
    const element = document.createElement('div');
    element.className = 'filter-label';
    element.textContent = text;
    return element;
  }

  function ownerGroup(group, query) {
    const ownerMatches = matches(group.owner, query);
    const repos = ownerMatches
      ? group.repos
      : group.repos.filter((repo) => matches(repo.nameWithOwner, query));
    if (!ownerMatches && repos.length === 0) return null;

    const expanded = overrides.has(group.owner)
      ? overrides.get(group.owner)
      : Boolean(query) || group.state !== 'none';
    const wrapper = document.createElement('div');
    wrapper.className = 'filter-group';

    const team = document.createElement('div');
    team.className = 'filter-team';
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'filter-caret';
    caret.textContent = expanded ? '▾' : '▸';
    caret.setAttribute('aria-expanded', String(expanded));
    caret.addEventListener('click', () => {
      overrides.set(group.owner, !expanded);
      draw();
    });

    const label = document.createElement('label');
    label.className = 'filter-row owner';
    rendered += 1;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = group.state === 'all';
    box.indeterminate = group.state === 'some';
    box.addEventListener('change', () => toggleOwner(group));
    const avatar = createAvatar(group.owner, group.avatarUrl);
    avatar.classList.add('filter-avatar');
    const name = document.createElement('span');
    name.className = 'filter-name';
    name.textContent = group.owner;
    const badge = document.createElement('span');
    badge.className = group.isOrg ? 'filter-badge' : 'filter-badge user';
    badge.textContent = group.isOrg ? 'org' : 'user';
    const count = document.createElement('span');
    count.className = 'filter-count';
    count.textContent = `${group.repos.filter((repo) => repo.selected).length}/${group.repos.length}`;
    label.append(box, avatar, name, badge, count);
    team.append(caret, label);
    wrapper.append(team);

    if (expanded) {
      const children = document.createElement('div');
      children.className = 'filter-children';
      for (const repo of repos) children.append(repoRow(repo));
      wrapper.append(children);
    }
    return wrapper;
  }

  function chipFor(name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'filter-chip';
    button.title = name;
    const text = document.createElement('span');
    text.textContent = name;
    const cross = document.createElement('span');
    cross.className = 'filter-chip-x';
    cross.textContent = '✕';
    button.append(text, cross);
    button.addEventListener('click', () => toggleRepo(name, false));
    return button;
  }

  function draw() {
    const query = search.value.trim().toLowerCase();
    rendered = 0;
    const nodes = [];
    const missing = view.missing.filter((name) => matches(name, query));
    if (missing.length > 0) {
      const unreadable = view.ok === false;
      nodes.push(heading(unreadable ? 'Selected' : 'No longer available'));
      for (const name of missing) {
        nodes.push(repoRow({ nameWithOwner: name, selected: true }, unreadable ? undefined : 'missing'));
      }
    }
    nodes.push(...view.groups.map((group) => ownerGroup(group, query)).filter(Boolean));
    list.replaceChildren(...nodes);

    const names = selectedNames();
    const total = view.groups.reduce((count, group) => count + group.repos.length, 0);
    if (chips) {
      chips.replaceChildren(...names.map(chipFor));
      chips.hidden = names.length === 0;
    }
    if (summary) summary.textContent = total > 0 ? `${names.length} of ${total} repositories shown` : '';
    if (clear) clear.hidden = names.length === 0;

    if (empty) {
      const message = view.error
        ? view.error
        : view.truncated
          ? `Too many repositories to list — showing the first ${total}. Narrow with the search.`
          : '';
      empty.hidden = !message;
      empty.textContent = message;
    }

    const shape = `${rendered}:${names.length}`;
    if (onChange && shape !== lastShape) {
      lastShape = shape;
      onChange();
    }
  }

  function load(refreshPool) {
    const mine = ++seq;
    if (empty && view.groups.length === 0 && view.missing.length === 0) {
      empty.hidden = false;
      empty.textContent = 'Loading repositories…';
    }
    return window.radar.getFilterView(refreshPool === true).then(
      (next) => {
        if (mine === seq) apply(next);
      },
      (error) => {
        if (mine === seq) setError(error?.message);
      },
    );
  }

  let frame = 0;
  function scheduleDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  search.addEventListener('input', scheduleDraw);
  if (refresh) refresh.addEventListener('click', () => load(true));
  if (clear) clear.addEventListener('click', () => save(window.radar.clearFilter()));
  return { load };
};
