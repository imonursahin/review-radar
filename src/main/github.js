const { execFile } = require('node:child_process');

const ENDPOINT = 'https://api.github.com/graphql';
const LATEST_RELEASE_URL = 'https://api.github.com/repos/imonursahin/review-radar/releases/latest';
const TIMEOUT_MS = 15000;
const GH_TIMEOUT_MS = 3000;
const GH_PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':');
const ORG_CONCURRENCY = 6;

const REVIEWS_QUERY = `
query {
  search(type: ISSUE, query: "is:open is:pr review-requested:@me archived:false", first: 50) {
    nodes {
      ... on PullRequest {
        id
        number
        title
        url
        isDraft
        createdAt
        repository { name nameWithOwner }
        author { login avatarUrl }
        labels(first: 5) { nodes { name } }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
          nodes {
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer {
                ... on User { login }
                ... on Team { slug organization { login } }
              }
            }
          }
        }
      }
    }
  }
}`;

const TEAMS_QUERY = `
query($login: String!) {
  viewer {
    organizations(first: 100) {
      nodes { login teams(first: 100, userLogins: [$login]) { nodes { slug } } }
    }
  }
}`;

const ORGS_QUERY = `
query {
  viewer {
    organizations(first: 100) {
      nodes { login }
    }
  }
}`;

const VIEWER_REPOS_QUERY = `
query($cursor: String) {
  viewer {
    repositories(first: 100, after: $cursor, affiliations: [OWNER, COLLABORATOR], orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner owner { avatarUrl } }
    }
  }
}`;

const ORG_REPOS_QUERY = `
query($login: String!, $cursor: String) {
  organization(login: $login) {
    repositories(first: 100, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner owner { avatarUrl } }
    }
  }
}`;

class GitHubError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function formatReset(epochSeconds) {
  const date = new Date(Number(epochSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function graphql(token, query, variables) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Review-Radar',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError';
    throw new GitHubError('network', timedOut ? 'GitHub did not answer in time.' : "Can't reach GitHub.");
  }

  if (response.status === 401) {
    throw new GitHubError('auth', 'GitHub rejected the token. Sign out and connect again.');
  }

  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
  if (rateLimited) {
    const reset = formatReset(response.headers.get('x-ratelimit-reset'));
    throw new GitHubError('rate', reset ? `GitHub rate limit hit. Resets at ${reset}.` : 'GitHub rate limit hit.');
  }

  if (!response.ok) {
    throw new GitHubError('http', `GitHub answered ${response.status}.`);
  }

  const body = await response.json().catch(() => null);
  if (!body) throw new GitHubError('http', 'GitHub sent an unreadable response.');

  let warning = null;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    if (body.errors.some((error) => error.type === 'RATE_LIMITED')) {
      throw new GitHubError('rate', 'GitHub rate limit hit.');
    }
    const message = body.errors[0].message || 'GitHub returned an error.';
    if (!body.data) throw new GitHubError('graphql', message);
    console.warn('GitHub returned partial data:', body.errors);
    warning = `Some results are hidden: ${message}`;
  }

  return { data: body.data, scopes: response.headers.get('x-oauth-scopes'), warning };
}

async function fetchViewer(token) {
  const { data, scopes } = await graphql(token, 'query { viewer { login } }');
  const login = data?.viewer?.login;
  if (!login) throw new GitHubError('graphql', 'GitHub did not return your login.');
  return { login, scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean) };
}

async function fetchTeams(token, login) {
  const { data } = await graphql(token, TEAMS_QUERY, { login });
  const teams = new Set();
  for (const org of data?.viewer?.organizations?.nodes ?? []) {
    if (!org) continue;
    for (const team of org.teams?.nodes ?? []) {
      if (team) teams.add(`${org.login}/${team.slug}`);
    }
  }
  return teams;
}

