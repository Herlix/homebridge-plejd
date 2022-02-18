import { Logger } from 'homebridge';

export class PlejdService {

  constructor(
    public readonly log: Logger,
    private readonly onUpdate: (identifier: number, state: number, dim?: number) => void) {
  }


  turnOn(identifier: number, brightens?: number) {
    this.log.debug('on/bright', identifier, brightens);
  }

  turnOff(identifier: number) {
    this.log.debug('off', identifier);

  }
}