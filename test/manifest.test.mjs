import assert from 'node:assert/strict';
import test from 'node:test';
import { parseManifest } from '../.tmp-test/core/manifest.js';

test('parses package identity and dependencies', () => {
  const result = parseManifest(`
[package]
org = "zed-pkg"
name = "demo"
version = "1.2.3"

[dependencies]
"zed-pkg/zed-interfaces" = "^0.1.0"
"acme/local" = { path = "../local", optional = true }
`, '/workspace/.zpkg.toml');

  assert.equal(result.identity.org, 'zed-pkg');
  assert.equal(result.identity.name, 'demo');
  assert.equal(result.dependencies.length, 2);
  assert.equal(result.dependencies[1].path, '../local');
  assert.equal(result.dependencies[1].optional, true);
  assert.equal(result.issues.length, 0);
});

test('reports missing package fields', () => {
  const result = parseManifest('[package]\nname = "demo"\n', '/workspace/.zpkg.toml');
  const codes = new Set(result.issues.map((entry) => entry.code));
  assert.ok(codes.has('manifest.org-missing'));
  assert.ok(codes.has('manifest.version-missing'));
});

test('reports malformed dependency declarations', () => {
  const result = parseManifest(`
[package]
org = "acme"
name = "demo"
version = "0.1.0"

[dependencies]
bare = { optional = true }
`, '/workspace/.zpkg.toml');

  const codes = result.issues.map((entry) => entry.code);
  assert.ok(codes.includes('manifest.dependency-invalid'));
});

test('does not treat hashes inside strings as comments', () => {
  const result = parseManifest(`
[package]
org = "acme"
name = "hash#package"
version = "0.1.0"
`, '/workspace/.zpkg.toml');
  assert.equal(result.identity.name, 'hash#package');
});
