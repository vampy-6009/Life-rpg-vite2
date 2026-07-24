/**
 * app.js — screen router + startup sequence.
 *
 * Follows the mandatory startup flow from the spec:
 *   Android launches app
 *     -> check first installation / init storage
 *     -> check permissions -> request missing (via custom screen first)
 *     -> verify database integrity
 *     -> load player profile
 *     -> open dashboard (or character creation if no profile)
 */

import * as DB from './database.js';
import * as Permissions from './permissions.js';
import { ensureTodaysQuests, completeQuestAndReward } from './quests.js';
import {
  xpProgressPercent,
  xpIntoCurrentLevel,
  xpRequiredForLevel,
  CLASSES,
  STATS,
  skillUpgradeCost,
} from './player.js';

const screens = {
  splash: document.getElementById('screen-splash'),
  permissionPrompt: document.getElementById('screen-permission-prompt'),
  characterCreation: document.getElementById('screen-character-creation'),
  home: document.getElementById('screen-home'),
  hero: document.getElementById('screen-hero'),
  quest: document.getElementById('screen-quest'),
  skills: document.getElementById('screen-skills'),
  more: document.getElementById('screen-more'),
  inventory: document.getElementById('screen-inventory'),
  achievements: document.getElementById('screen-achievements'),
  settings: document.getElementById('screen-settings'),
  repairNotice: document.getElementById('repair-toast'),
};

let selectedClass = null;
let currentPlayer = null;

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    if (!el || key === 'repairNotice') return;
    el.classList.toggle('screen--active', key === name);
  });

  // Sync every bottom-nav bar's active state to the current screen, since
  // each screen has its own copy of the nav rather than a shared layout shell.
  document.querySelectorAll('.bottom-nav__btn').forEach((btn) => {
    const isActive = btn.dataset.nav === name;
    btn.classList.toggle('bottom-nav__btn--active', isActive);
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
}

/** Wires every [data-nav] button on the page once, at startup. */
function initGlobalNavigation() {
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.dataset.nav;
      await routeTo(target);
    });
  });

  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await routeTo(btn.dataset.back);
    });
  });
}

/** Central place that (re)renders a screen's data right before showing it. */
async function routeTo(name) {
  switch (name) {
    case 'home':
      await renderHome();
      break;
    case 'hero':
      await renderHero();
      break;
    case 'quest':
      await renderQuestScreen();
      break;
    case 'skills':
      await renderSkillsScreen();
      break;
    case 'inventory':
      await renderInventoryScreen();
      break;
    case 'achievements':
      await renderAchievementsScreen();
      break;
    case 'settings':
      await renderSettingsScreen();
      break;
    default:
      break; // 'more' has no data to load
  }
  showScreen(name);
}

function showRepairToast() {
  if (!screens.repairNotice) return;
  screens.repairNotice.classList.add('toast--visible');
  setTimeout(() => screens.repairNotice.classList.remove('toast--visible'), 3500);
}

/* ---------------- Character Creation ---------------- */

function initCharacterCreationScreen() {
  const classCards = document.querySelectorAll('.class-card');
  const nameInput = document.getElementById('hero-name-input');
  const continueBtn = document.getElementById('character-continue-btn');
  const errorEl = document.getElementById('character-creation-error');

  classCards.forEach((card) => {
    card.addEventListener('click', () => {
      classCards.forEach((c) => c.classList.remove('class-card--selected'));
      card.classList.add('class-card--selected');
      selectedClass = card.dataset.classId;
      errorEl.textContent = '';
    });
  });

  continueBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      errorEl.textContent = 'Enter a hero name to continue.';
      return;
    }
    if (!selectedClass) {
      errorEl.textContent = 'Choose a class to continue.';
      return;
    }

    continueBtn.disabled = true;
    try {
      currentPlayer = await DB.createPlayer({ username: name, playerClass: selectedClass });
      await ensureTodaysQuests();
      await renderHome();
      showScreen('home');
    } catch (err) {
      console.error('Failed to create player:', err);
      errorEl.textContent = 'Could not save your hero. Please try again.';
      continueBtn.disabled = false;
    }
  });
}

