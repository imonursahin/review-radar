const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  shell,
} = require('electron');
const store = require('./store');
const github = require('./github');
const logic = require('./logic');

const PANEL_WIDTH = 380;
const PANEL_MAX_HEIGHT = 620;
const INTERVALS = [1, 2, 5, 10, 30];
const QUEUE_URL = 'https://github.com/pulls/review-requested';
const SUMMARY_HOUR = 9;
const VALID_REPO = /^[^\s/]{1,100}\/[^\s/]{1,100}$/;
const RENDERER = path.join(__dirname, '..', 'renderer');
const RENDERER_URL = `${pathToFileURL(RENDERER).href}/`;
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const MAX_TRAY_IMAGE_LENGTH = 500_000;
const TRAY_REOPEN_GUARD_MS = 250;
const SOUND = app.isPackaged
  ? path.join(process.resourcesPath, 'new-request.mp3')
  : path.join(__dirname, '..', '..', 'assets', 'new-request.mp3');

let tray = null;
let panel = null;
let settingsWindow = null;
let onboardingWindow = null;
let pollTimer = null;
let summaryTimer = null;

let token = null;
let session = 0;
let activePoll = null;
let teams = null;
let repoPool = null;
let prs = [];
let lastError = null;
let summaryDue = false;
let shownAsNew = new Set();
let lastBlurHideAt = 0;
const liveNotifications = new Set();

function isGitHubUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (isGitHubUrl(url)) shell.openExternal(url);
}

function webPreferences() {
  return { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false };
}

function visibleRepos(settings = store.get()) {
  return new Set((settings.filters?.repos ?? []).map((repo) => repo.toLowerCase()));
}

function visibilityFilter(settings = store.get()) {
  const visible = visibleRepos(settings);
  return (pr) => (settings.includeDrafts || !pr.isDraft) && logic.matchesFilter(pr.repoFullName, visible);
}

function currentView() {
  const settings = store.get();
  const unseen = new Set(settings.unseen);
  const rows = logic.buildRows(prs.filter(visibilityFilter(settings)), {
    now: Date.now(),
    yellowDays: settings.yellowDays,
    redDays: settings.redDays,
    unseen: new Set([...unseen, ...shownAsNew]),
  });
  return {
    connected: Boolean(token),
    loading: activePoll === session,
    error: lastError,
    rows,
    oldest: rows.length > 0 ? logic.formatAgeLong(rows[0].ageMs) : null,
    tray: logic.trayState(rows, rows.filter((row) => unseen.has(row.key)).length),
  };
}

async function loadPool(refresh) {
  if (repoPool && !refresh) return repoPool;
  repoPool = await github.fetchRepoPool(token);
  return repoPool;
}

async function filterView(refresh) {
  const selected = store.get().filters?.repos ?? [];
  try {
    return { ok: true, ...logic.buildFilterList(await loadPool(refresh), selected) };
  } catch (error) {
    console.error('Could not load the repository pool:', error);
    return {
      ok: false,
      error: error.message || 'Could not load your repositories.',
      ...logic.buildFilterList({ orgs: [], repos: [] }, selected),
    };
  }
}

function withSelection(mutate) {
  const current = store.get().filters?.repos ?? [];
  const repos = new Set(current);
  mutate(repos, current);
  store.update({ filters: { repos: [...repos] } });
  push();
  return filterView(false);
}

function push() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('state', currentView());
}

function playSound() {
  execFile('/usr/bin/afplay', [SOUND], (error) => {
    if (error) console.warn('Could not play the notification sound:', error.message);
  });
}

function notify({ title, subtitle, body, url, silent = false }) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, subtitle, body, silent });
  liveNotifications.add(notification);
  const release = () => liveNotifications.delete(notification);
  notification.on('click', () => {
    release();
    if (url) openExternal(url);
  });
  notification.on('close', release);
  notification.show();
}

