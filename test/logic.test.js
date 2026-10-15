const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../src/main/logic');

const event = (createdAt, requestedReviewer) => ({ createdAt, requestedReviewer });

const pr = (overrides = {}) => ({
  id: 'PR_1',
  number: 1,
  title: 'Title',
  url: 'https://github.com/acme/web/pull/1',
  isDraft: false,
  createdAt: '2026-10-01T00:00:00Z',
  repo: 'acme/web',
  author: 'elif',
  avatarUrl: null,
  labels: [],
  timelineItems: { nodes: [] },
  ...overrides,
});

test('waitingSince uses the latest request that targets me', () => {
  const item = pr({
    timelineItems: {
      nodes: [
        event('2026-10-02T00:00:00Z', { login: 'onur' }),
        event('2026-10-03T00:00:00Z', { login: 'someone' }),
        event('2026-10-04T00:00:00Z', { login: 'onur' }),
        event('2026-10-05T00:00:00Z', { login: 'someone-else' }),
      ],
    },
  });
  assert.equal(waitingSince(item, 'onur', new Set()), '2026-10-04T00:00:00Z');
});

test('waitingSince matches a request to one of my teams by org and slug', () => {
  const item = pr({
    timelineItems: {
      nodes: [
        event('2026-10-02T00:00:00Z', { slug: 'web', organization: { login: 'acme' } }),
        event('2026-10-03T00:00:00Z', { slug: 'web', organization: { login: 'other-org' } }),
      ],
    },
  });
  assert.equal(waitingSince(item, 'onur', new Set(['acme/web'])), '2026-10-02T00:00:00Z');
});

test('waitingSince falls back to PR creation when no event targets me', () => {
  const item = pr({ timelineItems: { nodes: [event('2026-10-03T00:00:00Z', { login: 'someone' }), null] } });
  assert.equal(waitingSince(item, 'onur', new Set()), '2026-10-01T00:00:00Z');
  assert.equal(waitingSince(pr({ timelineItems: null }), 'onur', new Set()), '2026-10-01T00:00:00Z');
});

test('waitingSince skips events whose reviewer was deleted', () => {
  const item = pr({ timelineItems: { nodes: [event('2026-10-02T00:00:00Z', { login: 'onur' }), event('2026-10-03T00:00:00Z', null)] } });
  assert.equal(waitingSince(item, 'onur', new Set()), '2026-10-02T00:00:00Z');
});

test('ageLevel colors by threshold, inclusive at each boundary', () => {
  assert.equal(ageLevel(2 * DAY - 1, 2, 5), 'green');
  assert.equal(ageLevel(2 * DAY, 2, 5), 'yellow');
  assert.equal(ageLevel(5 * DAY - 1, 2, 5), 'yellow');
  assert.equal(ageLevel(5 * DAY, 2, 5), 'red');
  assert.equal(ageLevel(0, 1, 3), 'green');
});

test('formatAge shows hours under a day and whole days after', () => {
  assert.equal(formatAge(30 * 60 * 1000), '<1h');
  assert.equal(formatAge(5 * HOUR + 59 * 60 * 1000), '5h');
  assert.equal(formatAge(23 * HOUR), '23h');
  assert.equal(formatAge(DAY), '1d');
  assert.equal(formatAge(3 * DAY + 23 * HOUR), '3d');
});

test('formatAgeLong uses singular and plural forms', () => {
  assert.equal(formatAgeLong(DAY), '1 day');
  assert.equal(formatAgeLong(6 * DAY), '6 days');
  assert.equal(formatAgeLong(HOUR), '1 hour');
  assert.equal(formatAgeLong(5 * HOUR), '5 hours');
  assert.equal(formatAgeLong(10 * 60 * 1000), 'less than an hour');
});

const tracked = (id, waiting) => ({ ...pr({ id }), waitingSince: waiting });
const NOW = Date.parse('2026-10-12T12:00:00Z');
const knownAt = (items, at = NOW) => new Map(items.map((item) => [requestKey(item), at]));

