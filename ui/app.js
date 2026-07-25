let state = null;
let currentView = 'active_review';
let selectedId = '';
let latestActionByJobId = new Map();

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
  refreshState: document.querySelector('#refreshState'),
  rebuildState: document.querySelector('#rebuildState'),
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
  try {
    await requestJson('/api/build-ui-state', { method: 'POST', body: '{}' });
    await loadState();
  } finally {
    els.rebuildState.disabled = false;
    els.rebuildState.textContent = 'Rebuild State';
  }
}

async function logJobAction(action, item, button, note = '') {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Saving...';
  try {
    await requestJson('/api/job-action', {
      method: 'POST',
      body: JSON.stringify({ action, job: item, note }),
    });
    await loadState();
  } finally {
    button.textContent = previousText;
    button.disabled = false;
  }
}

async function moveToPipeline(item, button) {
  button.disabled = true;
  const previousText = button.textContent;
  button.textContent = 'Moving...';
  try {
    await requestJson('/api/move-to-pipeline', {
      method: 'POST',
      body: JSON.stringify({ job: item }),
    });
    await loadState();
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
  ].filter(Boolean).join(' ').toLowerCase();
}

function filteredItems() {
  const query = els.search.value.trim().toLowerCase();
  const provider = els.providerFilter.value;
  const reason = els.reasonFilter.value;
  return itemsForView()
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

  for (const item of items) {
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
    row.addEventListener('click', () => {
      selectedId = item.id;
      renderJobRows();
    });
    els.jobRows.append(node);
  }

  renderDetail(items.find(item => item.id === selectedId) || items[0]);
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
  const company = document.createElement('p');
  company.className = 'detail-company';
  company.textContent = item.company || 'Unknown company';

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
    makeButton('Request Resume', 'token-action', button => requestGeneration('resume', item, button)),
    makeButton('Request Letter', 'token-action', button => requestGeneration('letter', item, button)),
  );

  const tokenNote = document.createElement('p');
  tokenNote.className = 'detail-note';
  tokenNote.textContent = 'Request buttons only add items to the local queue. Actual document generation stays a separate explicit token-cost command.';

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
      request.timestamp,
    ].filter(Boolean).join(' | ');
    main.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'request-actions';
    if (request.url) {
      const open = document.createElement('a');
      open.href = request.url;
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.textContent = 'Open Job';
      actions.append(open);
    }
    if (request.output_path) {
      const output = document.createElement('span');
      output.textContent = request.output_path;
      actions.append(output);
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

els.refreshState.addEventListener('click', loadState);
els.rebuildState.addEventListener('click', rebuildState);
els.search.addEventListener('input', renderJobRows);
els.providerFilter.addEventListener('change', renderJobRows);
els.reasonFilter.addEventListener('change', renderJobRows);
els.showHandled.addEventListener('change', renderJobRows);
for (const item of els.navItems) {
  item.addEventListener('click', () => setView(item.dataset.view));
}

loadState().catch(error => {
  els.detailPanel.textContent = error.message;
});
