/* Controller: sidebar, search, hash routing, keyboard shortcuts, theme. */
(function (global) {
  'use strict';

  var Spec = global.IntraLens.spec;
  var R = global.IntraLens.render;
  var el = R.el;

  var STORAGE_THEME = 'intralens:theme';
  var STORAGE_TAB = 'intralens:tab';

  var state = {
    model: null,
    status: null,
    tab: 'endpoints',
    query: '',
    results: [],
    cursor: -1
  };

  var dom = {};

  /* ------------------------------------------------------------------ boot */

  function init() {
    dom.search = document.getElementById('search');
    dom.list = document.getElementById('nav-list');
    dom.detail = document.getElementById('detail');
    dom.tabs = document.querySelectorAll('.nav-tab');
    dom.meta = document.getElementById('spec-meta');
    dom.count = document.getElementById('nav-count');
    dom.sidebar = document.getElementById('sidebar');
    dom.banner = document.getElementById('banner');

    applyTheme(readStorage(STORAGE_THEME) || 'dark');
    dom.detail.appendChild(el('div', { class: 'view' }, el('p', { class: 'muted', text: 'スペックを読み込んでいます…' })));

    var API = global.IntraLens.api;
    Promise.all([
      API.spec(),
      API.status()['catch'](function () { return null; })
    ]).then(function (results) {
      state.model = Spec.build(results[0]);
      state.status = results[1];
      global.IntraLens.runtime.status = results[1];
      state.tab = readStorage(STORAGE_TAB) === 'models' ? 'models' : 'endpoints';

      renderMeta();
      renderBanner();
      bindEvents();
      setTab(state.tab, { silent: true });
      route();
    })['catch'](function (err) {
      dom.detail.textContent = '';
      dom.detail.appendChild(el('div', { class: 'fatal' }, [
        el('h1', { text: 'スペックを読み込めませんでした' }),
        el('p', { class: 'prose', text: err.message }),
        el('p', { class: 'hint', text: 'intra-Lens サーバが動いているか確認してください: make run (既定 http://127.0.0.1:4242/)' })
      ]));
    });
  }

  /** Warn once, at the top of the page, when calls cannot work yet. */
  function renderBanner() {
    var status = state.status;
    if (!status) {
      dom.banner.className = 'banner banner-error';
      dom.banner.textContent = 'バックエンドに接続できません。API 実行は使用できません。';
      return;
    }
    if (status.configured) {
      dom.banner.className = 'banner is-hidden';
      return;
    }
    dom.banner.className = 'banner';
    dom.banner.textContent = '';
    dom.banner.appendChild(el('span', {
      text: '認証情報が未設定です。INTRA42_UID と INTRA42_SECRET を設定して再起動すると API を実行できます。'
    }));
    dom.banner.appendChild(el('code', { text: 'INTRA42_UID=... INTRA42_SECRET=... make run' }));
  }

  function renderMeta() {
    var status = state.status;
    dom.meta.textContent = '';
    dom.meta.appendChild(el('span', { text: 'spec v' + (state.model.info.version || '?') }));
    if (status && status.serverUrl) dom.meta.appendChild(el('code', { text: status.serverUrl }));
    dom.meta.appendChild(el('span', {
      class: status && status.configured ? 'auth-ok' : 'auth-off',
      text: status && status.configured
        ? '● 認証済み (' + (status.scopes || []).join(', ') + ')'
        : '○ 認証なし'
    }));
    dom.meta.appendChild(el('a', {
      href: 'https://github.com/42paris/intraoapi42',
      target: '_blank',
      rel: 'noreferrer noopener',
      text: '42paris/intraoapi42'
    }));
  }

  function bindEvents() {
    Array.prototype.forEach.call(dom.tabs, function (tab) {
      tab.addEventListener('click', function () { setTab(tab.getAttribute('data-tab')); });
    });

    dom.search.addEventListener('input', function () {
      state.query = this.value.trim();
      state.cursor = -1;
      renderList();
    });

    dom.search.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
        event.preventDefault();
        moveCursor(1);
      } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
        event.preventDefault();
        moveCursor(-1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        openCursor();
      } else if (event.key === 'Escape') {
        this.value = '';
        state.query = '';
        this.blur();
        renderList();
      } else if (event.key === 'Tab' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setTab(state.tab === 'endpoints' ? 'models' : 'endpoints');
      }
    });

    document.getElementById('theme-toggle').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    document.getElementById('menu-toggle').addEventListener('click', function () {
      dom.sidebar.classList.toggle('is-open');
    });

    global.addEventListener('hashchange', route);

    document.addEventListener('keydown', function (event) {
      if (event.target === dom.search || event.metaKey || event.ctrlKey || event.altKey) return;
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (event.key === '/' || event.key === 's') {
        event.preventDefault();
        dom.search.focus();
        dom.search.select();
      } else if (event.key === 'j') {
        moveCursor(1);
      } else if (event.key === 'k') {
        moveCursor(-1);
      } else if (event.key === 'Enter') {
        openCursor();
      } else if (event.key === 'g') {
        location.hash = '/';
      } else if (event.key === 't') {
        applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
      } else if (event.key === '?') {
        toggleHelp();
      }
    });
  }

  /* ----------------------------------------------------------------- theme */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☾' : '☀';
    writeStorage(STORAGE_THEME, theme);
  }

  function readStorage(key) {
    try { return global.localStorage.getItem(key); } catch (err) { return null; }
  }

  function writeStorage(key, value) {
    try { global.localStorage.setItem(key, value); } catch (err) { /* private mode */ }
  }

  /* ------------------------------------------------------------- side list */

  function setTab(tab, options) {
    state.tab = tab;
    state.cursor = -1;
    Array.prototype.forEach.call(dom.tabs, function (node) {
      node.classList.toggle('is-active', node.getAttribute('data-tab') === tab);
    });
    dom.search.placeholder = tab === 'endpoints' ? 'エンドポイントを検索  (/)' : 'モデルを検索  (/)';
    if (!options || !options.silent) writeStorage(STORAGE_TAB, tab);
    renderList();
  }

  function renderList() {
    var model = state.model;
    dom.list.textContent = '';

    if (state.tab === 'models') {
      state.results = Spec.searchSchemas(model, state.query).map(function (entry) {
        return { hash: '/model/' + entry.name, entry: entry };
      });
      state.results.forEach(function (item, index) {
        dom.list.appendChild(el('a', {
          class: 'nav-item nav-model',
          href: '#' + item.hash,
          'data-index': index
        }, [
          el('span', { class: 'nav-label', text: item.entry.name }),
          el('span', {
            class: 'nav-hint',
            title: 'このモデルを (入れ子も含めて) 返すエンドポイント数',
            text: item.entry.usedByOperations.length + ' ep'
          })
        ]));
      });
      dom.count.textContent = state.results.length + ' models';
    } else {
      var operations = Spec.searchOperations(model, state.query);
      state.results = operations.map(function (op) { return { hash: '/op/' + op.id, op: op }; });

      if (state.query) {
        state.results.forEach(function (item, index) {
          dom.list.appendChild(navItem(item.op, index));
        });
      } else {
        var order = state.results.map(function (item) { return item.op; });
        model.groups.forEach(function (group) {
          dom.list.appendChild(el('div', { class: 'nav-group', text: '/' + group.name }));
          group.operations.forEach(function (op) {
            dom.list.appendChild(navItem(op, order.indexOf(op)));
          });
        });
      }
      dom.count.textContent = state.results.length + ' endpoints';
    }

    highlightActive();
  }

  function navItem(op, index) {
    return el('a', {
      class: 'nav-item',
      href: '#/op/' + op.id,
      'data-index': index,
      title: op.summary
    }, [
      R.methodBadge(op.method),
      el('span', { class: 'nav-label' }, [R.pathText(op.path)])
    ]);
  }

  function moveCursor(delta) {
    if (!state.results.length) return;
    state.cursor = (state.cursor + delta + state.results.length) % state.results.length;
    var items = dom.list.querySelectorAll('.nav-item');
    Array.prototype.forEach.call(items, function (node) {
      var isCursor = Number(node.getAttribute('data-index')) === state.cursor;
      node.classList.toggle('is-cursor', isCursor);
      if (isCursor) node.scrollIntoView({ block: 'nearest' });
    });
  }

  function openCursor() {
    if (state.cursor < 0 || !state.results[state.cursor]) return;
    location.hash = state.results[state.cursor].hash;
    dom.sidebar.classList.remove('is-open');
  }

  function highlightActive() {
    var hash = currentHash();
    Array.prototype.forEach.call(dom.list.querySelectorAll('.nav-item'), function (node) {
      node.classList.toggle('is-active', node.getAttribute('href') === '#' + hash);
    });
  }

  /* --------------------------------------------------------------- routing */

  function currentHash() {
    var hash = location.hash.replace(/^#/, '');
    return hash || '/';
  }

  function route() {
    var hash = currentHash();
    var model = state.model;
    var view;

    var opMatch = /^\/op\/(.+)$/.exec(hash);
    var modelMatch = /^\/model\/(.+)$/.exec(hash);

    if (opMatch) {
      var op = model.findOperation(decodeURIComponent(opMatch[1]));
      if (op && state.tab !== 'endpoints') setTab('endpoints');
      view = op ? R.renderOperation(model, op) : R.renderNotFound(hash);
      document.title = op ? op.method + ' ' + op.path + ' · intra-Lens' : 'intra-Lens';
    } else if (modelMatch) {
      var entry = model.findSchema(decodeURIComponent(modelMatch[1]));
      if (entry && state.tab !== 'models') setTab('models');
      view = entry ? R.renderSchema(model, entry) : R.renderNotFound(hash);
      document.title = entry ? entry.name + ' · intra-Lens' : 'intra-Lens';
    } else {
      view = R.renderHome(model);
      document.title = 'intra-Lens · 42 Intra API';
    }

    dom.detail.textContent = '';
    dom.detail.appendChild(view);
    dom.detail.scrollTop = 0;
    dom.sidebar.classList.remove('is-open');
    highlightActive();
  }

  /* ------------------------------------------------------------------ help */

  function toggleHelp() {
    var existing = document.getElementById('help-overlay');
    if (existing) {
      existing.parentNode.removeChild(existing);
      return;
    }
    var rows = [
      ['/ または s', '検索にフォーカス'],
      ['j / k, ↑ / ↓', '結果を移動'],
      ['Enter', '選択した項目を開く'],
      ['Tab (検索中)', 'エンドポイント ↔ モデル'],
      ['g', 'トップの一覧へ'],
      ['t', 'テーマ切り替え'],
      ['?', 'このヘルプ']
    ];
    var overlay = el('div', {
      id: 'help-overlay',
      class: 'overlay',
      onclick: function (event) { if (event.target === this) toggleHelp(); }
    }, el('div', { class: 'overlay-card' }, [
      el('h2', { text: 'キーボードショートカット' }),
      el('table', { class: 'help' }, el('tbody', null, rows.map(function (row) {
        return el('tr', null, [el('td', null, el('kbd', { text: row[0] })), el('td', { text: row[1] })]);
      }))),
      el('button', { class: 'button-link', type: 'button', text: '閉じる', onclick: toggleHelp })
    ]));
    document.body.appendChild(overlay);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
