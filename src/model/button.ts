export interface Button {
  name: string;
  deviceId: string; // Plejd hardware device ID
  deviceAddress: number; // Mesh address (from site.deviceAddress)
  buttonIndex: number; // Input index (0, 1, ...)
  model: string;
  uuid: string;
  room?: string;
  hidden: boolean;
}