test('trackRequests seeds known requests on the first run without flagging them', () => {
  const prs = [tracked('A', '2026-10-01T00:00:00Z'), tracked('B', '2026-10-02T00:00:00Z')];
  const result = trackRequests(prs, new Map(), new Set(), { initialized: false, now: NOW });
  assert.deepEqual(result.fresh, []);
  assert.deepEqual([...result.known.keys()].sort(), prs.map(requestKey).sort());
  assert.equal(result.unseen.size, 0);
});

test('trackRequests flags only requests it has not seen before', () => {
  const a = tracked('A', '2026-10-01T00:00:00Z');
  const b = tracked('B', '2026-10-02T00:00:00Z');
  const result = trackRequests([a, b], knownAt([a]), new Set(), { initialized: true, now: NOW });
  assert.deepEqual(result.fresh.map((item) => item.id), ['B']);
  assert.deepEqual([...result.unseen], [requestKey(b)]);
});

test('trackRequests treats a re-request on the same PR as new', () => {
  const before = tracked('A', '2026-10-01T00:00:00Z');
  const after = tracked('A', '2026-10-06T00:00:00Z');
  const result = trackRequests([after], knownAt([before]), new Set(), { initialized: true, now: NOW });
  assert.deepEqual(result.fresh.map((item) => item.waitingSince), ['2026-10-06T00:00:00Z']);
});

test('trackRequests does not re-flag a request that briefly left the search results', () => {
  const a = tracked('A', '2026-10-01T00:00:00Z');
  const afterGap = trackRequests([], knownAt([a]), new Set(), { initialized: true, now: NOW });
  const back = trackRequests([a], afterGap.known, afterGap.unseen, { initialized: true, now: NOW + 60_000 });
  assert.deepEqual(back.fresh, []);
});

test('trackRequests forgets requests that have been gone for a week', () => {
  const a = tracked('A', '2026-10-01T00:00:00Z');
  const result = trackRequests([], knownAt([a], NOW - 8 * DAY), new Set(), { initialized: true, now: NOW });
  assert.equal(result.known.size, 0);
});

test('trackRequests matches by PR id when the waiting time moved because team data changed', () => {
  const beforeTeams = tracked('A', '2026-10-01T00:00:00Z');
  const withTeams = tracked('A', '2026-10-04T00:00:00Z');
  const brandNew = tracked('B', '2026-10-05T00:00:00Z');
  const result = trackRequests([withTeams, brandNew], knownAt([beforeTeams]), new Set(), {
    initialized: true,
    now: NOW,
    matchById: true,
  });
  assert.deepEqual(result.fresh.map((item) => item.id), ['B']);
});

test('trackRequests drops unseen markers for requests that left the queue', () => {
  const a = tracked('A', '2026-10-01T00:00:00Z');
  const gone = tracked('GONE', '2026-10-02T00:00:00Z');
  const result = trackRequests([a], knownAt([a, gone]), new Set([requestKey(gone)]), { initialized: true, now: NOW });
  assert.deepEqual(result.fresh, []);
  assert.equal(result.unseen.size, 0);
});

test('trackRequests keeps earlier unseen markers until the panel clears them', () => {
  const a = tracked('A', '2026-10-01T00:00:00Z');
  const result = trackRequests([a], knownAt([a]), new Set([requestKey(a)]), { initialized: true, now: NOW });
  assert.deepEqual([...result.unseen], [requestKey(a)]);
});

test('buildRows sorts oldest first and marks unseen rows', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const fresh = tracked('FRESH', '2026-10-12T07:00:00Z');
  const old = tracked('OLD', '2026-10-06T12:00:00Z');
  const rows = buildRows([fresh, old], { now, yellowDays: 2, redDays: 5, unseen: new Set([requestKey(fresh)]) });
  assert.deepEqual(rows.map((row) => row.id), ['OLD', 'FRESH']);
  assert.deepEqual(rows.map((row) => row.age), ['6d', '5h']);
  assert.deepEqual(rows.map((row) => row.level), ['red', 'green']);
  assert.deepEqual(rows.map((row) => row.isNew), [false, true]);
});