function recordRequests() {
  const settings = store.get();
  const hasTeams = teams !== null;
  const tracked = logic.trackRequests(prs, new Map(Object.entries(settings.known)), new Set(settings.unseen), {
    initialized: settings.initialized,
    now: Date.now(),
    matchById: hasTeams !== settings.knownWithTeams,
  });
  let unseen = [...tracked.unseen];
  if (panel.isVisible()) {
    for (const key of unseen) shownAsNew.add(key);
    unseen = [];
  }
  store.update({ known: Object.fromEntries(tracked.known), unseen, initialized: true, knownWithTeams: hasTeams });
  if (!settings.notify) return;
  const fresh = tracked.fresh.filter(visibilityFilter(settings));
  for (const pr of fresh) {
    notify({
      title: 'New review request',
      subtitle: `${pr.repo} #${pr.number} · ${pr.author}`,
      body: pr.title,
      url: pr.url,
      silent: true,
    });
  }
  if (fresh.length > 0 && settings.sound) playSound();
}

async function poll() {
  if (!token || activePoll === session) return;
  const pollSession = session;
  const pollToken = token;
  activePoll = pollSession;
  push();
  try {
    let pollTeams = teams;
    if (!pollTeams) {
      try {
        pollTeams = await github.fetchTeams(pollToken, store.get().login);
      } catch (error) {
        if (error.kind === 'auth' || error.kind === 'rate') throw error;
        console.warn('Could not load your teams; team review requests fall back to PR age:', error.message);
      }
    }
    const { prs: fetched, warning } = await github.fetchReviewRequests(pollToken);
    if (pollSession !== session) return;
    teams = pollTeams;
    const me = store.get().login;
    prs = fetched.map((pr) => ({ ...pr, waitingSince: logic.waitingSince(pr, me, teams ?? new Set()) }));
    recordRequests();
    lastError = warning;
    sendDailySummary();
  } catch (error) {
    if (pollSession !== session) return;
    lastError = error.message || 'Something went wrong while checking GitHub.';
    console.error('Poll failed:', error);
  } finally {
    if (activePoll === pollSession) activePoll = null;
    if (pollSession === session) push();
  }
}

function schedulePolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!token) return;
  pollTimer = setInterval(poll, store.get().intervalMinutes * 60 * 1000);
}

function startSession(newToken) {
  session += 1;
  token = newToken;
  teams = null;
  repoPool = null;
  prs = [];
  lastError = null;
  shownAsNew = new Set();
  schedulePolling();
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function sendDailySummary() {
  if (!summaryDue) return;
  summaryDue = false;
  if (store.get().lastSummaryDate === todayKey()) return;
  store.update({ lastSummaryDate: todayKey() });
  const overdue = currentView().rows.filter((row) => row.level === 'red');
  if (overdue.length === 0) return;
  const oldest = overdue[0];
  const days = Math.floor(oldest.ageMs / logic.DAY);
  notify({
    title: overdue.length === 1 ? 'Overdue review' : `${overdue.length} overdue reviews`,
    subtitle: `Waiting ${days} ${days === 1 ? 'day' : 'days'} · ${oldest.repo}`,
    body: oldest.title,
    url: overdue.length === 1 ? oldest.url : QUEUE_URL,
  });
}

function scheduleDailySummary() {
  clearTimeout(summaryTimer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(SUMMARY_HOUR, 0, 0, 0);
  if (now >= next) {
    if (store.get().lastSummaryDate !== todayKey()) summaryDue = true;
    next.setDate(next.getDate() + 1);
  }
  summaryTimer = setTimeout(() => {
    scheduleDailySummary();
    poll();
  }, next - now + 1000);
}

function positionPanel() {
  const bounds = tray.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const [, height] = panel.getSize();
  const x = Math.round(bounds.x + bounds.width / 2 - PANEL_WIDTH / 2);
  const clampedX = Math.min(Math.max(x, workArea.x + 8), workArea.x + workArea.width - PANEL_WIDTH - 8);
  panel.setBounds({ x: clampedX, y: Math.round(bounds.y + bounds.height + 4), width: PANEL_WIDTH, height });
}

function showPanel() {
  if (!token) {
    showOnboarding();
    return;
  }
  shownAsNew = new Set(store.get().unseen);
  store.update({ unseen: [] });
  push();
  positionPanel();
  panel.show();
  panel.focus();
}

function hidePanel() {
  if (panel.isVisible()) panel.hide();
}

function togglePanel() {
  if (panel.isVisible()) hidePanel();
  else if (Date.now() - lastBlurHideAt > TRAY_REOPEN_GUARD_MS) showPanel();
}

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: 300,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'popover',
    visualEffectState: 'active',
    roundedCorners: true,
    hasShadow: true,
    webPreferences: webPreferences(),
  });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.on('blur', () => {
    lastBlurHideAt = Date.now();
    hidePanel();
  });
  panel.on('hide', () => {
    shownAsNew = new Set();
    push();
  });
  panel.webContents.on('did-finish-load', push);
  panel.loadFile(path.join(RENDERER, 'panel.html'));
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('Review Radar');
  tray.on('click', togglePanel);
  tray.on('right-click', togglePanel);
}

