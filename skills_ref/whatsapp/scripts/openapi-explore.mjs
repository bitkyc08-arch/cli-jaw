#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse as parseYaml } from 'yaml'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']
const DEFAULT_PUBLISHED_WHATSAPP_OPENAPI = 'https://docs.kapso.ai/api/meta/whatsapp/openapi-whatsapp.yaml'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

function printHelp(exitCode = 0) {
  const msg = `
Explore OpenAPI specs (YAML)

Usage:
  node openapi-explore.mjs [openapi.yaml ...] <command> [args]
  node openapi-explore.mjs [--file <path> ...] <command> [args]
  node openapi-explore.mjs --all <command> [args]

Default (no files passed):
  Loads the published OpenAPI files from docs.kapso.ai:
  - ${DEFAULT_PUBLISHED_WHATSAPP_OPENAPI}
  - (plus platform + workflows, deduced from that URL)

Fallback:
  If it can't fetch the published specs (offline, etc.), it falls back to local repo files:
  api/**/openapi-*.yaml

Use --all to force local auto-discovery.

Commands:
  specs
  tags [--spec <id>]
  ops [--spec <id>] [--tag <tag>] [--q <query>]
  search <query> [--spec <id>]
  op <operationId | specId:operationId | "METHOD /path"> [--spec <id>]
  schema <SchemaName | specId:SchemaName> [--spec <id>]
  where <SchemaName | specId:SchemaName> [--spec <id>]

Flags:
  --file, -f <path>     Load a spec file (repeatable)
  --all                 Load all api/**/openapi-*.yaml files
  --spec <id>           Filter by spec id (platform, workflows, whatsapp, ...)
  --json                Output JSON (search/ops/where)
  --limit <n>           Limit results (default 30)
`
  console.log(msg.trim())
  process.exit(exitCode)
}

function die(msg, exitCode = 1) {
  console.error(msg)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const args = [...argv]
  const opts = { files: [], all: false, spec: null, json: false, limit: 30, tag: null, q: null }
  let command = null
  const rest = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') printHelp(0)

    if (a === '--all') {
      opts.all = true
      continue
    }
    if (a === '--json') {
      opts.json = true
      continue
    }
    if (a === '--file' || a === '-f') {
      const p = args[++i]
      if (!p) die('Missing value for --file')
      opts.files.push(p)
      continue
    }
    if (a === '--spec') {
      opts.spec = args[++i] || null
      if (!opts.spec) die('Missing value for --spec')
      continue
    }
    if (a === '--limit') {
      const raw = args[++i]
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) die(`Invalid --limit: ${raw}`)
      opts.limit = n
      continue
    }
    if (a === '--tag') {
      opts.tag = args[++i] || null
      if (!opts.tag) die('Missing value for --tag')
      continue
    }
    if (a === '--q') {
      opts.q = args[++i] || null
      if (!opts.q) die('Missing value for --q')
      continue
    }

    if (!command && (a.endsWith('.yaml') || a.endsWith('.yml'))) {
      opts.files.push(a)
      continue
    }

    if (!command) command = a
    else rest.push(a)
  }

  return { opts, command, rest }
}

function walk(dir, { filePattern, maxDepth = 10 } = {}, depth = 0, out = []) {
  if (depth > maxDepth) return out
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    const full = path.join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }

    if (st.isDirectory()) {
      walk(full, { filePattern, maxDepth }, depth + 1, out)
    } else if (!filePattern || filePattern.test(entry)) {
      out.push(full)
    }
  }

  return out
}

