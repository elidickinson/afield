// The key is only worth anything if the cookie it becomes reaches the
// WebSocket handshake, which is the thing basic auth cannot do.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './helpers.js'

test.use({ signIn: true })

test('the terminal is behind the key, typed as printed, and the cookie carries onto the socket', async ({ page, store }) => {
  await page.goto('/')
  await expect(page.locator('#screen')).toHaveCount(0)

  await page.goto('/login?key=wrong')
  await expect(page.locator('.refused')).toHaveText('That key is wrong.')

  // In capitals and with spaces for dashes: neither counts.
  const key = (await readFile(join(store.root, 'afield', 'key'), 'utf8')).trim()
  await page.fill('input[name=key]', key.replaceAll('-', ' ').toUpperCase())
  await page.press('input[name=key]', 'Enter')
  await expect(page.locator('#screen')).toContainText('fake-pi ready')
})
