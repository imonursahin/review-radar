const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  yellowDays: 2,
  redDays: 5,
  intervalMinutes: 2,
  notify: true,
  sound: false,
  includeDrafts: true,
  filters: { repos: [] },
  login: null,
  scopes: null,
  initialized: false,
  knownWithTeams: false,
  known: {},
  unseen: [],
  lastSummaryDate: null,
};

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const tokenPath = () => path.join(app.getPath('userData'), 'token.bin');

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read settings, using defaults:', error);
    return { ...DEFAULTS };
  }
}

let settings = null;

function get() {
  if (!settings) settings = load();
  return settings;
}

function update(patch) {
  settings = { ...get(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  writeAtomic(settingsPath(), JSON.stringify(settings, null, 2));
  return settings;
}

function readToken() {
  try {
    return safeStorage.decryptString(fs.readFileSync(tokenPath()));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read the stored token:', error);
    return null;
  }
}

function saveToken(token) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Keychain encryption is not available.');
  }
  fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
  writeAtomic(tokenPath(), safeStorage.encryptString(token));
}

function clearAccount() {
  fs.rmSync(tokenPath(), { force: true });
  update({
    login: null,
    scopes: null,
    initialized: false,
    knownWithTeams: false,
    known: {},
    unseen: [],
    lastSummaryDate: null,
    filters: { repos: [] },
  });
}

module.exports = { get, update, readToken, saveToken, clearAccount };