function findUpDir(startDir, targetDirName, { maxDepth = 12 } = {}) {
  let current = path.resolve(startDir)
  for (let i = 0; i <= maxDepth; i++) {
    const candidate = path.join(current, targetDirName)
    try {
      const st = statSync(candidate)
      if (st.isDirectory()) return candidate
    } catch {
      // ignore
    }

    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function findLocalApiDir() {
  return findUpDir(process.cwd(), 'api') || findUpDir(SCRIPT_DIR, 'api')
}

function isUrl(s) {
  return /^https?:\/\//i.test(String(s))
}

function deducePublishedOpenApiUrls(whatsappUrl = DEFAULT_PUBLISHED_WHATSAPP_OPENAPI) {
  const u = new URL(whatsappUrl)
  const origin = u.origin
  return [
    whatsappUrl,
    new URL('/api/platform/v1/openapi-platform.yaml', origin).toString(),
    new URL('/api/platform/v1/openapi-workflows.yaml', origin).toString(),
  ]
}

function inferSpecId(filePath, spec) {
  const base = (isUrl(filePath) ? path.basename(new URL(filePath).pathname) : path.basename(filePath)).toLowerCase()
  if (base.includes('whatsapp')) return 'whatsapp'
  if (base.includes('workflows')) return 'workflows'
  if (base.includes('platform')) return 'platform'

  const title = (spec?.info?.title || '').toLowerCase()
  if (title.includes('whatsapp')) return 'whatsapp'
  if (title.includes('workflow')) return 'workflows'
  if (title.includes('platform')) return 'platform'

  return base.replace(/^openapi-/, '').replace(/\.(ya?ml)$/, '') || 'spec'
}

function decodeJsonPointerToken(token) {
  return token.replaceAll('~1', '/').replaceAll('~0', '~')
}

function getByJsonPointer(doc, pointer) {
  if (!pointer || !pointer.startsWith('#/')) return null
  const parts = pointer.slice(2).split('/').map(decodeJsonPointerToken)
  let cur = doc
  for (const part of parts) {
    if (cur == null) return null
    cur = cur[part]
  }
  return cur ?? null
}

function refName(ref) {
  if (!ref) return null
  const parts = String(ref).split('/')
  return parts[parts.length - 1] || null
}

function derefObject(obj, doc, stack = new Set()) {
  if (!obj?.$ref) return obj
  const ref = String(obj.$ref)
  if (stack.has(ref)) return obj
  stack.add(ref)
  const resolved = getByJsonPointer(doc, ref)
  if (!resolved) return obj
  return derefObject(resolved, doc, stack)
}

function schemaTypeString(schema) {
  if (!schema) return 'any'
  if (schema.$ref) return refName(schema.$ref) || 'ref'
  if (schema.const !== undefined) return `const ${JSON.stringify(schema.const)}`
  if (schema.enum?.length) {
    const vals = schema.enum.slice(0, 6).map((v) => JSON.stringify(v)).join(' | ')
    return schema.enum.length > 6 ? `enum(${vals} | ...)` : `enum(${vals})`
  }
  if (schema.type) {
    if (Array.isArray(schema.type)) return schema.type.join('|')
    return schema.type
  }
  if (schema.oneOf) return 'oneOf'
  if (schema.anyOf) return 'anyOf'
  if (schema.allOf) return 'allOf'
  if (schema.properties) return 'object'
  if (schema.items) return 'array'
  return 'any'
}

function normalizeType(schema) {
  if (!schema) return null
  const t = schema.type
  if (!t) return null
  if (Array.isArray(t)) {
    const nonNull = t.find((x) => x !== 'null')
    return nonNull || t[0] || null
  }
  return t
}

function mergeAllOf(schema, doc, seen = new Set()) {
  if (!schema?.allOf?.length) return schema

  const out = { ...schema }
  delete out.allOf

  let merged = { type: 'object', properties: {}, required: [] }

  for (const part of schema.allOf) {
    let s = part
    if (s?.$ref) {
      const name = refName(s.$ref)
      if (name) {
        if (seen.has(name)) continue
        seen.add(name)
      }
      s = getByJsonPointer(doc, s.$ref) || s
    }
    if (s?.allOf) s = mergeAllOf(s, doc, seen)

    if (s?.type && normalizeType(s) !== 'object' && s.properties) {
      // some specs omit type: object but still have properties
    } else if (normalizeType(s) && normalizeType(s) !== 'object' && !s.properties) {
      return schema
    }

    if (s?.properties) Object.assign(merged.properties, s.properties)
    if (Array.isArray(s?.required)) merged.required.push(...s.required)
    if (s?.description && !merged.description) merged.description = s.description
  }

  merged.required = [...new Set(merged.required)]
  return { ...merged, ...out }
}

function formatSchemaPreview(schema, doc, { depth = 2, maxProps = 12 } = {}, indent = '', refStack = new Set()) {
  if (!schema) return [`${indent}any`]

  if (schema.$ref) {
    const name = refName(schema.$ref) || schema.$ref
    const resolved = getByJsonPointer(doc, schema.$ref)
    const lines = [`${indent}${name}`]
    const refKey = String(schema.$ref)
    if (refStack.has(refKey)) return lines
    refStack.add(refKey)
    if (resolved && depth > 0) {
      const next = resolved?.allOf ? mergeAllOf(resolved, doc) : resolved
      const childLines = formatSchemaPreview(next, doc, { depth, maxProps }, indent + '  ', refStack)
      // Avoid printing a single redundant "object" line for refs
      if (!(childLines.length === 1 && childLines[0].trim() === 'object')) lines.push(...childLines)
    }
    refStack.delete(refKey)
    return lines
  }

  const normalized = schema.allOf ? mergeAllOf(schema, doc) : schema

  const t = normalizeType(normalized) || schemaTypeString(normalized)
  if (t === 'object' || normalized.properties) {
    const props = normalized.properties || {}
    const required = new Set(normalized.required || [])
    const keys = Object.keys(props)
    if (!keys.length) return [`${indent}object`]

    const lines = []
    for (const key of keys.slice(0, maxProps)) {
      const s = props[key]
      const typeStr = schemaTypeString(s)
      const req = required.has(key) ? ' (required)' : ''
      const desc = s?.description ? ` - ${String(s.description).replaceAll('\n', ' ').slice(0, 80)}` : ''
      lines.push(`${indent}- ${key}: ${typeStr}${req}${desc}`)
      if (depth > 0) {
        const child = s?.$ref ? getByJsonPointer(doc, s.$ref) : s
        const childNorm = child?.allOf ? mergeAllOf(child, doc) : child
        const childType = normalizeType(childNorm)
        if (childType === 'object' || childNorm?.properties || childNorm?.items) {
          const nested = formatSchemaPreview(childNorm, doc, { depth: depth - 1, maxProps }, indent + '  ', refStack)
          // Only include nested if it adds something beyond "object"/"array"
          if (!(nested.length === 1 && ['object', 'array'].includes(nested[0].trim()))) lines.push(...nested)
        }
      }
    }
    if (keys.length > maxProps) lines.push(`${indent}- ... (${keys.length - maxProps} more)`)
    return lines
  }

  if (t === 'array' || normalized.items) {
    const itemType = schemaTypeString(normalized.items)
    const lines = [`${indent}array<${itemType}>`]
    if (normalized.items && depth > 0) {
      const next = normalized.items?.$ref ? getByJsonPointer(doc, normalized.items.$ref) : normalized.items
      const nextNorm = next?.allOf ? mergeAllOf(next, doc) : next
      const nested = formatSchemaPreview(nextNorm, doc, { depth: depth - 1, maxProps }, indent + '  ', refStack)
      const nestedTrim = nested.length === 1 ? nested[0].trim() : null
      const redundant =
        nestedTrim === null ? false : ['object', 'array'].includes(nestedTrim) || nestedTrim === itemType
      if (!redundant) lines.push(...nested)
    }
    return lines
  }

  if (normalized.oneOf?.length) {
    const opts = normalized.oneOf.slice(0, 5).map((s) => schemaTypeString(s)).join(' | ')
    return [`${indent}oneOf(${opts}${normalized.oneOf.length > 5 ? ' | ...' : ''})`]
  }
  if (normalized.anyOf?.length) {
    const opts = normalized.anyOf.slice(0, 5).map((s) => schemaTypeString(s)).join(' | ')
    return [`${indent}anyOf(${opts}${normalized.anyOf.length > 5 ? ' | ...' : ''})`]
  }

  return [`${indent}${schemaTypeString(normalized)}`]
}

function placeholderForString(schema) {
  if (schema?.enum?.length) return schema.enum[0]
  if (schema?.const !== undefined) return schema.const
  if (schema?.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
  if (schema?.format === 'date-time') return '2025-01-01T00:00:00Z'
  if (schema?.format === 'date') return '2025-01-01'
  if (schema?.format === 'email') return 'user@example.com'
  if (schema?.format === 'uri' || schema?.format === 'url') return 'https://example.com'
  return 'string'
}

function exampleFromSchema(schema, doc, { depth = 3, includeOptional = false } = {}, stack = new Set()) {
  if (!schema) return null

  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (name) {
      if (stack.has(name)) return `<circular:${name}>`
      stack.add(name)
    }
    const resolved = getByJsonPointer(doc, schema.$ref)
    const out = exampleFromSchema(resolved || {}, doc, { depth, includeOptional }, stack)
    if (name) stack.delete(name)
    return out
  }

  const normalized = schema.allOf ? mergeAllOf(schema, doc) : schema

  if (normalized.const !== undefined) return normalized.const
  if (normalized.enum?.length) return normalized.enum[0]

  const t = normalizeType(normalized)
  if (t === 'string') return placeholderForString(normalized)
  if (t === 'integer') return 0
  if (t === 'number') return 0
  if (t === 'boolean') return true
  if (t === 'null') return null

  if ((t === 'array' || normalized.items) && depth > 0) {
    return [exampleFromSchema(normalized.items || {}, doc, { depth: depth - 1, includeOptional }, stack)]
  }

  if ((t === 'object' || normalized.properties || normalized.additionalProperties) && depth > 0) {
    const props = normalized.properties || {}
    const required = new Set(normalized.required || [])
    const out = {}

    const keys = Object.keys(props)
    for (const key of keys) {
      if (!includeOptional && !required.has(key)) continue
      out[key] = exampleFromSchema(props[key], doc, { depth: depth - 1, includeOptional }, stack)
    }

    // If it is a free-form map, add a placeholder entry.
    if (!keys.length && normalized.additionalProperties) {
      out.key = exampleFromSchema(
        normalized.additionalProperties === true ? {} : normalized.additionalProperties,
        doc,
        { depth: depth - 1, includeOptional },
        stack,
      )
    }

    return out
  }

  if (normalized.oneOf?.length) return exampleFromSchema(normalized.oneOf[0], doc, { depth, includeOptional }, stack)
  if (normalized.anyOf?.length) return exampleFromSchema(normalized.anyOf[0], doc, { depth, includeOptional }, stack)

  return null
}

function collectSchemaRefs(schema, doc, out = new Set(), stack = new Set()) {
  if (!schema) return out

  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (name) out.add(name)
    if (name) {
      if (stack.has(name)) return out
      stack.add(name)
    }
    const resolved = getByJsonPointer(doc, schema.$ref)
    if (resolved) collectSchemaRefs(resolved, doc, out, stack)
    if (name) stack.delete(name)
    return out
  }

  const normalized = schema.allOf ? mergeAllOf(schema, doc) : schema

  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(normalized[key])) {
      for (const s of normalized[key]) collectSchemaRefs(s, doc, out, stack)
    }
  }

  if (normalized.properties) {
    for (const s of Object.values(normalized.properties)) collectSchemaRefs(s, doc, out, stack)
  }
  if (normalized.items) collectSchemaRefs(normalized.items, doc, out, stack)
  if (normalized.additionalProperties && normalized.additionalProperties !== true) {
    collectSchemaRefs(normalized.additionalProperties, doc, out, stack)
  }

  return out
}

