/* Model layer: turns a raw OpenAPI 3 document into the shapes the UI needs.
 * No DOM access lives here so it stays unit-testable from node (see tools/check_spec.py). */
(function (global) {
  'use strict';

  var HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

  /** Resolve a local `#/a/b/c` JSON pointer against the document. */
  function resolveRef(doc, ref) {
    if (typeof ref !== 'string' || ref.charAt(0) !== '#') return null;
    var node = doc;
    var parts = ref.slice(2).split('/');
    for (var i = 0; i < parts.length; i++) {
      var key = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
      if (node == null || typeof node !== 'object') return null;
      node = node[key];
    }
    return node == null ? null : node;
  }

  /** Follow `$ref` chains until a concrete node is reached. */
  function deref(doc, node, seen) {
    seen = seen || [];
    var guard = 0;
    while (node && node.$ref && guard++ < 32) {
      if (seen.indexOf(node.$ref) !== -1) return node;
      seen.push(node.$ref);
      var next = resolveRef(doc, node.$ref);
      if (!next) return node;
      node = next;
    }
    return node;
  }

  function refName(ref) {
    return typeof ref === 'string' ? ref.split('/').pop() : null;
  }

  /* The 42 API documents its sortable/filterable columns inside prose:
   *   "Must be one of: id, login, email."
   * Pulling them out lets the UI show searchable chips instead of a wall of text. */
  function splitDescription(description) {
    var out = { text: '', fields: [], examples: [] };
    if (!description) return out;
    var kept = [];
    description.split('\n').forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var example = /^Example\s*:\s*(.+)$/i.exec(trimmed);
      if (example) {
        out.examples.push(example[1].trim());
        return;
      }
      var list = /Must be one of\s*:\s*([^.]+)\.?/i.exec(trimmed);
      if (list) {
        list[1].split(',').forEach(function (field) {
          var name = field.trim();
          if (name && out.fields.indexOf(name) === -1) out.fields.push(name);
        });
        var rest = trimmed.replace(list[0], '').trim();
        if (rest) kept.push(rest);
        return;
      }
      kept.push(trimmed);
    });
    out.text = kept.join(' ');
    return out;
  }

  /** Short human-readable type label for a schema node ("string", "Array<UserResponse>", ...). */
  function typeLabel(doc, schema) {
    if (!schema) return 'any';
    if (schema.$ref) return refName(schema.$ref);
    if (schema.allOf) {
      var names = schema.allOf.map(function (part) { return typeLabel(doc, part); });
      return names.join(' & ');
    }
    if (schema.oneOf) return schema.oneOf.map(function (p) { return typeLabel(doc, p); }).join(' | ');
    if (schema.anyOf) return schema.anyOf.map(function (p) { return typeLabel(doc, p); }).join(' | ');
    if (schema.type === 'array') return 'Array<' + typeLabel(doc, schema.items) + '>';
    if (schema.type === 'object' && schema.additionalProperties) {
      return 'Map<string, ' + typeLabel(doc, schema.additionalProperties) + '>';
    }
    if (schema.enum) return (schema.type || 'enum') + ' (enum)';
    if (schema.format) return schema.type + '<' + schema.format + '>';
    return schema.type || 'object';
  }

  /** Flatten `allOf` so a composed model renders as one property table. */
  function flatten(doc, schema, depth) {
    depth = depth || 0;
    var result = { properties: [], required: [], description: '', example: undefined, extra: null };
    if (!schema || depth > 8) return result;
    if (schema.$ref) return flatten(doc, deref(doc, schema), depth + 1);

    if (schema.allOf) {
      schema.allOf.forEach(function (part) {
        var sub = flatten(doc, part, depth + 1);
        sub.properties.forEach(function (prop) {
          var existing = result.properties.filter(function (p) { return p.name === prop.name; })[0];
          if (existing) Object.assign(existing, prop);
          else result.properties.push(prop);
        });
        result.required = result.required.concat(sub.required);
        result.description = result.description || sub.description;
        if (result.example === undefined) result.example = sub.example;
      });
    }

    result.description = schema.description || result.description;
    if (schema.example !== undefined) result.example = schema.example;
    result.required = result.required.concat(schema.required || []);

    Object.keys(schema.properties || {}).forEach(function (name) {
      var child = schema.properties[name];
      var existing = result.properties.filter(function (p) { return p.name === name; })[0];
      var entry = {
        name: name,
        schema: child,
        type: typeLabel(doc, child),
        ref: child.$ref ? refName(child.$ref) : (child.type === 'array' && child.items && child.items.$ref ? refName(child.items.$ref) : null),
        description: child.description || '',
        nullable: child.nullable === true
      };
      if (existing) Object.assign(existing, entry);
      else result.properties.push(entry);
    });

    if (!schema.properties && !schema.allOf && (schema.type !== 'object' || schema.additionalProperties)) {
      result.extra = schema;
    }

    result.properties.forEach(function (prop) {
      prop.required = result.required.indexOf(prop.name) !== -1;
    });
    return result;
  }

  /** Collect every schema name referenced from a node (one level of indirection). */
  function collectRefs(node, into, depth) {
    into = into || [];
    depth = depth || 0;
    if (!node || typeof node !== 'object' || depth > 12) return into;
    if (Array.isArray(node)) {
      node.forEach(function (item) { collectRefs(item, into, depth + 1); });
      return into;
    }
    Object.keys(node).forEach(function (key) {
      if (key === '$ref') {
        var name = refName(node[key]);
        if (name && into.indexOf(name) === -1) into.push(name);
      } else {
        collectRefs(node[key], into, depth + 1);
      }
    });
    return into;
  }

  function groupOf(path) {
    var segments = path.split('/').filter(Boolean);
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].charAt(0) !== '{') return segments[i];
    }
    return segments[0] || '/';
  }

  function buildOperation(doc, path, method, raw) {
    var parameters = (raw.parameters || []).map(function (param) {
      var resolved = deref(doc, param);
      var schema = resolved.schema || {};
      var parts = splitDescription(resolved.description);
      return {
        component: param.$ref ? refName(param.$ref) : null,
        name: resolved.name,
        in: resolved.in,
        required: resolved.required === true || resolved.in === 'path',
        deprecated: resolved.deprecated === true,
        style: resolved.style || null,
        explode: resolved.explode === true,
        schema: schema,
        type: typeLabel(doc, schema),
        enum: schema.enum || null,
        defaultValue: schema.default,
        minimum: schema.minimum,
        maximum: schema.maximum,
        deepObject: resolved.style === 'deepObject',
        description: parts.text,
        fields: parts.fields,
        examples: parts.examples
      };
    });

    var responses = Object.keys(raw.responses || {}).map(function (status) {
      var resolved = deref(doc, raw.responses[status]);
      var content = resolved.content || {};
      var mediaType = Object.keys(content)[0] || null;
      var media = mediaType ? content[mediaType] : null;
      var schema = media ? media.schema : null;
      return {
        status: status,
        description: resolved.description || '',
        mediaType: mediaType,
        schema: schema,
        type: schema ? typeLabel(doc, schema) : null,
        ref: schema ? (schema.$ref ? refName(schema.$ref) : (schema.type === 'array' && schema.items && schema.items.$ref ? refName(schema.items.$ref) : null)) : null,
        headers: Object.keys(resolved.headers || {}).map(function (name) {
          var header = deref(doc, resolved.headers[name]);
          return { name: name, description: header.description || '', type: typeLabel(doc, header.schema) };
        })
      };
    }).sort(function (a, b) { return a.status.localeCompare(b.status); });

    var scopes = [];
    (raw.security || doc.security || []).forEach(function (entry) {
      Object.keys(entry).forEach(function (scheme) {
        (entry[scheme] || []).forEach(function (scope) {
          if (scopes.indexOf(scope) === -1) scopes.push(scope);
        });
      });
    });

    return {
      kind: 'operation',
      id: raw.operationId || (method + ' ' + path),
      method: method.toUpperCase(),
      path: path,
      group: groupOf(path),
      summary: raw.summary || '',
      description: raw.description || '',
      deprecated: raw.deprecated === true,
      scopes: scopes,
      parameters: parameters,
      pathParams: parameters.filter(function (p) { return p.in === 'path'; }),
      queryParams: parameters.filter(function (p) { return p.in === 'query'; }),
      headerParams: parameters.filter(function (p) { return p.in === 'header'; }),
      responses: responses,
      schemaRefs: collectRefs(raw.responses || {})
    };
  }

  function build(doc) {
    var components = doc.components || {};
    var operations = [];

    Object.keys(doc.paths || {}).forEach(function (path) {
      var item = doc.paths[path];
      HTTP_METHODS.forEach(function (method) {
        if (!item[method]) return;
        var op = item[method];
        var merged = Object.assign({}, op, {
          parameters: (item.parameters || []).concat(op.parameters || [])
        });
        operations.push(buildOperation(doc, path, method, merged));
      });
    });

    operations.sort(function (a, b) {
      return a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path);
    });

    var groups = [];
    operations.forEach(function (op) {
      var group = groups.filter(function (g) { return g.name === op.group; })[0];
      if (!group) {
        group = { name: op.group, operations: [] };
        groups.push(group);
      }
      group.operations.push(op);
    });
    groups.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var schemas = Object.keys(components.schemas || {}).map(function (name) {
      var schema = components.schemas[name];
      return {
        kind: 'schema',
        id: name,
        name: name,
        schema: schema,
        description: schema.description || '',
        type: typeLabel(doc, schema),
        refs: collectRefs(schema).filter(function (ref) { return ref !== name; })
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });

    // Transitive closure of model references, so "which endpoints return this?"
    // also answers for models that only appear nested inside another model.
    var refsByName = {};
    schemas.forEach(function (entry) { refsByName[entry.name] = entry.refs; });

    function closure(names) {
      var out = [];
      var queue = names.slice();
      while (queue.length) {
        var name = queue.shift();
        if (out.indexOf(name) !== -1) continue;
        out.push(name);
        (refsByName[name] || []).forEach(function (child) {
          if (out.indexOf(child) === -1) queue.push(child);
        });
      }
      return out;
    }

    operations.forEach(function (op) {
      op.allSchemaRefs = closure(op.schemaRefs);
    });

    // Reverse index: which operations / models point at a given model.
    schemas.forEach(function (entry) {
      entry.usedByOperations = operations.filter(function (op) {
        return op.allSchemaRefs.indexOf(entry.name) !== -1;
      });
      entry.directlyUsedByOperations = operations.filter(function (op) {
        return op.schemaRefs.indexOf(entry.name) !== -1;
      });
      entry.usedBySchemas = schemas.filter(function (other) {
        return other.name !== entry.name && other.refs.indexOf(entry.name) !== -1;
      }).map(function (other) { return other.name; });
    });

    var scopes = {};
    Object.keys(components.securitySchemes || {}).forEach(function (name) {
      var scheme = components.securitySchemes[name];
      Object.keys((scheme.flows || {})).forEach(function (flow) {
        Object.assign(scopes, scheme.flows[flow].scopes || {});
      });
    });

    return {
      doc: doc,
      info: doc.info || {},
      servers: doc.servers || [],
      baseUrl: (doc.servers && doc.servers[0] && doc.servers[0].url) || '',
      securitySchemes: components.securitySchemes || {},
      scopeDescriptions: scopes,
      operations: operations,
      groups: groups,
      schemas: schemas,
      findOperation: function (id) {
        return operations.filter(function (op) { return op.id === id; })[0] || null;
      },
      findSchema: function (name) {
        return schemas.filter(function (entry) { return entry.name === name; })[0] || null;
      }
    };
  }

  /** Case-insensitive subsequence match, used for the "/" quick filter. */
  function fuzzy(needle, haystack) {
    if (!needle) return 0;
    needle = needle.toLowerCase();
    haystack = (haystack || '').toLowerCase();
    var direct = haystack.indexOf(needle);
    if (direct !== -1) return 1000 - direct;
    var index = 0;
    var score = 0;
    for (var i = 0; i < haystack.length && index < needle.length; i++) {
      if (haystack.charAt(i) === needle.charAt(index)) {
        index++;
        score += 1;
      }
    }
    return index === needle.length ? score : -1;
  }

  function searchOperations(model, query) {
    if (!query) return model.operations.slice();
    return model.operations
      .map(function (op) {
        var haystacks = [op.path, op.id, op.summary, op.method + ' ' + op.path, op.group]
          .concat(op.queryParams.map(function (p) { return p.name; }));
        var best = -1;
        haystacks.forEach(function (text) {
          var score = fuzzy(query, text);
          if (score > best) best = score;
        });
        return { op: op, score: best };
      })
      .filter(function (hit) { return hit.score >= 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (hit) { return hit.op; });
  }

  function searchSchemas(model, query) {
    if (!query) return model.schemas.slice();
    return model.schemas
      .map(function (entry) { return { entry: entry, score: fuzzy(query, entry.name) }; })
      .filter(function (hit) { return hit.score >= 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (hit) { return hit.entry; });
  }

  global.IntraLens = global.IntraLens || {};
  global.IntraLens.spec = {
    build: build,
    deref: deref,
    resolveRef: resolveRef,
    refName: refName,
    flatten: flatten,
    typeLabel: typeLabel,
    splitDescription: splitDescription,
    searchOperations: searchOperations,
    searchSchemas: searchSchemas,
    fuzzy: fuzzy
  };
})(typeof window !== 'undefined' ? window : globalThis);
