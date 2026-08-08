/**
 * Validated settlement config. Fail fast at boot if anything required is missing,
 * rather than discovering a bad address or key mid-transaction.
 *
 * The attestor key is read here for the MVP. In production, set ATTESTOR_KMS_KEY_ID
 * instead and construct a KMS-backed signer — never ship a raw fund-moving key in env.
 */
import { z } from "zod";
import { getAddress, type Address, type Hex } from "viem";

const hexAddress = z.string().transform((v, ctx): Address => {
  try {
    return getAddress(v);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid EVM address" });
    return z.NEVER;
  }
});

const schema = z
  .object({
    CHAIN_ENV: z.enum(["testnet", "mainnet"]).default("testnet"),
    RPC_URL: z.string().url(),
    HANDOVER_ESCROW_ADDRESS: hexAddress,
    // exactly one signing source must be present
    ATTESTOR_PRIVATE_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex key")
      .optional(),
    ATTESTOR_KMS_KEY_ID: z.string().optional(),
  })
  .refine((c) => !!c.ATTESTOR_PRIVATE_KEY !== !!c.ATTESTOR_KMS_KEY_ID, {
    message: "set exactly one of ATTESTOR_PRIVATE_KEY (dev) or ATTESTOR_KMS_KEY_ID (prod)",
  });

const parsed = schema.parse(process.env);

export const settlementConfig = {
  chainEnv: parsed.CHAIN_ENV,
  rpcUrl: parsed.RPC_URL,
  escrowAddress: parsed.HANDOVER_ESCROW_ADDRESS,
  attestorPrivateKey: parsed.ATTESTOR_PRIVATE_KEY as Hex | undefined,
  attestorKmsKeyId: parsed.ATTESTOR_KMS_KEY_ID,
} as const;
