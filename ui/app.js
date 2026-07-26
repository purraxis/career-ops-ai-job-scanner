let state = null;
let currentView = 'active_review';
let selectedId = '';
let latestActionByJobId = new Map();
let visibleJobItems = [];
let resetScrollOnNextRender = true;
let jobRowsRaf = 0;
let searchDebounceTimer = 0;
let scanController = null;
let scanStartedAt = 0;
let scanElapsedTimer = 0;
const optimisticHiddenByView = new Map();

const rowHeight = 70;
const overscanRows = 10;
const maxRenderedRows = 60;
const searchDebounceMs = 150;

const els = {
  lastScan: document.querySelector('#lastScan'),
  activeReviewCount: document.querySelector('#activeReviewCount'),
  applyTodayCount: document.querySelector('#applyTodayCount'),
  activePipelineCount: document.querySelector('#activePipelineCount'),
  appliedCount: document.querySelector('#appliedCount'),
  generationCount: document.querySelector('#generationCount'),
  handledReviewCount: document.querySelector('#handledReviewCount'),
  pipelineCount: document.querySelector('#pipelineCount'),
  needsReviewCount: document.querySelector('#needsReviewCount'),
  rejectedCount: document.querySelector('#rejectedCount'),
  actionCount: document.querySelector('#actionCount'),
  search: document.querySelector('#search'),
  providerFilter: document.querySelector('#providerFilter'),
  reasonFilter: document.querySelector('#reasonFilter'),
  showHandled: document.querySelector('#showHandled'),
  viewKicker: document.querySelector('#viewKicker'),
  viewTitle: document.querySelector('#viewTitle'),
  viewMeta: document.querySelector('#viewMeta'),
  jobWorkspace: document.querySelector('#jobWorkspace'),
  summaryView: document.querySelector('#summaryView'),
  coverageView: document.querySelector('#coverageView'),
  generationView: document.querySelector('#generationView'),
  summaryContent: document.querySelector('#summaryContent'),
  coverageContent: document.querySelector('#coverageContent'),
  generationContent: document.querySelector('#generationContent'),
  jobRows: document.querySelector('#jobRows'),
  detailPanel: document.querySelector('#detailPanel'),
  runScan: document.querySelector('#runScan'),
  refreshState: document.querySelector('#refreshState'),
  rebuildState: document.querySelector('#rebuildState'),
  operationStatus: document.querySelector('#operationStatus'),
  scanLogPanel: document.querySelector('#scanLogPanel'),
  scanElapsed: document.querySelector('#scanElapsed'),
  scanLogLines: document.querySelector('#scanLogLines'),
  scanLogDismiss: document.querySelector('#scanLogDismiss'),
  navItems: [...document.querySelectorAll('.nav-item')],
  template: document.querySelector('#jobRowTemplate'),
};

const viewConfig = {
  active_review: {
    title: 'Active Review',
    kicker: 'Needs Review',
    source: () => state?.queues?.active_review || [],
    actionContext: 'review',
  },
  apply_today: {
    title: 'Apply Today',
    kicker: 'Daily Pipeline',
    source: () => state?.queues?.apply_today || [],
    actionContext: 'pipeline',
  },
  active_pipeline: {
    title: 'Active Pipeline',
    kicker: 'Pipeline',
    source: () => state?.queues?.active_pipeline || [],
    actionContext: 'pipeline',
  },
  applied: {
    title: 'Applied',
    kicker: 'Application History',
    source: () => state?.queues?.applied || [],
    actionContext: 'applied',
  },
  handled_review: {
    title: 'Handled Review',
    kicker: 'Review History',
    source: () => state?.queues?.handled_review || [],
    actionContext: 'handled_review',
  },
  rejected: {
    title: 'Scanner Rejected',
    kicker: 'Audit Log',
    source: () => state?.rejected || [],
    actionContext: 'rejected',
  },
  all_pipeline: {
    title: 'All Pipeline',
    kicker: 'Pipeline Audit',
    source: () => state?.pipeline || [],
    actionContext: 'pipeline',
  },
  all_review: {
    title: 'All Review',
    kicker: 'Review Audit',
    source: () => state?.needs_review || [],
    actionContext: 'review',
  },
};

const jobViews = new Set(Object.keys(viewConfig));
const handledActions = new Set(['moved_to_pipeline', 'rejected_by_user', 'applied']);

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.message || `Request failed: ${res.status}`);
  return data;
}

async function loadState() {
  state = await requestJson('/api/state');
  render();
}

