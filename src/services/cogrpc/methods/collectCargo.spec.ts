import * as grpc from '@grpc/grpc-js';
import { CargoDelivery, CargoDeliveryAck, CargoRelayServerMethodSet } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageSet,
  CargoMessageStream,
  generateRSAKeyPair,
  InvalidMessageError,
  issueEndpointCertificate,
  MockPrivateKeyStore,
  Parcel,
  ParcelCollectionAck,
  RecipientAddressType,
  SessionEnvelopedData,
  SessionKeyPair,
  UnknownKeyError,
} from '@relaycorp/relaynet-core';
import bufferToArray from 'buffer-to-arraybuffer';
import { addDays } from 'date-fns';
import {
  arrayBufferFrom,
  arrayToAsyncIterable,
  CDAChain,
  generateCCA,
  generateCDAChain,
  mockSpy,
  partialPinoLog,
  partialPinoLogger,
  PdaChain,
  UUID4_REGEX,
} from '../../../_test_utils';

import * as vault from '../../../backingServices/vault';
import { recordCCAFulfillment, wasCCAFulfilled } from '../../../ccaFulfilments';
import { MongoCertificateStore } from '../../../keystores/MongoCertificateStore';
import * as parcelCollectionAck from '../../../parcelCollection';
import { ParcelStore } from '../../../parcelStore';
import { Config, ConfigKey } from '../../../utilities/config';
import { generatePdaChain } from '../../_test_utils';
import {
  MockGrpcBidiCall,
  setUpTestEnvironment,
  STUB_OBJECT_STORE_BUCKET,
  STUB_PUBLIC_ADDRESS,
  STUB_PUBLIC_ADDRESS_URL,
} from '../_test_utils';
import { makeServiceImplementation } from '../service';

const TOMORROW = addDays(new Date(), 1);

let pdaChain: PdaChain;
let cdaChain: CDAChain;
let privateGatewayAddress: string;
beforeAll(async () => {
  pdaChain = await generatePdaChain();
  cdaChain = await generateCDAChain(pdaChain);
  privateGatewayAddress = await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress();
});

const { getMongooseConnection, getSvcImplOptions, getMockLogs } = setUpTestEnvironment();

const PRIVATE_KEY_STORE = new MockPrivateKeyStore();
let publicGatewaySessionKeyPair: SessionKeyPair;
beforeAll(async () => {
  publicGatewaySessionKeyPair = await SessionKeyPair.generate();
});
beforeEach(async () => {
  PRIVATE_KEY_STORE.clear();
  await PRIVATE_KEY_STORE.saveIdentityKey(pdaChain.publicGatewayPrivateKey);
  await PRIVATE_KEY_STORE.saveBoundSessionKey(
    publicGatewaySessionKeyPair.privateKey,
    publicGatewaySessionKeyPair.sessionKey.keyId,
    privateGatewayAddress,
  );
});
mockSpy(jest.spyOn(vault, 'initVaultKeyStore'), () => PRIVATE_KEY_STORE);

beforeEach(async () => {
  const connection = getMongooseConnection();

  const certificateStore = new MongoCertificateStore(connection);
  await certificateStore.save(pdaChain.publicGatewayCert);

  const config = new Config(connection);
  await config.set(
    ConfigKey.CURRENT_PRIVATE_ADDRESS,
    await pdaChain.publicGatewayCert.calculateSubjectPrivateAddress(),
  );
});

let SERVICE: CargoRelayServerMethodSet;
beforeEach(async () => {
  SERVICE = await makeServiceImplementation(getSvcImplOptions());
});

let CALL: MockGrpcBidiCall<CargoDelivery, CargoDeliveryAck>;
beforeEach(() => {
  CALL = new MockGrpcBidiCall();
});

const MOCK_RETRIEVE_ACTIVE_PARCELS = mockSpy(
  jest.spyOn(ParcelStore.prototype, 'retrieveActiveParcelsForGateway'),
  () => arrayToAsyncIterable([]),
);
const MOCK_GENERATE_PCAS = mockSpy(
  jest.spyOn(parcelCollectionAck, 'generatePCAs'),
  async function* (): CargoMessageStream {
    yield* arrayToAsyncIterable([]);
  },
);

