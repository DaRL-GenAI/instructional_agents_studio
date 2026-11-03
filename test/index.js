// index.js — lets `node --test test/` run the whole suite (Node treats the directory argument as a module path).
import './serialize.test.mjs';
import './projects.test.mjs';
import './http.test.mjs';
import './agents.test.mjs';
import './cli.test.mjs';
import './editor.test.mjs';
