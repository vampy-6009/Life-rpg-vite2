# Life RPG (Vite + Capacitor)

## What was actually broken

The previous `www/`-only version had no build step, but `database.js` and
`permissions.js` used bare package imports:

```js
import { Preferences } from '@capacitor/preferences';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
```

A browser (or Android WebView) has no way to resolve `@capacitor/preferences`
to an actual file — that only works when a bundler rewrites it into a real
relative path (or inlines the code) at build time. With no bundler, that
import fails at parse time, `app.js` (which imports `database.js`) never
finishes loading, and the WebView never gets a working page to render —
consistent with the hard `ERR_CONNECTION_REFUSED` rather than a blank page
or 404.

The earlier `strings.xml` / `custom_url_scheme` fix was a real, separate bug
and worth keeping fixed, but it was never going to produce a working app on
its own while this import problem also existed.

## The fix

This project adds Vite as an actual build step:

- Source lives in `src/js/` and `src/css/`, referenced from `index.html`
  via `/src/...` paths.
- `npm run build` runs `vite build`, which resolves every `@capacitor/*`
  import against `node_modules` and bundles it into `dist/`.
- `capacitor.config.json`'s `webDir` now points at `dist`, not raw `www`/`src`.
- **No game logic changed.** `app.js`, `database.js`, `player.js`,
  `quests.js`, `permissions.js` are byte-identical to what you already had —
  verified with `diff` before packaging this. Only their location and how
  they get loaded changed.

## Setup

```bash
npm install
npm run build          # produces dist/ — do this before cap add/sync
npx cap add android
npx cap sync android
```

Confirm the build actually bundled the imports:

```bash
grep -r "@capacitor/preferences" dist/
```

This should find nothing in `dist/assets/*.js` as a literal import
statement — Vite will have inlined the package's real code instead. If you
still see a literal `import ... from '@capacitor/preferences'` string in the
built output, the build didn't run correctly and Capacitor would hit the
same failure as before.

Then also re-check the thing that broke last time:

```bash
cat android/app/src/main/res/values/strings.xml
```

`custom_url_scheme` should read `capacitor`. Since this is a clean
`cap add android` with no hand-edits, it should generate correctly.

## Build order matters

`npm run build` must run **before** `npx cap sync android`, every time you
change source — sync only copies whatever is currently sitting in `dist/`.
The `npm run sync` and `npm run android` scripts in `package.json` already
chain these in the right order for you.

## What I could not verify here

I don't have network access in this sandbox, so I could not run
`npm install` or `vite build` myself. What I did verify:
- Every `src/js/*.js` file passes `node --check` (no syntax errors).
- Every game-logic file is byte-identical to your previous version —
  diffed directly, not just eyeballed.
- `index.html`'s stylesheet/script paths were updated to match the new
  `src/` layout Vite expects.

Please run `npm install && npm run build` on your machine and tell me the
exact output/error if anything fails — especially the `grep` check above,
since that's the one that actually confirms the root-cause fix worked.

---

## Update: app icon + all remaining screens added

Everything above this line describes the Vite rebuild and is still
accurate for that specific fix. Since then, this project has grown a lot
— worth a fresh accounting rather than pretending "no game logic
changed" still holds; it doesn't anymore, and here's exactly what does.

### App icon

Custom SVG icon (sword/level-up motif, app's own purple/cyan/gold
palette) — not the circular badge image you uploaded separately, for two
reasons: unclear licensing on that image, and separately, dense circular
badge art doesn't survive scaling to real launcher sizes (same lesson
learned the hard way below).

The first version of this icon was too thin/detailed and tested
illegible at 48px — I actually rendered it (via `wkhtmltoimage`, since
this sandbox has no true SVG-to-PNG tool) rather than assuming it looked
fine, caught the problem, and rebuilt it bolder before shipping. See
`android-icon-resources/README.md` for the full story and exact copy
instructions — short version:

```bash
cp -r android-icon-resources/* android/app/src/main/res/
```

Run this after `cap add android` (not before — it'd get overwritten).

### New screens: Hero, Quest, Skills, Inventory, Achievements, Settings

All six previously-disabled nav buttons are now live and route correctly.

- **Hero** — read-only summary: avatar, name, level/class, health/energy,
  the four attributes, total quests completed, days since character
  creation.
- **Quest** — the full quest system: today's list (same as Home's, kept
  in sync), a history section for past days, and a working "+ Add a
  quest" form for custom quests with your own XP/coin rewards.
- **Skills** — spend coins directly to raise Strength / Intelligence /
  Discipline / Creativity by 1 point each. Cost starts at 10 coins and
  goes up by 5 for every point already in that stat (10, 15, 20, 25...)
  — this curve isn't from your spec, I picked it as a simple, readable
  progression; easy to change if you want something steeper or flatter.
- **Inventory** — a real coin shop. Four items seeded (Health Potion,
  Energy Elixir, Lucky Charm, Dragon Scale) at increasing cost/rarity —
  again, a starting set I chose, not from your spec, swap freely. Owned
  items show with quantity; shop section shows what's still buyable.
- **Achievements** — six unlocked automatically based on real state:
  First Steps (1 quest), Quest Apprentice (10), Quest Veteran (50),
  Rising Hero (level 5), Seasoned Adventurer (level 10), Shopper (first
  purchase). You asked me to define this list since you hadn't given one
  — change titles/thresholds/add more anytime, they're all in one place
  (`ACHIEVEMENT_DEFINITIONS` in `database.js`).
- **Settings** — sound/notification toggles (UI-only right now — flip
  visually but nothing reads them yet to actually mute anything; that's
  real follow-up work, not done) and a manual "Back up now" button
  showing last-backup time.

### Data layer additions

`database.js` gained: `inventory` and `achievement` SQLite tables (both
included in JSON backup/restore), `spendCoinsOnSkill`, `buyItem`,
`checkAndUnlockAchievements`, `getTotalCompletedQuestCount`. All follow
the same "return `{ ok: false, reason }` instead of throwing" pattern as
the rest of the file for expected failure cases like insufficient coins.

`player.js` gained `STATS` (icon/label per attribute) and
`skillUpgradeCost()`.

### Verification performed this pass

Same constraint as before — no network in this sandbox, confirmed again
just now, so `npm install`/`vite build` are still yours to run. What I
did check, all programmatically rather than by eye:

- Every `.js` file passes `node --check` — no syntax errors.
- Every `getElementById` call in `app.js` (50 total) resolves to a real
  id in `index.html` — cross-referenced with a script, not manually.
- Every `data-nav`/`data-back` value in the HTML has a matching route in
  `app.js`'s screen registry and `routeTo()` switch.
- Every `DB.*` call from `app.js` (15 total) resolves to a real export in
  `database.js` — also cross-referenced with a script.
- HTML tags and CSS braces balanced (section/div/button/nav counts, brace
  counts) after every major edit, not just at the end.
- Caught and fixed one real bug during this process: `initGlobalNavigation`,
  `initQuestScreenControls`, and `initSettingsScreenControls` were all
  defined but never called from `startup()` — nav buttons and the add-quest
  form would have been inert. Fixed before packaging, not left for you to
  find.

What I still can't verify without your build: whether it actually
compiles, whether SQLite migrations apply cleanly on top of your existing
Vampy save data (schema additions use `CREATE TABLE IF NOT EXISTS`, which
should be safe, but "should be" isn't "verified"), and how it all looks
on an actual device.

