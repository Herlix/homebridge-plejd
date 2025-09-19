import { Device } from "./device.js";

export interface UserInputConfig {
  devices: Device[];
  cryptoKey: Buffer;
}
