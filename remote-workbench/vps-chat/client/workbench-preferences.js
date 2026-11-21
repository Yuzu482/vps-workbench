import { validTurnMetadata } from './composer-controls.js';
import { workbenchStorage } from './workbench-storage.js';

const preferenceKey = 'dsh-vps-chat:workbench:v1';

export const accentOptions = [
  { id: 'tool', label: '跟随执行端' },
  { id: 'blue', label: '海蓝', light: '#26619d', dark: '#9cc9ff', ink: '#173051' },
  { id: 'green', label: '苔绿', light: '#286853', dark: '#94d5b9', ink: '#15352a' },
  { id: 'violet', label: '梅紫', light: '#76438c', dark: '#d5afea', ink: '#372048' },
  { id: 'amber', label: '琥珀', light: '#8a4f25', dark: '#efbd91', ink: '#3d2817' },
  { id: 'neutral', label: '墨灰', light: '#47505d', dark: '#c2cad5', ink: '#262b33' },
];

export const preferenceOptions = {
  color: [['host', '跟随 DSH'], ['light', '浅色'], ['dark', '深色']],
  accent: accentOptions.map(({ id, label }) => [id, label]),
  textSize: [['standard', '标准'], ['large', '较大'], ['largest', '最大']],
  width: [['standard', '标准'], ['wide', '宽屏']],
  sendKey: [['enter', 'Enter'], ['ctrl-enter', 'Ctrl+Enter']],
  motion: [['system', '跟随系统'], ['reduce', '减少动画']],
};

export const defaultPreferences = Object.fromEntries(Object.entries(preferenceOptions)
  .map(([key, [[value]]]) => [key, value]));

function storageRead(key) {
  try {
    return JSON.parse(workbenchStorage.getItem(key));
  } catch {
    return null;
  }
}

function choices(value) {
  return Object.fromEntries(Object.entries(preferenceOptions)
    .filter(([key, options]) => options.some(([id]) => id === value?.[key]))
    .map(([key]) => [key, value[key]]));
}

function sanitizedProfiles(profiles, tools) {
  const entries = [];
  for (const id of tools) {
    const profile = profiles?.[id];
    const clean = choices(profile);
    const model = profile?.model;
    if (typeof model?.id === 'string' && typeof model.targetId === 'string' && /^[a-f0-9]{64}$/.test(model.targetId) &&
        validTurnMetadata({ model: model.id, effort: model.effort })) {
      clean.model = { id: model.id, targetId: model.targetId, ...(model.effort ? { effort: model.effort } : {}) };
    }
    if (Object.keys(clean).length) entries.push([id, clean]);
  }
  return Object.fromEntries(entries);
}

export function readPreferences() {
  return { ...defaultPreferences, ...choices(storageRead(preferenceKey)) };
}

export function writePreferences(preferences) {
  workbenchStorage.setItem(preferenceKey, JSON.stringify(preferences));
}

export function readToolProfiles(key, tools) {
  return key ? sanitizedProfiles(storageRead(`${key}:workbench`), tools) : {};
}

export function writeToolProfiles(key, profiles, tools) {
  const clean = sanitizedProfiles(profiles, tools);
  workbenchStorage.setItem(`${key}:workbench`, JSON.stringify(clean));
  return clean;
}
