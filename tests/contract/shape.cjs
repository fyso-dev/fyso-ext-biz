'use strict';
// Structural comparison of two wire bodies: same keys, same value types, recursively. Values never matter
// (etags, ids, names, timestamps are volatile). An empty array matches an array of anything, since it says nothing
// about its elements; arrays of objects are compared by the union of their elements' keys.

const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** Merge the shapes of several samples (array elements) into one. */
function merge(shapes) {
  if (shapes.length === 0) return {kind: 'array', items: null};
  const kinds = [...new Set(shapes.map(s => s.kind))];
  if (kinds.length > 1) return {kind: kinds.sort().join('|')};
  if (kinds[0] === 'object') {
    const keys = {};
    for (const s of shapes) for (const [k, v] of Object.entries(s.keys)) keys[k] = keys[k] ? merge([keys[k], v]) : v;
    return {kind: 'object', keys};
  }
  if (kinds[0] === 'array') return {kind: 'array', items: shapes.some(s => s.items) ? merge(shapes.filter(s => s.items).map(s => s.items)) : null};
  return {kind: kinds[0]};
}

function shapeOf(value) {
  const k = kind(value);
  if (k === 'object') return {kind: k, keys: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item)]))};
  if (k === 'array') return {kind: k, items: value.length ? merge(value.map(shapeOf)) : null};
  return {kind: k};
}

/** Differences `[{path, fake, real}]` between two shapes (empty = they agree). */
function diffShapes(fake, real, path = '$') {
  if (fake.kind !== real.kind) return [{path, fake: fake.kind, real: real.kind}];
  if (fake.kind === 'array') return fake.items && real.items ? diffShapes(fake.items, real.items, `${path}[]`) : [];
  if (fake.kind !== 'object') return [];
  const out = [];
  for (const key of new Set([...Object.keys(fake.keys), ...Object.keys(real.keys)])) {
    if (!(key in real.keys)) out.push({path: `${path}.${key}`, fake: fake.keys[key].kind, real: '(missing)'});
    else if (!(key in fake.keys)) out.push({path: `${path}.${key}`, fake: '(missing)', real: real.keys[key].kind});
    else out.push(...diffShapes(fake.keys[key], real.keys[key], `${path}.${key}`));
  }
  return out;
}

const render = shape => shape.kind === 'object' ? `{${Object.entries(shape.keys).map(([k, v]) => `${k}: ${render(v)}`).join(', ')}}` : shape.kind === 'array' ? `[${shape.items ? render(shape.items) : ''}]` : shape.kind;

/** Readable report of the differences, or null. */
function describeDiff(label, fakeBody, realBody) {
  const diffs = diffShapes(shapeOf(fakeBody), shapeOf(realBody));
  if (!diffs.length) return null;
  return [`${label}: the fake's wire shape differs from the real Biz's`, ...diffs.map(d => `  ${d.path}: fake ${d.fake}, real ${d.real}`),
    `  fake: ${render(shapeOf(fakeBody))}`, `  real: ${render(shapeOf(realBody))}`].join('\n');
}

module.exports = {shapeOf, diffShapes, describeDiff};
