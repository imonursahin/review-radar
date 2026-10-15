const fields = {
  yellowDays: document.getElementById('yellow-days'),
  redDays: document.getElementById('red-days'),
  intervalMinutes: document.getElementById('interval'),
  notify: document.getElementById('notify'),
  sound: document.getElementById('sound'),
  includeDrafts: document.getElementById('include-drafts'),
  launchAtLogin: document.getElementById('launch-at-login'),
};
const errorText = document.getElementById('error');
const freshLabel = document.getElementById('fresh-label');

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function describeScopes(scopes) {
  if (scopes === null) return 'Fine-grained token';
  if (scopes.length === 0) return 'Token · no scopes';
  return `Token · ${scopes.join(', ')}`;
}

function fill(settings) {
  document.getElementById('account-avatar').replaceChildren(createAvatar(settings.login, null));
  document.getElementById('login').textContent = settings.login ? `@${settings.login}` : 'Not connected';
  document.getElementById('scopes').textContent = describeScopes(settings.scopes);

  fields.intervalMinutes.replaceChildren(
    ...settings.intervals.map((minutes) => new Option(plural(minutes, 'minute'), String(minutes))),
  );
  fields.yellowDays.value = settings.yellowDays;
  fields.redDays.value = settings.redDays;
  fields.intervalMinutes.value = String(settings.intervalMinutes);
  fields.notify.checked = settings.notify;
  fields.sound.checked = settings.sound;
  fields.sound.disabled = !settings.notify;
  fields.includeDrafts.checked = settings.includeDrafts;
  fields.launchAtLogin.checked = settings.launchAtLogin;
  freshLabel.textContent = `under ${plural(settings.yellowDays, 'day')}`;
}

function collect() {
  return {
    yellowDays: fields.yellowDays.valueAsNumber,
    redDays: fields.redDays.valueAsNumber,
    intervalMinutes: Number(fields.intervalMinutes.value),
    notify: fields.notify.checked,
    sound: fields.sound.checked,
    includeDrafts: fields.includeDrafts.checked,
    launchAtLogin: fields.launchAtLogin.checked,
  };
}

function showError(message) {
  errorText.hidden = !message;
  errorText.textContent = message ?? '';
  const thresholdError = Boolean(message);
  fields.yellowDays.setAttribute('aria-invalid', String(thresholdError));
  fields.redDays.setAttribute('aria-invalid', String(thresholdError));
}

async function save() {
  const result = await window.radar.saveSettings(collect());
  if (!result.ok) {
    showError(result.error);
    return;
  }
  showError(null);
  fields.sound.disabled = !result.settings.notify;
  freshLabel.textContent = `under ${plural(result.settings.yellowDays, 'day')}`;
}

for (const field of Object.values(fields)) field.addEventListener('change', save);

document.getElementById('preview-sound').addEventListener('click', () => window.radar.previewSound());

document.getElementById('sign-out').addEventListener('click', () => window.radar.signOut());

const updateButton = document.getElementById('check-update');
const updateStatus = document.getElementById('update-status');
let releaseUrl = null;

function showUpdateStatus(...parts) {
  updateStatus.classList.remove('error');
  updateStatus.replaceChildren(...parts);
}

updateButton.addEventListener('click', async () => {
  if (releaseUrl) {
    window.radar.openUrl(releaseUrl);
    return;
  }
  updateButton.disabled = true;
  updateButton.textContent = 'Checking…';
  const result = await window.radar.checkUpdate();
  updateButton.disabled = false;
  updateButton.textContent = 'Check for updates';
  if (!result.ok) {
    showUpdateStatus(result.error);
    updateStatus.classList.add('error');
    return;
  }
  if (!result.update) {
    showUpdateStatus("You're up to date.");
    return;
  }
  const command = document.createElement('code');
  command.textContent = 'brew upgrade --cask review-radar';
  showUpdateStatus(`Version ${result.update.version} is out. Update with:`, command);
  releaseUrl = result.update.url;
  updateButton.textContent = 'View release';
});

window.radar.getSettings().then((settings) => {
  fill(settings);
  document.getElementById('version').textContent = `Version ${settings.version}`;
});

window
  .mountFilterPanel({
    list: document.getElementById('filter-list'),
    search: document.getElementById('filter-search'),
    empty: document.getElementById('filter-status'),
    refresh: document.getElementById('filter-refresh'),
    chips: document.getElementById('filter-chips'),
    summary: document.getElementById('filter-summary'),
    clear: document.getElementById('filter-clear'),
  })
  .load(false);
