import { z } from "zod";

/**
 * Strict, zero-trust schema for order payloads entering the edge.
 * Unknown properties are rejected so callers cannot smuggle extra fields
 * into downstream handlers.
 */
export const OrderPayloadSchema = z
  .object({
    id: z.string().uuid(),
    amount: z.number().finite().positive(),
    currency: z.enum(["USD", "PHP", "AUD"]),
    customerEmail: z.string().email(),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export type OrderPayload = z.infer<typeof OrderPayloadSchema>;
