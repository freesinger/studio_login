import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptFile), '..');
const ignoredDirectories = new Set(['.git', '.idea', 'dist', 'node_modules']);
const checkedExtensions = new Set(['.ts', '.js', '.json', '.md', '.sql', '.yml', '.yaml', '.env']);
const optionalForbiddenTerms = (process.env.SENSITIVE_FORBIDDEN_TERMS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const patterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'private key material',
    pattern: new RegExp(`BEGIN (?:RSA |EC |OPENSSH )?PRIVATE ${'KEY'}`),
  },
  {
    label: 'cloud access key',
    pattern: new RegExp(`AKI${'A'}[0-9A-Z]{16}`),
  },
  {
    label: 'credential embedded in remote URL',
    pattern: /(?:mysql2?|https?):\/\/[^\s/:]+:[^\s/@]+@(?!127\.0\.0\.1|localhost)/i,
  },
  ...optionalForbiddenTerms.map(term => ({
    label: 'forbidden business term',
    pattern: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  })),
];

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (checkedExtensions.has(extname(entry.name)) || entry.name === '.env.example') files.push(path);
  }
  return files;
}

const findings: string[] = [];
for (const file of await filesUnder(projectRoot)) {
  if (file === scriptFile) continue;
  const content = await readFile(file, 'utf8');
  for (const { label, pattern } of patterns) {
    if (pattern.test(content)) findings.push(`${relative(projectRoot, file)}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error(`Sensitive-content check failed:\n${findings.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Sensitive-content check passed.');
}