/* ---------------- Home Dashboard ---------------- */

async function renderHome() {
  currentPlayer = await DB.getPlayer();
  if (!currentPlayer) return;

  const classInfo = CLASSES[currentPlayer.class] ?? { label: currentPlayer.class, icon: '⭐' };

  document.getElementById('player-name').textContent = currentPlayer.username;
  document.getElementById('player-level-line').textContent = `Level ${currentPlayer.level} ${classInfo.label}`;
  document.getElementById('player-avatar-icon').textContent = classInfo.icon;
  document.getElementById('player-coins').textContent = currentPlayer.coins;

  const pct = xpProgressPercent(currentPlayer.xp);
  document.getElementById('xp-fill').style.width = `${pct}%`;
  document.getElementById('xp-label').textContent =
    `${xpIntoCurrentLevel(currentPlayer.xp)} / ${xpRequiredForLevel()} XP`;

  await renderQuests();
}

async function renderQuests() {
  const quests = await ensureTodaysQuests();
  const container = document.getElementById('quest-list');
  container.innerHTML = '';

  quests.forEach((quest) => {
    const card = document.createElement('div');
    card.className = 'quest-card' + (quest.completed ? ' quest-card--done' : '');

    card.innerHTML = `
      <div class="quest-card__title">${escapeHtml(quest.title)}</div>
      <div class="quest-card__reward">+${quest.reward_xp} XP · +${quest.reward_coin} coins</div>
      <button class="quest-card__btn" ${quest.completed ? 'disabled' : ''}>
        ${quest.completed ? 'Completed' : 'Complete'}
      </button>
    `;

    const btn = card.querySelector('.quest-card__btn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const result = await completeQuestAndReward(quest);
        if (!result.alreadyCompleted) {
          await renderHome();
          if (result.leveledUp) {
            showLevelUpToast(result.newLevel);
          }
          const newlyUnlocked = await DB.checkAndUnlockAchievements();
          if (newlyUnlocked.length > 0) {
            showAchievementToast(newlyUnlocked[0].title);
          }
        }
      } catch (err) {
        console.error('Failed to complete quest:', err);
        btn.disabled = false;
      }
    });

    container.appendChild(card);
  });
}

/* ---------------- Hero screen ---------------- */

async function renderHero() {
  const player = await DB.getPlayer();
  if (!player) return;
  const skills = await DB.getSkills();
  const completedCount = await DB.getTotalCompletedQuestCount();
  const classInfo = CLASSES[player.class] ?? { label: player.class, icon: '⭐' };

  document.getElementById('hero-avatar-icon').textContent = classInfo.icon;
  document.getElementById('hero-name').textContent = player.username;
  document.getElementById('hero-class-line').textContent = `Level ${player.level} ${classInfo.label}`;
  document.getElementById('hero-health').textContent = player.health;
  document.getElementById('hero-energy').textContent = player.energy;
  document.getElementById('hero-quests-completed').textContent = completedCount;

  const createdDate = new Date(player.created_date);
  const daysActive = Math.max(1, Math.floor((Date.now() - createdDate.getTime()) / 86400000) + 1);
  document.getElementById('hero-days-active').textContent = daysActive;

  const attrContainer = document.getElementById('hero-attr-list');
  attrContainer.innerHTML = '';
  Object.entries(STATS).forEach(([key, meta]) => {
    const row = document.createElement('div');
    row.className = 'attr-row';
    row.innerHTML = `
      <span class="attr-row__icon" aria-hidden="true">${meta.icon}</span>
      <span class="attr-row__label">${meta.label}</span>
      <span class="attr-row__value">${skills[key] ?? 0}</span>
    `;
    attrContainer.appendChild(row);
  });
}

/* ---------------- Quest screen (full history + add custom) ---------------- */

