export interface Device {
    name: string;
    model: string;
    identifier: number;
    isDimmer: boolean;
}

export interface UserInputConfig {
    devices: Device[];
    cryptoKey: Buffer;
}