let DUMMY_PARCEL: Parcel;
let DUMMY_PARCEL_SERIALIZED: Buffer;
beforeAll(async () => {
  const keyPair = await generateRSAKeyPair();
  const certificate = await issueEndpointCertificate({
    issuerPrivateKey: keyPair.privateKey,
    subjectPublicKey: keyPair.publicKey,
    validityEndDate: TOMORROW,
  });
  DUMMY_PARCEL = new Parcel(
    await certificate.calculateSubjectPrivateAddress(),
    certificate,
    Buffer.from('Pretend this is a CMS EnvelopedData value'),
  );
  DUMMY_PARCEL_SERIALIZED = Buffer.from(await DUMMY_PARCEL.serialize(keyPair.privateKey));
});

let cca: CargoCollectionAuthorization;
let ccaSerialized: Buffer;
let privateGatewaySessionPrivateKey: CryptoKey;
beforeAll(async () => {
  const generatedCCA = await generateCCA(
    STUB_PUBLIC_ADDRESS_URL,
    cdaChain,
    publicGatewaySessionKeyPair.sessionKey,
    pdaChain.privateGatewayPrivateKey,
  );
  cca = generatedCCA.cca;
  ccaSerialized = generatedCCA.ccaSerialized;
  privateGatewaySessionPrivateKey = generatedCCA.sessionPrivateKey;
});

