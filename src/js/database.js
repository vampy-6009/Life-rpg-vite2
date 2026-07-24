/**
 * database.js — SQLite (Capacitor Community plugin) as the primary store,
 * with a JSON backup layer for corruption recovery.
 *
 * Persistence strategy (per spec):
 *   - SQLite is the source of truth during normal operation.
 *   - After every meaningful write (quest complete, level up, class change),
 *     we also export a JSON snapshot to Capacitor Preferences as a backup.
 *   - On startup, we try to open/read the SQLite DB. If that fails or the
 *     player table is empty/corrupt, we fall back to the last JSON backup
 *     and rebuild the DB from it, then tell the caller a repair happened
 *     so the UI can show "Your adventure data was repaired."
 *
 * NOTE ON THE ORIGINAL SPEC: it asked for BOTH "Room Database" (native
 * Java) and "Capacitor SQLite plugin" (JS-callable). Those are two
 * separate, incompatible persistence stacks — Room has no bridge to a
 * Capacitor webview. Since the whole UI here is HTML/CSS/JS running in
 * Capacitor, only the Capacitor SQLite plugin actually makes sense; Room
 * would require rewriting the UI as native Android views, which
 * contradicts the "no heavy assets / lightweight JS app" goal. This file
 * implements the SQLite-plugin + JSON-backup hybrid you chose.
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Preferences } from '@capacitor/preferences';

const DB_NAME = 'liferpg_database';
const BACKUP_KEY = 'liferpg_json_backup';
const BACKUP_META_KEY = 'liferpg_json_backup_meta';

const sqliteConnection = new SQLiteConnection(CapacitorSQLite);

let db = null;
let didRepairThisSession = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS player (
  player_id INTEGER PRIMARY KEY CHECK (player_id = 1),
  username TEXT NOT NULL,
  class TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  coins INTEGER NOT NULL DEFAULT 0,
  health INTEGER NOT NULL DEFAULT 100,
  energy INTEGER NOT NULL DEFAULT 100,
  created_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quest (
  quest_id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  reward_xp INTEGER NOT NULL DEFAULT 0,
  reward_coin INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  skill_id INTEGER PRIMARY KEY CHECK (skill_id = 1),
  strength INTEGER NOT NULL DEFAULT 0,
  intelligence INTEGER NOT NULL DEFAULT 0,
  discipline INTEGER NOT NULL DEFAULT 0,
  creativity INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_key TEXT NOT NULL UNIQUE,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  rarity TEXT NOT NULL DEFAULT 'common'
);

CREATE TABLE IF NOT EXISTS achievement (
  achievement_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  unlocked INTEGER NOT NULL DEFAULT 0,
  unlocked_date TEXT
);
`;

/** Opens (creating if needed) the SQLite connection and applies schema. */
async function openDatabase() {
  const isConn = (await sqliteConnection.isConnection(DB_NAME, false)).result;
  if (isConn) {
    db = await sqliteConnection.retrieveConnection(DB_NAME, false);
  } else {
    db = await sqliteConnection.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  }
  await db.open();
  await db.execute(SCHEMA);
  return db;
}

/** Basic integrity check: DB opens, schema present, player row is readable. */
async function verifyIntegrity() {
  try {
    const result = await db.query('SELECT * FROM player WHERE player_id = 1;');
    return { ok: true, hasPlayer: (result.values?.length ?? 0) > 0 };
  } catch (err) {
    console.warn('Integrity check failed:', err);
    return { ok: false, hasPlayer: false };
  }
}

async function writeJsonBackup() {
  try {
    const player = await getPlayer();
    const quests = await getAllQuests();
    const skills = await getSkills();
    const inventory = await getInventory();
    const achievements = await getAllAchievements();
    const payload = { player, quests, skills, inventory, achievements, savedAt: new Date().toISOString() };
    await Preferences.set({ key: BACKUP_KEY, value: JSON.stringify(payload) });
    await Preferences.set({ key: BACKUP_META_KEY, value: payload.savedAt });
  } catch (err) {
    // A failed backup must never block the primary write that triggered it.
    console.warn('Failed to write JSON backup:', err);
  }
}

