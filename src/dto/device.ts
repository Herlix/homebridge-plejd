import { z } from 'zod';

export const deviceSchema = z.object({
  name: z.string(),
  model: z.string(),
  identifier: z.number(),
  isDimmer: z.boolean(),
  uuid: z.string(),
  room: z.string().optional(),
  hidden: z.boolean(),
});

export type Device = z.infer<typeof deviceSchema>;
