const test = require('node:test');
const assert = require('node:assert/strict');
const github = require('../src/main/github');

function stub(routes) {
  global.fetch = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    let data;
    if (query.includes('organization(login:')) data = routes.org[variables.login][variables.cursor ?? null];
    else if (query.includes('organizations(first:')) data = routes.orgs;
    else data = routes.viewer[variables.cursor ?? null];
    return {
      status: 200,
      ok: true,
      headers: { get: () => null, has: () => false },
      json: async () => ({ data }),
    };
  };
}

const connection = (names, hasNextPage, endCursor) => ({
  pageInfo: { hasNextPage, endCursor },
  nodes: names.map((nameWithOwner) => ({
    nameWithOwner,
    owner: { avatarUrl: `https://avatars.githubusercontent.com/${nameWithOwner.split('/')[0]}` },
  })),
});

test('fetchRepoPool collects the viewer repos and every organization repos', async () => {
  stub({
    orgs: { viewer: { organizations: { nodes: [{ login: 'acme' }, { login: 'globex' }] } } },
    viewer: { null: { viewer: { repositories: connection(['me/tool'], false, null) } } },
    org: {
      acme: {
        null: { organization: { repositories: connection(['acme/web'], true, 'c1') } },
        c1: { organization: { repositories: connection(['acme/api'], false, null) } },
      },
      globex: { null: { organization: { repositories: connection(['globex/x'], false, null) } } },
    },
  });
  const pool = await github.fetchRepoPool('t');
  assert.deepEqual(pool.orgs, ['acme', 'globex']);
  assert.deepEqual(pool.repos, ['acme/api', 'acme/web', 'globex/x', 'me/tool']);
  assert.equal(pool.avatars.acme, 'https://avatars.githubusercontent.com/acme');
  assert.equal(pool.avatars.me, 'https://avatars.githubusercontent.com/me');
  assert.equal(pool.truncated, false);
});

test('fetchRepoPool stops at maxPages per connection and reports truncation', async () => {
  stub({
    orgs: { viewer: { organizations: { nodes: [{ login: 'acme' }] } } },
    viewer: { null: { viewer: { repositories: connection(['me/1'], true, 'v1') } } },
    org: { acme: { null: { organization: { repositories: connection(['acme/1'], true, 'c1') } } } },
  });
  const pool = await github.fetchRepoPool('t', { maxPages: 1 });
  assert.deepEqual(pool.repos, ['acme/1', 'me/1']);
  assert.equal(pool.truncated, true);
});

test('fetchRepoPool skips an organization it cannot read', async () => {
  stub({
    orgs: { viewer: { organizations: { nodes: [{ login: 'acme' }, { login: 'secret' }] } } },
    viewer: { null: { viewer: { repositories: connection([], false, null) } } },
    org: {
      acme: { null: { organization: { repositories: connection(['acme/web'], false, null) } } },
      secret: { null: { organization: null } },
    },
  });
  const pool = await github.fetchRepoPool('t');
  assert.deepEqual(pool.repos, ['acme/web']);
});
