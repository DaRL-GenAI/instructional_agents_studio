// fs/backend.js — the storage backend in use: the project folder through the local server, or IndexedDB.
import { LOCAL } from './api.js';
import { idbBackend } from './backend-idb.js';
import { folderBackend } from './backend-folder.js';

export const backend = LOCAL ? folderBackend : idbBackend;
