import { Device } from "./device.js";
import { Scene } from "./scene.js";

export interface UserInputConfig {
  devices: Device[];
  scenes: Scene[];
  cryptoKey: Buffer;
}
