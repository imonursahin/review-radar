const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function waitingSince(pr, me, teams) {
  const events = (pr.timelineItems?.nodes ?? []).filter(Boolean);
  for (let i = events.length - 1; i >= 0; i--) {
    const reviewer = events[i].requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.login && reviewer.login === me) return events[i].createdAt;
    if (reviewer.slug && teams.has(`${reviewer.organization?.login}/${reviewer.slug}`)) {
      return events[i].createdAt;
    }
  }
  return pr.createdAt;
}

function ageLevel(ageMs, yellowDays, redDays) {
  if (ageMs >= redDays * DAY) return 'red';
  if (ageMs >= yellowDays * DAY) return 'yellow';
  return 'green';
}

function formatAge(ageMs) {
  if (ageMs >= DAY) return `${Math.floor(ageMs / DAY)}d`;
  const hours = Math.floor(ageMs / HOUR);
  return hours < 1 ? '<1h' : `${hours}h`;
}

function formatAgeLong(ageMs) {
  if (ageMs >= DAY) {
    const days = Math.floor(ageMs / DAY);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  const hours = Math.floor(ageMs / HOUR);
  if (hours < 1) return 'less than an hour';
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function requestKey(pr) {
  return `${pr.id}@${pr.waitingSince}`;
}

const KNOWN_GRACE_MS = 7 * DAY;

function trackRequests(prs, known, unseen, { initialized, now, matchById = false }) {
  const knownIds = new Set([...known.keys()].map((key) => key.split('@')[0]));
  const isKnown = (pr) => known.has(requestKey(pr)) || (matchById && knownIds.has(pr.id));
  const fresh = initialized ? prs.filter((pr) => !isKnown(pr)) : [];

  const nextKnown = new Map([...known].filter(([, seenAt]) => now - seenAt < KNOWN_GRACE_MS));
  for (const pr of prs) nextKnown.set(requestKey(pr), now);

  const currentKeys = new Set(prs.map(requestKey));
  const nextUnseen = new Set([...unseen].filter((key) => currentKeys.has(key)));
  for (const pr of fresh) nextUnseen.add(requestKey(pr));
  return { fresh, known: nextKnown, unseen: nextUnseen };
}

function trayState(rows, unseenCount) {
  if (rows.length === 0) return { mode: 'empty', count: 0, badge: 0 };
  if (unseenCount > 0) return { mode: 'new', count: rows.length, badge: unseenCount };
  return { mode: rows[0].level === 'green' ? 'normal' : rows[0].level, count: rows.length, badge: 0 };
}

function buildRows(prs, { now, yellowDays, redDays, unseen }) {
  return prs
    .map((pr) => {
      const ageMs = Math.max(0, now - Date.parse(pr.waitingSince));
      return {
        id: pr.id,
        key: requestKey(pr),
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        isDraft: pr.isDraft,
        author: pr.author,
        avatarUrl: pr.avatarUrl,
        labels: pr.labels,
        ageMs,
        age: formatAge(ageMs),
        level: ageLevel(ageMs, yellowDays, redDays),
        isNew: unseen.has(requestKey(pr)),
      };
    })
    .sort((a, b) => b.ageMs - a.ageMs);
}

function matchesFilter(repoFullName, visibleRepos) {
  if (!visibleRepos || visibleRepos.size === 0) return true;
  return visibleRepos.has(String(repoFullName ?? '').toLowerCase());
}

function buildFilterList(pool, selectedRepos) {
  const selected = new Set(selectedRepos.map((name) => name.toLowerCase()));
  const orgLogins = new Set((pool.orgs ?? []).map((login) => login.toLowerCase()));
  const avatars = pool.avatars ?? {};
  const byOwner = new Map();
  for (const nameWithOwner of pool.repos ?? []) {
    const [owner, name] = nameWithOwner.split('/');
    const key = owner.toLowerCase();
    if (!byOwner.has(key)) byOwner.set(key, { owner, isOrg: orgLogins.has(key), repos: [] });
    byOwner.get(key).repos.push({ name, nameWithOwner, selected: selected.has(nameWithOwner.toLowerCase()) });
  }
  const stateOf = (repos) => {
    if (repos.length === 0) return 'none';
    const on = repos.filter((repo) => repo.selected).length;
    if (on === repos.length) return 'all';
    return on === 0 ? 'none' : 'some';
  };
  const byName = (a, b) => a.name.localeCompare(b.name);
  const poolNames = new Set((pool.repos ?? []).map((name) => name.toLowerCase()));
  const groups = [...byOwner.values()]
    .map((group) => ({
      owner: group.owner,
      isOrg: group.isOrg,
      avatarUrl: avatars[group.owner.toLowerCase()] ?? null,
      state: stateOf(group.repos),
      repos: group.repos.sort(byName),
    }))
    .sort((a, b) => Number(b.isOrg) - Number(a.isOrg) || a.owner.localeCompare(b.owner));
  const missing = selectedRepos.filter((name) => !poolNames.has(name.toLowerCase())).sort();
  return { groups, missing, truncated: Boolean(pool.truncated) };
}

function isNewerVersion(latest, current) {
  const parse = (version) =>
    String(version)
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

module.exports = {
  DAY,
  HOUR,
  waitingSince,
  ageLevel,
  formatAge,
  formatAgeLong,
  requestKey,
  trackRequests,
  trayState,
  buildRows,
  isNewerVersion,
  matchesFilter,
  buildFilterList,
};
