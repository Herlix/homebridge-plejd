export interface Device {
    name: string;
    model: string;
    identifier: number;
    isDimmer: boolean;
    uuid: string;
}

export interface UserInputConfig {
    devices: Device[];
    cryptoKey: Buffer;
}