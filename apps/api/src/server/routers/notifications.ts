import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, verifiedProcedure } from "../trpc.js";

export const notificationsRouter = router({
  list: verifiedProcedure
    .input(z.object({ unreadOnly: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.notification.findMany({
        where: {
          userId: ctx.user.id,
          ...(input?.unreadOnly ? { status: "pending" } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    }),

  markRead: verifiedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const n = await ctx.prisma.notification.findUnique({ where: { id: input.id } });
      if (!n || n.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.prisma.notification.update({
        where: { id: n.id },
        data: { status: "delivered", readAt: new Date() },
      });
    }),
});