function collectSchemaFieldNames(schema, doc, out = new Set(), stack = new Set(), depth = 3) {
  if (!schema || depth < 0) return out

  if (schema.$ref) {
    const ref = String(schema.$ref)
    if (stack.has(ref)) return out
    stack.add(ref)
    const resolved = getByJsonPointer(doc, ref)
    if (resolved) collectSchemaFieldNames(resolved, doc, out, stack, depth)
    stack.delete(ref)
    return out
  }

  const normalized = schema.allOf ? mergeAllOf(schema, doc) : schema

  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(normalized[key])) {
      for (const s of normalized[key]) collectSchemaFieldNames(s, doc, out, stack, depth)
    }
  }

  if (normalized.properties) {
    for (const [k, s] of Object.entries(normalized.properties)) {
      out.add(k)
      collectSchemaFieldNames(s, doc, out, stack, depth - 1)
    }
  }

  if (normalized.items) collectSchemaFieldNames(normalized.items, doc, out, stack, depth - 1)
  if (normalized.additionalProperties && normalized.additionalProperties !== true) {
    collectSchemaFieldNames(normalized.additionalProperties, doc, out, stack, depth - 1)
  }

  return out
}

function normalizeOperationSecurity(op, spec) {
  if (Object.prototype.hasOwnProperty.call(op, 'security')) return op.security
  return spec.security
}