async function fetchReviewRequests(token) {
  const { data, warning } = await graphql(token, REVIEWS_QUERY);
  const nodes = data?.search?.nodes;
  if (!Array.isArray(nodes)) throw new GitHubError('graphql', warning ?? 'GitHub returned no search results.');
  const prs = nodes
    .filter((node) => node && node.id)
    .map((node) => ({
      id: node.id,
      number: node.number,
      title: node.title,
      url: node.url,
      isDraft: node.isDraft,
      createdAt: node.createdAt,
      repo: node.repository?.name ?? '',
      repoFullName: node.repository?.nameWithOwner ?? '',
      author: node.author?.login ?? 'ghost',
      avatarUrl: node.author?.avatarUrl ?? null,
      labels: (node.labels?.nodes ?? []).filter(Boolean).map((label) => label.name),
      timelineItems: node.timelineItems,
    }));
  return { prs, warning };
}

async function collectRepos(token, query, variables, read, maxPages) {
  const repos = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const { data } = await graphql(token, query, { ...variables, cursor });
    const connection = read(data);
    if (!connection) return { repos, truncated: false };
    for (const repo of connection.nodes ?? []) {
      if (repo?.nameWithOwner) {
        repos.push({ nameWithOwner: repo.nameWithOwner, avatarUrl: repo.owner?.avatarUrl ?? null });
      }
    }
    if (!connection.pageInfo?.hasNextPage) return { repos, truncated: false };
    cursor = connection.pageInfo.endCursor;
    if (page === maxPages - 1) return { repos, truncated: true };
  }
  return { repos, truncated: false };
}

async function fetchRepoPool(token, { maxPages = 10 } = {}) {
  const { data } = await graphql(token, ORGS_QUERY);
  const orgs = (data?.viewer?.organizations?.nodes ?? [])
    .filter((org) => org?.login)
    .map((org) => org.login)
    .sort();

  const names = new Set();
  const avatars = {};
  const add = (entries) => {
    for (const entry of entries) {
      names.add(entry.nameWithOwner);
      const owner = entry.nameWithOwner.split('/')[0].toLowerCase();
      if (entry.avatarUrl && !avatars[owner]) avatars[owner] = entry.avatarUrl;
    }
  };

  const mine = await collectRepos(token, VIEWER_REPOS_QUERY, {}, (view) => view?.viewer?.repositories, maxPages);
  add(mine.repos);

  let truncated = mine.truncated;
  const read = (view) => view?.organization?.repositories;
  for (let start = 0; start < orgs.length; start += ORG_CONCURRENCY) {
    const batch = orgs.slice(start, start + ORG_CONCURRENCY);
    const found = await Promise.all(
      batch.map((login) => collectRepos(token, ORG_REPOS_QUERY, { login }, read, maxPages)),
    );
    for (const result of found) {
      add(result.repos);
      truncated = truncated || result.truncated;
    }
  }
  return { orgs, repos: [...names].sort(), avatars, truncated };
}

async function fetchLatestRelease(token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Review-Radar' };
  if (token) headers.Authorization = `bearer ${token}`;
  let response;
  try {
    response = await fetch(LATEST_RELEASE_URL, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError';
    throw new GitHubError('network', timedOut ? 'GitHub did not answer in time.' : "Can't reach GitHub.");
  }
  if (response.status === 404) return null;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
  if (rateLimited) throw new GitHubError('rate', 'GitHub rate limit hit. Try again later.');
  if (!response.ok) throw new GitHubError('http', `GitHub answered ${response.status}.`);
  const body = await response.json().catch(() => null);
  if (typeof body?.tag_name !== 'string') throw new GitHubError('http', 'GitHub sent an unreadable response.');
  return { version: body.tag_name.replace(/^v/, ''), url: body.html_url };
}

function runGh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, env: { ...process.env, PATH: GH_PATH } }, (error, stdout) => {
      if (error && error.code !== 'ENOENT') console.warn(`gh ${args.slice(0, 2).join(' ')} failed:`, error.message);
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

async function readGhAccount() {
  const [token, login] = await Promise.all([
    runGh(['auth', 'token', '--hostname', 'github.com']),
    runGh(['config', 'get', '--host', 'github.com', 'user']),
  ]);
  return token ? { token, login } : null;
}

module.exports = { GitHubError, fetchViewer, fetchTeams, fetchRepoPool, fetchReviewRequests, fetchLatestRelease, readGhAccount };
