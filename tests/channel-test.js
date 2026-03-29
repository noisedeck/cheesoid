import { chromium } from 'playwright'

const BASE = 'http://localhost:3001'

async function testChannelRoundTrip() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const username = `ChanTest_${Date.now()}`

  try {
    console.log('=== Test: #test channel round-trip ===')
    await page.goto(BASE)
    await page.fill('#name-input', username)
    await page.click('#name-btn')
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)

    // Switch to #test
    const testRoom = page.getByText('#test', { exact: true })
    await testRoom.waitFor({ state: 'visible', timeout: 10000 })
    await testRoom.click()
    await page.waitForTimeout(1000)

    const channelText = await page.locator('#channel-name').textContent()
    if (channelText !== '#test') throw new Error(`Expected channel "#test", got "${channelText}"`)
    console.log('  Channel: #test ✓')

    // Send message
    const msgText = `CHAN_TEST_${Date.now()}`
    await page.fill('#input', msgText)
    await page.click('#send-btn')
    console.log(`  Sent: "${msgText}"`)

    // Wait for sent message — poll since it arrives via SSE
    let sentVisible = false
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000)
      sentVisible = await page.locator('.message-body', { hasText: msgText }).isVisible().catch(() => false)
      if (sentVisible) break
    }
    if (!sentVisible) {
      const html = await page.locator('#messages').innerHTML()
      console.log(`  Messages HTML: ${html.slice(0, 300)}`)
      await page.screenshot({ path: 'tests/channel-sent-fail.png', fullPage: true })
      throw new Error('Sent message not visible in #test')
    }
    console.log('  Sent message visible ✓')

    // Wait for agent response
    let responseText = null
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000)
      const bodies = await page.locator('.message-body').allTextContents()
      const responses = bodies.filter(t => t.trim() && !t.includes(msgText))
      if (responses.length > 0) {
        responseText = responses[responses.length - 1].trim()
        break
      }
    }
    if (!responseText) throw new Error('No agent response in #test after 60 seconds')
    console.log(`  Response: "${responseText.slice(0, 80)}"`)
    console.log('  ✓ #test round-trip PASSED')
    return { pass: true, msgText }
  } catch (err) {
    console.error(`  ✗ #test round-trip FAILED: ${err.message}`)
    await page.screenshot({ path: 'tests/channel-roundtrip-fail.png', fullPage: true }).catch(() => {})
    return { pass: false, msgText: null }
  } finally {
    await browser.close()
  }
}

async function testChannelIsolation(msgText) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const username = `IsoTest_${Date.now()}`

  try {
    console.log('\n=== Test: #test messages don\'t leak to #general ===')
    await page.goto(BASE)
    await page.fill('#name-input', username)
    await page.click('#name-btn')
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)

    // We start on #general — check for the #test message
    const generalBodies = await page.locator('.message-body').allTextContents()
    const leaked = generalBodies.filter(t => t.includes(msgText))
    if (leaked.length > 0) {
      await page.screenshot({ path: 'tests/channel-leak.png', fullPage: true })
      throw new Error(`#test message "${msgText}" leaked to #general!`)
    }
    console.log('  #test message not in #general ✓')

    // Switch to #test — message should be there
    const testRoom = page.locator('#rooms-list li', { hasText: '#test' })
    await testRoom.click()
    await page.waitForTimeout(3000)
    const testBodies = await page.locator('.message-body').allTextContents()
    const found = testBodies.some(t => t.includes(msgText))
    if (!found) throw new Error(`#test message "${msgText}" not found in #test scrollback`)
    console.log('  #test message in #test scrollback ✓')

    console.log('  ✓ Channel isolation PASSED')
    return true
  } catch (err) {
    console.error(`  ✗ Channel isolation FAILED: ${err.message}`)
    return false
  } finally {
    await browser.close()
  }
}

async function testChannelPersistence(msgText) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const username = `PersistChan_${Date.now()}`

  try {
    console.log('\n=== Test: #test messages persist after reload ===')
    await page.goto(BASE)
    await page.fill('#name-input', username)
    await page.click('#name-btn')
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)

    // Switch to #test
    const testRoom = page.locator('#rooms-list li', { hasText: '#test' })
    await testRoom.click()
    await page.waitForTimeout(3000)

    const bodies = await page.locator('.message-body').allTextContents()
    const found = bodies.some(t => t.includes(msgText))
    if (!found) throw new Error(`#test message "${msgText}" not in scrollback after fresh load`)
    console.log('  #test message persists after fresh page load ✓')

    console.log('  ✓ Channel persistence PASSED')
    return true
  } catch (err) {
    console.error(`  ✗ Channel persistence FAILED: ${err.message}`)
    return false
  } finally {
    await browser.close()
  }
}

async function testDMsNotInChannels() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const username = `DMChanTest_${Date.now()}`

  try {
    console.log('\n=== Test: DMs don\'t appear in any channel ===')
    await page.goto(BASE)
    await page.fill('#name-input', username)
    await page.click('#name-btn')
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)

    // Send DM to Red
    await page.locator('#participants li[data-name="Red"]').click()
    await page.waitForTimeout(500)
    const dmText = `DM_CHAN_CHECK_${Date.now()}`
    await page.fill('#input', dmText)
    await page.click('#send-btn')
    await page.waitForTimeout(15000)
    console.log(`  Sent DM: "${dmText}"`)

    // Check #general
    const generalRoom = page.locator('#rooms-list li').first()
    await generalRoom.click()
    await page.waitForTimeout(3000)
    let bodies = await page.locator('.message-body').allTextContents()
    if (bodies.some(t => t.includes(dmText))) throw new Error('DM leaked to #general!')
    console.log('  DM not in #general ✓')

    // Check #test
    const testRoom = page.locator('#rooms-list li', { hasText: '#test' })
    await testRoom.click()
    await page.waitForTimeout(3000)
    bodies = await page.locator('.message-body').allTextContents()
    if (bodies.some(t => t.includes(dmText))) throw new Error('DM leaked to #test!')
    console.log('  DM not in #test ✓')

    console.log('  ✓ DMs not in channels PASSED')
    return true
  } catch (err) {
    console.error(`  ✗ DMs not in channels FAILED: ${err.message}`)
    await page.screenshot({ path: 'tests/dm-chan-leak.png', fullPage: true }).catch(() => {})
    return false
  } finally {
    await browser.close()
  }
}

async function main() {
  const rt = await testChannelRoundTrip()
  const iso = rt.msgText ? await testChannelIsolation(rt.msgText) : false
  const persist = rt.msgText ? await testChannelPersistence(rt.msgText) : false
  const dmIso = await testDMsNotInChannels()

  console.log('\n=== RESULTS ===')
  console.log(`#test round-trip:      ${rt.pass ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`Channel isolation:     ${iso ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`Channel persistence:   ${persist ? 'PASS ✓' : 'FAIL ✗'}`)
  console.log(`DMs not in channels:   ${dmIso ? 'PASS ✓' : 'FAIL ✗'}`)

  process.exit(rt.pass && iso && persist && dmIso ? 0 : 1)
}

main()
