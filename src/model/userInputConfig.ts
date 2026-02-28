import { Button } from "./button.js";
import { Device } from "./device.js";
import { Scene } from "./scene.js";

export interface UserInputConfig {
  devices: Device[];
  scenes: Scene[];
  buttons: Button[];
  cryptoKey: Buffer;
}
