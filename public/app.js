/* Loker Board frontend — vanilla JS, no build step.
 *
 * Client-side router over real paths (/ for the board, /post for the form,
 * /job/<id> for detail). Navigation is intercepted so the iframe token
 * from the initial load survives every screen change; a full page load
 * (share link, theme reload) re-enters through the server's deep-link
 * handling with the token minted again.
 */
(function () {
  'use strict';

  var appEl = document.getElementById('app');

  var params = new URLSearchParams(window.location.search);
  var TOKEN = params.get('token') || '';
  var AUTH_HEADERS = TOKEN ? { 'x-usernode-token': TOKEN } : {};

  function api(path, options) {
    var opts = Object.assign({}, options);
    opts.headers = Object.assign({}, AUTH_HEADERS, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          err.details = (data && data.details) || null;
          throw err;
        }
        return data;
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = Date.now() - d.getTime();
    var day = 86400000;
    if (diff < day) return 'Today';
    if (diff < 2 * day) return 'Yesterday';
    if (diff < 7 * day) return Math.floor(diff / day) + ' days ago';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Contact is what the poster typed: an email, a phone number, or a link.
  // Turn it into something tappable without asking them to pick a type.
  function contactHref(contact) {
    var t = String(contact || '').trim();
    if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) {
      return /^https?:\/\//i.test(t) ? t : 'https://' + t;
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return 'mailto:' + t;
    return 'tel:' + t.replace(/[^+0-9]/g, '');
  }

  function contactAction(contact) {
    var t = String(contact || '').trim();
    if (/^https?:\/\//i.test(t) || /^www\./i.test(t)) return 'Open link';
    if (t.indexOf('@') !== -1) return 'Send email';
    return 'Call';
  }

  function tagPills(tags, extraClass) {
    if (!tags || !tags.length) return '';
    return '<div class="mt-3 flex flex-wrap gap-1.5">' + tags.map(function (t) {
      return '<span class="' + (extraClass || '') +
        'rounded-full bg-violet-100 text-violet-700 dark:bg-violet-600/20 dark:text-violet-300 text-xs font-medium px-2.5 py-1">' +
        esc(t) + '</span>';
    }).join('') + '</div>';
  }

  function toast(message) {
    if (window.unNative && window.unNative.toast) window.unNative.toast(message);
  }

  var INPUT_CLASS = 'mt-1.5 w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950/60 px-3.5 py-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30';
  var CARD_CLASS = 'rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900';

  // ---------- Router ----------

  function navigate(path) {
    history.pushState({}, '', path);
    render();
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[data-nav]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', render);

  function render() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var m = path.match(/^\/job\/(\d+)$/);
    if (path === '/post') renderPost();
    else if (m) renderDetail(m[1]);
    else renderList();
  }

  // ---------- Job list ----------

  // Filter state lives in the URL (`/?q=...&tag=...`) so search and tag
  // combinations are shareable deep links. listState mirrors it while the
  // list view is open.
  var listState = null;

  function listParams() {
    var sp = new URLSearchParams(window.location.search);
    return { q: sp.get('q') || '', tag: sp.get('tag') || '' };
  }

  function renderList() {
    if (!listState) listState = listParams();
    appEl.innerHTML =
      '<div class="max-w-md mx-auto px-4 pt-8 pb-28">' +
        '<header>' +
          '<h1 class="text-2xl font-bold tracking-tight">Loker Board</h1>' +
          '<p id="job-count" class="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">Loading…</p>' +
        '</header>' +
        '<div class="mt-5">' +
          '<input id="search" type="search" value="' + esc(listState.q) + '" placeholder="Search title, company, description" aria-label="Search jobs" class="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-3 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/30">' +
        '</div>' +
        '<div id="tag-bar" class="mt-3 -mx-4 px-4 flex gap-2 overflow-x-auto pb-1" style="scrollbar-width:none" aria-label="Filter by tag"></div>' +
        '<div id="job-list" class="mt-4 space-y-3"></div>' +
      '</div>' +
      '<button id="fab" aria-label="Post a job" class="fixed right-4 inline-flex items-center gap-2 rounded-full bg-violet-600 text-white text-sm font-semibold pl-4 pr-5 py-4 shadow-lg shadow-violet-600/30" style="bottom:calc(1rem + var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px)));right:calc(1rem + var(--un-safe-inset-right, env(safe-area-inset-right, 0px)))">' +
        '<svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H7a1 1 0 1 1 0-2h2V5a1 1 0 0 1 1-1Z"/></svg>' +
        'Post job' +
      '</button>';

    document.getElementById('fab').addEventListener('click', function () {
      navigate('/post');
    });

    var searchEl = document.getElementById('search');
    var timer = null;
    searchEl.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        listState.q = searchEl.value.trim();
        loadJobs();
      }, 250);
    });
    document.getElementById('tag-bar').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-tag]');
      if (!chip) return;
      listState.tag = chip.getAttribute('data-tag');
      loadJobs();
    });

    loadJobs();
  }

  function renderTagBar(tags, active) {
    var bar = document.getElementById('tag-bar');
    if (!bar) return;
    if (!tags.length) { bar.innerHTML = ''; return; }
    bar.innerHTML =
      '<button data-tag="" class="whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium border ' +
        (!active
          ? 'bg-violet-600 border-violet-600 text-white'
          : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300') +
      '">All</button>' +
      tags.map(function (t) {
        var on = t === active;
        return '<button data-tag="' + esc(t) + '" class="whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium border ' +
          (on
            ? 'bg-violet-600 border-violet-600 text-white'
            : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300') +
          '">' + esc(t) + '</button>';
      }).join('');
  }

  function jobCard(job) {
    return '<a data-nav href="/job/' + job.id + '" role="button" class="job-card un-pressable block ' + CARD_CLASS + ' p-4">' +
      '<div class="flex items-start justify-between gap-3">' +
        '<div class="min-w-0">' +
          '<h3 class="font-semibold leading-snug break-words">' + esc(job.title) + '</h3>' +
          '<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5 break-words">' + esc(job.company) + '</p>' +
        '</div>' +
        '<time class="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap pt-0.5">' + esc(fmtDate(job.created_at)) + '</time>' +
      '</div>' +
      tagPills(job.tags) +
    '</a>';
  }

  function listEmpty(filtersOn) {
    if (filtersOn) {
      return '<div class="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">' +
        '<p class="font-medium">No jobs match</p>' +
        '<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">Try a different keyword or tag.</p>' +
        '<button id="clear-filters" class="mt-4 rounded-full bg-violet-600 text-white text-sm font-semibold px-5 py-2.5">Clear filters</button>' +
      '</div>';
    }
    return '<div class="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">' +
      '<p class="font-medium">No jobs yet</p>' +
      '<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">Be the first to post one.</p>' +
      '<button id="empty-post" class="mt-4 rounded-full bg-violet-600 text-white text-sm font-semibold px-5 py-2.5">Post a job</button>' +
    '</div>';
  }

  function listSkeleton() {
    var one = '<div class="' + CARD_CLASS + ' p-4 animate-pulse">' +
      '<div class="h-4 rounded bg-zinc-200 dark:bg-zinc-800 w-3/4"></div>' +
      '<div class="h-3 rounded bg-zinc-200 dark:bg-zinc-800 w-1/2 mt-2"></div>' +
      '<div class="h-6 rounded-full bg-zinc-200 dark:bg-zinc-800 w-20 mt-3"></div>' +
    '</div>';
    return one + one + one;
  }

  var knownTags = [];

  async function loadJobs() {
    // Sync the filters into the URL without dropping the platform's own
    // params (?token=, ?un-theme=) that the frame loaded with.
    var apiQs = new URLSearchParams();
    if (listState.q) apiQs.set('q', listState.q);
    if (listState.tag) apiQs.set('tag', listState.tag);
    var query = apiQs.toString();
    var urlQs = new URLSearchParams(window.location.search);
    if (listState.q) urlQs.set('q', listState.q); else urlQs.delete('q');
    if (listState.tag) urlQs.set('tag', listState.tag); else urlQs.delete('tag');
    var urlQuery = urlQs.toString();
    history.replaceState({}, '', urlQuery ? '/?' + urlQuery : '/');

    var listEl = document.getElementById('job-list');
    var countEl = document.getElementById('job-count');
    if (!listEl) return;
    if (listEl.dataset.loaded !== '1') listEl.innerHTML = listSkeleton();

    try {
      var data = await api('/api/jobs' + (query ? '?' + query : ''));
      knownTags = data.tags || [];
      renderTagBar(knownTags, listState.tag);
      var jobs = data.jobs || [];
      listEl.dataset.loaded = '1';
      var filtersOn = !!(listState.q || listState.tag);
      if (countEl) countEl.textContent = filtersOn
        ? jobs.length + (jobs.length === 1 ? ' job matches' : ' jobs match')
        : jobs.length + (jobs.length === 1 ? ' job' : ' jobs');
      listEl.innerHTML = jobs.length
        ? jobs.map(jobCard).join('')
        : listEmpty(filtersOn);
      var clear = document.getElementById('clear-filters');
      if (clear) clear.addEventListener('click', function () {
        listState.q = '';
        listState.tag = '';
        var searchEl = document.getElementById('search');
        if (searchEl) searchEl.value = '';
        loadJobs();
      });
      var emptyPost = document.getElementById('empty-post');
      if (emptyPost) emptyPost.addEventListener('click', function () { navigate('/post'); });
    } catch (err) {
      if (err.status === 401) {
        listEl.innerHTML = '<p class="text-sm text-zinc-500 dark:text-zinc-400 text-center py-8">Sign in through Homeroom to see jobs.</p>';
      } else {
        listEl.innerHTML = '<div class="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">' +
          '<p class="font-medium">Couldn\'t load jobs</p>' +
          '<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">' + esc(err.message) + '</p>' +
          '<button id="retry-jobs" class="mt-4 rounded-full bg-violet-600 text-white text-sm font-semibold px-5 py-2.5">Try again</button>' +
        '</div>';
        var retry = document.getElementById('retry-jobs');
        if (retry) retry.addEventListener('click', loadJobs);
      }
    }
  }

  // ---------- Job detail ----------

  async function renderDetail(id) {
    appEl.innerHTML =
      '<div class="max-w-md mx-auto px-4 pt-6 pb-16">' +
        '<a data-nav href="/" class="inline-flex items-center gap-1 text-sm font-medium text-violet-600 dark:text-violet-400">Back</a>' +
        '<div id="job-detail" class="mt-4"></div>' +
      '</div>';
    var el = document.getElementById('job-detail');
    el.innerHTML = '<div class="' + CARD_CLASS + ' p-5 animate-pulse">' +
      '<div class="h-5 rounded bg-zinc-200 dark:bg-zinc-800 w-2/3"></div>' +
      '<div class="h-3 rounded bg-zinc-200 dark:bg-zinc-800 w-1/2 mt-2"></div>' +
      '<div class="h-3 rounded bg-zinc-200 dark:bg-zinc-800 w-full mt-4"></div>' +
      '<div class="h-3 rounded bg-zinc-200 dark:bg-zinc-800 w-5/6 mt-2"></div>' +
    '</div>';
    try {
      var data = await api('/api/jobs/' + id);
      var job = data.job;
      el.innerHTML =
        '<article class="' + CARD_CLASS + ' p-5">' +
          tagPills(job.tags, '!mt-0 mb-1') +
          '<h1 class="text-xl font-bold leading-snug break-words">' + esc(job.title) + '</h1>' +
          '<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">' + esc(job.company) + ' · ' + esc(fmtDate(job.created_at)) + '</p>' +
          '<hr class="my-4 border-zinc-200 dark:border-zinc-800">' +
          '<p class="text-sm leading-relaxed whitespace-pre-line break-words">' + esc(job.description) + '</p>' +
          '<a href="' + esc(contactHref(job.contact)) + '" target="_blank" rel="noopener noreferrer" class="mt-5 flex items-center justify-center w-full rounded-xl bg-violet-600 text-white text-sm font-semibold py-3">' +
            esc(contactAction(job.contact)) +
          '</a>' +
          '<p class="mt-2 text-xs text-zinc-400 dark:text-zinc-500 text-center break-all">' + esc(job.contact) + '</p>' +
        '</article>';
    } catch (err) {
      if (err.status === 404) {
        el.innerHTML = '<div class="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">' +
          '<p class="font-medium">Job not found</p>' +
          '<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">It may have been removed.</p>' +
          '<a data-nav href="/" class="mt-4 inline-block rounded-full bg-violet-600 text-white text-sm font-semibold px-5 py-2.5">Back to the board</a>' +
        '</div>';
      } else {
        el.innerHTML = '<div class="rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 p-8 text-center">' +
          '<p class="font-medium">Couldn\'t load this job</p>' +
          '<p class="text-sm text-zinc-500 dark:text-zinc-400 mt-1">' + esc(err.message) + '</p>' +
        '</div>';
      }
    }
  }

  // ---------- Post-job form ----------

  function formField(name, label, placeholder, optional) {
    return '<label class="block">' +
      '<span class="text-sm font-medium">' + esc(label) +
        (optional ? ' <span class="text-zinc-400 dark:text-zinc-500 font-normal">(optional)</span>' : '') +
      '</span>' +
      '<input name="' + name + '" type="text"' +
        (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') +
        ' class="' + INPUT_CLASS + '">' +
    '</label>';
  }

  function renderPost() {
    appEl.innerHTML =
      '<div class="max-w-md mx-auto px-4 pt-6 pb-16">' +
        '<a data-nav href="/" class="inline-flex items-center gap-1 text-sm font-medium text-violet-600 dark:text-violet-400">Back</a>' +
        '<h1 class="mt-3 text-2xl font-bold tracking-tight">Post a job</h1>' +
        '<form id="post-form" class="mt-4 ' + CARD_CLASS + ' p-5 space-y-4" novalidate>' +
          formField('title', 'Title', 'e.g. Frontend developer') +
          formField('company', 'Company', 'Who is hiring?') +
          formField('contact', 'Contact', 'Email, phone or link') +
          formField('tags', 'Tags', 'Comma separated, e.g. Remote, Design', true) +
          '<label class="block">' +
            '<span class="text-sm font-medium">Description</span>' +
            '<textarea name="description" rows="6" placeholder="What the work is, and anything a candidate should know" class="' + INPUT_CLASS + ' resize-y"></textarea>' +
          '</label>' +
          '<p id="form-error" class="hidden rounded-xl bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 text-sm px-3 py-2.5" role="alert"></p>' +
          '<button type="submit" id="submit-job" class="w-full rounded-xl bg-violet-600 text-white text-sm font-semibold py-3">Post job</button>' +
        '</form>' +
      '</div>';

    var form = document.getElementById('post-form');
    var errBox = document.getElementById('form-error');
    var submitBtn = document.getElementById('submit-job');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      var values = {
        title: String(fd.get('title') || '').trim(),
        company: String(fd.get('company') || '').trim(),
        contact: String(fd.get('contact') || '').trim(),
        description: String(fd.get('description') || '').trim(),
        tags: String(fd.get('tags') || ''),
      };

      var errors = [];
      if (values.title.length < 3) errors.push('Title must be at least 3 characters.');
      if (!values.company) errors.push('Company is required.');
      if (!values.contact) errors.push('Contact is required.');
      if (!values.description) errors.push('Description is required.');
      if (errors.length) {
        errBox.textContent = errors.join(' ');
        errBox.classList.remove('hidden');
        return;
      }

      errBox.classList.add('hidden');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Posting…';
      try {
        var data = await api('/api/jobs', { method: 'POST', body: values });
        toast('Job posted');
        listState = null;
        navigate('/job/' + data.job.id);
      } catch (err) {
        errBox.textContent = (err.details && err.details.length ? err.details.join('. ') : err.message);
        errBox.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post job';
      }
    });
  }

  render();
})();
