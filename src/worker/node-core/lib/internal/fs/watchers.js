import { unsupported, unsupportedClass } from './_unsupported.js';

export const kFSWatchStart = Symbol('kFSWatchStart');
export const createIgnoreMatcher = unsupported('internal/fs/watchers.createIgnoreMatcher');
export const watch = unsupported('internal/fs/watchers.watch');
export const StatWatcher = unsupportedClass('internal/fs/watchers.StatWatcher');

export default {
  kFSWatchStart,
  createIgnoreMatcher,
  watch,
  StatWatcher,
};
