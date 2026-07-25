let state = null;

const els = {
  lastScan: document.querySelector('#lastScan'),
  pipelineCount: document.querySelector('#pipelineCount'),
  needsReviewCount: document.querySelector('#needsReviewCount'),
  rejectedCount: document.querySelector('#rejectedCount'),
  search: document.querySelector('#search'),
  providerFilter: document.querySelector('#providerFilter'),
  viewFilter: document.querySelector('#viewFilter'),
  viewTitle: document.querySelector('#viewTitle'),
  viewMeta: document.querySelector('#viewMeta'),
  jobList: document.querySelector('#jobList'),
  refreshState: document.querySelector('#refreshState'),
  rebuildState: document.querySelector('#rebuildState'),
  template: document.querySelector('#jobCardTemplate'),
};

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
  await requestJson('/api/build-ui-state', { method: 'POST', body: '{}' });
  await loadState();
}

function currentItems() {
  const view = els.viewFilter.value;
  if (view === 'needs_review') return state.needs_review || [];
  if (view === 'rejected') return state.rejected || [];
  return state.pipeline || [];
}

function itemDate(item) {
  return item.first_seen || item.date_scanned || item.date || item.posted_at || '';
}

function providerValue(item) {
  return item.provider || 'unknown';
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
    item.url,
  ].filter(Boolean).join(' ').toLowerCase();
}

function filteredItems() {
  const query = els.search.value.trim().toLowerCase();
  const provider = els.providerFilter.value;
  return currentItems()
    .filter(item => !query || searchableText(item).includes(query))
    .filter(item => !provider || providerValue(item) === provider)
    .sort((a, b) => itemDate(b).localeCompare(itemDate(a)));
}

function renderProviderOptions() {
  const providers = [...new Set(currentItems().map(providerValue))].sort();
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

function renderStats() {
  els.lastScan.textContent = state.last_scan_at || '-';
  els.pipelineCount.textContent = state.stats?.pipeline_count ?? state.pipeline?.length ?? 0;
  els.needsReviewCount.textContent = state.stats?.needs_review_count ?? state.needs_review?.length ?? 0;
  els.rejectedCount.textContent = state.stats?.rejected_count ?? state.rejected?.length ?? 0;
}

function renderList() {
  const items = filteredItems();
  const view = els.viewFilter.value;
  document.body.classList.toggle('needs-review', view === 'needs_review');
  els.viewTitle.textContent = {
    pipeline: 'Pipeline',
    needs_review: 'Needs Review',
    rejected: 'Rejected',
  }[view];
  els.viewMeta.textContent = `${items.length} jobs`;
  els.jobList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No jobs match the current filters.';
    els.jobList.append(empty);
    return;
  }

  for (const item of items) {
    const node = els.template.content.cloneNode(true);
    const card = node.querySelector('.job-card');
    const title = node.querySelector('h3');
    const company = node.querySelector('.company');
    const meta = node.querySelector('.meta');
    const reason = node.querySelector('.reason');
    const open = node.querySelector('a');
    const move = node.querySelector('.move');

    title.textContent = item.title || item.label || item.url || 'Untitled job';
    company.textContent = item.company || 'Unknown company';
    meta.textContent = [
      item.location,
      providerValue(item),
      itemDate(item),
      item.compensation,
    ].filter(Boolean).join(' | ');
    reason.textContent = item.rejection_reason || item.verification_reason || item.why_not_accepted || '';
    open.href = item.final_url || item.url || '#';

    move.addEventListener('click', async () => {
      move.disabled = true;
      move.textContent = 'Moving...';
      await requestJson('/api/move-to-pipeline', {
        method: 'POST',
        body: JSON.stringify({ job: item }),
      });
      await loadState();
    });

    card.dataset.id = item.id;
    els.jobList.append(node);
  }
}

function render() {
  renderStats();
  renderProviderOptions();
  renderList();
}

els.refreshState.addEventListener('click', loadState);
els.rebuildState.addEventListener('click', rebuildState);
els.search.addEventListener('input', renderList);
els.providerFilter.addEventListener('change', renderList);
els.viewFilter.addEventListener('change', () => {
  renderProviderOptions();
  renderList();
});

loadState().catch(error => {
  els.jobList.textContent = error.message;
});