function securityLabel(opSecurity, spec) {
  if (!opSecurity) return null
  if (Array.isArray(opSecurity) && opSecurity.length === 0) return 'none'

  const schemes = spec?.components?.securitySchemes || {}

  function schemeLabel(name) {
    const s = schemes[name]
    if (!s) return name
    if (s.type === 'apiKey' && s.in === 'header' && s.name) return `${name} (${s.name} header)`
    if (s.type === 'apiKey' && s.in) return `${name} (apiKey in ${s.in})`
    if (s.type === 'http' && s.scheme === 'bearer') return `${name} (Authorization: Bearer ...)`
    if (s.type === 'http') return `${name} (http ${s.scheme || ''})`.trim()
    return `${name} (${s.type})`
  }

  const requirementSets = []
  for (const req of opSecurity || []) {
    const keys = Object.keys(req || {})
    if (!keys.length) continue
    requirementSets.push(keys.map(schemeLabel).join(' + '))
  }

  if (!requirementSets.length) return null
  return requirementSets.join(' OR ')
}

function toShortSpec(s) {
  return {
    id: s.id,
    title: s.title,
    version: s.version,
    file: s.filePath,
    servers: s.servers,
    operations: s.operations.length,
    schemas: Object.keys(s.schemas).length,
  }
}

