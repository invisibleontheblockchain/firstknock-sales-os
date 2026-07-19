import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const functionRoot = path.resolve('base44/functions');
const functionFiles = fs.readdirSync(functionRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(functionRoot, entry.name, 'entry.ts'))
  .filter((file) => fs.existsSync(file));

const syntaxErrors = [];
for (const file of functionFiles) {
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    },
    reportDiagnostics: true
  });
  for (const diagnostic of result.diagnostics || []) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    syntaxErrors.push(`${path.relative(process.cwd(), file)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
}
assert.deepEqual(syntaxErrors, [], `Backend syntax errors:\n${syntaxErrors.join('\n')}`);

const entityRoot = path.resolve('base44/entities');
const jsonFiles = [
  ...fs.readdirSync(entityRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonc'))
    .map((entry) => path.join(entityRoot, entry.name))
    .sort(),
  path.resolve('base44/config.jsonc'),
  path.resolve('package.json')
];
for (const file of jsonFiles) JSON.parse(fs.readFileSync(file, 'utf8'));

console.log(`Validated ${functionFiles.length} Base44 functions and ${jsonFiles.length} JSON configuration files.`);