function showOnboarding() {
  if (onboardingWindow) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }
  onboardingWindow = new BrowserWindow({
    width: 440,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: '',
    backgroundColor: '#1e1e20',
    webPreferences: webPreferences(),
  });
  onboardingWindow.on('closed', () => {
    onboardingWindow = null;
  });
  onboardingWindow.loadFile(path.join(RENDERER, 'onboarding.html'));
  app.focus({ steal: true });
}

function showSettings() {
  hidePanel();
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 642,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Settings',
    backgroundColor: '#1e1e20',
    webPreferences: webPreferences(),
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  settingsWindow.loadFile(path.join(RENDERER, 'settings.html'));
  app.focus({ steal: true });
}

function settingsView() {
  const settings = store.get();
  return {
    login: settings.login,
    scopes: settings.scopes,
    yellowDays: settings.yellowDays,
    redDays: settings.redDays,
    intervalMinutes: settings.intervalMinutes,
    intervals: INTERVALS,
    notify: settings.notify,
    sound: settings.sound,
    includeDrafts: settings.includeDrafts,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    version: app.getVersion(),
  };
}

function validateSettings(input) {
  if (!input || typeof input !== 'object') return 'Settings could not be read.';
  const yellowDays = Number(input.yellowDays);
  const redDays = Number(input.redDays);
  const intervalMinutes = Number(input.intervalMinutes);
  if (!Number.isInteger(yellowDays) || yellowDays < 1) return 'Yellow must be a whole number of days, 1 or more.';
  if (!Number.isInteger(redDays) || redDays <= yellowDays) return 'Red must be more days than yellow.';
  if (!INTERVALS.includes(intervalMinutes)) return 'Pick a check interval from the list.';
  return null;
}

function fromApp(event) {
  return Boolean(event.senderFrame?.url?.startsWith(RENDERER_URL));
}

