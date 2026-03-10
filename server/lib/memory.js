import { readFile, writeFile, appendFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export class Memory {
  constructor(personaDir, memorySubdir = 'memory/') {
    this.dir = join(personaDir, memorySubdir)
  }

  async loadContext(autoReadFiles) {
    const contents = []
    for (const f of autoReadFiles) {
      const c = await this.read(f)
      if (c !== null) contents.push(c)
    }
    return contents.join('\n\n')
  }

  async read(filename) {
    try {
      return await readFile(join(this.dir, filename), 'utf8')
    } catch {
      return null
    }
  }

  async write(filename, content) {
    await writeFile(join(this.dir, filename), content)
  }

  async append(filename, content) {
    await appendFile(join(this.dir, filename), '\n' + content)
  }

  async list() {
    try {
      const entries = await readdir(this.dir)
      return entries.filter(e => e.endsWith('.md'))
    } catch {
      return []
    }
  }
}
