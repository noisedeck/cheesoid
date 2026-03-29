import { chromium } from 'playwright'

const BASE = 'http://localhost:3001'

async function testDMRoundTrip(agentName) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const username = `DMTest_${agentName}_${Date.now()}`

  try {
    console.log(`\n=== Testing DM to ${agentName} ===`)

    await page.goto(BASE)
    await page.fill('#name-input', username)
    await page.click('#name-btn')
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)

    // Click agent in participant list
    const participant = page.locator(`#participants li[data-name="${agentName}"]`)
    if (!await participant.isVisible({ timeout: 10000 })) {
      throw new Error(`${agentName} not in participant list`)
    }
    await participant.click()
    await page.waitForTimeout(500)

    // Verify DM view
    const channelText = await page.locator('#channel-name').textContent()
    if (channelText !== agentName) {
      throw new Error(`Expected channel "${agentName}", got "${channelText}"`)
    }
    console.log(`  Channel: ${channelText} ✓`)

    // Send DM
    const dmText = `DM test ${Date.now()}`
    await page.fill('#input', dmText)
    await page.click('#send-btn')
    console.log(`  Sent: "${dmText}"`)

    // Wait for sent message to appear
    await page.waitForTimeout(5000)
    await page.screenshot({ path: `tests/dm-after-send-${agentName.toLowerCase()}.png`, fullPage: true })
    const allText = await page.locator('#messages').innerHTML()
    console.log(`  Messages HTML length: ${allText.length}`)
    console.log(`  Messages content: ${allText.slice(0, 500)}`)
    const sentVisible = await page.locator('.message-body', { hasText: dmText }).isVisible({ timeout: 10000 }).catch(() => false)
    if (!sentVisible) {
      throw new Error('Sent message not visible in DM view')
    }
    console.log('  Sent message visible ✓')

    // Wait for response — check every 2 seconds for up to 90 seconds
    let responseText = null
    for (let i = 0; i < 45; i++) {
      await page.waitForTimeout(2000)
      const bodies = await page.locator('.message-body').allTextContents()
      const responses = bodies.filter(t => t.trim() && !t.includes(dmText))
      if (responses.length > 0) {
        responseText = responses[responses.length - 1].trim()
        break
      }
    }

    if (!responseText) {
      await page.screenshot({ path: `tests/dm-fail-${agentName.toLowerCase()}.png`, fullPage: true })
      throw new Error(`No response from ${agentName} after 90 seconds`)
    }

    console.log(`  Response: "${responseText.slice(0, 100)}${responseText.length > 100 ? '...' : ''}"`)
    console.log(`  ✓ DM round-trip to ${agentName} PASSED`)

    await page.screenshot({ path: `tests/dm-pass-${agentName.toLowerCase()}.png`, fullPage: true })
    return true
  } catch (err) {
    console.error(`  ✗ DM round-trip to ${agentName} FAILED: ${err.message}`)
    try { await page.screenshot({ path: `tests/dm-fail-${agentName.toLowerCase()}.png`, fullPage: true }) } catch {}
    return false
  } finally {
    await browser.close()
  }
}

async function main() {
  const redResult = await testDMRoundTrip('Red')
  const greenResult = await testDMRoundTrip('Green')

  console.log('\n=== RESULTS ===')
  console.log(`Red DM:   ${redResult ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`Green DM: ${greenResult ? 'PASS ✓' : 'FAIL ✗'}`)

  process.exit(redResult && greenResult ? 0 : 1)
}

main()
