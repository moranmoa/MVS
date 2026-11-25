import { shot, chat } from './lib.mjs';

export default async function run() {
  // ---- member relays, slice 1 (410-419, #368) ---------------------------------
  for (const [query, name, step] of [
    ['lang=he&theme=light', '410-member-relay-on-he', 'privacy'],
    ['lang=he&theme=light&memberRelay=minor', '411-member-relay-minor-he', 'privacy'],
    ['lang=he&theme=light&relayOnly=1', '412-member-relay-relay-only-he', 'privacy'],
    ['lang=he&theme=light&memberRelayUnseen=1', '413-member-relay-disclosure-he', 'disclosure'],
    ['lang=en&theme=dark&memberRelayUnseen=1', '414-member-relay-disclosure-en-dark', 'disclosure'],
  ]) {
    const p = await chat(`?demo=1&still=1&update=999999&${query}`, 'x', query.includes('dark') ? { colorScheme: 'dark' } : undefined);
    if (step === 'privacy') {
      await p.getByRole('button', { name: 'הגדרות' }).first().click();
      await p.getByRole('button', { name: 'פרטיות' }).click();
      await p.locator('.member-relay').waitFor();
    } else {
      await p.locator('.member-relay-disclosure').waitFor();
    }
    await p.waitForTimeout(250);
    await shot(p, name);
    await p.close();
  }
}