async function rebuildState() {
  els.rebuildState.disabled = true;
  els.rebuildState.textContent = 'Rebuilding...';
  setOperationStatus('Rebuilding dashboard state...');
  try {
    await requestJson('/api/build-ui-state', { method: 'POST', body: '{}' });
    await loadState();
    setOperationStatus('Dashboard state rebuilt.');
  } catch (error) {
    setOperationStatus(error.message, 'error');
    throw error;
  } finally {
    els.rebuildState.disabled = false;
    els.rebuildState.textContent = 'Rebuild State';
  }
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function setScanElapsed() {
  if (!els.scanElapsed || !scanStartedAt) return;
  els.scanElapsed.textContent = formatElapsed(Date.now() - scanStartedAt);
}

function appendScanLog(line, tone = '') {
  if (!els.scanLogLines || !line) return;
  els.scanLogLines.textContent += `${tone ? `[${tone}] ` : ''}${line}\n`;
  els.scanLogLines.scrollTop = els.scanLogLines.scrollHeight;
}

function resetScanLog() {
  if (els.scanLogPanel) els.scanLogPanel.hidden = false;
  if (els.scanLogLines) els.scanLogLines.textContent = '';
  scanStartedAt = Date.now();
  setScanElapsed();
  clearInterval(scanElapsedTimer);
  scanElapsedTimer = setInterval(setScanElapsed, 1000);
}

function stopScanTimer() {
  clearInterval(scanElapsedTimer);
  scanElapsedTimer = 0;
  setScanElapsed();
}

function setScanRunning(isRunning) {
  if (isRunning) {
    els.runScan.textContent = 'Cancel Scan';
    els.runScan.classList.add('danger');
    els.refreshState.disabled = true;
    els.rebuildState.disabled = true;
    return;
  }
  els.runScan.textContent = 'Run Scan';
  els.runScan.classList.remove('danger');
  els.runScan.disabled = false;
  els.refreshState.disabled = false;
  els.rebuildState.disabled = false;
}

function parseSseChunk(buffer, onEvent) {
  let remaining = buffer;
  let boundary = remaining.indexOf('\n\n');
  while (boundary !== -1) {
    const rawEvent = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + 2);
    let event = 'message';
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const rawData = dataLines.join('\n');
    let data = {};
    try {
      data = rawData ? JSON.parse(rawData) : {};
    } catch {
      data = { line: rawData };
    }
    onEvent(event, data);
    boundary = remaining.indexOf('\n\n');
  }
  return remaining;
}

async function handleScanEvent(event, data) {
  if (event === 'stdout' || event === 'stderr') {
    appendScanLog(data.line, event === 'stderr' ? 'stderr' : '');
    return;
  }
  appendScanLog(data.message || data.line || event, event);
  if (event === 'done') {
    await loadState();
    setOperationStatus(data.message || 'Scan complete.');
  }
  if (event === 'error') {
    setOperationStatus(data.message || 'Scan failed.', 'error');
  }
  if (event === 'canceled') {
    setOperationStatus(data.message || 'Scan canceled.');
  }
}

async function runScan() {
  if (scanController) {
    await cancelScan();
    return;
  }

  scanController = new AbortController();
  resetScanLog();
  setScanRunning(true);
  setOperationStatus('Running scanner...');
  try {
    const res = await fetch('/api/run-scan', {
      method: 'POST',
      body: '{}',
      signal: scanController.signal,
    });
    if (!res.ok) {
      let message = `Scan failed: ${res.status}`;
      try {
        const data = await res.json();
        message = data.error || data.message || message;
      } catch {}
      throw new Error(message);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseChunk(buffer, (event, data) => {
        handleScanEvent(event, data).catch(error => setOperationStatus(error.message, 'error'));
      });
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      appendScanLog(error.message, 'error');
      setOperationStatus(error.message, 'error');
    }
  } finally {
    scanController = null;
    stopScanTimer();
    setScanRunning(false);
  }
}

async function cancelScan() {
  els.runScan.disabled = true;
  setOperationStatus('Canceling scan...');
  try {
    await requestJson('/api/cancel-scan', { method: 'POST', body: '{}' });
    appendScanLog('Cancel requested.', 'cancel');
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    els.runScan.disabled = false;
  }
}

function setOperationStatus(message, tone = '') {
  if (!els.operationStatus) return;
  els.operationStatus.textContent = message || '';
  els.operationStatus.classList.toggle('error', tone === 'error');
  if (message && tone === 'error') {
    clearTimeout(setOperationStatus.errorTimer);
    setOperationStatus.errorTimer = setTimeout(() => {
      if (els.operationStatus.textContent === message) setOperationStatus('');
    }, 8000);
  }
}

function hiddenIdsForView(view) {
  if (!optimisticHiddenByView.has(view)) optimisticHiddenByView.set(view, new Set());
  return optimisticHiddenByView.get(view);
}

function optimisticSelectionAfterRemoving(id) {
  const index = visibleJobItems.findIndex(item => item.id === id);
  return visibleJobItems[index + 1]?.id || visibleJobItems[index - 1]?.id || '';
}

