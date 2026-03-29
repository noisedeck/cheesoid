import { chromium } from 'playwright'

const BASE = 'http://localhost:3001'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const username = 'PersistTest'

  try {
    // Step 1: Send a DM
    console.log('=== Step 1: Send DM ===')
    await page.goto(BASE)
    await page.fill('#name-input', username)
    await page.click('#name-btn')
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)

    await page.locator('#participants li[data-name="Red"]').click()
    await page.waitForTimeout(500)

    const dmText = `PERSIST_TEST_${Date.now()}`
    await page.fill('#input', dmText)
    await page.click('#send-btn')
    console.log(`  Sent: "${dmText}"`)

    // Wait for response
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000)
      const bodies = await page.locator('.message-body').allTextContents()
      if (bodies.some(t => !t.includes(dmText) && t.trim())) {
        console.log(`  Got response`)
        break
      }
    }

    // Verify messages visible
    const beforeReload = await page.locator('.message-body').allTextContents()
    console.log(`  Messages before reload: ${beforeReload.length}`)
    for (const t of beforeReload) console.log(`    "${t.trim().slice(0, 80)}"`)

    // Step 2: Reload page
    console.log('\n=== Step 2: Reload page ===')
    await page.reload()
    await page.waitForSelector('#name-prompt', { state: 'visible', timeout: 5000 }).catch(() => {})

    // Re-enter name if prompted
    const nameVisible = await page.locator('#name-input').isVisible().catch(() => false)
    if (nameVisible) {
      await page.fill('#name-input', username)
      await page.click('#name-btn')
    }
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)

    // Step 3: Switch to dm:Red
    console.log('\n=== Step 3: Switch to dm:Red ===')
    const redParticipant = page.locator('#participants li[data-name="Red"]')
    await redParticipant.waitFor({ state: 'visible', timeout: 10000 })
    await redParticipant.click()
    await page.waitForTimeout(3000)

    // Check what's visible
    const afterReload = await page.locator('.message-body').allTextContents()
    console.log(`  Messages after reload: ${afterReload.length}`)
    for (const t of afterReload) console.log(`    "${t.trim().slice(0, 80)}"`)

    const found = afterReload.some(t => t.includes(dmText))
    if (found) {
      console.log(`\n✓ DM PERSISTS AFTER RELOAD`)
    } else {
      await page.screenshot({ path: 'tests/dm-persist-fail.png', fullPage: true })
      console.log(`\n✗ DM LOST AFTER RELOAD`)

      // Debug: check what scrollback returned
      const scrollback = await page.evaluate(() => {
        return fetch('/api/chat/scrollback').then(r => r.json())
      })
      const dmEntries = scrollback.messages.filter(m => m.dm_from || m.dm_to)
      console.log(`  Scrollback total: ${scrollback.messages.length}, DM entries: ${dmEntries.length}`)
      for (const e of dmEntries.slice(-5)) {
        console.log(`    ${e.dm_from}->${e.dm_to}: ${(e.text || '').slice(0, 60)}`)
      }

      // Check myName
      const myName = await page.evaluate(() => localStorage.getItem('cheesoid-name'))
      console.log(`  myName in localStorage: ${myName}`)
      const currentView = await page.evaluate(() => document.getElementById('channel-name')?.textContent)
      console.log(`  currentView label: ${currentView}`)
    }

    process.exit(found ? 0 : 1)
  } catch (err) {
    console.error(`ERROR: ${err.message}`)
    await page.screenshot({ path: 'tests/dm-persist-error.png', fullPage: true })
    process.exit(1)
  } finally {
    await browser.close()
  }
}

main()