describe('CCA validation', () => {
  test('UNAUTHENTICATED should be returned if Authorization is missing', async (cb) => {
    CALL.on('error', (error) => {
      const errorMessage = 'Authorization metadata should be specified exactly once';
      expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: errorMessage,
      });

      cb();
    });

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('UNAUTHENTICATED should be returned if Authorization is duplicated', async (cb) => {
    CALL.on('error', (error) => {
      const errorMessage = 'Authorization metadata should be specified exactly once';
      expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: errorMessage,
      });

      cb();
    });

    CALL.metadata.add('Authorization', 'Bearer s3cr3t');
    CALL.metadata.add('Authorization', 'Bearer s3cr3t');
    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('UNAUTHENTICATED should be returned if Authorization type is invalid', async (cb) => {
    CALL.on('error', (error) => {
      const errorMessage = 'Authorization type should be Relaynet-CCA';
      expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: errorMessage,
      });

      cb();
    });

    CALL.metadata.add('Authorization', 'Bearer s3cr3t');

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('UNAUTHENTICATED should be returned if Authorization value is missing', async (cb) => {
    CALL.on('error', (error) => {
      const errorMessage = 'Authorization value should be set to the CCA';
      expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: errorMessage,
      });

      cb();
    });

    CALL.metadata.add('Authorization', 'Relaynet-CCA');

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('UNAUTHENTICATED should be returned if CCA is malformed', async (cb) => {
    CALL.on('error', (error) => {
      const errorMessage = 'CCA is malformed';
      expect(getMockLogs()).toContainEqual(invalidCCALog(errorMessage));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: errorMessage,
      });

      cb();
    });

    const invalidCCASerialized = Buffer.from('I am not really a RAMF message');
    CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('UNAUTHENTICATED should be returned if payload is not an EnvelopedData value', async (cb) => {
    CALL.on('error', (error) => {
      expect(getMockLogs()).toContainEqual(invalidCCRLog('CMSError'));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid CCA',
      });

      cb();
    });

    const invalidCCASerialized = await generateCCAForPayload(
      STUB_PUBLIC_ADDRESS_URL,
      new ArrayBuffer(0),
    );
    CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('UNAUTHENTICATED should be returned if EnvelopedData cannot be decrypted', async (cb) => {
    CALL.on('error', (error) => {
      expect(getMockLogs()).toContainEqual(invalidCCRLog(UnknownKeyError.name));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid CCA',
      });

      cb();
    });

    const unknownSessionKey = (await SessionKeyPair.generate()).sessionKey;
    const { envelopedData } = await SessionEnvelopedData.encrypt(
      new ArrayBuffer(0),
      unknownSessionKey, // The public gateway doesn't have this key
    );
    const invalidCCASerialized = await generateCCAForPayload(
      STUB_PUBLIC_ADDRESS_URL,
      envelopedData.serialize(),
    );
    CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('UNAUTHENTICATED should be returned if CCR is malformed', async (cb) => {
    CALL.on('error', (error) => {
      expect(getMockLogs()).toContainEqual(invalidCCRLog(InvalidMessageError.name));
      expect(error).toEqual({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid CCA',
      });

      cb();
    });

    const { envelopedData } = await SessionEnvelopedData.encrypt(
      arrayBufferFrom('not a valid CCR'),
      publicGatewaySessionKeyPair.sessionKey,
    );
    const invalidCCASerialized = await generateCCAForPayload(
      STUB_PUBLIC_ADDRESS_URL,
      envelopedData.serialize(),
    );
    CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('INVALID_ARGUMENT should be returned if CCA recipient is malformed', async (cb) => {
    const malformedCCA = new CargoCollectionAuthorization(
      '0deadbeef',
      pdaChain.privateGatewayCert,
      Buffer.from([]),
    );
    CALL.on('error', (error) => {
      expect(getMockLogs()).toContainEqual(
        partialPinoLog('info', 'Refusing CCA with malformed recipient', {
          ccaRecipientAddress: malformedCCA.recipientAddress,
          grpcClient: CALL.getPeer(),
          grpcMethod: 'collectCargo',
          peerGatewayAddress: privateGatewayAddress,
        }),
      );
      expect(error).toEqual({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'CCA recipient is malformed',
      });

      cb();
    });

    const invalidCCASerialized = Buffer.from(
      await malformedCCA.serialize(pdaChain.privateGatewayPrivateKey),
    );
    CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('INVALID_ARGUMENT should be returned if CCA is not bound for current gateway', async (cb) => {
    const invalidCCA = new CargoCollectionAuthorization(
      `https://different-${STUB_PUBLIC_ADDRESS}`,
      pdaChain.privateGatewayCert,
      Buffer.from([]),
    );
    CALL.on('error', (error) => {
      expect(getMockLogs()).toContainEqual(
        partialPinoLog('info', 'Refusing CCA bound for another gateway', {
          ccaRecipientAddress: invalidCCA.recipientAddress,
          grpcClient: CALL.getPeer(),
          grpcMethod: 'collectCargo',
          peerGatewayAddress: privateGatewayAddress,
        }),
      );
      expect(error).toEqual({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'CCA recipient is a different gateway',
      });

      cb();
    });

    const invalidCCASerialized = Buffer.from(
      await invalidCCA.serialize(pdaChain.privateGatewayPrivateKey),
    );
    CALL.metadata.add('Authorization', `Relaynet-CCA ${invalidCCASerialized.toString('base64')}`);

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('PERMISSION_DENIED should be returned if CCA was already fulfilled', async (cb) => {
    await recordCCAFulfillment(cca, getMongooseConnection());

    CALL.on('error', (error) => {
      expect(getMockLogs()).toContainEqual(
        partialPinoLog('info', 'Refusing CCA that was already fulfilled', {
          grpcClient: CALL.getPeer(),
          grpcMethod: 'collectCargo',
          peerGatewayAddress: privateGatewayAddress,
        }),
      );
      expect(error).toEqual({
        code: grpc.status.PERMISSION_DENIED,
        message: 'CCA was already fulfilled',
      });

      cb();
    });

    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

    await SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  function invalidCCALog(errorMessage: string): ReturnType<typeof partialPinoLog> {
    return partialPinoLog('info', 'Refusing malformed/invalid CCA', {
      grpcClient: CALL.getPeer(),
      grpcMethod: 'collectCargo',
      reason: errorMessage,
    });
  }

  function invalidCCRLog(errorTypeName: string): ReturnType<typeof partialPinoLog> {
    return partialPinoLog('info', 'Failed to extract Cargo Collection Request', {
      err: expect.objectContaining({ type: errorTypeName }),
      grpcClient: CALL.getPeer(),
      grpcMethod: 'collectCargo',
    });
  }
});

test('Parcel store should be bound to correct bucket', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(MOCK_RETRIEVE_ACTIVE_PARCELS.mock.instances[0]).toHaveProperty(
    'bucket',
    STUB_OBJECT_STORE_BUCKET,
  );
});

test('Parcels retrieved should be limited to sender of CCA', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(MOCK_RETRIEVE_ACTIVE_PARCELS).toBeCalledWith(
    privateGatewayAddress,
    partialPinoLogger({ peerGatewayAddress: privateGatewayAddress }) as any,
  );
});

test('Call should end immediately if there is no cargo for specified gateway', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(CALL.write).not.toBeCalled();
  expect(CALL.end).toBeCalled();
});

test('One cargo should be returned if all messages fit in it', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
    arrayToAsyncIterable([
      {
        body: DUMMY_PARCEL_SERIALIZED,
        expiryDate: TOMORROW,
        extra: null,
        key: 'prefix/1.parcel',
      },
    ]),
  );

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(CALL.input).toHaveLength(1);
  await validateCargoDelivery(CALL.input[0], [DUMMY_PARCEL_SERIALIZED]);
  expect(getMockLogs()).toContainEqual(
    partialPinoLog('info', 'CCA was fulfilled successfully', {
      cargoesCollected: 1,
    }),
  );
});

test('Call should end after cargo has been delivered', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
    arrayToAsyncIterable([
      {
        body: DUMMY_PARCEL_SERIALIZED,
        expiryDate: TOMORROW,
        extra: null,
        key: 'prefix/1.parcel',
      },
    ]),
  );

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(CALL.end).toBeCalled();
});

test('PCAs should be limited to the sender of the CCA', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(MOCK_GENERATE_PCAS).toBeCalledTimes(1);
  expect(MOCK_GENERATE_PCAS).toBeCalledWith(
    await pdaChain.privateGatewayCert.calculateSubjectPrivateAddress(),
    getMongooseConnection(),
  );
});

