import { createContext } from 'react';
import type { NIndexedDB } from '@nostrify/indexeddb';

/**
 * The app-wide IndexedDB event store.
 *
 * Its connection may still be opening — `NIndexedDB` is constructed
 * synchronously and opens in the background — but every method awaits the
 * connection internally, so consumers can call it straight away without
 * awaiting anything first.
 */
export type NostrStorageContextType = NIndexedDB;

export const NostrStorageContext = createContext<NostrStorageContextType | null>(null);
