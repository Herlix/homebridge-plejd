import { Device } from './device';

export interface UserInputConfig {
    devices: Device[];
    cryptoKey: Buffer;
}