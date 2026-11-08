// Publishes dist/ as the only content of the gh-pages branch (GitHub Pages: Deploy from a branch).
import { execSync } from 'child_process';
import { existsSync, rmSync, writeFileSync } from 'fs';

if (!existsSync('dist/index.html')) throw new Error('dist/ is empty — run npm run build first');

const remote = execSync('git remote get-url origin').toString().trim();
const sha = execSync('git rev-parse --short HEAD').toString().trim();
const sh = (cmd) => execSync(cmd, { cwd: 'dist', stdio: 'inherit' });

writeFileSync('dist/.nojekyll', ''); // serve files as-is
rmSync('dist/.git', { recursive: true, force: true });
sh('git init -q -b gh-pages');
sh('git add -A');
sh(`git commit -q -m "Deploy redeem page from ${sha}"`);
sh(`git push -q -f ${remote} gh-pages`);
rmSync('dist/.git', { recursive: true, force: true });
console.log(`Published to ${remote} (gh-pages). The page updates in 1-2 minutes.`);