function initQuestScreenControls() {
  const addBtn = document.getElementById('add-quest-btn');
  const form = document.getElementById('add-quest-form');
  const cancelBtn = document.getElementById('new-quest-cancel');
  const saveBtn = document.getElementById('new-quest-save');
  const titleInput = document.getElementById('new-quest-title');
  const xpInput = document.getElementById('new-quest-xp');
  const coinsInput = document.getElementById('new-quest-coins');

  addBtn.addEventListener('click', () => {
    form.classList.remove('add-quest-form--hidden');
    addBtn.classList.add('add-quest-form--hidden');
  });

  const closeForm = () => {
    form.classList.add('add-quest-form--hidden');
    addBtn.classList.remove('add-quest-form--hidden');
    titleInput.value = '';
    xpInput.value = '50';
    coinsInput.value = '10';
  };

  cancelBtn.addEventListener('click', closeForm);

  saveBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) return;
    const rewardXp = Math.max(0, parseInt(xpInput.value, 10) || 0);
    const rewardCoin = Math.max(0, parseInt(coinsInput.value, 10) || 0);

    saveBtn.disabled = true;
    try {
      await DB.addQuest({ title, description: 'Custom Quest', rewardXp, rewardCoin });
      closeForm();
      await renderQuestScreen();
    } catch (err) {
      console.error('Failed to add custom quest:', err);
    } finally {
      saveBtn.disabled = false;
    }
  });
}

async function renderQuestScreen() {
  const todays = await ensureTodaysQuests();
  const all = await DB.getAllQuests();
  const todayIds = new Set(todays.map((q) => q.quest_id));
  const history = all.filter((q) => !todayIds.has(q.quest_id));

  renderQuestCardsInto('quest-list-full', todays, true);
  renderQuestCardsInto('quest-history-list', history, false);
}

/**
 * Shared quest-card renderer used by both the Home screen's short list
 * and the full Quest screen's today/history lists. `interactive` controls
 * whether a working Complete button is attached (history entries are
 * read-only, since they're from past days).
 */
function renderQuestCardsInto(containerId, quests, interactive) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (quests.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'inventory-empty';
    empty.textContent = interactive ? 'No quests yet today.' : 'No quest history yet.';
    container.appendChild(empty);
    return;
  }

  quests.forEach((quest) => {
    const card = document.createElement('div');
    card.className = 'quest-card' + (quest.completed ? ' quest-card--done' : '');

    const dateLabel = interactive ? '' : `<div class="quest-card__reward">${escapeHtml(quest.date)}</div>`;

    card.innerHTML = `
      <div class="quest-card__title">${escapeHtml(quest.title)}</div>
      <div class="quest-card__reward">+${quest.reward_xp} XP · +${quest.reward_coin} coins</div>
      ${dateLabel}
      ${
        interactive
          ? `<button class="quest-card__btn" ${quest.completed ? 'disabled' : ''}>${
              quest.completed ? 'Completed' : 'Complete'
            }</button>`
          : `<span class="quest-card__reward">${quest.completed ? 'Completed' : 'Missed'}</span>`
      }
    `;

    if (interactive) {
      const btn = card.querySelector('.quest-card__btn');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const result = await completeQuestAndReward(quest);
          if (!result.alreadyCompleted) {
            await renderQuestScreen();
            await renderHome(); // keep Home's cached view fresh for when the user navigates back
            if (result.leveledUp) showLevelUpToast(result.newLevel);
            const newlyUnlocked = await DB.checkAndUnlockAchievements();
            if (newlyUnlocked.length > 0) showAchievementToast(newlyUnlocked[0].title);
          }
        } catch (err) {
          console.error('Failed to complete quest:', err);
          btn.disabled = false;
        }
      });
    }

    container.appendChild(card);
  });
}

/* ---------------- Skills screen ---------------- */

