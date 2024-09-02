import { NodeConnectionParams } from '@relaycorp/relaynet-core';
import { FastifyInstance } from 'fastify';

import { registerDisallowedMethods } from '../../utilities/fastify/server';
import { InternetGatewayManager } from '../../node/InternetGatewayManager';
import type { PowebRouteOptions } from './PowebRouteOptions';
import { CONTENT_TYPES } from './contentTypes';

const ENDPOINT_URL = '/connection-params.der';

export default async function registerRoutes(
  fastify: FastifyInstance,
  options: PowebRouteOptions,
): Promise<void> {
  registerDisallowedMethods(['HEAD', 'GET'], ENDPOINT_URL, fastify);

  const gatewayManager = await InternetGatewayManager.init(fastify.mongoose);

  fastify.route({
    method: ['HEAD', 'GET'],
    url: ENDPOINT_URL,
    async handler(_req, reply): Promise<void> {
      const gateway = await gatewayManager.getCurrent();
      const params = new NodeConnectionParams(
        options.internetAddress,
        gateway.identityKeyPair.publicKey,
        (await gateway.keyStores.privateKeyStore.retrieveUnboundSessionPublicKey(gateway.id))!,
      );
      const paramsSerialised = await params.serialize();
      reply.type(CONTENT_TYPES.CONNECTION_PARAMS).send(Buffer.from(paramsSerialised));
    },
  });
}
