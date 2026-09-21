/* View layer: pure DOM construction from the model produced by spec.js. */
(function (global) {
  'use strict';

  var Spec = global.IntraLens.spec;

  /* ---------------------------------------------------------------- helpers */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value === true ? '' : value);
      });
    }
    append(node, children);
    return node;
  }

  function append(parent, children) {
    if (children === null || children === undefined || children === false) return parent;
    if (Array.isArray(children)) {
      children.forEach(function (child) { append(parent, child); });
      return parent;
    }
    parent.appendChild(children.nodeType ? children : document.createTextNode(String(children)));
    return parent;
  }

  function section(title, children, extra) {
    return el('section', { class: 'panel' }, [
      el('header', { class: 'panel-head' }, [el('h2', { text: title }), extra || null]),
      el('div', { class: 'panel-body' }, children)
    ]);
  }

  function chip(text, className) {
    return el('span', { class: 'chip ' + (className || ''), text: text });
  }

  function methodBadge(method) {
    return el('span', { class: 'method method-' + method.toLowerCase(), text: method });
  }

  function pathText(path) {
    var frag = document.createDocumentFragment();
    path.split(/(\{[^}]+\})/).forEach(function (part) {
      if (!part) return;
      frag.appendChild(
        part.charAt(0) === '{'
          ? el('em', { class: 'path-param', text: part })
          : document.createTextNode(part)
      );
    });
    return frag;
  }

  function copyButton(label, getText) {
    return el('button', {
      class: 'copy',
      type: 'button',
      title: 'クリップボードにコピー',
      onclick: function () {
        var button = this;
        var text = typeof getText === 'function' ? getText() : getText;
        copyToClipboard(text).then(function () {
          var original = button.textContent;
          button.textContent = 'copied!';
          button.classList.add('is-copied');
          setTimeout(function () {
            button.textContent = original;
            button.classList.remove('is-copied');
          }, 1200);
        });
      }
    }, label);
  }

  function copyToClipboard(text) {
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)['catch'](function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var area = el('textarea', { class: 'offscreen' });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (err) { /* nothing else we can do */ }
    document.body.removeChild(area);
  }

  function link(hash, children, className) {
    return el('a', { class: className || '', href: '#' + hash }, children);
  }

  function markdownish(text) {
    // The spec only uses inline `code` spans and paragraph breaks.
    var frag = document.createDocumentFragment();
    String(text || '').split(/\n{2,}/).forEach(function (block) {
      var p = el('p', { class: 'prose' });
      block.split(/(`[^`]+`)/).forEach(function (part) {
        if (!part) return;
        if (part.charAt(0) === '`' && part.length > 2) p.appendChild(el('code', { text: part.slice(1, -1) }));
        else p.appendChild(document.createTextNode(part.replace(/\n/g, ' ')));
      });
      frag.appendChild(p);
    });
    return frag;
  }

  /* ------------------------------------------------------------ schema tree */

  /** Recursive, lazily expanded property tree with a cycle guard on $ref names. */
  function schemaTree(model, schema, options) {
    options = options || {};
    var ancestry = options.ancestry || [];
    var depth = options.depth || 0;
    var doc = model.doc;

    if (!schema) return el('div', { class: 'tree-empty', text: '(スキーマなし)' });

    var refN = schema.$ref ? Spec.refName(schema.$ref) : null;
    if (refN && ancestry.indexOf(refN) !== -1) {
      return el('div', { class: 'tree-cycle' }, ['↺ ', link('/model/' + refN, refN), ' (循環参照)']);
    }

    if (schema.type === 'array') {
      var itemName = schema.items && schema.items.$ref ? Spec.refName(schema.items.$ref) : null;
      return el('div', { class: 'tree-array' }, [
        el('div', { class: 'tree-array-head' }, [
          chip('array', 'chip-type'),
          ' of ',
          itemName ? link('/model/' + itemName, itemName, 'ref-link') : el('code', { text: Spec.typeLabel(doc, schema.items) })
        ]),
        schemaTree(model, schema.items, { ancestry: ancestry, depth: depth })
      ]);
    }

    var name = refN;
    var flat = Spec.flatten(doc, schema);
    var nextAncestry = name ? ancestry.concat([name]) : ancestry;

    if (!flat.properties.length) {
      var leaf = Spec.deref(doc, schema);
      return el('div', { class: 'tree-leaf' }, [
        chip(Spec.typeLabel(doc, leaf), 'chip-type'),
        leaf.description ? el('span', { class: 'muted', text: ' ' + leaf.description }) : null,
        leaf.example !== undefined ? el('code', { class: 'inline-example', text: JSON.stringify(leaf.example) }) : null
      ]);
    }

    var list = el('ul', { class: 'tree' });
    flat.properties.forEach(function (prop) {
      var child = prop.schema;
      var childRef = prop.ref;
      var expandable = !!childRef && nextAncestry.indexOf(childRef) === -1;

      var row = el('li', { class: 'tree-row' });
      var head = el('div', { class: 'tree-head' }, [
        expandable ? el('button', { class: 'twisty', type: 'button', 'aria-label': '展開', text: '▸' }) : el('span', { class: 'twisty-spacer' }),
        el('code', { class: 'prop-name', text: prop.name }),
        prop.required ? chip('required', 'chip-required') : null,
        childRef
          ? link('/model/' + childRef, prop.type, 'chip chip-type ref-link')
          : chip(prop.type, 'chip-type'),
        child.enum ? el('span', { class: 'enum-inline', text: child.enum.slice(0, 6).join(' | ') + (child.enum.length > 6 ? ' …' : '') }) : null,
        prop.description ? el('span', { class: 'prop-desc', text: prop.description }) : null
      ]);
      row.appendChild(head);

      if (expandable) {
        var body = el('div', { class: 'tree-children' });
        var loaded = false;
        head.querySelector('.twisty').addEventListener('click', function () {
          var open = row.classList.toggle('is-open');
          this.textContent = open ? '▾' : '▸';
          if (open && !loaded) {
            loaded = true;
            body.appendChild(schemaTree(model, child.type === 'array' ? child.items : child, {
              ancestry: nextAncestry, depth: depth + 1
            }));
          }
        });
        row.appendChild(body);
      }
      list.appendChild(row);
    });
    return list;
  }

  /* --------------------------------------------------------------- snippets */

  /* Snippet generation mirrors what oapi-codegen produces for this spec:
   * `GetUsersWithResponse(ctx, path..., *GetUsersParams)`, and no params struct at all
   * for operations that take no query/header parameters. */

  /** `filter[login]` stays readable: brackets are legal unencoded in a query string. */
  function encodeName(name) {
    return encodeURIComponent(name).replace(/%5B/g, '[').replace(/%5D/g, ']');
  }

  /** Non-empty query entries, in the order the parameters are declared in the spec. */
  function activeQuery(values) {
    return values.query
      .filter(function (entry) { return entry.name && entry.value !== ''; })
      .sort(function (a, b) { return a.order === b.order ? a.seq - b.seq : a.order - b.order; });
  }

  /** The intranet the backend actually talks to, falling back to the spec. */
  function baseUrl(model) {
    var status = global.IntraLens.runtime && global.IntraLens.runtime.status;
    return (status && status.serverUrl) || model.baseUrl;
  }

  function buildUrl(model, op, values) {
    var path = op.path.replace(/\{([^}]+)\}/g, function (_, name) {
      var value = values.path[name];
      return value ? encodeURIComponent(value) : ':' + name;
    });
    var query = activeQuery(values).map(function (entry) {
      return encodeName(entry.name) + '=' + encodeURIComponent(entry.value);
    });
    return baseUrl(model) + path + (query.length ? '?' + query.join('&') : '');
  }

  function pascal(name) {
    return name
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map(function (part) { return part.charAt(0).toUpperCase() + part.slice(1); })
      .join('');
  }

  function camel(name) {
    var text = pascal(name);
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  function goMethodName(operationId) {
    return pascal(operationId) + 'WithResponse';
  }

  function goParamsType(op) {
    return pascal(op.id) + 'Params';
  }

  function goLiteral(param, value) {
    if (param.type === 'integer' || param.type === 'number') {
      return value && /^-?\d+$/.test(value) ? value : '1';
    }
    return JSON.stringify(value || '');
  }

  /** Group the flat query entries back under the parameter that produced them. */
  function groupEntries(values) {
    var grouped = {};
    activeQuery(values).forEach(function (entry) {
      var base = entry.id.split('#')[0];
      (grouped[base] = grouped[base] || []).push(entry);
    });
    return grouped;
  }

  function bracketKey(entry) {
    var match = /\[([^\]]+)\]$/.exec(entry.name);
    return match ? match[1] : entry.name;
  }

  /** Does the 2xx response carry a collection? Drives the printf in the Go snippet. */
  function isListResponse(op) {
    var ok = op.responses.filter(function (response) { return /^2/.test(response.status); })[0];
    return !!(ok && ok.schema && ok.schema.type === 'array');
  }

  function goSnippet(model, op, values) {
    var grouped = groupEntries(values);
    var decls = [];
    var fields = [];

    op.queryParams.concat(op.headerParams).forEach(function (param) {
      var entries = grouped[param.name];
      if (!entries || !entries.length) return;
      var varName = camel(param.name);

      if (param.deepObject) {
        decls.push(varName + ' := map[string]string{' + entries.map(function (entry) {
          return JSON.stringify(bracketKey(entry)) + ': ' + JSON.stringify(entry.value);
        }).join(', ') + '}');
      } else {
        var literal = goLiteral(param, entries[0].value);
        // Parameters declared under components/parameters get a named type.
        decls.push(varName + ' := ' + (param.component
          ? 'intraoapi42.' + pascal(param.component) + '(' + literal + ')'
          : literal));
      }
      fields.push({ name: pascal(param.name), value: '&' + varName });
    });

    var args = ['ctx'].concat(op.pathParams.map(function (param) {
      return goLiteral(param, values.path[param.name]);
    }));

    var hasParams = op.queryParams.length + op.headerParams.length > 0;
    if (hasParams) {
      // gofmt aligns struct literal values, so do the same here.
      var width = fields.reduce(function (max, field) { return Math.max(max, field.name.length); }, 0);
      args.push(fields.length
        ? '&intraoapi42.' + goParamsType(op) + '{\n' + fields.map(function (field) {
            return '\t' + field.name + ':' + new Array(width - field.name.length + 2).join(' ') + field.value + ',';
          }).join('\n') + '\n}'
        : '&intraoapi42.' + goParamsType(op) + '{}');
    }

    return decls.concat([
      (decls.length ? '\n' : '') + 'resp, err := client.' + goMethodName(op.id) + '(' + args.join(', ') + ')',
      'if err != nil {',
      '\tlog.Fatal(err)',
      '}',
      'fmt.Println(resp.StatusCode(), ' + (isListResponse(op) ? 'len(*resp.JSON200))' : '*resp.JSON200)')
    ]).join('\n');
  }

  function pythonSnippet(model, op, values) {
    var grouped = groupEntries(values);
    var assignments = [];

    var path = op.path.replace(/\{([^}]+)\}/g, function (_, name) {
      // `id` would shadow the builtin, so give the local a resource-qualified name.
      var variable = name === 'id' ? op.group.replace(/s$/, '') + '_id' : name;
      variable = variable.replace(/[^a-zA-Z0-9_]/g, '_');
      var value = values.path[name];
      assignments.push(variable + ' = ' + JSON.stringify(value || 'CHANGE_ME'));
      return '{' + variable + '}';
    });

    var params = [];
    op.queryParams.forEach(function (param) {
      (grouped[param.name] || []).forEach(function (entry) {
        params.push('        "' + entry.name + '": ' + JSON.stringify(entry.value) + ',');
      });
    });

    var prefix = assignments.length ? 'f' : '';
    return [
      'import requests',
      '',
      assignments.length ? assignments.join('\n') + '\n' : null,
      'resp = requests.get(',
      '    ' + prefix + '"' + baseUrl(model) + path + '",',
      '    headers={"Authorization": f"Bearer {token}"},',
      params.length ? '    params={\n' + params.join('\n') + '\n    },' : null,
      '    timeout=10,',
      ')',
      'resp.raise_for_status()',
      'print(resp.json())'
    ].filter(function (line) { return line !== null; }).join('\n');
  }

  function snippetFor(kind, model, op, values) {
    if (kind === 'go') return goSnippet(model, op, values);
    if (kind === 'python') return pythonSnippet(model, op, values);
    return 'curl -s -H "Authorization: Bearer $TOKEN" \\\n  "' + buildUrl(model, op, values) + '"';
  }

  /* ------------------------------------------------------- parameter tables */

  function parameterTable(model, params, onValueChange, values) {
    var table = el('table', { class: 'params' }, [
      el('thead', null, el('tr', null, [
        el('th', { text: '名前' }),
        el('th', { text: '型' }),
        el('th', { text: '値 / 説明' })
      ]))
    ]);
    var body = el('tbody');

    params.forEach(function (param) {
      var order = values.orderOf(param);
      var rows = el('div', { class: 'field-rows' });
      var seq = 0;
      var firstInput = null;

      /** One editable row; deepObject params can hold several (filter[a], filter[b]). */
      function addRow(focus) {
        var entry = { id: param.name + '#' + seq, name: param.deepObject ? '' : param.name, value: '', order: order, seq: seq };
        seq += 1;
        values.query.push(entry);

        var keyInput = null;
        var input;

        if (param.deepObject) {
          keyInput = el('input', {
            class: 'field field-key',
            type: 'text',
            placeholder: 'field',
            list: param.fields.length ? 'fields-' + param.name : null
          });
        }

        if (param.enum) {
          input = el('select', { class: 'field' }, [el('option', { value: '', text: '—' })].concat(
            param.enum.map(function (option) { return el('option', { value: option, text: option }); })
          ));
        } else {
          input = el('input', {
            class: 'field',
            type: param.type === 'integer' ? 'number' : 'text',
            placeholder: param.deepObject
              ? 'value'
              : (param.defaultValue !== undefined ? String(param.defaultValue) : param.type),
            min: param.minimum,
            max: param.maximum
          });
        }

        function sync() {
          if (param.in === 'path') {
            values.path[param.name] = input.value.trim();
          } else if (param.deepObject) {
            var key = keyInput.value.trim();
            entry.name = key ? param.name + '[' + key + ']' : '';
            entry.value = input.value.trim();
          } else {
            entry.value = input.value.trim();
          }
          onValueChange();
        }

        input.addEventListener('input', sync);
        input.addEventListener('change', sync);
        if (keyInput) {
          keyInput.addEventListener('input', sync);
          keyInput.addEventListener('change', sync);
        }

        var row = el('div', { class: 'field-row' }, [keyInput, input]);
        if (param.deepObject) {
          row.appendChild(el('button', {
            class: 'copy row-drop',
            type: 'button',
            title: 'この行を削除',
            text: '×',
            onclick: function () {
              values.query.splice(values.query.indexOf(entry), 1);
              rows.removeChild(row);
              if (!rows.children.length) addRow(false);
              onValueChange();
            }
          }));
        }
        rows.appendChild(row);
        if (!firstInput) {
          firstInput = input;
          // Let callers (the pager) drive simple fields programmatically.
          values.controls[param.name] = {
            get: function () { return input.value; },
            set: function (value) {
              input.value = value;
              sync();
            }
          };
        }
        if (focus) (keyInput || input).focus();
      }

      addRow(false);

      var meta = [];
      if (param.required) meta.push(chip('required', 'chip-required'));
      if (param.deprecated) meta.push(chip('deprecated', 'chip-warn'));
      if (param.style) meta.push(chip(param.style + (param.explode ? ' · explode' : ''), 'chip-soft'));
      if (param.defaultValue !== undefined) meta.push(chip('default: ' + param.defaultValue, 'chip-soft'));
      if (param.minimum !== undefined || param.maximum !== undefined) {
        meta.push(chip(
          (param.minimum !== undefined ? param.minimum : '…') + ' – ' + (param.maximum !== undefined ? param.maximum : '…'),
          'chip-soft'
        ));
      }

      var valueCell = el('td', { class: 'param-value' }, [
        rows,
        param.deepObject
          ? el('button', {
              class: 'copy row-add',
              type: 'button',
              text: '+ 条件を追加',
              onclick: function () { addRow(true); }
            })
          : null,
        meta.length ? el('div', { class: 'chip-row' }, meta) : null,
        param.description ? el('div', { class: 'param-desc' }, markdownish(param.description)) : null,
        param.examples.length
          ? el('div', { class: 'examples' }, param.examples.map(function (example) {
              return el('code', { class: 'example', text: example });
            }))
          : null,
        param.fields.length ? fieldChips(param) : null
      ]);

      body.appendChild(el('tr', null, [
        el('td', { class: 'param-name' }, [el('code', { text: param.name })]),
        el('td', { class: 'param-type' }, [chip(param.type, 'chip-type')]),
        valueCell
      ]));
    });

    table.appendChild(body);
    return table;
  }

  /** The long "Must be one of: ..." column lists, as a filterable chip cloud. */
  function fieldChips(param) {
    var wrap = el('details', { class: 'fields' });
    var list = el('div', { class: 'chip-cloud' });
    var datalist = el('datalist', { id: 'fields-' + param.name });

    param.fields.forEach(function (field) {
      list.appendChild(el('code', { class: 'field-chip', text: field }));
      datalist.appendChild(el('option', { value: field }));
    });

    var filter = el('input', {
      class: 'field field-filter',
      type: 'search',
      placeholder: 'カラム名で絞り込み',
      oninput: function () {
        var needle = this.value.toLowerCase();
        Array.prototype.forEach.call(list.children, function (node) {
          node.classList.toggle('is-hidden', needle && node.textContent.toLowerCase().indexOf(needle) === -1);
        });
      }
    });

    wrap.appendChild(el('summary', { text: '使用できるフィールド (' + param.fields.length + ')' }));
    wrap.appendChild(filter);
    wrap.appendChild(list);
    wrap.appendChild(datalist);
    return wrap;
  }

  /* ------------------------------------------------------------- operations */

  function renderOperation(model, op) {
    var values = {
      path: {},
      query: [],
      controls: {},
      orderOf: function (param) { return op.parameters.indexOf(param); }
    };
    var urlCode = el('code', { class: 'url' });
    var snippetCode = el('pre', { class: 'snippet' });
    var currentKind = 'curl';

    function update() {
      urlCode.textContent = buildUrl(model, op, values);
      snippetCode.textContent = snippetFor(currentKind, model, op, values);
    }

    var tabs = ['curl', 'go', 'python'].map(function (kind) {
      return el('button', {
        class: 'tab' + (kind === currentKind ? ' is-active' : ''),
        type: 'button',
        'data-kind': kind,
        text: kind,
        onclick: function () {
          currentKind = kind;
          Array.prototype.forEach.call(this.parentNode.children, function (node) {
            node.classList.toggle('is-active', node === this);
          }, this);
          update();
        }
      });
    });

    var head = el('div', { class: 'op-head' }, [
      el('div', { class: 'op-title' }, [
        methodBadge(op.method),
        el('h1', { class: 'op-path' }, [pathText(op.path)]),
        copyButton('copy path', op.path)
      ]),
      el('p', { class: 'op-summary', text: op.summary }),
      el('div', { class: 'chip-row' }, [
        chip(op.id, 'chip-id'),
        chip(op.group, 'chip-soft'),
        op.deprecated ? chip('deprecated', 'chip-warn') : null
      ].concat(op.scopes.map(function (scope) {
        return el('span', {
          class: 'chip chip-scope',
          title: model.scopeDescriptions[scope] || '',
          text: 'scope: ' + scope
        });
      })))
    ]);

    var sections = [head];

    if (op.description) sections.push(el('div', { class: 'op-description' }, markdownish(op.description)));

    if (op.pathParams.length) {
      sections.push(section('パスパラメータ', parameterTable(model, op.pathParams, update, values)));
    }
    if (op.queryParams.length) {
      sections.push(section('クエリパラメータ', parameterTable(model, op.queryParams, update, values)));
    }
    if (op.headerParams.length) {
      sections.push(section('ヘッダー', parameterTable(model, op.headerParams, update, values)));
    }

    var resultArea = el('div', { class: 'result-area' });
    var status = global.IntraLens.runtime.status;
    var callable = !status || (status.configured && (!status.operations || status.operations.indexOf(op.id) !== -1));
    var runButton = el('button', {
      class: 'run',
      type: 'button',
      text: '実行  (Ctrl+Enter)',
      disabled: !callable,
      title: callable ? '' : '認証情報が未設定、またはこの操作は Go クライアント側に未実装です',
      onclick: function () { execute(); }
    });

    /** POST the current form to the backend, which calls the 42 API for us. */
    function execute() {
      if (runButton.disabled) return;
      runButton.disabled = true;
      runButton.classList.add('is-busy');
      var label = runButton.textContent;
      runButton.textContent = '実行中…';

      var payload = { operationId: op.id, path: {}, query: {} };
      op.pathParams.forEach(function (param) {
        payload.path[param.name] = values.path[param.name] || '';
      });
      activeQuery(values).forEach(function (entry) {
        payload.query[entry.name] = entry.value;
      });

      global.IntraLens.api.call(payload).then(function (result) {
        resultArea.textContent = '';
        resultArea.appendChild(global.IntraLens.response.render(result, op, pageJump));
      })['catch'](function (err) {
        resultArea.textContent = '';
        resultArea.appendChild(global.IntraLens.response.error(err.message));
      }).then(function () {
        runButton.disabled = false;
        runButton.classList.remove('is-busy');
        runButton.textContent = label;
      });
    }

    /** Pager callback: move the `page` field and re-run. */
    function pageJump(page) {
      var control = values.controls.page || values.controls['page[number]'];
      if (!control) return;
      control.set(String(Math.max(1, page)));
      execute();
    }

    var container = el('div', { class: 'view view-op' });
    container.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        execute();
      }
    });

    sections.push(section('実行', [
      el('div', { class: 'url-row' }, [
        methodBadge(op.method),
        urlCode,
        copyButton('copy', function () { return urlCode.textContent; }),
        runButton
      ]),
      el('p', {
        class: 'hint',
        text: callable
          ? 'ローカルの intra-Lens サーバ経由で 42 API を呼び出します (認証・リトライは intraoapi42 が担当)。'
          : '実行するには INTRA42_UID / INTRA42_SECRET を設定してサーバを再起動してください。'
      }),
      resultArea
    ]));

    sections.push(section('コード', [
      el('div', { class: 'tabs' }, tabs),
      el('div', { class: 'snippet-wrap' }, [snippetCode, copyButton('copy', function () { return snippetCode.textContent; })])
    ]));

    sections.push(section('レスポンス定義', op.responses.map(function (response) {
      return el('article', { class: 'response' }, [
        el('div', { class: 'response-head' }, [
          el('span', { class: 'status status-' + statusClass(response.status), text: response.status }),
          el('span', { class: 'response-desc', text: response.description }),
          response.type
            ? (response.ref
                ? link('/model/' + response.ref, response.type, 'chip chip-type ref-link')
                : chip(response.type, 'chip-type'))
            : null,
          response.mediaType ? chip(response.mediaType, 'chip-soft') : null
        ]),
        response.headers.length
          ? el('div', { class: 'headers' }, [
              el('h3', { text: 'レスポンスヘッダー' }),
              el('ul', { class: 'header-list' }, response.headers.map(function (header) {
                return el('li', null, [el('code', { text: header.name }), chip(header.type, 'chip-type'), el('span', { class: 'muted', text: header.description })]);
              }))
            ])
          : null,
        response.schema ? schemaTree(model, response.schema, {}) : null,
        exampleBlock(model, response.schema)
      ]);
    })));

    var related = op.schemaRefs
      .map(function (name) { return model.findSchema(name); })
      .filter(Boolean);
    if (related.length) {
      sections.push(section('関連モデル', el('div', { class: 'chip-row' }, related.map(function (entry) {
        return link('/model/' + entry.name, entry.name, 'chip chip-type ref-link');
      }))));
    }

    update();
    append(container, sections);
    return container;
  }

  function statusClass(status) {
    if (status === 'default') return 'default';
    var code = parseInt(status, 10);
    if (code >= 200 && code < 300) return 'ok';
    if (code >= 400 && code < 500) return 'client';
    if (code >= 500) return 'server';
    return 'default';
  }

  function exampleBlock(model, schema) {
    if (!schema) return null;
    var target = schema.type === 'array' ? schema.items : schema;
    var flat = Spec.flatten(model.doc, target);
    if (flat.example === undefined) return null;
    var payload = schema.type === 'array' ? [flat.example] : flat.example;
    var text = JSON.stringify(payload, null, 2);
    return el('details', { class: 'example-block' }, [
      el('summary', { text: 'レスポンス例' }),
      el('div', { class: 'snippet-wrap' }, [el('pre', { class: 'snippet', text: text }), copyButton('copy', text)])
    ]);
  }

  /* ----------------------------------------------------------------- models */

  function renderSchema(model, entry) {
    var flat = Spec.flatten(model.doc, entry.schema);
    var sections = [
      el('div', { class: 'op-head' }, [
        el('div', { class: 'op-title' }, [
          el('h1', { class: 'op-path', text: entry.name }),
          copyButton('copy name', entry.name)
        ]),
        flat.description ? el('p', { class: 'op-summary', text: flat.description }) : null,
        el('div', { class: 'chip-row' }, [
          chip(flat.properties.length + ' プロパティ', 'chip-soft'),
          chip(flat.required.length + ' required', 'chip-soft')
        ])
      ]),
      section('プロパティ', schemaTree(model, entry.schema, {}))
    ];

    if (entry.usedByOperations.length) {
      sections.push(section('このモデルを返すエンドポイント', el('ul', { class: 'usage' }, entry.usedByOperations.map(function (op) {
        var direct = entry.directlyUsedByOperations.indexOf(op) !== -1;
        return el('li', null, [
          link('/op/' + op.id, [methodBadge(op.method), el('code', { text: op.path })], 'usage-link'),
          direct ? null : el('span', { class: 'muted', text: ' (入れ子)' })
        ]);
      }))));
    }
    if (entry.usedBySchemas.length) {
      sections.push(section('参照しているモデル', el('div', { class: 'chip-row' }, entry.usedBySchemas.map(function (name) {
        return link('/model/' + name, name, 'chip chip-type ref-link');
      }))));
    }
    if (flat.example !== undefined) {
      sections.push(section('例', el('div', { class: 'snippet-wrap' }, [
        el('pre', { class: 'snippet', text: JSON.stringify(flat.example, null, 2) }),
        copyButton('copy', JSON.stringify(flat.example, null, 2))
      ])));
    }

    return el('div', { class: 'view view-model' }, sections);
  }

  /* ------------------------------------------------------------------- home */

  function renderHome(model) {
    var rows = model.operations.map(function (op) {
      return el('tr', {
        class: 'index-row',
        tabindex: '0',
        onclick: function () { location.hash = '/op/' + op.id; },
        onkeydown: function (event) { if (event.key === 'Enter') location.hash = '/op/' + op.id; }
      }, [
        el('td', null, methodBadge(op.method)),
        el('td', { class: 'index-path' }, [pathText(op.path)]),
        el('td', { class: 'index-summary', text: op.summary }),
        el('td', null, el('code', { class: 'muted', text: op.id })),
        el('td', null, op.scopes.map(function (scope) { return chip(scope, 'chip-scope'); }))
      ]);
    });

    var scopeList = Object.keys(model.scopeDescriptions).map(function (scope) {
      return el('li', null, [el('code', { text: scope }), ' — ', model.scopeDescriptions[scope]]);
    });

    var tokenCmd = [
      'curl -s -X POST "https://api.intra.42.fr/oauth/token" \\',
      '  -d grant_type=client_credentials \\',
      '  -d client_id=$UID \\',
      '  -d client_secret=$SECRET'
    ].join('\n');

    return el('div', { class: 'view view-home' }, [
      el('div', { class: 'hero' }, [
        el('h1', { text: model.info.title || 'API' }),
        el('p', { class: 'op-summary', text: (model.info.description || '').trim() }),
        el('div', { class: 'chip-row' }, [
          chip('spec v' + (model.info.version || '?'), 'chip-soft'),
          chip(model.operations.length + ' エンドポイント', 'chip-soft'),
          chip(model.schemas.length + ' モデル', 'chip-soft'),
          chip(model.baseUrl, 'chip-id')
        ])
      ]),
      section('エンドポイント一覧', el('table', { class: 'index' }, [
        el('thead', null, el('tr', null, [
          el('th', { text: 'method' }),
          el('th', { text: 'path' }),
          el('th', { text: '概要' }),
          el('th', { text: 'operationId' }),
          el('th', { text: 'scope' })
        ])),
        el('tbody', null, rows)
      ])),
      section('認証 (OAuth2 client credentials)', [
        el('p', { class: 'prose', text: 'アプリ単位のトークンを取得し、Authorization: Bearer ヘッダーで送ります。トークンは 2 時間で失効します。' }),
        el('div', { class: 'snippet-wrap' }, [el('pre', { class: 'snippet', text: tokenCmd }), copyButton('copy', tokenCmd)]),
        el('h3', { text: 'スコープ' }),
        el('ul', { class: 'scopes' }, scopeList)
      ]),
      section('ページネーション', [
        el('p', { class: 'prose', text: '一覧系エンドポイントは既定で 1 ページ 30 件です。page / per_page もしくは page[number] / page[size] を使います (最大 100 件)。' }),
        el('ul', { class: 'scopes' }, [
          el('li', null, [el('code', { text: 'X-Page' }), ' — 現在のページ番号']),
          el('li', null, [el('code', { text: 'X-Per-Page' }), ' — 1 ページあたりの件数']),
          el('li', null, [el('code', { text: 'X-Total' }), ' — 総件数']),
          el('li', null, [el('code', { text: 'Link' }), ' — RFC5988 の first / prev / next / last'])
        ]),
        el('p', { class: 'hint', text: 'レート制限は 2 req/sec・1200 req/hour が目安です。429 が返ったら待ってから再試行してください。' })
      ]),
      section('モデル一覧', el('div', { class: 'chip-row' }, model.schemas.map(function (entry) {
        return link('/model/' + entry.name, entry.name, 'chip chip-type ref-link');
      })))
    ]);
  }

  function renderNotFound(hash) {
    return el('div', { class: 'view' }, [
      el('h1', { text: '見つかりません' }),
      el('p', { class: 'prose', text: hash + ' に対応するエンドポイントやモデルはありません。' }),
      link('/', '一覧に戻る', 'button-link')
    ]);
  }

  global.IntraLens.render = {
    el: el,
    chip: chip,
    link: link,
    methodBadge: methodBadge,
    pathText: pathText,
    copyButton: copyButton,
    renderHome: renderHome,
    renderOperation: renderOperation,
    renderSchema: renderSchema,
    renderNotFound: renderNotFound,
    buildUrl: buildUrl,
    snippetFor: snippetFor
  };
})(typeof window !== 'undefined' ? window : globalThis);
