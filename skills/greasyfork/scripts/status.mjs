// Print which of your scripts Greasy Fork has set up to sync (from webhook-info).
// Requires login (ego-browser task space).
import { ego, ensureLoggedIn } from './lib.mjs';

await ensureLoggedIn();
const txt = await ego(`
  await gotoAndWait(GF + '/en/users/webhook-info', { timeout: 60 });
  emit(await js(String.raw\`(() => {
    const t = document.body.innerText;
    const i = t.indexOf('already set up to sync');
    return i >= 0 ? t.slice(i, i + 1200) : '(no "set up to sync" listing found)';
  })()\`));
`);
console.log(txt);
