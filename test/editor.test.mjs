// Editor package: download, sha-256 check, unpack into the cache, found afterwards; a bad checksum installs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from './helpers.mjs';

delete process.env.IA_EDITOR_DIR;
process.env.IA_CACHE_DIR = tmpdir('ia-cache-');
const { installEditor, findEditor } = await import('../server/editor-pkg.mjs');

test('install a verified editor package into the cache', async () => {
  const work = tmpdir(); const ed = path.join(work, 'editor-trim');
  fs.mkdirSync(path.join(ed, 'sdkjs/slide'), { recursive: true });
  fs.writeFileSync(path.join(ed, 'editor.html'), '<!doctype html>'); fs.writeFileSync(path.join(ed, 'sdkjs/slide/sdk-all.js'), '// sdk');
  execFileSync('tar', ['-czf', path.join(work, 'ed.tar.gz'), '-C', work, 'editor-trim']);
  const buf = fs.readFileSync(path.join(work, 'ed.tar.gz')); const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const srv = http.createServer((q, r) => { r.writeHead(200); r.end(buf); }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/ed.tar.gz`;
  try {
    assert.equal(findEditor(), null);
    await assert.rejects(installEditor({ url, sha256: '0'.repeat(64), version: 'v1' }), /Checksum mismatch/);
    assert.equal(findEditor(), null, 'nothing installed after a bad checksum');
    const got = await installEditor({ url, sha256: sha, version: 'v1' });
    assert.equal(got.version, 'v1'); assert.equal(fs.readFileSync(path.join(got.dir, 'sdkjs/slide/sdk-all.js'), 'utf8'), '// sdk');
  } finally { srv.close(); }
});
