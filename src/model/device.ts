export interface Device {
  name: string;
  model: string;
  identifier: number;
  outputType: "LIGHT" | "RELAY";
  uuid: string;
  room?: string;
  hidden: boolean;
  plejdDeviceId: string;
}
