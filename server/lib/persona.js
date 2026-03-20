import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { loadPlugins } from './plugins.js'

export async function loadPersona(personaDir) {
  const configPath = join(personaDir, 'persona.yaml')
  let raw
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (err) {
    throw new Error(`Could not read persona.yaml at ${configPath}: ${err.message}`)
  }

  const config = yaml.load(raw)
  resolveEnvVars(config)
  const plugins = await loadPlugins(config.plugins || [])
  return { dir: personaDir, config, plugins }
}

function resolveEnvVars(obj) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        obj[i] = substituteEnv(obj[i])
      } else if (typeof obj[i] === 'object' && obj[i] !== null) {
        resolveEnvVars(obj[i])
      }
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        obj[key] = substituteEnv(obj[key])
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        resolveEnvVars(obj[key])
      }
    }
  }
}

function substituteEnv(str) {
  return str.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '')
}
