const DEFAULTS = {
  webdavUrl: '',
  username: '',
  password: '',
  encryptionPassword: '',
  importToNativeHistory: false,
  autoDownloadOnEmpty: true,
  dateTabsPosition: 'top',
  deviceId: '',
  remotePath: 'chrome-history',
  syncDays: 7,
  syncIntervalMinutes: 60
};
const DAY_MS = 24 * 60 * 60 * 1000;
let activePage = null;
let currentDeviceId = '';
const suppressedHistoryUrls = new Map();

const dayKey = (time) => {
  const date = new Date(time);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};
const storageKey = (day) => `history:${day}`;
const nativeImportKey = (day) => `native-imported:${day}`;
const visitId = (item) => `${item.url}\u0000${item.visitTime}`;
const normalizeRecord = (item) => ({
  url: item.url,
  title: item.title || '',
  visitTime: Number(item.visitTime),
  duration: Math.max(0, Number(item.duration) || 0),
  deviceId: typeof item.deviceId === 'string' ? item.deviceId : ''
});

async function getSettings() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (!settings.deviceId) {
    settings.deviceId = `Chrome-${crypto.randomUUID().slice(0, 8)}`;
    await chrome.storage.local.set({ deviceId: settings.deviceId });
  }
  return settings;
}
async function deviceIdForNewRecord() {
  if (!currentDeviceId) currentDeviceId = (await getSettings()).deviceId;
  return currentDeviceId;
}

async function addRecord(record) {
  if (!record.url || !record.visitTime || record.url.startsWith('chrome://')) return;
  const normalized = normalizeRecord({ ...record, deviceId: record.deviceId || await deviceIdForNewRecord() });
  const key = storageKey(dayKey(normalized.visitTime));
  const saved = await chrome.storage.local.get(key);
  const records = Array.isArray(saved[key]) ? saved[key] : [];
  const index = records.findIndex((entry) => visitId(entry) === visitId(normalized));
  if (index >= 0) records[index] = { ...records[index], ...normalized, deviceId: normalized.deviceId || records[index].deviceId || '', duration: Math.max(records[index].duration || 0, normalized.duration || 0) };
  else records.push(normalized);
  await chrome.storage.local.set({ [key]: records });
}

async function importChromeHistory(days) {
  const startTime = Date.now() - days * DAY_MS;
  const items = await chrome.history.search({ text: '', startTime, maxResults: 100000 });
  for (const item of items) {
    const visits = await chrome.history.getVisits({ url: item.url });
    for (const visit of visits) {
      if (visit.visitTime >= startTime) await addRecord({ url: item.url, title: item.title, visitTime: visit.visitTime, duration: 0 });
    }
  }
}

async function closeActivePage(at = Date.now()) {
  const stored = activePage || (await chrome.storage.session.get('activePage')).activePage;
  if (!stored) return;
  const elapsed = Math.max(0, at - stored.startedAt);
  if (elapsed) await addRecord({ ...stored, visitTime: stored.visitTime, duration: elapsed });
  activePage = null;
  await chrome.storage.session.remove('activePage');
}

async function beginTracking(tab) {
  await closeActivePage();
  if (!tab?.url || tab.url.startsWith('chrome://')) return;
  const now = Date.now();
  activePage = { tabId: tab.id, url: tab.url, title: tab.title || '', visitTime: now, startedAt: now };
  await chrome.storage.session.set({ activePage });
}

chrome.history.onVisited.addListener(async (item) => {
  const suppressedUntil = suppressedHistoryUrls.get(item.url);
  if (suppressedUntil && suppressedUntil > Date.now()) {
    suppressedHistoryUrls.delete(item.url);
    return;
  }
  const visitTime = item.lastVisitTime || Date.now();
  // Navigation and history events are delivered separately; bind the foreground
  // timer to the browser's actual visit timestamp when possible.
  const tracked = activePage || (await chrome.storage.session.get('activePage')).activePage;
  if (tracked?.url === item.url) {
    activePage = { ...tracked, visitTime };
    chrome.storage.session.set({ activePage });
  }
  await addRecord({ url: item.url, title: item.title, visitTime, duration: 0 });
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => beginTracking(await chrome.tabs.get(tabId)));
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && activePage && activePage.url !== changeInfo.url) await beginTracking(tab);
});
chrome.tabs.onRemoved.addListener((tabId) => { if (activePage?.tabId === tabId) closeActivePage(); });
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return closeActivePage();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  beginTracking(tab);
});
chrome.idle.onStateChanged.addListener((state) => { if (state !== 'active') closeActivePage(); });

