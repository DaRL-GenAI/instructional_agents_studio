import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../server/security.mjs';

test('extra hosts are opt-in, https-only, and still need the token', () => {
  const req = (host, origin) => ({ headers: { host, ...(origin ? { origin } : {}) } });
  const plain = createGuard({ token: 't', port: 9 });
  assert.deepEqual(plain.checkHost(req('demo.example.ms')), [421, 'Unknown host']);
  const g = createGuard({ token: 't', port: 9, allowHosts: ['Demo.Example.ms'] });
  assert.equal(g.checkHost(req('demo.example.ms')), null);
  assert.equal(g.checkOrigin(req('demo.example.ms', 'https://demo.example.ms')), null);
  assert.deepEqual(g.checkOrigin(req('demo.example.ms', 'http://demo.example.ms')), [403, 'Cross-origin request refused']);
  assert.deepEqual(g.checkHost(req('evil.example')), [421, 'Unknown host']);
  assert.equal(g.authed(req('demo.example.ms')), false);
});