async function readSpecSource(source) {
  if (isUrl(source)) {
    const res = await fetch(source, {
      // Some CDNs / WAFs behave better with a UA.
      headers: { 'User-Agent': 'kapso-openapi-explore/1.0 (+https://docs.kapso.ai)' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return await res.text()
  }
  return readFileSync(source, 'utf-8')
}

async function loadSpecsAsync({ sources, sourceMode, specFilter }) {
  if (!sources.length) die('No OpenAPI sources provided')

  const seenIds = new Map()
  const specs = []
  const errors = []

  for (const filePath of sources) {
    let raw = null
    try {
      raw = await readSpecSource(filePath)
    } catch (e) {
      errors.push({ source: filePath, error: e })
      if (sourceMode === 'explicit') console.error(`Skipping ${filePath}: ${e.message}`)
      continue
    }

    let doc
    try {
      doc = parseYaml(raw)
    } catch (e) {
      errors.push({ source: filePath, error: e })
      console.error(`Skipping ${filePath}: YAML parse error: ${e.message}`)
      continue
    }

    const idBase = inferSpecId(filePath, doc)
    const n = (seenIds.get(idBase) || 0) + 1
    seenIds.set(idBase, n)
    const id = n === 1 ? idBase : `${idBase}${n}`

    if (specFilter && id !== specFilter) continue

    const title = doc?.info?.title || id
    const version = doc?.info?.version || '?'
    const servers = (doc?.servers || []).map((s) => s?.url).filter(Boolean)
    const tags = doc?.tags || []
    const schemas = doc?.components?.schemas || {}
    const schemaFieldCache = new Map()

    const getSchemaFields = (schemaName) => {
      if (schemaFieldCache.has(schemaName)) return schemaFieldCache.get(schemaName)
      const schema = schemas?.[schemaName]
      const fields = schema ? [...collectSchemaFieldNames(schema, doc)] : []
      schemaFieldCache.set(schemaName, fields)
      return fields
    }

    const operations = []
    const paths = doc?.paths || {}
    for (const [p, pathItemRaw] of Object.entries(paths)) {
      const pathItem = pathItemRaw || {}
      const pathParams = Array.isArray(pathItem.parameters) ? pathItem.parameters.map((x) => derefObject(x, doc)) : []

      for (const method of HTTP_METHODS) {
        const op = pathItem[method]
        if (!op) continue

        const mergedParams = [...pathParams, ...((op.parameters || []).filter(Boolean))]
          .map((x) => derefObject(x, doc))
          .filter(Boolean)
        const opSecurity = normalizeOperationSecurity(op, doc)
        const opRequestBody = derefObject(op.requestBody || null, doc)

        const refs = new Set()
        // params
        for (const param of mergedParams) {
          if (param?.schema) collectSchemaRefs(param.schema, doc, refs)
          if (param?.content) {
            for (const media of Object.values(param.content)) {
              if (media?.schema) collectSchemaRefs(media.schema, doc, refs)
            }
          }
        }
        // body
        if (opRequestBody?.content) {
          for (const media of Object.values(opRequestBody.content)) {
            if (media?.schema) collectSchemaRefs(media.schema, doc, refs)
          }
        }
        // responses
        if (op?.responses) {
          for (const resp of Object.values(op.responses)) {
            const r = derefObject(resp, doc)
            if (r?.content) {
              for (const media of Object.values(r.content)) {
                if (media?.schema) collectSchemaRefs(media.schema, doc, refs)
              }
            }
          }
        }

        const fieldsUsed = new Set()
        for (const schemaName of refs) {
          for (const f of getSchemaFields(schemaName)) fieldsUsed.add(f)
        }

        operations.push({
          specId: id,
          specTitle: title,
          specFile: filePath,
          method,
          path: p,
          operationId: op.operationId || null,
          summary: op.summary || null,
          description: op.description || null,
          tags: op.tags || [],
          deprecated: Boolean(op.deprecated),
          security: opSecurity,
          securityLabel: securityLabel(opSecurity, doc),
          parameters: mergedParams,
          requestBody: opRequestBody,
          responses: op.responses || {},
          refsUsed: refs,
          fieldsUsed,
        })
      }
    }

    specs.push({
      id,
      filePath,
      title,
      version,
      servers,
      doc,
      tags,
      schemas,
      operations,
    })
  }

  if (!specs.length) {
    if (sourceMode === 'default_remote' && errors.length) {
      const apiDir = findLocalApiDir()
      const local = apiDir ? walk(apiDir, { filePattern: /^openapi-.*\.ya?ml$/ }) : []
      if (local.length) {
        console.error(`Could not fetch published OpenAPI specs. Falling back to local repo specs (api/**/openapi-*.yaml).`)
        return await loadSpecsAsync({ sources: local, sourceMode: 'explicit', specFilter })
      }
    }
    if (specFilter) die(`No specs matched --spec ${specFilter}`)
    die('No specs loaded')
  }

  if (sourceMode === 'default_remote' && errors.length) {
    console.error(`Some published OpenAPI specs could not be fetched:`)
    for (const e of errors) console.error(`- ${e.source}: ${e.error?.message || String(e.error)}`)
  }

  return specs
}

function findOperation(specs, query, { specHint } = {}) {
  const raw = query.trim()
  const direct = raw.includes(':') ? raw.split(':') : null
  const qSpec = direct?.[0] || specHint
  const qId = direct?.[1] || raw

  // METHOD /path
  const m = raw.match(/^(get|post|put|patch|delete|options|head)\\s+(.+)$/i)
  if (m) {
    const method = m[1].toLowerCase()
    const p = m[2].trim()
    const matches = []
    for (const s of specs) {
      if (qSpec && s.id !== qSpec) continue
      for (const op of s.operations) {
        if (op.method === method && op.path === p) matches.push(op)
      }
    }
    return matches
  }

  // operationId
  const matches = []
  for (const s of specs) {
    if (qSpec && s.id !== qSpec) continue
    for (const op of s.operations) {
      if (op.operationId === qId) matches.push(op)
    }
  }
  return matches
}

function findSchema(specs, query, { specHint } = {}) {
  const raw = query.trim()
  const direct = raw.includes(':') ? raw.split(':') : null
  const qSpec = direct?.[0] || specHint
  const qName = direct?.[1] || raw

  const matches = []
  for (const s of specs) {
    if (qSpec && s.id !== qSpec) continue
    if (Object.prototype.hasOwnProperty.call(s.schemas, qName)) {
      matches.push({ spec: s, name: qName, schema: s.schemas[qName] })
    }
  }
  return matches
}

function scoreText(hay, q) {
  if (!hay) return 0
  const h = hay.toLowerCase()
  if (h === q) return 100
  if (h.startsWith(q)) return 60
  if (h.includes(q)) return 30
  return 0
}

function search(specs, query, { specHint, limit = 30 } = {}) {
  const q = query.toLowerCase().trim()
  if (!q) return { ops: [], schemas: [] }

  const ops = []
  const schemas = []

  for (const s of specs) {
    if (specHint && s.id !== specHint) continue

    for (const op of s.operations) {
      let score = 0
      score += scoreText(op.operationId, q) * 3
      score += scoreText(`${op.method} ${op.path}`, q) * 2
      score += scoreText(op.summary, q) * 2
      score += scoreText(op.description, q)
      for (const t of op.tags || []) score += scoreText(t, q) * 2
      score += scoreText((op.parameters || []).map((p) => p?.name).filter(Boolean).join(' '), q) * 2
      score += scoreText([...op.refsUsed].join(' '), q) * 2
      score += scoreText([...op.fieldsUsed].join(' '), q)
      if (score > 0) ops.push({ score, op })
    }

    for (const [name, schema] of Object.entries(s.schemas)) {
      let score = 0
      score += scoreText(name, q) * 3
      score += scoreText(schema?.description, q)
      score += scoreText([...collectSchemaFieldNames(schema, s.doc)].join(' '), q) * 2
      if (score > 0) schemas.push({ score, spec: s, name, schema })
    }
  }

  ops.sort((a, b) => b.score - a.score)
  schemas.sort((a, b) => b.score - a.score)

  return {
    ops: ops.slice(0, limit).map((x) => x.op),
    schemas: schemas.slice(0, limit).map((x) => ({ specId: x.spec.id, name: x.name })),
  }
}

function printTable(rows, { sep = '  ' } = {}) {
  if (!rows.length) return
  const widths = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).length)
    })
  }
  for (const row of rows) {
    const line = row
      .map((cell, i) => String(cell).padEnd(widths[i], ' '))
      .join(sep)
      .trimEnd()
    console.log(line)
  }
}