async function renderSkillsScreen() {
  const player = await DB.getPlayer();
  const skills = await DB.getSkills();
  document.getElementById('skills-coins').textContent = player.coins;

  const container = document.getElementById('skills-list');
  container.innerHTML = '';

  Object.entries(STATS).forEach(([key, meta]) => {
    const currentValue = skills[key] ?? 0;
    const cost = skillUpgradeCost(currentValue);
    const canAfford = player.coins >= cost;

    const card = document.createElement('div');
    card.className = 'skill-card';
    card.innerHTML = `
      <div class="skill-card__top">
        <span class="skill-card__icon" aria-hidden="true">${meta.icon}</span>
        <span class="skill-card__name">${meta.label}</span>
        <span class="skill-card__value">${currentValue}</span>
      </div>
      <button class="skill-card__btn" ${canAfford ? '' : 'disabled'}>
        ${canAfford ? `Raise for ${cost} coins` : `Need ${cost} coins`}
      </button>
    `;

    const btn = card.querySelector('.skill-card__btn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const result = await DB.spendCoinsOnSkill(key, cost);
        if (result.ok) {
          await renderSkillsScreen();
        } else {
          btn.disabled = false;
        }
      } catch (err) {
        console.error('Failed to spend coins on skill:', err);
        btn.disabled = false;
      }
    });

    container.appendChild(card);
  });
}

/* ---------------- Inventory screen ---------------- */

const RARITY_ICON = { common: '⚪', rare: '🔵', epic: '🟣' };

async function renderInventoryScreen() {
  const player = await DB.getPlayer();
  const owned = await DB.getInventory();
  const catalog = DB.getShopCatalog();

  document.getElementById('inventory-coins').textContent = player.coins;

  const ownedContainer = document.getElementById('inventory-owned-list');
  ownedContainer.innerHTML = '';
  if (owned.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'inventory-empty';
    empty.textContent = "You haven't collected any items yet.";
    ownedContainer.appendChild(empty);
  } else {
    owned.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'inventory-card';
      card.innerHTML = `
        <span class="inventory-card__icon" aria-hidden="true">${RARITY_ICON[item.rarity] ?? '⚪'}</span>
        <div class="inventory-card__info">
          <div class="inventory-card__name">${escapeHtml(item.item_name)}</div>
          <div class="inventory-card__rarity inventory-card__rarity--${item.rarity}">${item.rarity}</div>
        </div>
        <span class="inventory-card__qty">×${item.quantity}</span>
      `;
      ownedContainer.appendChild(card);
    });
  }

  const shopContainer = document.getElementById('inventory-shop-list');
  shopContainer.innerHTML = '';
  catalog.forEach((item) => {
    const canAfford = player.coins >= item.cost;
    const card = document.createElement('div');
    card.className = 'inventory-card';
    card.innerHTML = `
      <span class="inventory-card__icon" aria-hidden="true">${RARITY_ICON[item.rarity] ?? '⚪'}</span>
      <div class="inventory-card__info">
        <div class="inventory-card__name">${escapeHtml(item.name)}</div>
        <div class="inventory-card__rarity inventory-card__rarity--${item.rarity}">${item.rarity}</div>
      </div>
      <button class="inventory-card__buy-btn" ${canAfford ? '' : 'disabled'}>
        ${canAfford ? `${item.cost} 🪙` : 'Not enough'}
      </button>
    `;

    const btn = card.querySelector('.inventory-card__buy-btn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const result = await DB.buyItem(item.key);
        if (result.ok) {
          await renderInventoryScreen();
          const newlyUnlocked = await DB.checkAndUnlockAchievements();
          if (newlyUnlocked.length > 0) showAchievementToast(newlyUnlocked[0].title);
        } else {
          btn.disabled = false;
        }
      } catch (err) {
        console.error('Failed to buy item:', err);
        btn.disabled = false;
      }
    });

    shopContainer.appendChild(card);
  });
}

/* ---------------- Achievements screen ---------------- */

