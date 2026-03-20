import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugins } from '../server/lib/plugins.js'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function makePlugin(dir, { pluginJson, skillName, skillMd, references = {} } = {}) {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(pluginJson))
  const skillDir = join(dir, 'skills', skillName)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), skillMd)
  if (Object.keys(references).length > 0) {
    const refDir = join(skillDir, 'references')
    await mkdir(refDir, { recursive: true })
    for (const [name, content] of Object.entries(references)) {
      await writeFile(join(refDir, name), content)
    }
  }
}

describe('loadPlugins', () => {
  it('loads a plugin with skill content and strips frontmatter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-plugin-'))
    const pluginDir = join(dir, 'test-plugin')
    await makePlugin(pluginDir, {
      pluginJson: { name: 'test-plugin', version: '1.0.0', description: 'A test plugin' },
      skillName: 'test-skill',
      skillMd: '---\nname: test-skill\ndescription: Test skill\n---\n\n# Test Skill\n\nDo the thing.',
    })

    const plugins = await loadPlugins([pluginDir])
    assert.equal(plugins.length, 1)
    assert.equal(plugins[0].name, 'test-plugin')
    assert.equal(plugins[0].skills.length, 1)
    assert.equal(plugins[0].skills[0].name, 'test-skill')
    assert.ok(plugins[0].skills[0].content.includes('# Test Skill'))
    assert.ok(!plugins[0].skills[0].content.includes('---'))
  })

  it('includes references directory path when references exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-plugin-'))
    const pluginDir = join(dir, 'sre-plugin')
    await makePlugin(pluginDir, {
      pluginJson: { name: 'sre-discipline', version: '1.0.0', description: 'SRE' },
      skillName: 'sre',
      skillMd: '---\nname: sre\ndescription: SRE discipline\n---\n\n# SRE\n\nFollow the checklist.',
      references: { 'containers.md': '# Containers\nDon\'t break them.' },
    })

    const plugins = await loadPlugins([pluginDir])
    assert.ok(plugins[0].skills[0].referencesDir)
    assert.ok(plugins[0].skills[0].referencesDir.endsWith('/skills/sre/references'))
  })

  it('returns empty array for empty plugin list', async () => {
    const plugins = await loadPlugins([])
    assert.deepEqual(plugins, [])
  })

  it('skips missing plugin directories gracefully', async () => {
    const plugins = await loadPlugins(['/nonexistent/path'])
    assert.deepEqual(plugins, [])
  })

  it('loads multiple skills from one plugin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cheesoid-plugin-'))
    const pluginDir = join(dir, 'multi')
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'multi', version: '1.0.0' }))
    const skill1 = join(pluginDir, 'skills', 'alpha')
    const skill2 = join(pluginDir, 'skills', 'beta')
    await mkdir(skill1, { recursive: true })
    await mkdir(skill2, { recursive: true })
    await writeFile(join(skill1, 'SKILL.md'), '---\nname: alpha\n---\n\n# Alpha')
    await writeFile(join(skill2, 'SKILL.md'), '---\nname: beta\n---\n\n# Beta')

    const plugins = await loadPlugins([pluginDir])
    assert.equal(plugins[0].skills.length, 2)
  })
})
