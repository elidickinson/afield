// The key stands in front of a shell, so the interesting questions are what it
// lets through, what it hands out, and who can read it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auth, ensureKey, keyHeaders, keyPath, loginPage } from '../../server/auth.js'

const withCookie = value => ({ headers: { cookie: value } })

test('no key lets everything through', () => {
  const auth = new Auth(undefined)
  assert.equal(auth.required, false)
  assert.ok(auth.admits({ headers: {} }))
})

test('the cookie it hands out is admitted and nothing else is', () => {
  const auth = new Auth('k3y')
  const cookie = auth.cookie({ secure: false }).split(';')[0]

  assert.ok(auth.admits(withCookie(cookie)))
  assert.ok(auth.admits(withCookie(`other=1; ${cookie}; more=2`)), 'among other cookies')
  assert.ok(!auth.admits({ headers: {} }))
  assert.ok(!auth.admits(withCookie('afield=guessed')))
})

test('dashes, spaces and capitals in a typed key don\'t count', () => {
  const auth = new Auth('abcd-2345-wxyz')
  assert.ok(auth.accepts('ABCD 2345 wxyz'))
  assert.ok(auth.accepts('abcd2345wxyz'))
  assert.ok(!auth.accepts('abcd-2345-wxy'))
})

test('a picked key with any characters signs in, and the cookie is not the key', () => {
  const auth = new Auth('Tr0ub4dor; &3 é')
  assert.ok(auth.accepts('tr0ub4dor;&3é'))
  const value = auth.cookie({ secure: false }).split(';')[0].slice('afield='.length)
  assert.match(value, /^[\w-]+$/, 'nothing a cookie cannot carry')
  assert.ok(auth.admits(withCookie(`afield=${value}`)))
})

test('the cookie is scoped so no other site can cause it to be sent', () => {
  const auth = new Auth('k3y')
  const cookie = auth.cookie({ secure: true })
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Secure/)
  assert.doesNotMatch(auth.cookie({ secure: false }), /Secure/, 'plain http would refuse it')
})

test('the key is made once, readable only by this user, and is what the CLI sends', async () => {
  const saved = process.env.XDG_CONFIG_HOME
  const root = await mkdtemp(join(tmpdir(), 'afield-key-'))
  process.env.XDG_CONFIG_HOME = root
  try {
    assert.equal(keyHeaders(), undefined)
    const key = ensureKey()
    assert.match(key, /^[2-9a-z]{4}-[2-9a-z]{4}-[2-9a-z]{4}$/)
    assert.doesNotMatch(key, /[ilou]/, 'nothing to misread')
    assert.equal(ensureKey(), key, 'a second serve reuses it')
    assert.equal((await stat(keyPath())).mode & 0o777, 0o600)
    assert.ok(new Auth(key).admits({ headers: keyHeaders() }))
    await writeFile(keyPath(), ' - \n')
    assert.throws(() => ensureKey(), /no key in it/)
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = saved
    await rm(root, { recursive: true, force: true })
  }
})

test('the sign-in page carries no client bundle', () => {
  assert.doesNotMatch(loginPage(), /<script/)
  assert.match(loginPage(), /<form method="post" action="\/login">/, 'a typed key stays out of the address')
  assert.match(loginPage(true), /That key is wrong/)
})
