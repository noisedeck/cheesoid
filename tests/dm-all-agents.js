import { chromium } from 'playwright'

const BASE = 'http://localhost:3001'
let results = []

function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ': ' + detail : ''}`)
}

async function withPage(username, fn) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(BASE)
    // Handle name prompt (may be auto-skipped if auth proxy)
    const nameInput = page.locator('#name-input')
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await page.fill('#name-input', username)
      await page.click('#name-btn')
    }
    await page.waitForSelector('#messages', { state: 'visible' })
    await page.waitForTimeout(3000)
    return await fn(page, browser)
  } finally {
    await browser.close()
  }
}

async function switchToDM(page, agentName) {
  await page.locator(`#participants li[data-name="${agentName}"]`).click()
  await page.waitForTimeout(1500)
}

async function switchToRoom(page, room) {
  await page.locator(`#rooms-list li[data-room="${room}"]`).click()
  await page.waitForTimeout(1500)
}

async function sendMsg(page, text) {
  await page.fill('#input', text)
  await page.click('#send-btn')
}

async function getMessages(page) {
  return (await page.locator('.message-body').allTextContents()).map(t => t.trim()).filter(Boolean)
}

async function waitForResponse(page, sentText, timeoutSec = 30) {
  const msgsBefore = (await getMessages(page)).length
  for (let i = 0; i < timeoutSec; i++) {
    await page.waitForTimeout(1000)
    const msgs = await getMessages(page)
    // Look for any message after our sent one
    if (msgs.length > msgsBefore) return true
  }
  return false
}

// ============================================================
// TEST: DM to host (Red) - send, receive, persist
// ============================================================
async function testDMHost() {
  console.log('\n=== DM to host (Red) ===')
  const msg = `DMHOST_${Date.now()}`

  // Send DM and get response
  const { responded } = await withPage('DMHostUser', async (page) => {
    await switchToDM(page, 'Red')
    await sendMsg(page, msg)
    const found = await waitForResponse(page, msg, 30)
    record('DM to Red: sent + response received', found)
    return { responded: found }
  })

  if (!responded) return { msg, pass: false }

  // Verify persistence in fresh session
  const { persisted, msgs } = await withPage('DMHostUser', async (page) => {
    await switchToDM(page, 'Red')
    await page.waitForTimeout(3000)
    const msgs = await getMessages(page)
    const hasSent = msgs.some(m => m.includes(msg))
    const hasResp = msgs.length >= 2
    record('DM to Red: sent persists after reload', hasSent)
    record('DM to Red: response persists after reload', hasResp)
    return { persisted: hasSent && hasResp, msgs }
  })

  // Verify DM not in channels
  const { leaked } = await withPage('DMHostSpy', async (page) => {
    await switchToRoom(page, '#general')
    await page.waitForTimeout(2000)
    const genMsgs = await getMessages(page)
    const inGeneral = genMsgs.some(m => m.includes(msg))
    record('DM to Red: NOT in #general', !inGeneral)

    await switchToRoom(page, '#test')
    await page.waitForTimeout(2000)
    const testMsgs = await getMessages(page)
    const inTest = testMsgs.some(m => m.includes(msg))
    record('DM to Red: NOT in #test', !inTest)

    return { leaked: inGeneral || inTest }
  })

  // Verify spy can't see DM
  const { spySees } = await withPage('DMHostSpy', async (page) => {
    await switchToDM(page, 'Red')
    await page.waitForTimeout(2000)
    const msgs = await getMessages(page)
    const seen = msgs.some(m => m.includes(msg))
    record('Spy cannot see DM to Red', !seen)
    return { spySees: seen }
  })

  return { msg, pass: responded && persisted && !leaked && !spySees }
}