function printSpecs(specs, { json } = {}) {
  if (json) {
    console.log(JSON.stringify(specs.map(toShortSpec), null, 2))
    return
  }

  const rows = [['id', 'version', 'operations', 'schemas', 'file']]
  for (const s of specs) rows.push([s.id, s.version, String(s.operations.length), String(Object.keys(s.schemas).length), s.filePath])
  printTable(rows)
}

function printTags(specs, { specHint } = {}) {
  const rows = [['spec', 'tag', 'description']]
  for (const s of specs) {
    if (specHint && s.id !== specHint) continue
    for (const t of s.tags || []) rows.push([s.id, t.name, (t.description || '').replaceAll('\n', ' ').slice(0, 80)])
  }
  if (rows.length === 1) die('No tags found')
  printTable(rows)
}

function printOps(specs, { specHint, tag, q, json, limit = 30 } = {}) {
  let ops = []
  for (const s of specs) {
    if (specHint && s.id !== specHint) continue
    ops.push(...s.operations)
  }

  if (tag) ops = ops.filter((o) => (o.tags || []).includes(tag))

  if (q) {
    const res = search(specs, q, { specHint, limit: Math.max(limit, 200) })
    const opSet = new Set(res.ops.map((o) => `${o.specId}:${o.operationId || o.method + ' ' + o.path}`))
    ops = ops.filter((o) => opSet.has(`${o.specId}:${o.operationId || o.method + ' ' + o.path}`))
  }

  ops = ops.slice(0, limit)

  if (json) {
    console.log(
      JSON.stringify(
        ops.map((o) => ({
          spec: o.specId,
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          summary: o.summary,
        })),
        null,
        2,
      ),
    )
    return
  }

  const rows = [['spec', 'operationId', 'method', 'path', 'summary']]
  for (const o of ops) rows.push([o.specId, o.operationId || '-', o.method.toUpperCase(), o.path, (o.summary || '').slice(0, 80)])
  printTable(rows)
}

function splitParams(params) {
  const out = { path: [], query: [], header: [], cookie: [], other: [] }
  for (const p of params || []) {
    const loc = p?.in
    if (loc === 'path') out.path.push(p)
    else if (loc === 'query') out.query.push(p)
    else if (loc === 'header') out.header.push(p)
    else if (loc === 'cookie') out.cookie.push(p)
    else out.other.push(p)
  }
  return out
}

function paramType(param) {
  const s = param?.schema
  if (s) return schemaTypeString(s)
  if (param?.content) {
    const media = Object.values(param.content)[0]
    if (media?.schema) return schemaTypeString(media.schema)
  }
  return 'any'
}

function printParamsBlock(title, params) {
  if (!params.length) return
  console.log(`\n${title}`)
  const rows = [['name', 'in', 'required', 'type', 'description']]
  for (const p of params) {
    rows.push([
      p.name || '-',
      p.in || '-',
      p.required ? 'yes' : 'no',
      paramType(p),
      (p.description || '').replaceAll('\n', ' ').slice(0, 80),
    ])
  }
  printTable(rows)
}

function printOperation(op, spec) {
  const baseUrl = spec.servers?.[0] || ''
  const full = baseUrl ? `${baseUrl}${op.path}` : op.path

  const id = op.operationId ? `${op.specId}:${op.operationId}` : `${op.specId}:${op.method.toUpperCase()} ${op.path}`

  console.log(id)
  console.log(`${op.method.toUpperCase()} ${full}`)

  if (op.summary) console.log(`\n${op.summary}`)
  if (op.deprecated) console.log(`\nDeprecated: yes`)

  const auth = op.securityLabel
  if (auth) console.log(`\nAuth: ${auth}`)

  if (op.tags?.length) console.log(`Tags: ${op.tags.join(', ')}`)

  if (op.description) {
    const desc = String(op.description).trim().replace(/\n{3,}/g, '\n\n')
    const short = desc.length > 800 ? `${desc.slice(0, 800)}\n...` : desc
    console.log(`\n${short}`)
  }

  const params = splitParams(op.parameters || [])
  printParamsBlock('Path params', params.path)
  printParamsBlock('Query params', params.query)
  printParamsBlock('Header params', params.header)

  if (op.requestBody?.content) {
    console.log('\nBody')
    const required = op.requestBody.required ? 'required' : 'optional'
    console.log(`required: ${required}`)

    const contentTypes = Object.keys(op.requestBody.content)
    for (const ct of contentTypes) {
      const schema = op.requestBody.content?.[ct]?.schema
      if (!schema) continue
      console.log(`\n${ct}`)
      const lines = formatSchemaPreview(schema, spec.doc, { depth: 3, maxProps: 12 })
      for (const l of lines) console.log(l)

      if (ct === 'application/json') {
        const ex = exampleFromSchema(schema, spec.doc, { depth: 3, includeOptional: false })
        if (ex && typeof ex === 'object') {
          console.log('\nexample (required fields)')
          console.log(JSON.stringify(ex, null, 2))
        }
      }
    }
  }

  if (op.responses && Object.keys(op.responses).length) {
    console.log('\nResponses')
    const codes = Object.keys(op.responses).sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
      if (a === 'default') return 1
      if (b === 'default') return -1
      return a.localeCompare(b)
    })

    for (const code of codes) {
      const resp = derefObject(op.responses[code], spec.doc)
      const desc = resp?.description ? ` - ${String(resp.description).replaceAll('\n', ' ').slice(0, 80)}` : ''
      console.log(`\n${code}${desc}`)

      const content = resp?.content || {}
      for (const [ct, media] of Object.entries(content)) {
        if (!media?.schema) continue
        console.log(`${ct}`)
        const lines = formatSchemaPreview(media.schema, spec.doc, { depth: 3, maxProps: 12 })
        for (const l of lines) console.log(l)
      }
    }
  }

  console.log('\ncurl')
  console.log(formatCurl(op, spec))
}