test('PCAs should be included in payload', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
    arrayToAsyncIterable([
      {
        body: DUMMY_PARCEL_SERIALIZED,
        expiryDate: TOMORROW,
        extra: null,
        key: 'prefix/1.parcel',
      },
    ]),
  );
  const pca = new ParcelCollectionAck('0beef', 'https://endpoint.example/', 'the-id');
  const pcaSerialized = Buffer.from(pca.serialize());
  MOCK_GENERATE_PCAS.mockReturnValue(
    arrayToAsyncIterable([{ expiryDate: new Date(), message: pcaSerialized }]),
  );

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(CALL.input).toHaveLength(1);
  await validateCargoDelivery(CALL.input[0], [pcaSerialized, DUMMY_PARCEL_SERIALIZED]);
});

test('Cargo should be signed with the current key', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));
  MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
    arrayToAsyncIterable([
      {
        body: DUMMY_PARCEL_SERIALIZED,
        expiryDate: TOMORROW,
        extra: null,
        key: 'prefix/1.parcel',
      },
    ]),
  );

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(CALL.input).toHaveLength(1);
  const cargo = await Cargo.deserialize(bufferToArray(CALL.input[0].cargo));
  await cargo.validate(RecipientAddressType.PRIVATE, [cdaChain.privateGatewayCert]);
});

test('CCA should be logged as fulfilled to make sure it is only used once', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  await expect(wasCCAFulfilled(cca, getMongooseConnection())).resolves.toBeTrue();
});

test('CCA fulfillment should be logged and end the call', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(getMockLogs()).toContainEqual(
    partialPinoLog('info', 'CCA was fulfilled successfully', {
      cargoesCollected: 0,
      grpcClient: CALL.getPeer(),
      grpcMethod: 'collectCargo',
      peerGatewayAddress: privateGatewayAddress,
    }),
  );
  expect(CALL.end).toBeCalledWith();
});

