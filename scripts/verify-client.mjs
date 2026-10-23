// Check the browser half of the plugin without a browser.
//
// The bundle is a plain script that registers itself with the harness module
// loader. This script provides a small fake of the loader, of React, and of
// the client context, then asserts that the panel registers the sidebar entry
// and the main panel the harness expects.
//
// Usage: node scripts/verify-client.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** The fake module loader: it captures the bundle's registration. */
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry
    },
  },
}

await import(`data:text/javascript,${encodeURIComponent(bundle)}`)

if (registered === null) throw new Error('the bundle did not register itself')
if (registered.id !== 'dsh-data-dbx') throw new Error(`unexpected bundle id: ${registered.id}`)

/** A React stub: enough for the panel's rendering shape. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => undefined],
  useEffect: () => undefined,
  useCallback: (callback) => callback,
  useRef: (initial) => ({ current: initial }),
  Fragment: 'fragment',
}

const module = registered.factory(id => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

if (typeof module.apply !== 'function') throw new Error('the bundle exports no apply')
if (!Array.isArray(module.inject) || !module.inject.includes('slots')) {
  throw new Error(`the bundle injects the wrong services: ${JSON.stringify(module.inject)}`)
}

/** The fake client context: it records what the panel registers. */
const calls = { locale: [], slots: [] }
const context = {
  effect: (execute) => {
    const dispose = execute()
    if (typeof dispose === 'function') dispose()
  },
  locale: {
    register: (ns, dicts) => {
      calls.locale.push({ ns, dicts })
      return () => undefined
    },
    bind: (ns) => (key) => `${ns}:${key}`,
  },
  slots: {
    inject: (name, register) => {
      calls.slots.push({ name })
      register()
      return () => undefined
    },
    register: (options, component) => {
      calls.slots.push({ registered: options, component })
      return () => undefined
    },
  },
}

module.apply(context)

const sidebar = calls.slots.find(entry => entry.registered?.name === 'sidebar.panellist')
if (sidebar === undefined) throw new Error('the sidebar entry was not registered')
if (sidebar.registered.id !== 'dsh-data-dbx') throw new Error('the sidebar entry has the wrong id')

const main = calls.slots.find(entry => entry.registered?.name === 'main')
if (main === undefined) throw new Error('the main panel was not registered')
if (main.registered.key !== sidebar.registered.id) {
  throw new Error('the main panel key must equal the sidebar id')
}

const dictionary = calls.locale.find(entry => entry.ns === 'dataDbx.panel')
if (dictionary === undefined) throw new Error('the dictionaries were not registered')
for (const language of ['zh', 'en']) {
  if (typeof dictionary.dicts[language] !== 'object') throw new Error(`the ${language} dictionary is missing`)
}
for (const key of ['panel', 'run', 'newConnection', 'connections', 'schema', 'schemaHint']) {
  if (typeof dictionary.dicts.zh[key] !== 'string') throw new Error(`the zh dictionary lacks ${key}`)
  if (typeof dictionary.dicts.en[key] !== 'string') throw new Error(`the en dictionary lacks ${key}`)
}

// The schema field belongs to the engines that have one, and the form must
// decide that from the host's catalog rather than from a hard-coded list: a
// field offered where nothing honours it is worse than no field at all.
if (!/engine\.schema && selfBuilt/.test(bundle)) {
  throw new Error('the schema field is not gated on the engine declaring a schema')
}
if (!/schema: engine\.schema \? schema\.trim\(\) : undefined/.test(bundle)) {
  throw new Error('the schema is not sent with the connection body')
}
if (!/dbx-conn-sub[\s\S]{0,400}connection\.schema\.length > 0/.test(bundle)) {
  throw new Error('the connection list does not show the schema')
}

console.log('client bundle ok:', {
  id: registered.id,
  inject: module.inject,
  sidebar: { id: sidebar.registered.id, order: sidebar.registered.order },
  main: { key: main.registered.key },
  dictionaries: Object.keys(dictionary.dicts),
})

// --- stylesheet audit -------------------------------------------------------
//
// The panel paints itself with the harness theme tokens. Two mistakes are easy
// to make and stay invisible until a human opens the panel, so assert them
// here:
//
//   1. A token the harness never defines — the declaration is dropped by the
//      CSS parser and the element silently falls back to an inherited colour.
//   2. A primary fill paired with a label token of the same hue. DSH's
//      --dsw-alias-brand-primary is near-black in light mode and near-white in
//      dark mode, and --dsw-alias-brand-text resolves to that very same value,
//      so the pair yields a 1:1 contrast ratio: invisible text on the button.

const styleMatch = /const STYLE = `([\s\S]*?)`/.exec(bundle)
if (styleMatch === null) throw new Error('the bundle carries no style sheet')
const style = styleMatch[1]

/** Tokens the harness actually defines; verified against the app stylesheet. */
const KNOWN_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-mask-2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
])

/** Tokens that share the value of --dsw-alias-brand-primary; never a label. */
const FORBIDDEN_LABELS = new Set(['--dsw-alias-brand-text'])

const used = new Set(style.match(/--dsw-alias-[a-z0-9-]+/g) ?? [])
const unknown = [...used].filter((token) => !KNOWN_TOKENS.has(token))
if (unknown.length > 0) throw new Error(`the style sheet uses undefined tokens: ${unknown.join(', ')}`)

const forbidden = [...used].filter((token) => FORBIDDEN_LABELS.has(token))
if (forbidden.length > 0) throw new Error(`the style sheet paints with same-hue labels: ${forbidden.join(', ')}`)

// An unbalanced var() silently kills the whole declaration, which is how the
// connection hover and selected states went missing once already.
if (style.includes('))')) {
  const offset = style.indexOf('))')
  throw new Error(`the style sheet has an unbalanced var(): ${style.slice(Math.max(0, offset - 60), offset + 2)}`)
}

const FILLS = ['var(--dsw-alias-brand-primary)', 'var(--dsw-alias-button-primary-fill)']
const rules = style.split('}').map((rule) => rule.trim()).filter((rule) => rule.length > 0)
for (const rule of rules) {
  const isFilled = FILLS.some((fill) => rule.includes(`background: ${fill}`))
  if (isFilled && !rule.includes('color: var(--dsw-alias-label-primary-inverted)')) {
    throw new Error(`a brand-filled rule has no inverted label: ${rule.split('\n')[0]}`)
  }
}

console.log('stylesheet ok:', { rules: rules.length, tokens: used.size })
