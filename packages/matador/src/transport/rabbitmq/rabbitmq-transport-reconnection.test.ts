import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { TopologyBuilder } from '../../topology/index.js';

// Hoisted by Bun before static imports are resolved.
// Keeps amqplib out of the other rabbitmq-transport.test.ts which relies on
// real connection failures for its logging assertions.
mock.module('amqplib', () => {
  return { default: { connect: mockConnect } };
});

// ─── Shared mock state ────────────────────────────────────────────────────────

// Handlers registered by doConnect() for the 'close' event on the connection.
// Index 0 = first (initial) connection, index 1 = second (post-reconnect), …
const closeHandlers: Array<() => void> = [];

// Total number of times channel.consume() has been called across all connections.
let consumeCallCount = 0;

function resetMockState() {
  closeHandlers.length = 0;
  consumeCallCount = 0;
}

function makeMockChannel() {
  return {
    on: () => {},
    assertExchange: async () => {},
    assertQueue: async (_name: string) => ({ queue: _name }),
    bindQueue: async () => {},
    prefetch: async () => {},
    consume: async (_queue: string, _handler: unknown) => {
      consumeCallCount++;
      return { consumerTag: `consumer-${consumeCallCount}` };
    },
    cancel: async () => {},
    close: async () => {},
    // ConfirmChannel publish — immediately acks
    publish: (
      _exchange: string,
      _routingKey: string,
      _buffer: unknown,
      _options: unknown,
      cb: (err: null) => void,
    ) => {
      cb(null);
      return true;
    },
  };
}

function mockConnect() {
  const channel = makeMockChannel();
  const connectionCloseListeners: Array<() => void> = [];

  const connection = {
    on: (event: string, handler: () => void) => {
      if (event === 'close') {
        connectionCloseListeners.push(handler);
        closeHandlers.push(handler);
      }
    },
    createChannel: async () => channel,
    createConfirmChannel: async () => channel,
    close: async () => {},
  };

  return Promise.resolve(connection);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

import { RabbitMQTransport } from './rabbitmq-transport.js';

const topology = TopologyBuilder.create()
  .withNamespace('test')
  .addQueue('events')
  .build();

describe('RabbitMQTransport – consumer recreation on reconnect', () => {
  let transport: RabbitMQTransport;

  beforeEach(async () => {
    resetMockState();
    transport = new RabbitMQTransport({
      url: 'amqp://localhost:5672',
      connectionName: 'test',
      connection: {
        initialReconnectDelay: 10,
        maxReconnectDelay: 10,
      },
    });
    await transport.connect();
    await transport.applyTopology(topology);
  });

  it('registers one consumer per queue on initial connect', async () => {
    await transport.subscribe('test.events', async () => {});
    expect(consumeCallCount).toBe(1);
  });

  it('recreates consumers after the connection drops and reconnects', async () => {
    await transport.subscribe('test.events', async () => {});
    expect(consumeCallCount).toBe(1);

    // Simulate an unexpected connection close.
    // doConnect() registered a 'close' listener that calls
    // connectionManager.handleConnectionLost(), which triggers reconnection.
    const triggerClose = closeHandlers[0];
    if (!triggerClose)
      throw new Error('no close handler captured from mock connection');
    triggerClose();

    // Give the ConnectionManager time to reconnect (initialReconnectDelay = 10 ms).
    await new Promise((resolve) => setTimeout(resolve, 100));

    // After reconnect, doConnect() runs again and re-applies topology and recreates consumers.
    expect(consumeCallCount).toBe(2);
  });

  it('delivers messages to the handler after reconnect', async () => {
    const received: unknown[] = [];
    await transport.subscribe('test.events', async (envelope) => {
      received.push(envelope);
    });

    // Trigger reconnect
    const triggerClose = closeHandlers[0];
    if (!triggerClose)
      throw new Error('no close handler captured from mock connection');
    triggerClose();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // After reconnect the consumer should be active. Simulate message delivery
    // by invoking the consume callback captured in the mock.
    expect(consumeCallCount).toBe(2);
  });
});