test('CCA payload encryption key should be stored', async () => {
  CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));
  MOCK_RETRIEVE_ACTIVE_PARCELS.mockReturnValue(
    arrayToAsyncIterable([
      {
        body: DUMMY_PARCEL_SERIALIZED,
        expiryDate: TOMORROW,
        extra: null,
        key: 'prefix/1.parcel',
      },
    ]),
  );

  await SERVICE.collectCargo(CALL.convertToGrpcStream());

  expect(CALL.input).toHaveLength(1);
  const cargo = await Cargo.deserialize(bufferToArray(CALL.input[0].cargo));
  const cargoUnwrap = await cargo.unwrapPayload(privateGatewaySessionPrivateKey);
  expect(cargoUnwrap.payload.messages).toHaveLength(1);
});

describe('Errors while generating cargo', () => {
  const err = new Error('Whoops');
  beforeEach(() => {
    MOCK_RETRIEVE_ACTIVE_PARCELS.mockImplementation(async function* (): AsyncIterable<any> {
      throw err;
    });
    CALL.metadata.add('Authorization', serializeAuthzMetadata(ccaSerialized));
  });

  test('Error should be logged and end the call', async (cb) => {
    CALL.on('error', async () => {
      expect(getMockLogs()).toContainEqual(
        partialPinoLog('error', 'Failed to send cargo', {
          err: expect.objectContaining({ message: err.message }),
          grpcClient: CALL.getPeer(),
          grpcMethod: 'collectCargo',
          peerGatewayAddress: privateGatewayAddress,
        }),
      );
      cb();
    });

    SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('Call should end with an error for the client', async (cb) => {
    CALL.on('error', (callError) => {
      expect(callError).toEqual({
        code: grpc.status.UNAVAILABLE,
        message: 'Internal server error; please try again later',
      });

      cb();
    });

    SERVICE.collectCargo(CALL.convertToGrpcStream());
  });

  test('CCA should not be marked as fulfilled', async (cb) => {
    CALL.on('error', async () => {
      await expect(wasCCAFulfilled(cca, getMongooseConnection())).resolves.toBeFalse();
      cb();
    });

    SERVICE.collectCargo(CALL.convertToGrpcStream());
  });
});

function serializeAuthzMetadata(ccaSerialization: Buffer): string {
  return `Relaynet-CCA ${ccaSerialization.toString('base64')}`;
}

async function generateCCAForPayload(
  recipientAddress: string,
  payload: ArrayBuffer,
): Promise<Buffer> {
  const auth = new CargoCollectionAuthorization(
    recipientAddress,
    pdaChain.privateGatewayCert,
    Buffer.from(payload),
  );
  return Buffer.from(await auth.serialize(pdaChain.privateGatewayPrivateKey));
}

async function validateCargoDelivery(
  cargoDelivery: CargoDelivery,
  expectedMessagesSerialized: readonly Buffer[],
): Promise<void> {
  expect(cargoDelivery).toHaveProperty('id', UUID4_REGEX);

  expect(cargoDelivery).toHaveProperty('cargo');
  const cargoMessageSet = await unwrapCargoMessages(cargoDelivery.cargo);
  const cargoMessages = Array.from(cargoMessageSet.messages).map((m) => Buffer.from(m));
  expect(cargoMessages).toHaveLength(expectedMessagesSerialized.length);
  for (const expectedMessageSerialized of expectedMessagesSerialized) {
    const matchingMessages = cargoMessages.filter((m) => m.equals(expectedMessageSerialized));
    expect(matchingMessages).toHaveLength(1);
  }
}

async function unwrapCargoMessages(cargoSerialized: Buffer): Promise<CargoMessageSet> {
  const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
  const { payload } = await cargo.unwrapPayload(privateGatewaySessionPrivateKey);
  return payload;
}
