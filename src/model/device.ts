export interface Device {
  name: string;
  model: string;
  identifier: number;
  isDimmer: boolean;
  uuid: string;
  room?: string;
  hidden: boolean;
}