function remoteFile(settings, day) {
  const base = settings.webdavUrl.replace(/\/+$/, '');
  const path = settings.remotePath.replace(/^\/+|\/+$/g, '');
  return `${base}/${path ? `${path}/` : ''}${day}.json`;
}
async function ensureRemoteDirectory(settings) {
  const base = settings.webdavUrl.replace(/\/+$/, '');
  const parts = settings.remotePath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let current = base;
  for (const part of parts) {
    current += `/${encodeURIComponent(part)}`;
    const response = await fetch(current, { method: 'MKCOL', headers: authHeaders(settings) });
    // 201 = created; 405 commonly means the collection already exists.
    if (!(response.ok || response.status === 405)) throw new Error(`创建远端目录失败（HTTP ${response.status}）`);
  }
}
function authHeaders(settings) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (settings.username || settings.password) headers.Authorization = `Basic ${btoa(`${settings.username}:${settings.password}`)}`;
  return headers;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = (bytes) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
async function encryptionKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encodeRemote(records, settings) {
  if (!settings.encryptionPassword) return JSON.stringify(records);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(settings.encryptionPassword, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(records))));
  return JSON.stringify({ version: 1, encryption: 'AES-GCM', kdf: 'PBKDF2-SHA-256', iterations: 250000, salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(ciphertext) });
}
async function decodeRemote(payload, settings) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (!payload?.ciphertext || !payload?.salt || !payload?.iv) throw new Error('远端文件格式无效');
  if (!settings.encryptionPassword) throw new Error('远端数据已加密，请填写加密密码');
  try {
    const key = await encryptionKey(settings.encryptionPassword, fromBase64(payload.salt));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(payload.iv) }, key, fromBase64(payload.ciphertext));
    const records = JSON.parse(decoder.decode(plaintext));
    if (!Array.isArray(records)) throw new Error('解密后的数据格式无效');
    return records;
  } catch (error) {
    throw new Error('无法解密远端数据：加密密码可能不正确，或文件已损坏');
  }
}
function mergeRecords(local, remote) {
  const merged = new Map();
  for (const record of [...remote, ...local]) {
    if (!record || !record.url || !Number.isFinite(Number(record.visitTime))) continue;
    const normalized = normalizeRecord(record);
    const existing = merged.get(visitId(normalized));
    merged.set(visitId(normalized), existing ? { ...existing, ...normalized, deviceId: normalized.deviceId || existing.deviceId || '', duration: Math.max(existing.duration, normalized.duration) } : normalized);
  }
  return [...merged.values()].sort((a, b) => a.visitTime - b.visitTime);
}
async function fetchRemote(url, settings) {
  const response = await fetch(url, { headers: authHeaders(settings) });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`读取远端失败（HTTP ${response.status}）`);
  return decodeRemote(await response.json(), settings);
}
async function importRemoteToChrome(records) {
  let added = 0;
  let failed = 0;
  const importedIds = [];
  for (const record of records) {
    try {
      suppressedHistoryUrls.set(record.url, Date.now() + 10_000);
      await chrome.history.addUrl({ url: record.url });
      added += 1;
      importedIds.push(visitId(record));
    } catch (_) {
      // Chrome rejects unsupported internal URLs; they remain in the extension archive.
      failed += 1;
    }
  }
  return { added, failed, importedIds };
}
async function validateSyncSettings() {
  const settings = await getSettings();
  if (!settings.webdavUrl) throw new Error('请先在选项中填写 WebDAV 地址');
  return settings;
}
async function upload() {
  const settings = await validateSyncSettings();
  const days = Math.max(1, Number(settings.syncDays) || 7);
  await importChromeHistory(days);
  await closeActivePage();
  await ensureRemoteDirectory(settings);
  const results = [];
  for (let i = 0; i < days; i += 1) {
    const day = dayKey(Date.now() - i * DAY_MS);
    const key = storageKey(day);
    const local = (await chrome.storage.local.get(key))[key] || [];
    const url = remoteFile(settings, day);
    const remote = await fetchRemote(url, settings);
    const merged = mergeRecords(local, remote);
    const response = await fetch(url, { method: 'PUT', headers: authHeaders(settings), body: await encodeRemote(merged, settings) });
    if (!response.ok) throw new Error(`${day} 上传失败（HTTP ${response.status}）`);
    await chrome.storage.local.set({ [key]: merged });
    results.push({ day, count: merged.length });
  }
  await chrome.storage.local.set({ lastSyncAt: Date.now(), lastSyncResult: `已上传并合并 ${results.length} 天` });
  return results;
}
async function download() {
  const settings = await validateSyncSettings();
  const days = Math.max(1, Number(settings.syncDays) || 7);
  const results = [];
  for (let i = 0; i < days; i += 1) {
    const day = dayKey(Date.now() - i * DAY_MS);
    results.push(await downloadDay(day, settings));
  }
  const imported = results.reduce((total, result) => total + result.imported, 0);
  const failed = results.reduce((total, result) => total + result.failed, 0);
  await chrome.storage.local.set({ lastSyncAt: Date.now(), lastSyncResult: `已下载 ${results.length} 天，导入 Chrome ${imported} 条${failed ? `，失败 ${failed} 条` : ''}` });
  return results;
}
async function downloadDay(day, providedSettings) {
  const settings = providedSettings || await validateSyncSettings();
  const key = storageKey(day);
  const importedKey = nativeImportKey(day);
  const local = (await chrome.storage.local.get(key))[key] || [];
  const remote = await fetchRemote(remoteFile(settings, day), settings);
  const localIds = new Set(local.map(visitId));
  const downloaded = remote.filter((record) => !localIds.has(visitId(record)));
  const merged = mergeRecords(local, remote);
  await chrome.storage.local.set({ [key]: merged });
  let nativeResult = { added: 0, failed: 0, importedIds: [] };
  if (settings.importToNativeHistory) {
    const alreadyImported = new Set((await chrome.storage.local.get(importedKey))[importedKey] || []);
    nativeResult = await importRemoteToChrome(remote.filter((record) => !alreadyImported.has(visitId(record))));
    if (nativeResult.importedIds.length) await chrome.storage.local.set({ [importedKey]: [...alreadyImported, ...nativeResult.importedIds] });
  }
  return { day, count: downloaded.length, total: merged.length, imported: nativeResult.added, failed: nativeResult.failed, nativeEnabled: settings.importToNativeHistory };
}
async function loadDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式无效');
  const settings = await getSettings();
  const key = storageKey(day);
  let records = (await chrome.storage.local.get(key))[key] || [];
  let downloaded = false;
  if (!records.length && settings.autoDownloadOnEmpty) {
    await downloadDay(day, await validateSyncSettings());
    records = (await chrome.storage.local.get(key))[key] || [];
    downloaded = true;
  }
  return { day, records, downloaded, deviceId: settings.deviceId, dateTabsPosition: settings.dateTabsPosition };
}
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.deviceId) currentDeviceId = changes.deviceId.newValue || ''; });
async function sync() {
  const downloaded = await download();
  const uploaded = await upload();
  return { downloaded, uploaded };
}

async function configureAlarm() {
  const { syncIntervalMinutes } = await getSettings();
  chrome.alarms.create('historySync', { periodInMinutes: Math.max(5, Number(syncIntervalMinutes) || 60) });
}
chrome.runtime.onInstalled.addListener(configureAlarm);
chrome.runtime.onStartup.addListener(configureAlarm);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'historySync') sync().catch((error) => chrome.storage.local.set({ lastSyncResult: error.message })); });
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('history.html') }));
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'sync') sync().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
  if (message.type === 'upload') upload().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
  if (message.type === 'download') download().then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
  if (message.type === 'loadDay') loadDay(message.day).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
  if (message.type === 'configureAlarm') configureAlarm().then(() => sendResponse({ ok: true }));
  return true;
});