function hideJobOptimistically(item, nextSelectedId) {
  hiddenIdsForView(currentView).add(item.id);
  selectedId = nextSelectedId;
  renderJobRows();
}

function restoreOptimisticJob(item, view, previousSelection) {
  hiddenIdsForView(view).delete(item.id);
  if (currentView === view) {
    selectedId = previousSelection;
    renderJobRows();
  }
}

async function refreshStateAfterAction(item, view) {
  try {
    await loadState();
    hiddenIdsForView(view).delete(item.id);
  } catch (error) {
    setOperationStatus(error.message, 'error');
  }
}

function runOptimisticAction(item, button, pendingText, requestFn, successMessage) {
  button.disabled = true;
  const previousText = button.textContent;
  const view = currentView;
  const previousSelection = selectedId;
  const nextSelection = optimisticSelectionAfterRemoving(item.id);
  button.textContent = pendingText;
  hideJobOptimistically(item, nextSelection);
  setOperationStatus(successMessage || 'Action saved.');

  requestFn()
    .then(() => refreshStateAfterAction(item, view))
    .catch(error => {
      restoreOptimisticJob(item, view, previousSelection);
      setOperationStatus(error.message, 'error');
    })
    .finally(() => {
      button.textContent = previousText;
      button.disabled = false;
    });
}

