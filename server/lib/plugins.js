import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export async function loadPlugins(pluginPaths) {
  const plugins = []

  for (const pluginDir of pluginPaths) {
    try {
      const raw = await readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')
      const meta = JSON.parse(raw)

      const skillsDir = join(pluginDir, 'skills')
      let skillNames
      try {
        const entries = await readdir(skillsDir, { withFileTypes: true })
        skillNames = entries.filter(e => e.isDirectory()).map(e => e.name)
      } catch {
        skillNames = []
      }

      const skills = []
      for (const name of skillNames) {
        const skillPath = join(skillsDir, name, 'SKILL.md')
        try {
          const skillRaw = await readFile(skillPath, 'utf8')
          const { frontmatter, content } = stripFrontmatter(skillRaw)
          const refsDir = join(skillsDir, name, 'references')
          let referencesDir = null
          try {
            const s = await stat(refsDir)
            if (s.isDirectory()) referencesDir = refsDir
          } catch { /* no references dir */ }

          skills.push({
            name: frontmatter.name || name,
            content,
            referencesDir,
          })
        } catch { /* skip skills without SKILL.md */ }
      }

      plugins.push({
        name: meta.name,
        description: meta.description,
        version: meta.version,
        skills,
      })
    } catch {
      console.warn(`[plugins] Skipping plugin at ${pluginDir}: not found or invalid`)
    }
  }

  return plugins
}

function stripFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return { frontmatter: {}, content: text }

  const frontmatter = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
  }
  return { frontmatter, content: text.slice(match[0].length).trimStart() }
}
