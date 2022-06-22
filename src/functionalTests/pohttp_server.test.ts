import {
  generateRSAKeyPair,
  issueEndpointCertificate,
  Parcel,
  ParcelCollectionHandshakeSigner,
  StreamingMode,
} from '@relaycorp/relaynet-core';
import { deliverParcel, PoHTTPInvalidParcelError } from '@relaycorp/relaynet-pohttp';
import { PoWebClient } from '@relaycorp/relaynet-poweb';
import pipe from 'it-pipe';
import { Stan } from 'node-nats-streaming';

import { expectBuffersToEqual } from '../testUtils/buffers';
import { asyncIterableToArray } from '../testUtils/iter';
import { GW_POHTTP_URL, GW_POWEB_LOCAL_PORT } from './services';
import { connectToNatsStreaming, createAndRegisterPrivateGateway } from './utils';

describe('PoHTTP server', () => {
  let stanConnection: Stan;
  beforeEach(async () => (stanConnection = await connectToNatsStreaming()));
  afterEach(async () => {
    stanConnection.close();
    await new Promise((resolve) => stanConnection.once('close', resolve));
  });

  test('Valid parcel should be accepted', async () => {
    const { pdaChain } = await createAndRegisterPrivateGateway();
    const parcel = new Parcel(
      await pdaChain.peerEndpointCert.calculateSubjectPrivateAddress(),
      pdaChain.pdaCert,
      Buffer.from([]),
      { senderCaCertificateChain: [pdaChain.peerEndpointCert, pdaChain.privateGatewayCert] },
    );
    const parcelSerialized = await parcel.serialize(pdaChain.pdaGranteePrivateKey);

    // We should get a successful response
    await deliverParcel(GW_POHTTP_URL, parcelSerialized);

    // The parcel should've been safely stored
    const poWebClient = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
    const signer = new ParcelCollectionHandshakeSigner(
      pdaChain.privateGatewayCert,
      pdaChain.privateGatewayPrivateKey,
    );
    const incomingParcels = await pipe(
      poWebClient.collectParcels([signer], StreamingMode.CLOSE_UPON_COMPLETION),
      async function* (collections): AsyncIterable<ArrayBuffer> {
        for await (const collection of collections) {
          yield await collection.parcelSerialized;
          await collection.ack();
        }
      },
      asyncIterableToArray,
    );
    expect(incomingParcels).toHaveLength(1);
    expectBuffersToEqual(parcelSerialized, incomingParcels[0]);
  });

  test('Unauthorized parcel should be refused', async () => {
    const senderKeyPair = await generateRSAKeyPair();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const senderCertificate = await issueEndpointCertificate({
      issuerPrivateKey: senderKeyPair.privateKey,
      subjectPublicKey: senderKeyPair.publicKey,
      validityEndDate: tomorrow,
    });
    const parcel = new Parcel('0deadbeef', senderCertificate, Buffer.from([]));

    try {
      await deliverParcel(GW_POHTTP_URL, await parcel.serialize(senderKeyPair.privateKey));
    } catch (error) {
      expect(error).toBeInstanceOf(PoHTTPInvalidParcelError);
      return;
    }
    expect.fail("Parcel delivery should've failed");
  });
});
