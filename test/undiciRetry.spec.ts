import { Client } from 'undici'
import type { Dispatcher } from 'undici'
import { getLocal } from 'mockttp'
import { describe, afterEach, beforeEach, it, expect } from 'vitest'
import { DEFAULT_RETRY_CONFIG, sendWithRetry } from '../lib/undiciRetry'

const baseUrl = 'http://localhost:4000/'
const JSON_HEADERS = {
  'content-type': 'application/json',
}

const TEXT_HEADERS = {
  'content-type': 'text/plain',
}

const request: Dispatcher.RequestOptions = {
  method: 'GET',
  path: '/',
}

const mockServer = getLocal()

describe('undiciRetry', () => {
  let client: Client
  beforeEach(async () => {
    await mockServer.start(4000)
    client = new Client(baseUrl)
  })
  afterEach(async () => {
    await mockServer.stop()
  })

  describe('requests', () => {
    it('retry on specified status codes', async () => {
      await mockServer.forGet('/').thenReply(500, 'A mocked response1')
      await mockServer.forGet('/').thenReply(502, 'A mocked response2')
      await mockServer.forGet('/').thenReply(200, 'A mocked response3')
      await mockServer.forGet('/').thenReply(200, 'A mocked response4')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 0,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual('A mocked response3')
    })

    it('default does not retry', async () => {
      await mockServer.forGet('/').thenReply(500, 'A mocked response1')
      await mockServer.forGet('/').thenReply(200, 'A mocked response3')

      const response = await sendWithRetry(client, request, DEFAULT_RETRY_CONFIG)

      expect(response.error).toBeDefined()
      expect(response.error?.statusCode).toEqual(500)
      expect(response.error?.body).toEqual('A mocked response1')
    })

    it('do not retry on success', async () => {
      await mockServer.forGet('/').thenReply(200, 'A mocked response1')
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')
      await mockServer.forGet('/').thenReply(200, 'A mocked response3')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 0,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual('A mocked response1')
    })

    it('propagates error in case of invalid response content-type if no retries left', async () => {
      await mockServer.forGet('/').thenReply(200, 'err', 'Not actually a JSON', JSON_HEADERS)
      expect.assertions(1)

      try {
        await sendWithRetry(client, request, {
          maxAttempts: 3,
          delayBetweenAttemptsInMsecs: 0,
          statusCodesToRetry: [500, 502, 503],
          retryOnTimeout: false,
          safeParseJson: true,
        })
      } catch (err: any) {
        expect(err.message).toBe('Error while parsing HTTP JSON response')
      }
    })

    it('retries in case of invalid response content-type correctly if retries left', async () => {
      await mockServer.forGet('/').thenReply(502, 'err', 'Not actually a JSON', JSON_HEADERS)
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 50,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
        safeParseJson: true,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual('A mocked response2')
    })

    it('handles non-json content', async () => {
      await mockServer.forGet('/').thenReply(200, 'err', 'Not actually a JSON', TEXT_HEADERS)

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 0,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
        safeParseJson: true,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual('Not actually a JSON')
    })

    it('handles json content', async () => {
      await mockServer.forGet('/').thenReply(
        200,
        'err',
        JSON.stringify({
          id: 1,
        }),
        JSON_HEADERS,
      )

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 0,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
        safeParseJson: false,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual({
        id: 1,
      })
    })

    it('retry on connection closed', async () => {
      await mockServer.forGet('/').thenCloseConnection()
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 0,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual('A mocked response2')
    })

    it('retry on connection reset', async () => {
      await mockServer.forGet('/').thenResetConnection()
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 0,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual('A mocked response2')
    })

    it('retry on timeout if enabled', async () => {
      await mockServer.forGet('/').thenTimeout()
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')

      const response = await sendWithRetry(
        client,
        {
          ...request,
          bodyTimeout: 500,
          headersTimeout: 500,
        },
        {
          maxAttempts: 3,
          delayBetweenAttemptsInMsecs: 0,
          statusCodesToRetry: [500, 502, 503],
          retryOnTimeout: true,
        },
      )

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toEqual('A mocked response2')
    })

    it('do not retry on timeout if disabled', async () => {
      await mockServer.forGet('/').thenTimeout()
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')

      expect.assertions(1)

      try {
        await sendWithRetry(
          client,
          {
            ...request,
            bodyTimeout: 500,
            headersTimeout: 500,
          },
          {
            maxAttempts: 3,
            delayBetweenAttemptsInMsecs: 0,
            statusCodesToRetry: [500, 502, 503],
            retryOnTimeout: false,
          },
        )
      } catch (err: any) {
        expect(err.message).toBe('Headers Timeout Error')
      }
    })

    it('throw internal error if max retries exceeded', async () => {
      await mockServer.forGet('/').thenCloseConnection()
      await mockServer.forGet('/').thenCloseConnection()
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')

      expect.assertions(1)

      try {
        await sendWithRetry(client, request, {
          maxAttempts: 2,
          delayBetweenAttemptsInMsecs: 10,
          statusCodesToRetry: [500, 502, 503],
          retryOnTimeout: false,
        })
      } catch (err: any) {
        expect(err.message).toBe('other side closed')
      }
    })

    it('return error response if error is not retriable', async () => {
      await mockServer.forGet('/').thenReply(400, 'status message', 'Invalid request', {})
      await mockServer.forGet('/').thenReply(200, 'A mocked response2')

      const result = await sendWithRetry(client, request, {
        maxAttempts: 2,
        delayBetweenAttemptsInMsecs: 10,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
      })

      expect(result!.error!.statusCode).toBe(400)
      expect(result!.error!.body).toBe('Invalid request')
    })

    it('returns body as blob', async () => {
      const mockedResponse = {
        hello: 'world',
      }
      await mockServer.forGet('/').thenReply(200, 'ok', JSON.stringify(mockedResponse))

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        delayBetweenAttemptsInMsecs: 0,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
        safeParseJson: true,
        blobBody: true,
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
      expect(response.result?.body).toBeInstanceOf(Blob)
      expect(response.result?.body).toEqual(new Blob([JSON.stringify(mockedResponse)]))
    })
  })

  describe('DelayResolver', () => {
    it('does not retry on -1', async () => {
      await mockServer.forGet('/').thenReply(500, 'A mocked response1')
      await mockServer.forGet('/').thenReply(502, 'A mocked response2')
      await mockServer.forGet('/').thenReply(200, 'A mocked response3')
      await mockServer.forGet('/').thenReply(200, 'A mocked response4')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
        delayResolver: (response) => {
          if (response.statusCode === 500) {
            return 100
          }
          return -1
        },
      })

      expect(response.error).toBeDefined()
      expect(response.error?.statusCode).toEqual(502)
      expect(response.error?.body).toEqual('A mocked response2')
    })

    it('does not invoke delay resolved on unspecified codes', async () => {
      await mockServer.forGet('/').thenReply(500, 'A mocked response1')
      await mockServer.forGet('/').thenReply(502, 'A mocked response2')
      await mockServer.forGet('/').thenReply(200, 'A mocked response3')
      await mockServer.forGet('/').thenReply(200, 'A mocked response4')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        statusCodesToRetry: [502, 503],
        retryOnTimeout: false,
        delayResolver: (response) => {
          if (response.statusCode === 500) {
            return 100
          }
          return -1
        },
      })

      expect(response.error).toBeDefined()
      expect(response.error?.statusCode).toEqual(500)
      expect(response.error?.body).toEqual('A mocked response1')
    })

    it('fallbacks to set retry time if resolver returns undefined', async () => {
      await mockServer.forGet('/').thenReply(500, 'A mocked response1')
      await mockServer.forGet('/').thenReply(502, 'A mocked response2')
      await mockServer.forGet('/').thenReply(200, 'A mocked response3')
      await mockServer.forGet('/').thenReply(200, 'A mocked response4')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
        delayBetweenAttemptsInMsecs: 30,
        delayResolver: () => {
          return undefined
        },
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
    })

    it('fallbacks to immediate retry if everything returns undefined', async () => {
      await mockServer.forGet('/').thenReply(500, 'A mocked response1')
      await mockServer.forGet('/').thenReply(502, 'A mocked response2')
      await mockServer.forGet('/').thenReply(200, 'A mocked response3')
      await mockServer.forGet('/').thenReply(200, 'A mocked response4')

      const response = await sendWithRetry(client, request, {
        maxAttempts: 3,
        statusCodesToRetry: [500, 502, 503],
        retryOnTimeout: false,
        delayResolver: () => {
          return undefined
        },
      })

      expect(response.result).toBeDefined()
      expect(response.result?.statusCode).toEqual(200)
    })
  })
})
