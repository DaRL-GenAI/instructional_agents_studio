// What a new user runs into: commits under their own git name, a LaTeX file or loose notes in an opened folder,
// font stand-ins of the trimmed editor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';
import { gitUser } from '../server/vcs.mjs';
import { ruleClassify } from '../js/import/classify.js';

test('git identity from a config file: [user] name / email, comments and quotes', () => {
  const f = path.join(tmpdir(), 'gitconfig');
  fs.writeFileSync(f, '[core]\n\tname = not-me\n[user]\n\tname = "Ada Lovelace" ; comment\n\temail = ada@example.edu\n[alias]\n\tst = status\n');
  assert.deepEqual(gitUser(f), { name: 'Ada Lovelace', email: 'ada@example.edu' });
  assert.deepEqual(gitUser(path.join(tmpdir(), 'missing')), {});
});

test('opening a folder: LaTeX stays LaTeX, loose notes are not a chapter, numbered notes are a script', () => {
  assert.equal(ruleClassify('hw/hw2.tex', '\\section{Homework 2}').kind, 'reference');
  assert.equal(ruleClassify('notes.md', '# Notes').kind, 'reference');
  const s = ruleClassify('week3_notes.md', '# Week 3'); assert.equal(s.kind, 'script'); assert.equal(s.chapterNo, 3);
  assert.equal(ruleClassify('lecture01_transcript.md', '').kind, 'script');
});
