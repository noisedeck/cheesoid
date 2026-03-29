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

    // Verify DMs don't leak to #general — switch to room view and check
    const roomItem = page.locator('#rooms-list li').first()
    if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await roomItem.click()
      await page.waitForTimeout(2000)
      const generalBodies = await page.locator('.message-body').allTextContents()
      const leaked = generalBodies.filter(t => t.includes(dmText))
      if (leaked.length > 0) {
        await page.screenshot({ path: `tests/dm-leak-${agentName.toLowerCase()}.png`, fullPage: true })
        throw new Error(`DM leaked to #general! Found "${dmText}" in room view`)
      }
      console.log(`  No DM leak to #general ✓`)
    }

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

async function testDMPrivacy() {
  // User A sends DM to Red, User B should NOT see it
  const browserA = await chromium.launch({ headless: true })
  const browserB = await chromium.launch({ headless: true })
  const pageA = await browserA.newPage()
  const pageB = await browserB.newPage()

  try {
    console.log('\n=== Testing DM privacy (non-recipient cannot see DMs) ===')

    // User A joins
    await pageA.goto(BASE)
    await pageA.fill('#name-input', 'Alice')
    await pageA.click('#name-btn')
    await pageA.waitForSelector('#messages', { state: 'visible' })
    await pageA.waitForTimeout(3000)

    // User B joins
    await pageB.goto(BASE)
    await pageB.fill('#name-input', 'Bob')
    await pageB.click('#name-btn')
    await pageB.waitForSelector('#messages', { state: 'visible' })
    await pageB.waitForTimeout(3000)

    // Alice sends DM to Red
    const aliceParticipant = pageA.locator('#participants li[data-name="Red"]')
    await aliceParticipant.click()
    await pageA.waitForTimeout(500)
    const dmText = `SECRET_DM_${Date.now()}`
    await pageA.fill('#input', dmText)
    await pageA.click('#send-btn')
    console.log(`  Alice sent DM to Red: "${dmText}"`)

    // Wait for Alice to see her message
    await pageA.waitForTimeout(5000)
    const aliceSees = await pageA.locator('.message-body', { hasText: dmText }).isVisible().catch(() => false)
    console.log(`  Alice sees her DM: ${aliceSees ? '✓' : '✗'}`)

    // Wait for response from Red
    await pageA.waitForTimeout(15000)

    // Bob opens dm:Red — should NOT see Alice's DM
    const bobParticipant = pageB.locator('#participants li[data-name="Red"]')
    await bobParticipant.click()
    await pageB.waitForTimeout(3000)
    const bobBodies = await pageB.locator('.message-body').allTextContents()
    const bobSeesAliceDM = bobBodies.some(t => t.includes(dmText))
    console.log(`  Bob sees Alice's DM in dm:Red: ${bobSeesAliceDM ? '✗ LEAKED!' : '✓ Hidden'}`)

    // Bob checks #general too
    const roomItem = pageB.locator('#rooms-list li').first()
    if (await roomItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await roomItem.click()
      await pageB.waitForTimeout(2000)
      const generalBodies = await pageB.locator('.message-body').allTextContents()
      const bobSeesInGeneral = generalBodies.some(t => t.includes(dmText))
      console.log(`  Bob sees Alice's DM in #general: ${bobSeesInGeneral ? '✗ LEAKED!' : '✓ Hidden'}`)
    }

    if (bobSeesAliceDM) {
      await pageB.screenshot({ path: 'tests/dm-privacy-fail.png', fullPage: true })
      throw new Error('DM leaked to non-recipient!')
    }

    console.log('  ✓ DM privacy PASSED')
    return true
  } catch (err) {
    console.error(`  ✗ DM privacy FAILED: ${err.message}`)
    return false
  } finally {
    await browserA.close()
    await browserB.close()
  }
}

async function main() {
  const redResult = await testDMRoundTrip('Red')
  const greenResult = await testDMRoundTrip('Green')
  const privacyResult = await testDMPrivacy()

  console.log('\n=== RESULTS ===')
  console.log(`Red DM:      ${redResult ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`Green DM:    ${greenResult ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`DM Privacy:  ${privacyResult ? 'PASS ✓' : 'FAIL ✗'}`)

  process.exit(redResult && greenResult && privacyResult ? 0 : 1)
}

main()