async function renderAchievementsScreen() {
  await DB.checkAndUnlockAchievements(); // catch anything earned since last visit
  const all = await DB.getAllAchievements();

  const container = document.getElementById('achievements-list');
  container.innerHTML = '';

  all.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'achievement-card' + (a.unlocked ? ' achievement-card--unlocked' : '');
    card.innerHTML = `
      <span class="achievement-card__icon" aria-hidden="true">${a.unlocked ? '🏆' : '🔒'}</span>
      <div class="achievement-card__info">
        <div class="achievement-card__title">${escapeHtml(a.title)}</div>
        <div class="achievement-card__desc">${escapeHtml(a.description)}</div>
      </div>
    `;
    container.appendChild(card);
  });
}

/* ---------------- Settings screen ---------------- */

function initSettingsScreenControls() {
  const soundToggle = document.getElementById('settings-sound-toggle');
  const notifToggle = document.getElementById('settings-notifications-toggle');
  const backupBtn = document.getElementById('settings-backup-btn');

  const wireToggle = (btn) => {
    btn.addEventListener('click', () => {
      const isChecked = btn.getAttribute('aria-checked') === 'true';
      btn.setAttribute('aria-checked', String(!isChecked));
      // Note: these toggles currently reflect UI state only — no
      // sound-mute or notification-suppression logic reads them yet.
      // Wiring them to actually change behavior is follow-up work,
      // not part of this screen-building pass.
    });
  };
  wireToggle(soundToggle);
  wireToggle(notifToggle);

  backupBtn.addEventListener('click', async () => {
    backupBtn.disabled = true;
    try {
      await DB.createBackupNow();
      await renderSettingsScreen();
    } finally {
      backupBtn.disabled = false;
    }
  });
}

async function renderSettingsScreen() {
  const lastBackup = await DB.getLastBackupTime();
  const statusEl = document.getElementById('settings-backup-status');
  if (lastBackup) {
    const date = new Date(lastBackup);
    statusEl.textContent = `Last backed up: ${date.toLocaleString()}`;
  } else {
    statusEl.textContent = 'No backup yet.';
  }
}

function showLevelUpToast(newLevel) {
  const toast = document.getElementById('levelup-toast');
  if (!toast) return;
  toast.querySelector('.toast__text').textContent = `Level Up! You reached Level ${newLevel}`;
  toast.classList.add('toast--visible');
  setTimeout(() => toast.classList.remove('toast--visible'), 3000);
}

function showAchievementToast(title) {
  const toast = document.getElementById('achievement-toast');
  if (!toast) return;
  toast.querySelector('.toast__text').textContent = `Achievement Unlocked: ${title}`;
  toast.classList.add('toast--visible');
  setTimeout(() => toast.classList.remove('toast--visible'), 3200);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------- Permission prompt screen ---------------- */

function initPermissionPromptScreen(onDone) {
  const continueBtn = document.getElementById('permission-continue-btn');
  continueBtn.addEventListener('click', async () => {
    continueBtn.disabled = true;
    await Permissions.requestNotificationPermission(); // denial is fine, never blocks
    await Permissions.markPermissionPromptShown();
    onDone();
  });
}

/* ---------------- Startup sequence ---------------- */

async function startup() {
  showScreen('splash');
  initCharacterCreationScreen();
  initGlobalNavigation();
  initQuestScreenControls();
  initSettingsScreenControls();

  const splashMinDuration = new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    const { repaired, hasPlayer } = await DB.initDatabase();

    await splashMinDuration; // keep splash on screen for its full 2s regardless of init speed

    const proceedToNextScreen = async () => {
      if (repaired) showRepairToast();

      if (hasPlayer) {
        await ensureTodaysQuests();
        await renderHome();
        showScreen('home');
      } else {
        showScreen('characterCreation');
      }
    };

    const alreadyPrompted = await Permissions.hasShownPermissionPrompt();
    if (alreadyPrompted) {
      await proceedToNextScreen();
    } else {
      initPermissionPromptScreen(proceedToNextScreen);
      showScreen('permissionPrompt');
    }
  } catch (err) {
    // Startup must never leave the user on a blank/frozen splash screen.
    console.error('Startup sequence failed:', err);
    await splashMinDuration;
    showScreen('characterCreation');
  }
}

document.addEventListener('DOMContentLoaded', startup);
