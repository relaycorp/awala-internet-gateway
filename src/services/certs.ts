import { Certificate } from '@relaycorp/relaynet-core';
import { getModelForClass } from '@typegoose/typegoose';
import bufferToArray from 'buffer-to-arraybuffer';
import { Connection } from 'mongoose';

import { OwnCertificate } from './models';
import { BasicLogger } from './types';

export async function retrieveOwnCertificates(
  connection: Connection,
  logger: BasicLogger | null = null,
): Promise<readonly Certificate[]> {
  logger?.info('Before getModelForClass()');
  const ownCertificateModel = getModelForClass(OwnCertificate, { existingConnection: connection });
  logger?.info('Before find()');
  const findOne = ownCertificateModel.find({});
  logger?.info('Before exec()');
  const ownCerts = (await findOne.exec()) as readonly OwnCertificate[];

  logger?.info('Before map()');
  return ownCerts.map((c) => Certificate.deserialize(bufferToArray(c.serializationDer)));
}