function registerIpc() {
  const on = (channel, listener) =>
    ipcMain.on(channel, (event, ...args) => {
      if (fromApp(event)) listener(event, ...args);
    });
  const handle = (channel, handler) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromApp(event)) throw new Error('Rejected IPC from an unknown sender.');
      return handler(event, ...args);
    });

  on('refresh', () => poll());
  on('open-url', (_event, url) => {
    hidePanel();
    openExternal(url);
  });
  on('open-queue', () => {
    hidePanel();
    openExternal(QUEUE_URL);
  });
  on('open-settings', showSettings);
  on('quit', () => app.quit());
  on('close-panel', hidePanel);
  on('preview-sound', playSound);

  on('panel-height', (_event, height) => {
    const value = Math.min(Math.max(Math.ceil(Number(height) || 0), 120), PANEL_MAX_HEIGHT);
    const [width, current] = panel.getSize();
    if (value !== current) panel.setSize(width, value);
  });

  on('tray-image', (_event, payload) => {
    const dataUrl = payload?.dataUrl;
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_TRAY_IMAGE_LENGTH) return;
    if (!dataUrl.startsWith('data:image/png;base64,')) return;
    const buffer = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    const image = nativeImage.createFromBuffer(buffer, { scaleFactor: 2 });
    image.setTemplateImage(Boolean(payload.template));
    tray.setImage(image);
  });

  handle('settings:get', () => settingsView());

  handle('settings:save', (_event, input) => {
    const error = validateSettings(input);
    if (error) return { ok: false, error };
    const previousInterval = store.get().intervalMinutes;
    store.update({
      yellowDays: Number(input.yellowDays),
      redDays: Number(input.redDays),
      intervalMinutes: Number(input.intervalMinutes),
      notify: Boolean(input.notify),
      sound: Boolean(input.sound),
      includeDrafts: Boolean(input.includeDrafts),
    });
    if (app.getLoginItemSettings().openAtLogin !== Boolean(input.launchAtLogin)) {
      app.setLoginItemSettings({ openAtLogin: Boolean(input.launchAtLogin) });
    }
    if (previousInterval !== store.get().intervalMinutes) schedulePolling();
    push();
    return { ok: true, settings: settingsView() };
  });

  handle('filter:view', (_event, refresh) => filterView(refresh === true));

  handle('filter:toggle', (_event, input) => {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!VALID_REPO.test(name)) return { ok: false, error: 'That repository name is not valid.' };
    const select = input?.selected === true;
    return withSelection((repos, current) => {
      const stored = current.find((repo) => repo.toLowerCase() === name.toLowerCase());
      if (select) {
        if (!stored) repos.add(name);
      } else if (stored) {
        repos.delete(stored);
      }
    });
  });

  handle('filter:owner', (_event, input) => {
    const owner = typeof input?.owner === 'string' ? input.owner.trim().toLowerCase() : '';
    if (!owner) return { ok: false, error: 'That owner is not valid.' };
    if (!repoPool) return { ok: false, error: 'The repository list is still loading.' };
    const select = input?.select === true;
    return withSelection((repos, current) => {
      for (const name of repoPool.repos) {
        if (name.split('/')[0].toLowerCase() !== owner) continue;
        const stored = current.find((repo) => repo.toLowerCase() === name.toLowerCase());
        if (select) {
          if (!stored) repos.add(name);
        } else if (stored) {
          repos.delete(stored);
        }
      }
    });
  });

  handle('filter:clear', () => withSelection((repos) => repos.clear()));

  handle('sign-out', () => {
    store.clearAccount();
    startSession(null);
    hidePanel();
    push();
    if (settingsWindow) settingsWindow.close();
    showOnboarding();
  });

  handle('connect', (_event, rawToken) => {
    const candidate = typeof rawToken === 'string' ? rawToken.trim() : '';
    if (!candidate) return { ok: false, error: 'Paste a token first.' };
    return connectWith(candidate);
  });

  handle('check-update', async () => {
    try {
      const latest = await github.fetchLatestRelease(token);
      const update = latest && logic.isNewerVersion(latest.version, app.getVersion()) ? latest : null;
      return { ok: true, update };
    } catch (error) {
      return { ok: false, error: error.message || 'Could not check for updates.' };
    }
  });

  handle('gh-account', async () => {
    const account = await github.readGhAccount();
    return account ? { login: account.login } : null;
  });

  handle('connect-gh', async () => {
    const account = await github.readGhAccount();
    if (!account) return { ok: false, error: 'GitHub CLI is not signed in anymore. Use a token instead.' };
    return connectWith(account.token);
  });
}

async function connectWith(candidate) {
  try {
    const viewer = await github.fetchViewer(candidate);
    store.saveToken(candidate);
    store.update({ login: viewer.login, scopes: viewer.scopes, initialized: false, knownWithTeams: false, known: {}, unseen: [] });
    startSession(candidate);
    if (store.get().notify) {
      notify({ title: 'Review Radar is connected', body: `Watching review requests for @${viewer.login}.` });
    }
    if (onboardingWindow) onboardingWindow.close();
    poll();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'Could not connect to GitHub.' };
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (token) showPanel();
    else showOnboarding();
  });
  app.on('window-all-closed', () => {});
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (navigation) => navigation.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    if (app.dock) app.dock.hide();
    registerIpc();
    createTray();
    createPanel();
    powerMonitor.on('resume', () => {
      scheduleDailySummary();
      poll();
    });
    scheduleDailySummary();
    startSession(store.readToken());
    if (token) {
      poll();
    } else {
      showOnboarding();
    }
  });
}
