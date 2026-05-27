export interface ClimateSettings {
  regulationMode: "TEMP" | "PWM";
  minTemp: number;
  maxTemp: number;
  step?: number;
}

export interface Device {
  name: string;
  model: string;
  identifier: number;
  outputType: "LIGHT" | "RELAY" | "SENSOR" | "CLIMATE";
  uuid: string;
  room?: string;
  hidden: boolean;
  plejdDeviceId: string;
  climateSettings?: ClimateSettings;
}
