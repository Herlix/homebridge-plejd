import { deviceSchema } from './device';
import { z } from 'zod';

export const userInputConfigSchema = z.object({
  devices: z.array(deviceSchema),
  cryptoKey: z.string().transform((val) => Buffer.from(val, 'hex')),
});

export type UserInputConfig = z.infer<typeof userInputConfigSchema>;
