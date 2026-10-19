import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveOpenAiTranscriptionUrl,
  sanitizeOpenAiTranscriptionErrorMessage
} from './openai-transcription-client'

describe('sanitizeOpenAiTranscriptionErrorMessage', () => {
  it('does not expose the invalid OpenAI API key echoed by the provider', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Incorrect API key provided: fsdfdsfsdf. You can find your API key at https://platform.openai.com/account/api-keys.'
      )
    ).toBe('Incorrect OpenAI API key provided.')
  })

  it('redacts API keys and bearer tokens from other provider errors', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Request failed for sk-testSecret123 with Authorization: Bearer token-value_123'
      )
    ).toBe('Request failed for [redacted] with Authorization: Bearer [redacted]')
  })
})

describe('resolveOpenAiTranscriptionUrl', () => {
  const originalBaseUrl = process.env.OPENAI_BASE_URL

  beforeEach(() => {
    delete process.env.OPENAI_BASE_URL
  })

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL
    } else {
      process.env.OPENAI_BASE_URL = originalBaseUrl
    }
  })

  it('defaults to the hosted OpenAI endpoint', () => {
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'https://api.openai.com/v1/audio/transcriptions'
    )
  })

  it('honours OPENAI_BASE_URL for a local gateway', () => {
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:20128'
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'http://127.0.0.1:20128/v1/audio/transcriptions'
    )
  })

  it('normalises trailing slashes and surrounding whitespace', () => {
    process.env.OPENAI_BASE_URL = ' http://127.0.0.1:20128/// '
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'http://127.0.0.1:20128/v1/audio/transcriptions'
    )
  })

  it('prefers an explicit base URL over the environment', () => {
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:20128'
    expect(resolveOpenAiTranscriptionUrl('https://gateway.internal')).toBe(
      'https://gateway.internal/v1/audio/transcriptions'
    )
  })
})