async function logJobAction(action, item, button, note = '') {
  if (['applied', 'rejected_by_user'].includes(action) && item?.id) {
    runOptimisticAction(
      item,
      button,
      'Saving...',
      () => requestJson('/api/job-action', {
        method: 'POST',
        body: JSON.stringify({ action, job: item, note }),
      }),
      action === 'applied' ? 'Marked applied.' : 'Rejected.',
    );
    return;
  }

  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Saving...';
  try {
    await requestJson('/api/job-action', {
      method: 'POST',
      body: JSON.stringify({ action, job: item, note }),
    });
    await loadState();
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

async function moveToPipeline(item, button) {
  if (item?.id) {
    runOptimisticAction(
      item,
      button,
      'Moving...',
      () => requestJson('/api/move-to-pipeline', {
        method: 'POST',
        body: JSON.stringify({ job: item }),
      }),
      'Moved to pipeline.',
    );
    return;
  }

  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Moving...';
  try {
    await requestJson('/api/move-to-pipeline', {
      method: 'POST',
      body: JSON.stringify({ job: item }),
    });
    await loadState();
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

async function requestGeneration(type, item, button) {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Queued...';
  try {
    await requestJson('/api/generation-request', {
      method: 'POST',
      body: JSON.stringify({ type, job: item }),
    });
    await loadState();
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

async function runQueuedMaterials(button) {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Generating...';
  try {
    await requestJson('/api/generate-queued-materials', {
      method: 'POST',
      body: '{}',
    });
    await loadState();
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

async function prepareFinalPackage(item, button) {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Preparing...';
  try {
    await requestJson('/api/prepare-final-generation-package', {
      method: 'POST',
      body: JSON.stringify({ type: item.type, job: item }),
    });
    await loadState();
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

async function cacheJobDescription(item, button) {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Caching...';
  try {
    await requestJson('/api/cache-job-description', {
      method: 'POST',
      body: JSON.stringify({ job: item }),
    });
    await loadState();
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

async function matchCareerContext(item, button) {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Matching...';
  try {
    await requestJson('/api/match-career-context', {
      method: 'POST',
      body: JSON.stringify({ job: item }),
    });
    await loadState();
  } catch (error) {
    setOperationStatus(error.message, 'error');
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

function itemsForView(view = currentView) {
  return viewConfig[view]?.source() || [];
}

function actionLabel(action) {
  return {
    moved_to_pipeline: 'Moved to pipeline',
    move_to_pipeline_skipped: 'Already in pipeline',
    rejected_by_user: 'Rejected by user',
    applied: 'Marked applied',
    saved_for_later: 'Saved for later',
  }[action] || action;
}

function refreshActionIndex() {
  latestActionByJobId = new Map();
  for (const action of state?.job_actions || []) {
    const id = action.job_id || '';
    if (!id) continue;
    const previous = latestActionByJobId.get(id);
    if (!previous || action.timestamp > previous.timestamp) {
      latestActionByJobId.set(id, action);
    }
  }
}

function itemDate(item) {
  return item.first_seen || item.date_scanned || item.date || item.posted_at || item.fetched_at || '';
}

function providerValue(item) {
  return item.provider || 'unknown';
}

function primaryReason(item) {
  return item.rejection_reason
    || item.verification_reason
    || item.why_not_accepted
    || item.review_category
    || item.classification
    || '';
}

function isHandled(item) {
  if (item.is_handled) return true;
  const action = item.latest_action || latestActionByJobId.get(item.id);
  return action ? handledActions.has(action.action) : false;
}

function searchableText(item) {
  return [
    item.company,
    item.title,
    item.location,
    item.provider,
    item.classification,
    item.rejection_reason,
    item.verification_reason,
    item.why_not_accepted,
    item.why_not_rejected,
    item.review_category,
    item.url,
    item.jd_cached ? 'jd cached' : 'jd missing',
    item.context_matched ? 'context matched' : 'context missing',
  ].filter(Boolean).join(' ').toLowerCase();
}

function filteredItems() {
  const query = els.search.value.trim().toLowerCase();
  const provider = els.providerFilter.value;
  const reason = els.reasonFilter.value;
  const hidden = hiddenIdsForView(currentView);
  return itemsForView()
    .filter(item => !hidden.has(item.id))
    .filter(item => els.showHandled.checked || currentView !== 'all_review' || !isHandled(item))
    .filter(item => els.showHandled.checked || currentView !== 'all_pipeline' || (!item.is_applied && !item.is_rejected_by_user))
    .filter(item => !query || searchableText(item).includes(query))
    .filter(item => !provider || providerValue(item) === provider)
    .filter(item => !reason || primaryReason(item) === reason)
    .sort((a, b) => itemDate(b).localeCompare(itemDate(a)));
}

function renderProviderOptions() {
  const providers = [...new Set(itemsForView().map(providerValue))].sort();
  const previous = els.providerFilter.value;
  els.providerFilter.innerHTML = '<option value="">All providers</option>';
  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider;
    option.textContent = provider;
    els.providerFilter.append(option);
  }
  els.providerFilter.value = providers.includes(previous) ? previous : '';
}

function renderReasonOptions() {
  const reasons = [...new Set(itemsForView().map(primaryReason).filter(Boolean))].sort();
  const previous = els.reasonFilter.value;
  els.reasonFilter.innerHTML = '<option value="">All reasons</option>';
  for (const reason of reasons) {
    const option = document.createElement('option');
    option.value = reason;
    option.textContent = reason.length > 64 ? `${reason.slice(0, 61)}...` : reason;
    els.reasonFilter.append(option);
  }
  els.reasonFilter.value = reasons.includes(previous) ? previous : '';
}

function renderStats() {
  els.lastScan.textContent = state?.last_scan_at || '-';
  els.activeReviewCount.textContent = state?.stats?.active_review_count ?? state?.queues?.active_review?.length ?? 0;
  els.applyTodayCount.textContent = state?.stats?.apply_today_count ?? state?.queues?.apply_today?.length ?? 0;
  els.activePipelineCount.textContent = state?.stats?.active_pipeline_count ?? state?.queues?.active_pipeline?.length ?? 0;
  els.appliedCount.textContent = state?.stats?.applied_count ?? state?.queues?.applied?.length ?? 0;
  els.generationCount.textContent = state?.stats?.pending_generation_requests_count ?? 0;
  els.handledReviewCount.textContent = state?.stats?.handled_review_count ?? state?.queues?.handled_review?.length ?? 0;
  els.pipelineCount.textContent = state?.stats?.pipeline_count ?? state?.pipeline?.length ?? 0;
  els.needsReviewCount.textContent = state?.stats?.needs_review_count ?? state?.needs_review?.length ?? 0;
  els.rejectedCount.textContent = state?.stats?.rejected_count ?? state?.rejected?.length ?? 0;
  const actions = state?.job_actions?.length ?? 0;
  els.actionCount.textContent = `${actions} action${actions === 1 ? '' : 's'}`;
}

function setView(view) {
  currentView = view;
  selectedId = '';
  resetScrollOnNextRender = true;
  els.navItems.forEach(item => item.classList.toggle('active', item.dataset.view === view));
  render();
}

function setVisiblePanel() {
  const isJobView = jobViews.has(currentView);
  els.jobWorkspace.hidden = !isJobView;
  els.summaryView.hidden = currentView !== 'scan_summary';
  els.coverageView.hidden = currentView !== 'company_coverage';
  els.generationView.hidden = currentView !== 'generation_queue';
  els.search.disabled = !isJobView;
  els.providerFilter.disabled = !isJobView;
  els.reasonFilter.disabled = !isJobView;
  els.showHandled.disabled = !isJobView;
}

function renderJobRows() {
  const items = filteredItems();
  const config = viewConfig[currentView];
  const selectedStillVisible = items.some(item => item.id === selectedId);
  if (!selectedStillVisible) selectedId = items[0]?.id || '';
  visibleJobItems = items;

  const targetScrollTop = resetScrollOnNextRender ? 0 : els.jobRows.scrollTop;
  resetScrollOnNextRender = false;

  els.viewKicker.textContent = config?.kicker || 'Review Queue';
  els.viewTitle.textContent = config?.title || 'Jobs';
  els.viewMeta.textContent = `${items.length} visible jobs`;
  els.jobRows.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No jobs match the current filters.';
    els.jobRows.append(empty);
    renderDetail(null);
    return;
  }

  renderJobWindow(targetScrollTop);
  els.jobRows.scrollTop = targetScrollTop;
  renderDetail(items.find(item => item.id === selectedId) || items[0]);
}

function makeSpacer(height) {
  const spacer = document.createElement('div');
  spacer.className = 'job-row-spacer';
  spacer.style.height = `${Math.max(0, height)}px`;
  return spacer;
}

function makeJobRow(item) {
  const node = els.template.content.cloneNode(true);
  const row = node.querySelector('.job-row');
  const latestAction = item.latest_action || latestActionByJobId.get(item.id);
  row.dataset.id = item.id;
  row.classList.toggle('selected', item.id === selectedId);
  row.classList.toggle('handled', Boolean(latestAction));
  node.querySelector('.row-title').textContent = item.title || item.label || item.url || 'Untitled job';
  node.querySelector('.row-company').textContent = [item.company, item.location].filter(Boolean).join(' | ') || 'Unknown company';
  node.querySelector('.row-reason').textContent = latestAction
    ? actionLabel(latestAction.action)
    : primaryReason(item);
  node.querySelector('.row-provider').textContent = providerValue(item);
  node.querySelector('.row-date').textContent = itemDate(item) || '-';
  row.addEventListener('click', () => selectJobRow(item.id));
  return node;
}

function renderJobWindow(scrollTopOverride) {
  const items = visibleJobItems;
  if (!items.length || !jobViews.has(currentView)) return;

  const viewportHeight = els.jobRows.clientHeight || rowHeight * 12;
  const scrollTop = scrollTopOverride ?? els.jobRows.scrollTop;
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, firstVisible - overscanRows);
  const end = Math.min(items.length, firstVisible + visibleCount + overscanRows + 1, start + maxRenderedRows);
  const fragment = document.createDocumentFragment();

  fragment.append(makeSpacer(start * rowHeight));
  for (let i = start; i < end; i += 1) {
    fragment.append(makeJobRow(items[i]));
  }
  fragment.append(makeSpacer((items.length - end) * rowHeight));

  els.jobRows.replaceChildren(fragment);
}

function scheduleJobWindowRender() {
  if (jobRowsRaf) return;
  jobRowsRaf = requestAnimationFrame(() => {
    jobRowsRaf = 0;
    renderJobWindow();
  });
}

function selectJobRow(id) {
  if (!id || selectedId === id) {
    renderDetail(visibleJobItems.find(item => item.id === selectedId) || null);
    return;
  }
  const previousId = selectedId;
  selectedId = id;
  const previousRow = els.jobRows.querySelector(`.job-row[data-id="${CSS.escape(previousId)}"]`);
  const currentRow = els.jobRows.querySelector(`.job-row[data-id="${CSS.escape(selectedId)}"]`);
  if (previousRow) previousRow.classList.remove('selected');
  if (currentRow) currentRow.classList.add('selected');
  renderDetail(visibleJobItems.find(item => item.id === selectedId) || null);
}

function appendDetailRow(parent, label, value) {
  if (!value) return;
  const row = document.createElement('div');
  row.className = 'detail-row';
  const key = document.createElement('span');
  key.textContent = label;
  const text = document.createElement('strong');
  text.textContent = value;
  row.append(key, text);
  parent.append(row);
}

function makeButton(label, className, onClick, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', () => onClick(button));
  return button;
}

function renderDetail(item) {
  els.detailPanel.innerHTML = '';
  if (!item) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Select a job to inspect details.';
    els.detailPanel.append(empty);
    return;
  }

  const latestAction = item.latest_action || latestActionByJobId.get(item.id);
  const actionContext = viewConfig[currentView]?.actionContext || '';
  const title = document.createElement('h3');
  title.textContent = item.title || item.label || 'Untitled job';
  const company = document.createElement('div');
  company.className = 'detail-company';
  const companyText = document.createElement('p');
  companyText.textContent = item.company || 'Unknown company';
  company.append(companyText);
  appendBadges(company, item, latestAction);

  const details = document.createElement('div');
  details.className = 'detail-grid';
  appendDetailRow(details, 'Location', item.location);
  appendDetailRow(details, 'Provider', providerValue(item));
  appendDetailRow(details, 'Date', itemDate(item));
  appendDetailRow(details, 'Compensation', item.compensation);
  appendDetailRow(details, 'Classification', item.classification);
  appendDetailRow(details, 'Reason', primaryReason(item));
  appendDetailRow(details, 'Final URL', item.final_url || item.url);
  appendDetailRow(details, 'JD Cache', item.jd_cached ? `Cached | ${item.jd_cache_path}` : `Missing | ${item.jd_cache_path || ''}`);
  appendDetailRow(details, 'Career Context', item.context_matched ? `Matched | ${item.context_match_path}` : `Missing | ${item.context_match_path || ''}`);
  appendDetailRow(details, 'Latest Action', latestAction ? `${actionLabel(latestAction.action)} | ${latestAction.timestamp}` : '');
  appendDetailRow(details, 'Generation Requests', generationRequestSummary(item));

  const actions = document.createElement('div');
  actions.className = 'detail-actions';
  const open = document.createElement('a');
  open.href = item.final_url || item.url || '#';
  open.target = '_blank';
  open.rel = 'noreferrer';
  open.textContent = 'Open Job';
  actions.append(open);
  actions.append(makeButton(item.jd_cached ? 'Re-cache JD' : 'Cache JD', 'secondary', button => cacheJobDescription(item, button)));
  actions.append(makeButton(item.context_matched ? 'Re-match Context' : 'Match Context', 'secondary', button => matchCareerContext(item, button), !item.jd_cached));

  if (actionContext === 'review' && !item.is_moved_to_pipeline && !item.is_rejected_by_user) {
    actions.append(
      makeButton('Move to Pipeline', 'primary', button => moveToPipeline(item, button)),
      makeButton('Reject', 'danger', button => logJobAction('rejected_by_user', item, button, 'Rejected from dashboard review')),
    );
  }
  if (actionContext === 'pipeline' && !item.is_applied && !item.is_rejected_by_user) {
    actions.append(
      makeButton('Mark Applied', 'primary', button => logJobAction('applied', item, button, 'Marked applied from dashboard')),
      makeButton('Reject', 'danger', button => logJobAction('rejected_by_user', item, button, 'Rejected from dashboard pipeline')),
    );
  }
  if (actionContext === 'applied' || actionContext === 'handled_review') {
    actions.append(makeButton('Log Follow-Up', 'secondary', button => logJobAction('saved_for_later', item, button, 'Follow-up noted from dashboard')));
  }
  actions.append(
    makeButton(
      hasGenerationRequest(item, 'resume') ? 'Resume Queued' : 'Queue Resume',
      'token-action',
      button => requestGeneration('resume', item, button),
      hasGenerationRequest(item, 'resume'),
    ),
    makeButton(
      hasGenerationRequest(item, 'letter') ? 'Letter Queued' : 'Queue Letter',
      'token-action',
      button => requestGeneration('letter', item, button),
      hasGenerationRequest(item, 'letter'),
    ),
  );

  const tokenNote = document.createElement('p');
  tokenNote.className = 'detail-note';
  tokenNote.textContent = 'Queue buttons only write local requests. Deterministic PDF generation runs separately and does not spend LLM tokens.';

  els.detailPanel.append(title, company, details, actions, tokenNote);
}

function generationRequestSummary(item) {
  const requests = generationRequestsForItem(item);
  if (!requests.length) return '';
  return requests
    .map(request => `${request.type}: ${request.status || 'pending'}`)
    .join(', ');
}

function generationRequestsForItem(item) {
  return (state?.generation_requests || []).filter(request => request.job_id === item.id);
}

function hasGenerationRequest(item, type) {
  return generationRequestsForItem(item).some(request => request.type === type);
}

function badge(label, variant = '') {
  const node = document.createElement('span');
  node.className = `status-badge ${variant}`.trim();
  node.textContent = label;
  return node;
}

function statusVariant(status = '') {
  if (status === 'generated_pdf') return 'success';
  if (status.includes('review')) return 'warn';
  if (status.startsWith('blocked')) return 'danger';
  if (status === 'pending') return 'pending';
  return '';
}

function appendBadges(parent, item, latestAction) {
  const badges = document.createElement('div');
  badges.className = 'status-badges';
  if (item.status) badges.append(badge(item.status, statusVariant(item.status)));
  badges.append(item.jd_cached ? badge('JD cached', 'success') : badge('JD missing', 'warn'));
  badges.append(item.context_matched ? badge('context matched', 'success') : badge('context missing', 'warn'));
  if (latestAction) badges.append(badge(actionLabel(latestAction.action), 'pending'));
  for (const request of generationRequestsForItem(item)) {
    badges.append(badge(`${request.type}: ${request.status || 'pending'}`, statusVariant(request.status || 'pending')));
  }
  parent.append(badges);
}

function localFileHref(filePath) {
  return `/api/local-file?path=${encodeURIComponent(filePath)}`;
}

function localFileLink(label, filePath, exists) {
  if (!filePath) return null;
  const link = document.createElement('a');
  link.href = exists ? localFileHref(filePath) : '#';
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = exists ? label : `${label} missing`;
  link.className = exists ? '' : 'disabled-link';
  if (!exists) link.setAttribute('aria-disabled', 'true');
  return link;
}

function addMetric(parent, label, value) {
  const card = document.createElement('article');
  card.className = 'metric-card';
  const number = document.createElement('strong');
  number.textContent = value ?? 0;
  const caption = document.createElement('span');
  caption.textContent = label;
  card.append(number, caption);
  parent.append(card);
}

function addBreakdown(parent, title, entries) {
  const card = document.createElement('article');
  card.className = 'breakdown-card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('div');
  list.className = 'breakdown-list';
  for (const [label, value] of Object.entries(entries || {}).sort((a, b) => b[1] - a[1])) {
    const row = document.createElement('p');
    const name = document.createElement('span');
    name.textContent = label;
    const count = document.createElement('strong');
    count.textContent = value;
    row.append(name, count);
    list.append(row);
  }
  if (!list.children.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No data available.';
    list.append(empty);
  }
  card.append(heading, list);
  parent.append(card);
}

function renderSummary() {
  const summary = state?.latest_scan_summary;
  els.viewKicker.textContent = 'Scan Intelligence';
  els.viewTitle.textContent = 'Scan Summary';
  els.viewMeta.textContent = summary?.latest_scan_at ? `Latest scan ${summary.latest_scan_at}` : 'No scan summary found';
  els.summaryContent.innerHTML = '';
  addMetric(els.summaryContent, 'Pipeline', summary?.totals?.pipeline);
  addMetric(els.summaryContent, 'Needs Review', summary?.totals?.needs_review);
  addMetric(els.summaryContent, 'Rejected', summary?.totals?.rejected);
  addMetric(els.summaryContent, 'Scan History Rows', summary?.totals?.scan_history);
  addBreakdown(els.summaryContent, 'Latest Scan By Provider', summary?.latest_scan?.by_provider);
  addBreakdown(els.summaryContent, 'Latest Scan By Status', summary?.latest_scan?.by_status);
  addBreakdown(els.summaryContent, 'Rejected By Reason', summary?.latest_scan?.rejected_by_reason);
  addBreakdown(els.summaryContent, 'Needs Review By Category', summary?.latest_scan?.needs_review_by_category);
}

function renderCoverage() {
  const coverage = state?.company_coverage;
  els.viewKicker.textContent = 'Source Coverage';
  els.viewTitle.textContent = 'Company Coverage';
  els.viewMeta.textContent = coverage?.source_file || 'No coverage summary found';
  els.coverageContent.innerHTML = '';
  addMetric(els.coverageContent, 'Tracked Companies', coverage?.summary?.tracked_companies);
  addMetric(els.coverageContent, 'Enabled Boards', coverage?.summary?.enabled_companies);
  addMetric(els.coverageContent, 'Zero History Boards', coverage?.summary?.zero_history_enabled_boards);
  addMetric(els.coverageContent, 'Enabled Aggregators', coverage?.summary?.enabled_aggregator_sources);
  addBreakdown(els.coverageContent, 'Companies By Provider', coverage?.summary?.by_provider);

  const stale = (coverage?.companies || [])
    .filter(company => company.enabled && !company.scan_history_count)
    .slice(0, 40)
    .reduce((acc, company) => {
      acc[company.name || company.careers_url || 'unknown'] = company.provider;
      return acc;
    }, {});
  addBreakdown(els.coverageContent, 'Enabled Boards With No Scan History', stale);
}

function renderGenerationQueue() {
  const requests = [...(state?.generation_requests || [])]
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  els.viewKicker.textContent = 'Explicit Token Queue';
  els.viewTitle.textContent = 'Generation Queue';
  els.viewMeta.textContent = `${requests.length} material requests`;
  els.generationContent.innerHTML = '';

  const toolbar = document.createElement('div');
  toolbar.className = 'queue-toolbar';
  toolbar.append(
    makeButton('Run Local Generator', 'primary', button => runQueuedMaterials(button), !requests.some(request => request.status === 'pending')),
    badge(`${state?.stats?.pending_generation_requests_count ?? 0} pending`, 'pending'),
    badge(`${state?.stats?.generated_pdf_count ?? 0} generated`, 'success'),
    badge(`${state?.stats?.generated_needs_content_review_count ?? 0} content review`, 'warn'),
    badge(`${state?.stats?.generated_needs_layout_review_count ?? 0} layout review`, 'warn'),
    badge(`${state?.stats?.final_generation_packages_count ?? 0} final packages`, 'pending'),
  );
  els.generationContent.append(toolbar);

  if (!requests.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No generation requests yet.';
    els.generationContent.append(empty);
    return;
  }

  for (const request of requests) {
    const row = document.createElement('article');
    row.className = 'request-row';
    const main = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = `${request.type || 'material'} | ${request.company || 'Unknown company'}`;
    const meta = document.createElement('p');
    meta.textContent = [
      request.title,
      request.status,
      request.jd_cached ? 'JD cached' : 'JD missing',
      request.context_matched ? 'context matched' : 'context missing',
      request.timestamp,
    ].filter(Boolean).join(' | ');
    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'request-actions';
    actions.append(badge(request.status || 'pending', statusVariant(request.status || 'pending')));
    if (request.validation?.pages) {
      actions.append(badge(`${request.validation.pages} page${request.validation.pages === 1 ? '' : 's'}`, request.validation.passed ? 'success' : 'warn'));
    }
    if (request.validation?.words) {
      actions.append(badge(`${request.validation.words} words`, request.validation.passed ? 'success' : 'warn'));
    }
    if (request.url) {
      const open = document.createElement('a');
      open.href = request.url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.textContent = 'Open Job';
      actions.append(open);
    }
    const materialLinks = document.createElement('div');
    materialLinks.className = 'material-links';
    for (const link of [
      localFileLink('Open PDF', request.output_path, request.output_exists),
      localFileLink('Open HTML', request.html_path, request.html_exists),
      localFileLink('Open Markdown', request.markdown_path, request.markdown_exists),
      localFileLink('Open Validation', request.validation_path, request.validation_exists),
      localFileLink('Open Final Package', request.final_package_path, request.final_package_exists),
      localFileLink('Open Package Manifest', request.final_package_manifest_path, request.final_package_manifest_exists),
    ].filter(Boolean)) {
      materialLinks.append(link);
    }
    if (materialLinks.children.length) actions.append(materialLinks);
    if (request.jd_cached && request.context_matched) {
      actions.append(makeButton(
        request.final_package_exists ? 'Refresh Final Package' : 'Prepare Final Package',
        'token-action',
        button => prepareFinalPackage(request, button),
      ));
    }
    if (!request.jd_cached) {
      actions.append(makeButton('Cache JD', 'secondary', button => cacheJobDescription(request, button)));
    }
    if (request.jd_cached && !request.context_matched) {
      actions.append(makeButton('Match Context', 'secondary', button => matchCareerContext(request, button)));
    }
    if (request.validation?.issues?.length) {
      const issues = document.createElement('p');
      issues.className = 'request-issues';
      issues.textContent = request.validation.issues.join(' | ');
      main.append(issues);
    }
    if (request.output_path) {
      const outputPath = document.createElement('p');
      outputPath.className = 'material-path';
      outputPath.textContent = request.output_path;
      main.append(outputPath);
    }
    if (request.final_package_path) {
      const packagePath = document.createElement('p');
      packagePath.className = 'material-path';
      packagePath.textContent = request.final_package_path;
      main.append(packagePath);
    }
    row.append(main, actions);
    els.generationContent.append(row);
  }
}

function render() {
  refreshActionIndex();
  renderStats();
  setVisiblePanel();
  els.navItems.forEach(item => item.classList.toggle('active', item.dataset.view === currentView));

  if (jobViews.has(currentView)) {
    renderProviderOptions();
    renderReasonOptions();
    renderJobRows();
  } else if (currentView === 'scan_summary') {
    renderSummary();
  } else if (currentView === 'company_coverage') {
    renderCoverage();
  } else if (currentView === 'generation_queue') {
    renderGenerationQueue();
  }
}

els.runScan.addEventListener('click', () => runScan().catch(() => {}));
els.refreshState.addEventListener('click', () => {
  loadState()
    .then(() => setOperationStatus('Dashboard refreshed.'))
    .catch(error => setOperationStatus(error.message, 'error'));
});
els.rebuildState.addEventListener('click', () => rebuildState().catch(() => {}));
els.search.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    resetScrollOnNextRender = true;
    renderJobRows();
  }, searchDebounceMs);
});
els.providerFilter.addEventListener('change', () => {
  resetScrollOnNextRender = true;
  renderJobRows();
});
els.reasonFilter.addEventListener('change', () => {
  resetScrollOnNextRender = true;
  renderJobRows();
});
els.showHandled.addEventListener('change', () => {
  resetScrollOnNextRender = true;
  renderJobRows();
});
els.jobRows.addEventListener('scroll', scheduleJobWindowRender, { passive: true });
window.addEventListener('resize', scheduleJobWindowRender);
els.scanLogDismiss.addEventListener('click', () => {
  if (!scanController && els.scanLogPanel) els.scanLogPanel.hidden = true;
});
for (const item of els.navItems) {
  item.addEventListener('click', () => setView(item.dataset.view));
}

loadState().catch(error => {
  els.detailPanel.textContent = error.message;
});
