import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { parseModule, validateImportBindings } from '../scripts/module-parser.mjs';

const root = new URL('../', import.meta.url);

test('index loads a browser-classic bundle for direct file opening', async () => {
  const index = await readFile(new URL('index.html', root), 'utf8');
  const bundle = await readFile(new URL('bundle.js', root), 'utf8');

  assert.match(index, /<script src="bundle\.js" defer><\/script>/);
  assert.doesNotMatch(index, /<script[^>]+type="module"/);
  assert.doesNotMatch(bundle, /^\s*(?:import|export)\s/m);
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'bundle.js' }));
});

test('bundle parser supports semicolon-free direct imports and rejects aliases', () => {
  const continuation = '\\' + '\n';
  const parsed = parseModule(
    "import { value } from './dependency.js'\nexport const result = value;",
    'fixture.js'
  );
  assert.deepEqual(parsed.imports, [{ specifier: './dependency.js', names: ['value'] }]);
  assert.deepEqual(parsed.exports, ['result']);
  assert.match(parsed.code, /const result = value/);
  assert.throws(
    () => parseModule("import { value as alias } from './dependency.js';", 'fixture.js'),
    /Only direct named imports/
  );
  assert.throws(
    () => parseModule("import dependency from './dependency.js';", 'fixture.js'),
    /Only direct named imports/
  );
  assert.throws(
    () => validateImportBindings('fixture.js', ['missing'], 'dependency.js', ['value']),
    /imports missing bindings.*missing/
  );
  assert.throws(
    () => parseModule("const text = `BEFORE\\nimport { value } from './dependency.js';\\nAFTER`;", 'fixture.js'),
    /Template literals are not supported/
  );
  assert.throws(
    () => parseModule("/*\\nexport const hidden = true;\\n*/", 'fixture.js'),
    /Block comments are not supported/
  );
  assert.throws(
    () => parseModule("const text = 'BEFORE" + continuation + "export const hidden = true;" + continuation + "AFTER';", 'fixture.js'),
    /Line continuations are not supported/
  );
  assert.throws(
    () => parseModule("const loadUi = () => import('./ui.js');", 'fixture.js'),
    /Dynamic imports are not supported/
  );
});
