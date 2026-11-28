// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { hostMessages } from './host-messages.mjs';
import { pauseReasons, setupErrors } from './setup-codes.mjs';

const panel = new URL('../', import.meta.url);
const catalogs = [
  ['locales/', ['screens/', 'components/']],
  ['identity/locales/', ['identity/']],
  ['workflows/', ['workflows/']],
];
const readCatalog = (directory, language) =>
  JSON.parse(readFileSync(new URL(directory + language + '.json', panel), 'utf8'));

function keys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix + key;
    return typeof entry === 'string' ? [path] : keys(entry, path + '.');
  }).sort();
}

function literals(node) {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  return [];
}

function literalKeys(file, source) {
  const found = new Set();
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      for (const key of literals(node.arguments[0])) found.add(key);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

test.each(catalogs)('%s has matching Spanish and English message keys', directory => {
  expect(keys(readCatalog(directory, 'es'))).toEqual(keys(readCatalog(directory, 'en')));
});

test.each(['es', 'en'])('%s defines every dynamic Setup message', language => {
  const { setup } = readCatalog('locales/', language);
  const expected = [
    ...['gitleaks', 'machine_paths'].map(name => `pub.checkNames.${name}`),
    ...['pill-ok', 'pill-down', 'pill-unk'].map(state => `pub.checkStatus.${state}`),
    ...setupErrors.map(code => `errors.${code}`),
    ...[...pauseReasons, 'other'].map(reason => `codes.${reason}`),
  ];
  expect(keys(setup)).toEqual(expect.arrayContaining(expected));
});

test.each(catalogs)('%s defines every literal translation call in its screens', (directory, sourceDirs) => {
  const localized = ['es', 'en'].map(language =>
    new Set(keys({ ...hostMessages[language], ...readCatalog(directory, language) })));
  const missing = [];
  for (const sourceDir of sourceDirs) {
    const root = new URL(sourceDir, panel);
    for (const file of readdirSync(root, { recursive: true }).filter(file => /\.tsx?$/.test(file))) {
      const source = readFileSync(new URL(file, root), 'utf8');
      for (const key of literalKeys(file, source)) {
        if (!localized.every(catalog => catalog.has(key) || (catalog.has(key + '_one') && catalog.has(key + '_other')))) {
          missing.push(`${sourceDir}${file}: ${key}`);
        }
      }
    }
  }
  expect(missing).toEqual([]);
});