function replacePathParams(p) {
  return p.replaceAll(/\{([^}]+)\}/g, '<$1>')
}

function formatCurl(op, spec) {
  const baseUrl = spec.servers?.[0] || ''
  let url = baseUrl ? `${baseUrl}${replacePathParams(op.path)}` : replacePathParams(op.path)

  const requiredQuery = (op.parameters || [])
    .filter((p) => p?.in === 'query' && p?.required && p?.name)
    .map((p) => `${encodeURIComponent(p.name)}=<${p.name}>`)
  if (requiredQuery.length) url += `?${requiredQuery.join('&')}`

  const lines = []
  lines.push(`curl -X ${op.method.toUpperCase()} '${url}' \\`)

  // auth header if we can infer it
  const schemes = spec?.doc?.components?.securitySchemes || {}
  const sec = Array.isArray(op.security) ? op.security : null
  const candidates = (sec || []).filter((x) => x && typeof x === 'object')
  const preferred =
    candidates.find((req) =>
      Object.keys(req).some((name) => schemes[name]?.type === 'apiKey' && schemes[name]?.in === 'header'),
    ) || candidates[0]

  for (const name of Object.keys(preferred || {})) {
    const s = schemes[name]
    if (s?.type === 'apiKey' && s.in === 'header' && s.name) {
      lines.push(`  -H '${s.name}: $KAPSO_API_KEY' \\`)
    } else if (s?.type === 'http' && s.scheme === 'bearer') {
      lines.push(`  -H 'Authorization: Bearer $ACCESS_TOKEN' \\`)
    }
  }

  // content-type + body for JSON
  const jsonSchema = op.requestBody?.content?.['application/json']?.schema
  if (jsonSchema) {
    const ex = exampleFromSchema(jsonSchema, spec.doc, { depth: 4, includeOptional: false })
    lines.push(`  -H 'Content-Type: application/json' \\`)
    lines.push(`  -d '${JSON.stringify(ex ?? {}, null, 0)}'`)
    return lines.join('\n')
  }

  // trim trailing backslash
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\\\$/, '')
  return lines.join('\n')
}

function printSchemaDetails(match, specs, { includeUsedBy = true } = {}) {
  const { spec, name, schema } = match
  console.log(`${spec.id}:${name}`)

  const normalized = schema?.allOf ? mergeAllOf(schema, spec.doc) : schema
  const typeStr = schemaTypeString(normalized)
  console.log(typeStr)

  if (normalized?.description) console.log(`\n${String(normalized.description).trim()}`)

  const required = normalized?.required || []
  if (required.length) console.log(`\nrequired: ${required.join(', ')}`)

  if (normalized?.properties || normalized?.items) {
    console.log('\nshape')
    const lines = formatSchemaPreview(normalized, spec.doc, { depth: 3, maxProps: 25 })
    for (const l of lines) console.log(l)
  }

  const ex = exampleFromSchema(normalized, spec.doc, { depth: 4, includeOptional: false })
  if (ex && typeof ex === 'object') {
    console.log('\nexample (required fields)')
    console.log(JSON.stringify(ex, null, 2))
  }

  if (includeUsedBy) {
    const usedBy = []
    for (const s of specs) {
      for (const op of s.operations) {
        if (op.refsUsed?.has(name)) usedBy.push(op)
      }
    }

    if (usedBy.length) {
      console.log('\nused by')
      const rows = [['spec', 'operationId', 'method', 'path']]
      for (const op of usedBy.slice(0, 30)) rows.push([op.specId, op.operationId || '-', op.method.toUpperCase(), op.path])
      printTable(rows)
      if (usedBy.length > 30) console.log(`... (${usedBy.length - 30} more)`)
    }
  }
}

function printWhere(specs, schemaQuery, { specHint, json, limit = 30 } = {}) {
  const matches = findSchema(specs, schemaQuery, { specHint })
  if (!matches.length) die(`Schema not found: ${schemaQuery}`)
  if (matches.length > 1 && !schemaQuery.includes(':')) {
    die(`Schema exists in multiple specs. Use specId:SchemaName\n${matches.map((m) => `- ${m.spec.id}:${m.name}`).join('\n')}`)
  }

  const { name } = matches[0]
  const usedBy = []
  for (const s of specs) {
    if (specHint && s.id !== specHint) continue
    for (const op of s.operations) {
      if (op.refsUsed?.has(name)) usedBy.push(op)
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        usedBy.slice(0, limit).map((o) => ({
          spec: o.specId,
          operationId: o.operationId,
          method: o.method,
          path: o.path,
          summary: o.summary,
        })),
        null,
        2,
      ),
    )
    return
  }

  if (!usedBy.length) {
    console.log('No operations reference this schema (via $ref).')
    return
  }

  const rows = [['spec', 'operationId', 'method', 'path', 'summary']]
  for (const o of usedBy.slice(0, limit)) rows.push([o.specId, o.operationId || '-', o.method.toUpperCase(), o.path, (o.summary || '').slice(0, 80)])
  printTable(rows)
  if (usedBy.length > limit) console.log(`... (${usedBy.length - limit} more)`)
}

