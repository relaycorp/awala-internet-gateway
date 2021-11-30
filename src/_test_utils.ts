import {
  CargoCollectionAuthorization,
  CargoCollectionRequest,
  Certificate,
  issueDeliveryAuthorization,
  issueGatewayCertificate,
  SessionEnvelopedData,
  SessionKey,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { BinaryLike, createHash, Hash } from 'crypto';
import { Connection, createConnection } from 'mongoose';
import pino, { symbols as PinoSymbols } from 'pino';
import split2 from 'split2';

import { reSerializeCertificate } from './services/_test_utils';

export const TOMORROW = new Date();
TOMORROW.setDate(TOMORROW.getDate() + 1);

export const UUID4_REGEX = expect.stringMatching(/^[0-9a-f-]+$/);

export const MONGO_ENV_VARS = {
  MONGO_DB: 'the_db',
  MONGO_PASSWORD: 'letmein',
  MONGO_URI: 'mongodb://example.com',
  MONGO_USER: 'alicia',
};

export async function* arrayToAsyncIterable<T>(array: readonly T[]): AsyncIterable<T> {
  for (const item of array) {
    yield item;
  }
}

export async function asyncIterableToArray<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  // tslint:disable-next-line:readonly-array
  const values = [];
  for await (const item of iterable) {
    values.push(item);
  }
  return values;
}

export async function* appendErrorToAsyncIterable<T>(
  error: Error,
  array: readonly T[],
): AsyncIterable<T> {
  yield* await arrayToAsyncIterable(array);
  throw error;
}

export function arrayBufferFrom(value: string): ArrayBuffer {
  return bufferToArray(Buffer.from(value));
}

export async function getPromiseRejection<E extends Error>(
  promise: Promise<any>,
  expectedErrorClass?: new (...args: readonly any[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    if (expectedErrorClass && !(error instanceof expectedErrorClass)) {
      throw new Error(`"${error}" does not extend ${expectedErrorClass.name}`);
    }
    return error;
  }
  throw new Error('Expected project to reject');
}

// tslint:disable-next-line:readonly-array
export function mockSpy<T, Y extends any[]>(
  spy: jest.MockInstance<T, Y>,
  mockImplementation?: (...args: readonly any[]) => any,
): jest.MockInstance<T, Y> {
  beforeEach(() => {
    spy.mockReset();
    if (mockImplementation) {
      spy.mockImplementation(mockImplementation);
    }
  });

  afterAll(() => {
    spy.mockRestore();
  });

  return spy;
}

// tslint:disable-next-line:readonly-array
export type MockLogSet = object[];

export interface MockLogging {
  readonly logger: pino.Logger;
  readonly logs: MockLogSet;
}

export function makeMockLogging(): MockLogging {
  // tslint:disable-next-line:readonly-array
  const logs: object[] = [];
  const stream = split2((data) => {
    logs.push(JSON.parse(data));
  });
  const logger = pino({ level: 'debug' }, stream);
  return { logger, logs };
}

export function partialPinoLogger(bindings: { readonly [key: string]: any }): object {
  return expect.objectContaining({
    [PinoSymbols.formattersSym]: { bindings },
  });
}

export function partialPinoLog(level: pino.Level, message: string, extraAttributes?: any): object {
  const levelNumber = pino.levels.values[level];
  return expect.objectContaining({
    level: levelNumber,
    msg: message,
    ...(extraAttributes && extraAttributes),
  });
}

function makeSHA256Hash(plaintext: BinaryLike): Hash {
  return createHash('sha256').update(plaintext);
}

export function sha256Hex(plaintext: string): string {
  return makeSHA256Hash(plaintext).digest('hex');
}

export function sha256(plaintext: BinaryLike): Buffer {
  return makeSHA256Hash(plaintext).digest();
}

export function iterableTake<T>(max: number): (iterable: AsyncIterable<T>) => AsyncIterable<T> {
  return async function* (iterable: AsyncIterable<T>): AsyncIterable<T> {
    if (max <= 0) {
      return;
    }

    let count = 0;
    for await (const item of iterable) {
      yield item;
      count++;
      if (max === count) {
        break;
      }
    }
  };
}

export interface CDAChain {
  readonly publicGatewayCert: Certificate;
  readonly privateGatewayCert: Certificate;
}

export interface ExternalPdaChain extends CDAChain {
  readonly privateGatewayPrivateKey: CryptoKey;
  readonly peerEndpointCert: Certificate;
  readonly peerEndpointPrivateKey: CryptoKey;
  readonly pdaCert: Certificate;
  readonly pdaGranteePrivateKey: CryptoKey;
}

export interface PdaChain extends ExternalPdaChain {
  readonly publicGatewayPrivateKey: CryptoKey;
}

export async function generateCDAChain(pdaChain: ExternalPdaChain): Promise<CDAChain> {
  const privateGatewayCert = reSerializeCertificate(
    await issueGatewayCertificate({
      issuerPrivateKey: pdaChain.privateGatewayPrivateKey,
      subjectPublicKey: await pdaChain.privateGatewayCert.getPublicKey(),
      validityEndDate: pdaChain.privateGatewayCert.expiryDate,
    }),
  );
  const publicGatewayCert = reSerializeCertificate(
    await issueDeliveryAuthorization({
      issuerCertificate: privateGatewayCert,
      issuerPrivateKey: pdaChain.privateGatewayPrivateKey,
      subjectPublicKey: await pdaChain.publicGatewayCert.getPublicKey(),
      validityEndDate: TOMORROW,
    }),
  );
  return { privateGatewayCert, publicGatewayCert };
}

export interface GeneratedCCA {
  readonly ccaSerialized: Buffer;
  readonly sessionPrivateKey: CryptoKey;
}

export async function generateCCA(
  recipientAddress: string,
  chain: CDAChain,
  publicGatewaySessionKey: SessionKey,
  privateGatewayPrivateKey: CryptoKey,
): Promise<GeneratedCCA> {
  const ccr = new CargoCollectionRequest(chain.publicGatewayCert);
  const { envelopedData, dhPrivateKey } = await SessionEnvelopedData.encrypt(
    ccr.serialize(),
    publicGatewaySessionKey,
  );
  const cca = new CargoCollectionAuthorization(
    recipientAddress,
    chain.privateGatewayCert,
    Buffer.from(envelopedData.serialize()),
  );
  const ccaSerialized = await cca.serialize(privateGatewayPrivateKey);
  return { ccaSerialized: Buffer.from(ccaSerialized), sessionPrivateKey: dhPrivateKey };
}

export function useFakeTimers(): void {
  beforeEach(() => {
    jest.useFakeTimers('modern');
  });

  afterEach(() => {
    jest.useRealTimers();
  });
}

export function setUpTestDBConnection(): () => Connection {
  let connection: Connection;

  const connect = () =>
    createConnection((global as any).__MONGO_URI__, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

  beforeAll(async () => {
    connection = await connect();
  });

  beforeEach(async () => {
    if (connection.readyState === 0) {
      connection = await connect();
    }
  });

  afterAll(async () => {
    if (connection.readyState !== 0) {
      await connection.close();
    }
  });

  return () => connection;
}