// ============================================================
// TEST: DM to visitor (Green) - send, receive, persist
// ============================================================
async function testDMGreen() {
  console.log('\n=== DM to visitor (Green) ===')
  const msg = `DMGREEN_${Date.now()}`

  const { responded } = await withPage('DMGreenUser', async (page) => {
    await switchToDM(page, 'Green')
    await sendMsg(page, msg)
    const found = await waitForResponse(page, msg, 30)
    record('DM to Green: sent + response received', found)
    if (found) {
      const msgs = await getMessages(page)
      console.log(`    Messages: ${msgs.map(m => m.slice(0, 60)).join(' | ')}`)
    }
    return { responded: found }
  })

  if (!responded) return { msg, pass: false }

  // Verify persistence
  const { persisted } = await withPage('DMGreenUser', async (page) => {
    await switchToDM(page, 'Green')
    await page.waitForTimeout(3000)
    const msgs = await getMessages(page)
    const hasSent = msgs.some(m => m.includes(msg))
    const hasResp = msgs.length >= 2
    record('DM to Green: sent persists after reload', hasSent)
    record('DM to Green: response persists after reload', hasResp)
    if (!hasSent || !hasResp) {
      console.log(`    Scrollback messages: ${msgs.map(m => m.slice(0, 60)).join(' | ')}`)
    }
    return { persisted: hasSent && hasResp }
  })

  // Verify not leaked to channels
  const { leaked } = await withPage('DMGreenSpy', async (page) => {
    await switchToRoom(page, '#general')
    await page.waitForTimeout(2000)
    const genMsgs = await getMessages(page)
    const inGeneral = genMsgs.some(m => m.includes(msg))
    record('DM to Green: NOT in #general', !inGeneral)

    await switchToRoom(page, '#test')
    await page.waitForTimeout(2000)
    const testMsgs = await getMessages(page)
    const inTest = testMsgs.some(m => m.includes(msg))
    record('DM to Green: NOT in #test', !inTest)

    return { leaked: inGeneral || inTest }
  })

  // Verify spy can't see DM
  const { spySees } = await withPage('DMGreenSpy', async (page) => {
    await switchToDM(page, 'Green')
    await page.waitForTimeout(2000)
    const msgs = await getMessages(page)
    const seen = msgs.some(m => m.includes(msg))
    record('Spy cannot see DM to Green', !seen)
    return { spySees: seen }
  })

  return { msg, pass: responded && persisted && !leaked && !spySees }
}

// ============================================================
// TEST: DM to visitor (Blue) - send, receive, persist
// ============================================================
async function testDMBlue() {
  console.log('\n=== DM to visitor (Blue) ===')
  const msg = `DMBLUE_${Date.now()}`

  const { responded } = await withPage('DMBlueUser', async (page) => {
    await switchToDM(page, 'Blue')
    await sendMsg(page, msg)
    const found = await waitForResponse(page, msg, 30)
    record('DM to Blue: sent + response received', found)
    if (found) {
      const msgs = await getMessages(page)
      console.log(`    Messages: ${msgs.map(m => m.slice(0, 60)).join(' | ')}`)
    }
    return { responded: found }
  })

  if (!responded) return { msg, pass: false }

  // Verify persistence
  const { persisted } = await withPage('DMBlueUser', async (page) => {
    await switchToDM(page, 'Blue')
    await page.waitForTimeout(3000)
    const msgs = await getMessages(page)
    const hasSent = msgs.some(m => m.includes(msg))
    const hasResp = msgs.length >= 2
    record('DM to Blue: sent persists after reload', hasSent)
    record('DM to Blue: response persists after reload', hasResp)
    if (!hasSent || !hasResp) {
      console.log(`    Scrollback messages: ${msgs.map(m => m.slice(0, 60)).join(' | ')}`)
    }
    return { persisted: hasSent && hasResp }
  })

  // Verify not leaked
  const { leaked } = await withPage('DMBlueSpy', async (page) => {
    await switchToRoom(page, '#general')
    await page.waitForTimeout(2000)
    const genMsgs = await getMessages(page)
    const inGeneral = genMsgs.some(m => m.includes(msg))
    record('DM to Blue: NOT in #general', !inGeneral)

    await switchToRoom(page, '#test')
    await page.waitForTimeout(2000)
    const testMsgs = await getMessages(page)
    const inTest = testMsgs.some(m => m.includes(msg))
    record('DM to Blue: NOT in #test', !inTest)

    return { leaked: inGeneral || inTest }
  })

  // Verify spy can't see DM
  const { spySees } = await withPage('DMBlueSpy', async (page) => {
    await switchToDM(page, 'Blue')
    await page.waitForTimeout(2000)
    const msgs = await getMessages(page)
    const seen = msgs.some(m => m.includes(msg))
    record('Spy cannot see DM to Blue', !seen)
    return { spySees: seen }
  })

  return { msg, pass: responded && persisted && !leaked && !spySees }
}

async function main() {
  console.log('=== DM TO ALL AGENTS — COMPREHENSIVE TEST ===')

  const t1 = await testDMHost()
  const t2 = await testDMGreen()
  const t3 = await testDMBlue()

  console.log('\n========================================')
  console.log('=== RESULTS ===')
  console.log('========================================')
  const allPass = results.every(r => r.pass)
  for (const r of results) {
    console.log(`${r.pass ? '✓' : '✗'} ${r.name}`)
  }
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} passed`)
  console.log(allPass ? '\n*** ALL DM TESTS PASS ***' : '\n*** DM FAILURES DETECTED ***')

  process.exit(allPass ? 0 : 1)
}

main()