test('buildRows never reports a negative age for clock skew', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const rows = buildRows([tracked('A', '2026-10-12T12:05:00Z')], { now, yellowDays: 2, redDays: 5, unseen: new Set() });
  assert.equal(rows[0].ageMs, 0);
});

test('trayState follows the oldest row and prefers the new-request state', () => {
  assert.deepEqual(trayState([], 0), { mode: 'empty', count: 0, badge: 0 });
  assert.deepEqual(trayState([{ level: 'green' }, { level: 'green' }], 0), { mode: 'normal', count: 2, badge: 0 });
  assert.deepEqual(trayState([{ level: 'yellow' }], 0), { mode: 'yellow', count: 1, badge: 0 });
  assert.deepEqual(trayState([{ level: 'red' }, { level: 'green' }], 0), { mode: 'red', count: 2, badge: 0 });
  assert.deepEqual(trayState([{ level: 'red' }, { level: 'green' }], 1), { mode: 'new', count: 2, badge: 1 });
});

test('isNewerVersion compares release tags number by number', () => {
  assert.equal(isNewerVersion('v1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('1.10.0', '1.9.3'), true);
  assert.equal(isNewerVersion('v2.0', '1.9.9'), true);
  assert.equal(isNewerVersion('v1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0', '1.0.0'), false);
  assert.equal(isNewerVersion('v0.9.9', '1.0.0'), false);
});

test('matchesFilter shows everything when nothing is selected', () => {
  assert.equal(matchesFilter('acme/web', new Set()), true);
  assert.equal(matchesFilter('acme/web', undefined), true);
});

test('matchesFilter keeps only the selected repositories', () => {
  assert.equal(matchesFilter('acme/web', new Set(['acme/web'])), true);
  assert.equal(matchesFilter('acme/api', new Set(['acme/web'])), false);
});

test('matchesFilter ignores case and tolerates a missing repo name', () => {
  assert.equal(matchesFilter('Acme/Web', new Set(['acme/web'])), true);
  assert.equal(matchesFilter(undefined, new Set(['acme/web'])), false);
});

const POOL = {
  orgs: ['zorg'],
  repos: ['zorg/web', 'zorg/api', 'alice/tool'],
  avatars: { zorg: 'https://avatars.githubusercontent.com/zorg', alice: 'https://avatars.githubusercontent.com/alice' },
  truncated: false,
};

test('buildFilterList groups by owner, orgs first, with short repo names', () => {
  const list = buildFilterList(POOL, ['zorg/web']);
  assert.deepEqual(
    list.groups.map((group) => [group.owner, group.isOrg, group.avatarUrl, group.state]),
    [
      ['zorg', true, 'https://avatars.githubusercontent.com/zorg', 'some'],
      ['alice', false, 'https://avatars.githubusercontent.com/alice', 'none'],
    ],
  );
  assert.deepEqual(list.groups[0].repos, [
    { name: 'api', nameWithOwner: 'zorg/api', selected: false },
    { name: 'web', nameWithOwner: 'zorg/web', selected: true },
  ]);
});

test('buildFilterList reports all/none group states', () => {
  assert.equal(buildFilterList(POOL, ['zorg/web', 'zorg/api']).groups[0].state, 'all');
  assert.equal(buildFilterList(POOL, []).groups[0].state, 'none');
});

test('buildFilterList surfaces checked entries missing from the pool', () => {
  const list = buildFilterList(POOL, ['zorg/web', 'old/repo']);
  assert.deepEqual(list.missing, ['old/repo']);
});

test('buildFilterList reports an empty group as none, not all', () => {
  assert.equal(buildFilterList({ orgs: [], repos: [] }, []).groups.length, 0);
});

test('buildFilterList matches case-insensitively and passes truncation through', () => {
  const list = buildFilterList({ ...POOL, truncated: true }, ['Zorg/Web']);
  assert.equal(list.groups[0].repos.find((repo) => repo.nameWithOwner === 'zorg/web').selected, true);
  assert.deepEqual(list.missing, []);
  assert.equal(list.truncated, true);
});
