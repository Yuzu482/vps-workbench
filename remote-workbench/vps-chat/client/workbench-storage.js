let storageOverride;

export function setWorkbenchStorage(storage) {
  storageOverride = storage;
}

export const workbenchStorage = {
  getItem(key) {
    return (storageOverride ?? globalThis.localStorage).getItem(key);
  },
  setItem(key, value) {
    (storageOverride ?? globalThis.localStorage).setItem(key, value);
  },
  removeItem(key) {
    (storageOverride ?? globalThis.localStorage).removeItem(key);
  },
};