async function main() {
  const { opts, command, rest } = parseArgs(process.argv.slice(2))
  if (!command) printHelp(1)

  let sources = []
  let sourceMode = 'explicit'

  if (opts.files.length) {
    sources = opts.files
    sourceMode = 'explicit'
  } else if (opts.all) {
    const apiDir = findLocalApiDir()
    sources = apiDir ? walk(apiDir, { filePattern: /^openapi-.*\.ya?ml$/ }) : []
    sourceMode = 'explicit'
  } else {
    sources = deducePublishedOpenApiUrls(DEFAULT_PUBLISHED_WHATSAPP_OPENAPI)
    sourceMode = 'default_remote'
  }

  const specs = await loadSpecsAsync({ sources, sourceMode, specFilter: opts.spec })

  if (command === 'specs') return printSpecs(specs, { json: opts.json })
  if (command === 'tags') return printTags(specs, { specHint: opts.spec })
  if (command === 'ops') return printOps(specs, { specHint: opts.spec, tag: opts.tag, q: opts.q, json: opts.json, limit: opts.limit })
  if (command === 'search') {
    const q = rest.join(' ').trim()
    if (!q) die('Usage: search <query>')
    const res = search(specs, q, { specHint: opts.spec, limit: opts.limit })
    if (opts.json) {
      return console.log(
        JSON.stringify(
          {
            ops: res.ops.map((o) => ({
              spec: o.specId,
              operationId: o.operationId,
              method: o.method,
              path: o.path,
              summary: o.summary,
            })),
            schemas: res.schemas,
          },
          null,
          2,
        ),
      )
    }

    if (!res.ops.length && !res.schemas.length) {
      console.log('No matches.')
      return
    }

    if (res.ops.length) {
      console.log('ops')
      const rows = [['spec', 'operationId', 'method', 'path', 'summary']]
      for (const o of res.ops) rows.push([o.specId, o.operationId || '-', o.method.toUpperCase(), o.path, (o.summary || '').slice(0, 80)])
      printTable(rows)
    }
    if (res.schemas.length) {
      console.log('\nschemas')
      const rows = [['spec', 'name']]
      for (const s of res.schemas) rows.push([s.specId, s.name])
      printTable(rows)
    }
    return
  }
  if (command === 'op') {
    const q = rest.join(' ').trim()
    if (!q) die('Usage: op <operationId | specId:operationId | "METHOD /path">')
    const matches = findOperation(specs, q, { specHint: opts.spec })
    if (!matches.length) {
      const res = search(specs, q, { specHint: opts.spec, limit: 10 })
      if (res.ops.length) {
        console.log(`Operation not found: ${q}\n`)
        console.log('closest ops')
        const rows = [['spec', 'operationId', 'method', 'path', 'summary']]
        for (const o of res.ops) rows.push([o.specId, o.operationId || '-', o.method.toUpperCase(), o.path, (o.summary || '').slice(0, 80)])
        printTable(rows)
        process.exit(1)
      }
      die(`Operation not found: ${q}`)
    }
    if (matches.length > 1 && !q.includes(':') && !q.match(/^(get|post|put|patch|delete|options|head)\\s+/i)) {
      die(`OperationId exists in multiple specs. Use specId:operationId\n${matches.map((m) => `- ${m.specId}:${m.operationId}`).join('\n')}`)
    }
    const op = matches[0]
    const spec = specs.find((s) => s.id === op.specId)
    if (!spec) die(`Internal error: missing spec ${op.specId}`)
    printOperation(op, spec)
    return
  }
  if (command === 'schema') {
    const q = rest.join(' ').trim()
    if (!q) die('Usage: schema <SchemaName | specId:SchemaName>')
    const matches = findSchema(specs, q, { specHint: opts.spec })
    if (!matches.length) {
      const res = search(specs, q, { specHint: opts.spec, limit: 10 })
      if (res.schemas.length) {
        console.log(`Schema not found: ${q}\n`)
        console.log('closest schemas')
        const rows = [['spec', 'name']]
        for (const s of res.schemas) rows.push([s.specId, s.name])
        printTable(rows)
        process.exit(1)
      }
      die(`Schema not found: ${q}`)
    }
    if (matches.length > 1 && !q.includes(':')) {
      die(`Schema exists in multiple specs. Use specId:SchemaName\n${matches.map((m) => `- ${m.spec.id}:${m.name}`).join('\n')}`)
    }
    printSchemaDetails(matches[0], specs, { includeUsedBy: true })
    return
  }
  if (command === 'where') {
    const q = rest.join(' ').trim()
    if (!q) die('Usage: where <SchemaName | specId:SchemaName>')
    return printWhere(specs, q, { specHint: opts.spec, json: opts.json, limit: opts.limit })
  }

  die(`Unknown command: ${command}`)
}

main().catch((e) => die(e?.stack || e?.message || String(e)))
