import { afterEach, describe, expect, it } from 'vitest'
import {
  SCREENDRAW_KEYWORD,
  SCREENDRAW_KEYWORD_BINDING_ID,
  displayShortcut,
  findOwnKeywordBinding,
  persistentBindingActive,
  resolvePluginUuid,
  setMacPlatformForTests,
  shortcutFromKeyboardEvent,
} from './shortcutBinding'

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent
}

afterEach(() => setMacPlatformForTests(null))

describe('shortcutFromKeyboardEvent', () => {
  it('builds modifier chains with the main key last (non-mac)', () => {
    setMacPlatformForTests(false)
    expect(
      shortcutFromKeyboardEvent(keyEvent({ key: 'd', ctrlKey: true, shiftKey: true })),
    ).toBe('CommandOrControl+Shift+D')
    expect(shortcutFromKeyboardEvent(keyEvent({ key: '8', altKey: true }))).toBe('Alt+8')
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'F8' }))).toBe('F8')
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'F9', ctrlKey: true }))).toBe('CommandOrControl+F9')
  })

  it('keeps Command and Control distinct on mac', () => {
    setMacPlatformForTests(true)
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'd', metaKey: true, shiftKey: true }))).toBe('Command+Shift+D')
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'd', ctrlKey: true }))).toBe('Control+D')
    expect(shortcutFromKeyboardEvent(keyEvent({ key: '8', altKey: true }))).toBe('Alt+8')
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'F8' }))).toBe('F8')
  })

  it('rejects modifier-only presses and unsupported main keys', () => {
    setMacPlatformForTests(false)
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'Meta', metaKey: true }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'Escape' }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'ArrowDown', ctrlKey: true }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyEvent({ key: ';', ctrlKey: true }))).toBeNull()
  })

  it('requires a strong modifier for letters and digits (no shift-only hijack)', () => {
    setMacPlatformForTests(false)
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'd' }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'D', shiftKey: true }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyEvent({ key: 'd', altKey: true }))).toBe('Alt+D')
  })
})

describe('displayShortcut', () => {
  it('renders mac symbols on mac and text forms elsewhere', () => {
    setMacPlatformForTests(true)
    expect(displayShortcut('CommandOrControl+Shift+D')).toBe('⌘⇧D')
    setMacPlatformForTests(false)
    expect(displayShortcut('CommandOrControl+Shift+D')).toBe('Ctrl+Shift+D')
    expect(displayShortcut('Alt+F8')).toBe('Alt+F8')
    expect(displayShortcut('Control+Alt+P')).toBe('Ctrl+Alt+P')
  })
})

describe('findOwnKeywordBinding', () => {
  const own = {
    id: SCREENDRAW_KEYWORD_BINDING_ID,
    pluginUuid: 'OTools-Screendraw',
    shortcut: 'CommandOrControl+Shift+D',
    keyword: SCREENDRAW_KEYWORD,
    enabled: true,
  }

  it('prefers the stable id match regardless of uuid case', () => {
    const list = [
      { id: 'other', pluginUuid: 'otools-screendraw', shortcut: 'Alt+L', keyword: SCREENDRAW_KEYWORD, enabled: false },
      own,
    ]
    expect(findOwnKeywordBinding(list, 'otools-screendraw')).toMatchObject({
      id: SCREENDRAW_KEYWORD_BINDING_ID,
      enabled: true,
    })
  })

  it('falls back to a keyword match from the host settings page', () => {
    const list = [
      { id: 'kw-1', pluginUuid: 'otools-screendraw', shortcut: 'Ctrl+Alt+Z', keyword: 'launch', enabled: true },
    ]
    expect(findOwnKeywordBinding(list, 'otools-screendraw')).toMatchObject({ id: 'kw-1', shortcut: 'Ctrl+Alt+Z' })
  })

  it('skips malformed entries, foreign plugins and empty shortcuts', () => {
    const list = [
      null,
      'oops',
      { pluginUuid: 'otools-screendraw', shortcut: 'Alt+X', keyword: 'launch' },
      { id: 'x', pluginUuid: 'otools-other', shortcut: 'Alt+X', keyword: 'launch', enabled: true },
      { id: 'y', pluginUuid: 'otools-screendraw', shortcut: '', keyword: 'launch', enabled: true },
      { id: 'z', pluginUuid: 'otools-screendraw', shortcut: 'Alt+X', keyword: 'other', enabled: true },
    ]
    expect(findOwnKeywordBinding(list, 'otools-screendraw')).toBeNull()
    expect(findOwnKeywordBinding({}, 'otools-screendraw')).toBeNull()
    expect(findOwnKeywordBinding(null, 'otools-screendraw')).toBeNull()
  })
})

describe('persistentBindingActive', () => {
  it('is true only for enabled non-empty bindings', () => {
    expect(persistentBindingActive(null)).toBe(false)
    expect(persistentBindingActive({ id: '', pluginUuid: '', shortcut: 'Alt+D', keyword: '', enabled: false })).toBe(false)
    expect(persistentBindingActive({ id: '', pluginUuid: '', shortcut: '', keyword: '', enabled: true })).toBe(false)
    expect(persistentBindingActive({ id: '', pluginUuid: '', shortcut: 'Alt+D', keyword: '', enabled: true })).toBe(true)
  })
})

describe('resolvePluginUuid', () => {
  it('prefers the injected env uuid and falls back to the manifest uuid', () => {
    expect(resolvePluginUuid('otools-screendraw-dev')).toBe('otools-screendraw-dev')
    expect(resolvePluginUuid('   ')).toBe('otools-screendraw')
    expect(resolvePluginUuid(undefined)).toBe('otools-screendraw')
    expect(resolvePluginUuid(42)).toBe('otools-screendraw')
  })
})
