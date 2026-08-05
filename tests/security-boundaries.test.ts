import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { isAllowedExternalUrl, resolveDirectChild } from '../src/main/security-boundaries.ts'

test('resolveDirectChild accepts a direct package or map name', () => {
  const root = resolve('C:\\BrokenNetLib\\mental-omega\\packages')
  assert.equal(resolveDirectChild(root, 'MentalOmega'), join(root, 'MentalOmega'))
  assert.equal(resolveDirectChild(root, '中文地图 (2)'), join(root, '中文地图 (2)'))
})

test('resolveDirectChild rejects paths outside or below the library root', () => {
  for (const name of ['', '.', '..', '../outside', '..\\outside', 'nested/item', 'nested\\item', 'C:\\Windows']) {
    assert.throws(() => resolveDirectChild('C:\\BrokenNetLib\\maps', name), /无效|超出/)
  }
})

test('external URLs are limited to HTTP and HTTPS', () => {
  assert.equal(isAllowedExternalUrl('https://cncnet.org/'), true)
  assert.equal(isAllowedExternalUrl('http://example.test/path'), true)
  assert.equal(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe'), false)
  assert.equal(isAllowedExternalUrl('mailto:test@example.com'), false)
  assert.equal(isAllowedExternalUrl('not a url'), false)
})
