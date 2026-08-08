import { initTRPC, TRPCError } from "@trpc/server";
import { prisma } from "@manebra/db";

export interface Context {
  prisma: typeof prisma;
  userId: string | null;
}

const t = initTRPC.context<Context>().create();
export const router = t.router;
export const publicProcedure = t.procedure;

export const authedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

/** KYC-gated: account active + passport verified (PRD §3). */
export const verifiedProcedure = authedProcedure.use(async ({ ctx, next }) => {
  const user = await ctx.prisma.user.findUnique({ where: { id: ctx.userId! } });
  if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });
  if (user.accountStatus !== "active") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Account is not active." });
  }
  if (!user.isVerified) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Passport verification required to post, bid, or chat." });
  }
  return next({ ctx: { ...ctx, user } });
});
