export function parseModule(source, file) {
  // This intentionally small parser works one statement per source line. Fail
  // closed on JavaScript constructs that can contain module-looking text across
  // lines instead of silently rewriting content inside them.
  if (source.includes('`')) {
    throw new Error('Template literals are not supported in ' + file);
  }
  if (/\/\*[\s\S]*?\*\//.test(source)) {
    throw new Error('Block comments are not supported in ' + file);
  }
  if (/\\\r?\n/.test(source)) {
    throw new Error('Line continuations are not supported in ' + file);
  }
  if (/\bimport\s*\(/.test(source)) {
    throw new Error('Dynamic imports are not supported in ' + file);
  }

  const imports = [];
  const codeLines = [];
  let importLines = null;

  for (const line of source.split('\n')) {
    if (!importLines && /^\s*import\b/.test(line)) importLines = [];
    if (importLines) {
      importLines.push(line);
      const statement = importLines.join('\n');
      const match = statement.match(/^\s*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?\s*$/);
      if (match) {
        const bindings = match[1].trim();
        if (!/^\{[\s\S]*\}$/.test(bindings) || /\bas\b/.test(bindings)) {
          throw new Error('Only direct named imports are supported in ' + file);
        }
        const body = bindings.slice(1, -1).trim();
        const names = body ? body.split(',').map(name => name.trim()).filter(Boolean) : [];
        if (names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) {
          throw new Error('Invalid named import in ' + file);
        }
        imports.push({ specifier: match[3], names });
        importLines = null;
      }
      continue;
    }
    codeLines.push(line);
  }

  if (importLines) throw new Error('Unsupported import syntax in ' + file);
  let code = codeLines.join('\n');
  const unsupportedExport = code.match(/^\s*export\s+(?!const\b|let\b|var\b|function\b|class\b)/m);
  if (unsupportedExport) {
    throw new Error('Unsupported export syntax in ' + file + ': ' + unsupportedExport[0].trim());
  }
  const exports = [...code.matchAll(/^\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1]);
  code = code.replace(/^(\s*)export\s+(?=(?:const|let|var|function|class)\b)/gm, '$1');
  if (/^\s*(?:import|export)\b/m.test(code)) throw new Error('Module syntax remains in ' + file);
  return { imports, exports, code };
}

export function validateImportBindings(importer, importedNames, dependency, exportedNames) {
  const available = new Set(exportedNames);
  const missing = importedNames.filter(name => !available.has(name));
  if (missing.length) {
    throw new Error(importer + ' imports missing bindings from ' + dependency + ': ' + missing.join(', '));
  }
}