async function readJsonBackup() {
  try {
    const { value } = await Preferences.get({ key: BACKUP_KEY });
    if (!value) return null;
    return JSON.parse(value);
  } catch (err) {
    console.warn('Failed to read JSON backup:', err);
    return null;
  }
}

async function restoreFromBackup(backup) {
  if (!backup?.player) return false;
  const p = backup.player;
  await db.run(
    `INSERT OR REPLACE INTO player
      (player_id, username, class, level, xp, coins, health, energy, created_date)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [p.username, p.class, p.level, p.xp, p.coins, p.health, p.energy, p.created_date]
  );

  if (backup.skills) {
    const s = backup.skills;
    await db.run(
      `INSERT OR REPLACE INTO skills (skill_id, strength, intelligence, discipline, creativity)
       VALUES (1, ?, ?, ?, ?);`,
      [s.strength, s.intelligence, s.discipline, s.creativity]
    );
  }

  if (Array.isArray(backup.quests)) {
    for (const q of backup.quests) {
      await db.run(
        `INSERT INTO quest (title, description, reward_xp, reward_coin, completed, date)
         VALUES (?, ?, ?, ?, ?, ?);`,
        [q.title, q.description, q.reward_xp, q.reward_coin, q.completed, q.date]
      );
    }
  }

  if (Array.isArray(backup.inventory)) {
    for (const item of backup.inventory) {
      await db.run(
        `INSERT OR REPLACE INTO inventory (item_key, item_name, quantity, rarity)
         VALUES (?, ?, ?, ?);`,
        [item.item_key, item.item_name, item.quantity, item.rarity]
      );
    }
  }

  if (Array.isArray(backup.achievements)) {
    for (const a of backup.achievements) {
      await db.run(
        `INSERT OR REPLACE INTO achievement (achievement_key, title, description, unlocked, unlocked_date)
         VALUES (?, ?, ?, ?, ?);`,
        [a.achievement_key, a.title, a.description, a.unlocked, a.unlocked_date]
      );
    }
  }
  return true;
}

/**
 * Call once on app startup.
 * Returns { repaired: boolean, hasPlayer: boolean } so the caller can
 * decide whether to show character creation or the dashboard, and
 * whether to show the "data was repaired" message.
 */
export async function initDatabase() {
  await openDatabase();
  const integrity = await verifyIntegrity();

  if (!integrity.ok) {
    // DB itself is unreadable/corrupt — rebuild schema and try backup restore.
    console.warn('Database corruption detected — attempting restore from backup.');
    try {
      await db.close();
    } catch (_) {
      /* ignore close errors on an already-broken connection */
    }
    await sqliteConnection.closeConnection(DB_NAME, false).catch(() => {});
    await openDatabase();

    const backup = await readJsonBackup();
    if (backup) {
      await restoreFromBackup(backup);
      await ensureAchievementRows();
      didRepairThisSession = true;
      return { repaired: true, hasPlayer: true };
    }
    await ensureAchievementRows();
    return { repaired: true, hasPlayer: false };
  }

  if (!integrity.hasPlayer) {
    // Fresh install or player table empty — check if a backup exists anyway
    // (e.g. app data partially cleared but Preferences survived).
    const backup = await readJsonBackup();
    if (backup?.player) {
      await restoreFromBackup(backup);
      await ensureAchievementRows();
      didRepairThisSession = true;
      return { repaired: true, hasPlayer: true };
    }
    await ensureAchievementRows();
    return { repaired: false, hasPlayer: false };
  }

  await ensureAchievementRows();
  return { repaired: false, hasPlayer: true };
}

export function wasRepairedThisSession() {
  return didRepairThisSession;
}

/* ---------------- Player ---------------- */

export async function createPlayer({ username, playerClass }) {
  const created = new Date().toISOString();
  await db.run(
    `INSERT OR REPLACE INTO player
      (player_id, username, class, level, xp, coins, health, energy, created_date)
     VALUES (1, ?, ?, 1, 0, 0, 100, 100, ?);`,
    [username, playerClass, created]
  );
  await db.run(
    `INSERT OR REPLACE INTO skills (skill_id, strength, intelligence, discipline, creativity)
     VALUES (1, 0, 0, 0, 0);`
  );
  await writeJsonBackup();
  return getPlayer();
}

export async function getPlayer() {
  const result = await db.query('SELECT * FROM player WHERE player_id = 1;');
  return result.values?.[0] ?? null;
}

export async function updatePlayer(fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getPlayer();
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  await db.run(`UPDATE player SET ${setClause} WHERE player_id = 1;`, values);
  await writeJsonBackup();
  return getPlayer();
}

/* ---------------- Skills ---------------- */

export async function getSkills() {
  const result = await db.query('SELECT * FROM skills WHERE skill_id = 1;');
  return result.values?.[0] ?? { strength: 0, intelligence: 0, discipline: 0, creativity: 0 };
}

export async function addSkillPoints(deltas) {
  const current = await getSkills();
  const next = {
    strength: current.strength + (deltas.strength ?? 0),
    intelligence: current.intelligence + (deltas.intelligence ?? 0),
    discipline: current.discipline + (deltas.discipline ?? 0),
    creativity: current.creativity + (deltas.creativity ?? 0),
  };
  await db.run(
    `UPDATE skills SET strength = ?, intelligence = ?, discipline = ?, creativity = ? WHERE skill_id = 1;`,
    [next.strength, next.intelligence, next.discipline, next.creativity]
  );
  await writeJsonBackup();
  return next;
}

/**
 * Atomically spends coins to raise one stat by 1 point. Returns
 * { ok: false, reason: 'insufficient_coins' } rather than throwing when
 * the player can't afford it — this is an expected, common outcome, not
 * an error condition.
 */
export async function spendCoinsOnSkill(statKey, cost) {
  const player = await getPlayer();
  if (!player || player.coins < cost) {
    return { ok: false, reason: 'insufficient_coins' };
  }
  await db.run(`UPDATE player SET coins = coins - ? WHERE player_id = 1;`, [cost]);
  const updatedSkills = await addSkillPoints({ [statKey]: 1 });
  await writeJsonBackup();
  return { ok: true, skills: updatedSkills, remainingCoins: player.coins - cost };
}

/* ---------------- Quests ---------------- */

export async function getAllQuests() {
  const result = await db.query('SELECT * FROM quest ORDER BY quest_id DESC;');
  return result.values ?? [];
}

export async function getTodaysQuests() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await db.query('SELECT * FROM quest WHERE date = ? ORDER BY quest_id ASC;', [today]);
  return result.values ?? [];
}

export async function addQuest({ title, description, rewardXp, rewardCoin }) {
  const today = new Date().toISOString().slice(0, 10);
  await db.run(
    `INSERT INTO quest (title, description, reward_xp, reward_coin, completed, date)
     VALUES (?, ?, ?, ?, 0, ?);`,
    [title, description ?? '', rewardXp, rewardCoin, today]
  );
  await writeJsonBackup();
  return getTodaysQuests();
}

export async function completeQuest(questId) {
  await db.run(`UPDATE quest SET completed = 1 WHERE quest_id = ?;`, [questId]);
  await writeJsonBackup();
}

/** Total quests ever completed, across all days — used for achievement triggers. */
export async function getTotalCompletedQuestCount() {
  const result = await db.query('SELECT COUNT(*) as count FROM quest WHERE completed = 1;');
  return result.values?.[0]?.count ?? 0;
}

/* ---------------- Inventory ---------------- */

const SHOP_ITEMS = {
  health_potion: { name: 'Health Potion', rarity: 'common', cost: 15 },
  energy_elixir: { name: 'Energy Elixir', rarity: 'common', cost: 15 },
  lucky_charm: { name: 'Lucky Charm', rarity: 'rare', cost: 40 },
  dragon_scale: { name: 'Dragon Scale', rarity: 'epic', cost: 100 },
};

export function getShopCatalog() {
  return Object.entries(SHOP_ITEMS).map(([key, item]) => ({ key, ...item }));
}

export async function getInventory() {
  const result = await db.query('SELECT * FROM inventory ORDER BY item_id ASC;');
  return result.values ?? [];
}

/**
 * Buys one unit of a shop item. Returns { ok: false, reason } instead of
 * throwing on a normal "can't afford it" outcome, same pattern as
 * spendCoinsOnSkill.
 */
export async function buyItem(itemKey) {
  const item = SHOP_ITEMS[itemKey];
  if (!item) return { ok: false, reason: 'unknown_item' };

  const player = await getPlayer();
  if (!player || player.coins < item.cost) {
    return { ok: false, reason: 'insufficient_coins' };
  }

  await db.run(`UPDATE player SET coins = coins - ? WHERE player_id = 1;`, [item.cost]);
  await db.run(
    `INSERT INTO inventory (item_key, item_name, quantity, rarity)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(item_key) DO UPDATE SET quantity = quantity + 1;`,
    [itemKey, item.name, item.rarity]
  );
  await writeJsonBackup();
  return { ok: true, remainingCoins: player.coins - item.cost };
}

/* ---------------- Achievements ---------------- */

const ACHIEVEMENT_DEFINITIONS = [
  { key: 'first_steps', title: 'First Steps', description: 'Complete your first quest.' },
  { key: 'quest_apprentice', title: 'Quest Apprentice', description: 'Complete 10 quests.' },
  { key: 'quest_veteran', title: 'Quest Veteran', description: 'Complete 50 quests.' },
  { key: 'level_5', title: 'Rising Hero', description: 'Reach Level 5.' },
  { key: 'level_10', title: 'Seasoned Adventurer', description: 'Reach Level 10.' },
  { key: 'first_purchase', title: 'Shopper', description: 'Buy your first item.' },
];

/** Ensures all known achievement definitions exist as rows (unlocked or not). */
export async function ensureAchievementRows() {
  for (const def of ACHIEVEMENT_DEFINITIONS) {
    await db.run(
      `INSERT OR IGNORE INTO achievement (achievement_key, title, description, unlocked, unlocked_date)
       VALUES (?, ?, ?, 0, NULL);`,
      [def.key, def.title, def.description]
    );
  }
}

export async function getAllAchievements() {
  const result = await db.query('SELECT * FROM achievement ORDER BY rowid ASC;');
  return result.values ?? [];
}

/**
 * Checks current player/quest state against achievement conditions and
 * unlocks any newly-earned ones. Returns the list of achievements newly
 * unlocked this call (empty if none), so the UI can show a toast.
 */
export async function checkAndUnlockAchievements() {
  const player = await getPlayer();
  const completedCount = await getTotalCompletedQuestCount();
  const inventory = await getInventory();
  const all = await getAllAchievements();
  const already = new Set(all.filter((a) => a.unlocked).map((a) => a.achievement_key));
  const newlyUnlocked = [];

  const conditions = {
    first_steps: completedCount >= 1,
    quest_apprentice: completedCount >= 10,
    quest_veteran: completedCount >= 50,
    level_5: (player?.level ?? 1) >= 5,
    level_10: (player?.level ?? 1) >= 10,
    first_purchase: inventory.some((i) => i.quantity > 0),
  };

  for (const def of ACHIEVEMENT_DEFINITIONS) {
    if (already.has(def.key)) continue;
    if (conditions[def.key]) {
      await db.run(
        `UPDATE achievement SET unlocked = 1, unlocked_date = ? WHERE achievement_key = ?;`,
        [new Date().toISOString(), def.key]
      );
      newlyUnlocked.push(def);
    }
  }

  if (newlyUnlocked.length > 0) {
    await writeJsonBackup();
  }
  return newlyUnlocked;
}

/* ---------------- Manual backup controls (exposed for Settings later) ---------------- */

export async function createBackupNow() {
  await writeJsonBackup();
}

export async function getLastBackupTime() {
  const { value } = await Preferences.get({ key: BACKUP_META_KEY });
  return value ?? null;
}
