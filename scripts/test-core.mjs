import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(root, '.tmp-test');
rmSync(temporary, { recursive: true, force: true });

try {
  execFileSync('tsc', ['-p', 'tsconfig.core.json'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, ['--test', 'test/manifest.test.mjs'], { cwd: root, stdio: 'inherit' });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
