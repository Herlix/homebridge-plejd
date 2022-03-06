export interface Device {
    name: string;
    model: string;
    identifier: number;
    // Runtime, should not be added by user
    isDimmer: boolean;
    uuid: string;
}

export interface UserInputConfig {
    devices: Device[];
    cryptoKey: Buffer;
}