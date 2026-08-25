const dateInput = document.querySelector('#date');
const list = document.querySelector('#list');
const search = document.querySelector('#search');
const summary = document.querySelector('#summary');
const status = document.querySelector('#status');
const dateTabs = document.querySelector('#recentDates');
const pagination = document.querySelector('#pagination');
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 40;
let records = [];
let page = 1;
let ownDeviceId = '';

function localDay(time) { const date = new Date(time); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; } catch (_) { return '#'; } }
function host(value) { try { return new URL(value).hostname || value; } catch (_) { return value; } }
function duration(value) { const seconds = Math.round((value || 0) / 1000); if (seconds < 60) return `${seconds} 秒`; const minutes = Math.floor(seconds / 60); return `${minutes} 分 ${seconds % 60} 秒`; }
function cloud(record) { return record.deviceId && record.deviceId !== ownDeviceId ? `<span class="cloud" title="来自 ${escapeHtml(record.deviceId)}">☁</span>` : ''; }
function makeDateTabs() { const today = new Date(); dateTabs.innerHTML = Array.from({ length: 7 }, (_, offset) => localDay(today.getTime() - offset * DAY_MS)).reverse().map((value) => { const date = new Date(`${value}T00:00:00`); return `<button data-date="${value}" class="date-tab">${date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</button>`; }).join(''); }
function applyDateTabsPosition(position) { dateTabs.classList.remove('floating-top', 'floating-bottom'); dateTabs.classList.add(position === 'bottom' ? 'floating-bottom' : 'floating-top'); const main = document.querySelector('main'); if (position === 'bottom') main.append(dateTabs); else main.insertBefore(dateTabs, document.querySelector('.history-controls')); }
function makeGroups(shown) { const groups = []; for (const record of shown) { const current = groups.at(-1); if (current && current.host === host(record.url)) current.records.push(record); else groups.push({ host: host(record.url), records: [record] }); } return groups; }
function renderPagination(totalPages) { if (totalPages <= 1) { pagination.innerHTML = ''; return; } pagination.innerHTML = `<button id="pagePrevious" class="ghost" ${page === 1 ? 'disabled' : ''}>上一页</button><span>第 ${page} / ${totalPages} 页</span><button id="pageNext" class="ghost" ${page === totalPages ? 'disabled' : ''}>下一页</button>`; document.querySelector('#pagePrevious')?.addEventListener('click', () => { page -= 1; render(); }); document.querySelector('#pageNext')?.addEventListener('click', () => { page += 1; render(); }); }
function render() { const term = search.value.trim().toLowerCase(); const filtered = records.filter((record) => !term || `${record.title} ${record.url}`.toLowerCase().includes(term)).sort((a, b) => b.visitTime - a.visitTime); const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); page = Math.min(page, totalPages); const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE); const groups = makeGroups(shown); summary.textContent = `${filtered.length} 条访问 · ${groups.length} 个网站`; list.innerHTML = groups.map((group, index) => { const latest = group.records[0]; const collapsed = group.records.length > 1; return `<li class="history-group"><article><div class="site-row"><div class="site-content"><a href="${escapeHtml(safeUrl(latest.url))}" target="_blank" rel="noreferrer">${cloud(latest)}${escapeHtml(latest.title || latest.url)}</a><div class="history-meta">${escapeHtml(latest.host)} · ${new Date(latest.visitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${latest.duration ? ` · 停留 ${duration(latest.duration)}` : ''}${collapsed ? ` · 连续访问 ${group.records.length} 次` : ''}</div></div><button class="expand ${collapsed ? '' : 'hidden'}" data-group="${index}" aria-expanded="false" aria-label="展开连续访问记录">⌄</button></div><div id="group-${index}" class="visits hidden">${group.records.slice(1).map((record) => `<a href="${escapeHtml(safeUrl(record.url))}" target="_blank" rel="noreferrer"><span>${cloud(record)}${escapeHtml(record.title || record.url)}</span><small>${new Date(record.visitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${duration(record.duration)}</small></a>`).join('')}</div></article></li>`; }).join('') || '<li class="empty">这一天没有匹配的历史记录</li>'; document.querySelectorAll('.expand').forEach((button) => button.addEventListener('click', () => { const details = document.querySelector(`#group-${button.dataset.group}`); const open = !details.classList.toggle('hidden'); button.setAttribute('aria-expanded', String(open)); button.textContent = open ? '⌃' : '⌄'; })); renderPagination(totalPages); }
async function loadDay() { status.textContent = '正在读取记录…'; list.innerHTML = ''; const response = await chrome.runtime.sendMessage({ type: 'loadDay', day: dateInput.value }); if (!response.ok) { records = []; status.textContent = `读取失败：${response.error}`; render(); return; } records = response.result.records; ownDeviceId = response.result.deviceId || ownDeviceId; applyDateTabsPosition(response.result.dateTabsPosition); status.textContent = response.result.downloaded ? '本地没有该日期，已自动拉取远端记录。' : ''; document.querySelectorAll('.date-tab').forEach((button) => button.classList.toggle('selected', button.dataset.date === dateInput.value)); render(); }
async function run(type) { const buttons = [...document.querySelectorAll('#download, #upload')]; buttons.forEach((button) => { button.disabled = true; }); status.textContent = type === 'download' ? '正在下载最近范围的记录…' : '正在上传并合并最近范围的记录…'; const response = await chrome.runtime.sendMessage({ type }); if (!response.ok) status.textContent = `操作失败：${response.error}`; else { status.textContent = type === 'download' ? `下载完成：新增 ${response.result.reduce((sum, item) => sum + item.count, 0)} 条记录。` : `上传完成：已处理 ${response.result.length} 天。`; page = 1; await loadDay(); } buttons.forEach((button) => { button.disabled = false; }); }

dateInput.value = localDay(Date.now());
makeDateTabs();
dateInput.addEventListener('change', () => { page = 1; loadDay(); });
dateTabs.addEventListener('click', (event) => { const button = event.target.closest('[data-date]'); if (!button) return; dateInput.value = button.dataset.date; page = 1; loadDay(); });
document.querySelector('#previous').addEventListener('click', () => { dateInput.value = localDay(new Date(`${dateInput.value}T12:00:00`).getTime() - DAY_MS); page = 1; loadDay(); });
document.querySelector('#next').addEventListener('click', () => { dateInput.value = localDay(new Date(`${dateInput.value}T12:00:00`).getTime() + DAY_MS); page = 1; loadDay(); });
search.addEventListener('input', () => { page = 1; render(); });
document.querySelector('#download').addEventListener('click', () => run('download'));
document.querySelector('#upload').addEventListener('click', () => run('upload'));
document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
loadDay();
