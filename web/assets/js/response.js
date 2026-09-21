/* Response viewer: status bar, collapsible JSON tree, raw view, download. */
(function (global) {
  'use strict';

  var el = global.IntraLens.render.el;
  var copyButton = global.IntraLens.render.copyButton;

  var PREVIEW_LIMIT = 25; // array items rendered before "さらに表示"

  function statusClass(status) {
    if (status >= 200 && status < 300) return 'ok';
    if (status >= 400 && status < 500) return 'client';
    if (status >= 500) return 'server';
    return 'default';
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function summary(value) {
    if (Array.isArray(value)) return '[' + value.length + ' 件]';
    if (value && typeof value === 'object') {
      var keys = Object.keys(value);
      var label = keys.slice(0, 3).join(', ');
      return '{' + label + (keys.length > 3 ? ', …' : '') + '}';
    }
    return '';
  }

  /** A label that helps identify a list item without expanding it. */
  function itemLabel(value, index) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      var name = value.login || value.name || value.displayname || value.title || value.slug;
      var id = value.id !== undefined ? '#' + value.id : '';
      if (name || id) return String(index) + '  ' + [id, name].filter(Boolean).join(' ');
    }
    return String(index);
  }

  function scalar(value) {
    if (value === null) return el('span', { class: 'json-null', text: 'null' });
    if (typeof value === 'string') return el('span', { class: 'json-string', text: JSON.stringify(value) });
    if (typeof value === 'number') return el('span', { class: 'json-number', text: String(value) });
    if (typeof value === 'boolean') return el('span', { class: 'json-bool', text: String(value) });
    return el('span', { text: String(value) });
  }

  /** Lazily expanded tree; only visible branches are built. */
  function node(key, value, depth) {
    if (value === null || typeof value !== 'object') {
      return el('div', { class: 'json-row' }, [
        el('span', { class: 'twisty-spacer' }),
        key !== null ? el('span', { class: 'json-key', text: key + ':' }) : null,
        scalar(value)
      ]);
    }

    var entries = Array.isArray(value)
      ? value.map(function (item, index) { return [itemLabel(item, index), item]; })
      : Object.keys(value).map(function (name) { return [name, value[name]]; });

    var row = el('div', { class: 'json-branch' });
    var twisty = el('button', { class: 'twisty', type: 'button', text: depth < 1 ? '▾' : '▸' });
    var children = el('div', { class: 'json-children' });
    var loaded = false;

    function renderChildren(limit) {
      children.textContent = '';
      entries.slice(0, limit).forEach(function (entry) {
        children.appendChild(node(entry[0], entry[1], depth + 1));
      });
      if (entries.length > limit) {
        children.appendChild(el('button', {
          class: 'copy more',
          type: 'button',
          text: '残り ' + (entries.length - limit) + ' 件を表示',
          onclick: function () { renderChildren(entries.length); }
        }));
      }
    }

    function toggle() {
      var open = row.classList.toggle('is-open');
      twisty.textContent = open ? '▾' : '▸';
      if (open && !loaded) {
        loaded = true;
        renderChildren(PREVIEW_LIMIT);
      }
    }

    twisty.addEventListener('click', toggle);

    var head = el('div', { class: 'json-row' }, [
      twisty,
      key !== null ? el('span', { class: 'json-key', text: key + ':' }) : null,
      el('span', { class: 'json-summary', text: summary(value) })
    ]);
    head.addEventListener('dblclick', toggle);

    row.appendChild(head);
    row.appendChild(children);

    if (depth < 1) {
      row.classList.add('is-open');
      loaded = true;
      renderChildren(PREVIEW_LIMIT);
    }
    return row;
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var anchor = el('a', { href: url, download: filename });
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /**
   * Render one completed call.
   * `payload` is the backend response; `onPage` (optional) jumps to a page.
   */
  function render(payload, operation, onPage) {
    var hasBody = payload.body !== undefined && payload.body !== null;
    var pretty = hasBody ? JSON.stringify(payload.body, null, 2) : (payload.bodyText || '');

    var bar = el('div', { class: 'result-bar' }, [
      el('span', { class: 'status status-' + statusClass(payload.status), text: payload.status }),
      el('span', { class: 'result-meta', text: payload.durationMs + ' ms' }),
      el('span', { class: 'result-meta', text: formatBytes(payload.bytes) }),
      payload.truncated ? el('span', { class: 'chip chip-warn', text: 'truncated' }) : null,
      el('code', { class: 'result-url', text: payload.url || '' }),
      copyButton('copy json', pretty),
      el('button', {
        class: 'copy',
        type: 'button',
        text: 'download',
        onclick: function () { download(operation.id + '.json', pretty); }
      })
    ]);

    var blocks = [bar];

    var pages = payload.pagination;
    if (pages && (pages.total || pages.page)) {
      var current = pages.page || 1;
      var last = pages.totalPages || 0;
      blocks.push(el('div', { class: 'pager' }, [
        el('button', {
          class: 'copy',
          type: 'button',
          text: '← 前',
          disabled: !onPage || current <= 1,
          onclick: function () { onPage(current - 1); }
        }),
        el('span', {
          class: 'result-meta',
          text: 'page ' + current + (last ? ' / ' + last : '') +
            (pages.total ? '   ·   ' + pages.total + ' 件' : '') +
            (pages.perPage ? '   ·   ' + pages.perPage + ' 件/ページ' : '')
        }),
        el('button', {
          class: 'copy',
          type: 'button',
          text: '次 →',
          disabled: !onPage || (last > 0 && current >= last),
          onclick: function () { onPage(current + 1); }
        })
      ]));
    }

    var tree = el('div', { class: 'json-view' });
    if (hasBody) tree.appendChild(node(null, payload.body, 0));
    else tree.appendChild(el('pre', { class: 'snippet', text: pretty || '(空のレスポンス)' }));

    var raw = el('pre', { class: 'snippet is-hidden', text: pretty });

    var headers = el('details', { class: 'example-block' }, [
      el('summary', { text: 'レスポンスヘッダー (' + Object.keys(payload.headers || {}).length + ')' }),
      el('ul', { class: 'header-list' }, Object.keys(payload.headers || {}).sort().map(function (name) {
        return el('li', null, [el('code', { text: name }), el('span', { class: 'muted', text: payload.headers[name] })]);
      }))
    ]);

    var viewTabs = el('div', { class: 'tabs' }, [
      el('button', {
        class: 'tab is-active',
        type: 'button',
        text: 'ツリー',
        onclick: function () { switchView(this, true); }
      }),
      el('button', {
        class: 'tab',
        type: 'button',
        text: 'JSON',
        onclick: function () { switchView(this, false); }
      })
    ]);

    function switchView(button, showTree) {
      Array.prototype.forEach.call(button.parentNode.children, function (tab) {
        tab.classList.toggle('is-active', tab === button);
      });
      tree.classList.toggle('is-hidden', !showTree);
      raw.classList.toggle('is-hidden', showTree);
    }

    blocks.push(viewTabs, tree, raw, headers);
    return el('div', { class: 'result' }, blocks);
  }

  function error(message) {
    return el('div', { class: 'result' }, [
      el('div', { class: 'result-bar' }, [
        el('span', { class: 'status status-server', text: 'ERROR' }),
        el('span', { class: 'result-meta', text: message })
      ])
    ]);
  }

  global.IntraLens.response = { render: render, error: error };
})(typeof window !== 'undefined' ? window : globalThis);
