import { prisma } from "@manebra/db";

/** In-app job alert (push hooks onto agents/match.proposed via Inngest). */
export async function writeJobAlert(args: {
  travelerId: string;
  itemRequestId: string;
  tripId: string;
  score: number;
  itemName: string;
  destinationCity: string;
  itemCostCents: number;
}): Promise<void> {
  const dollars = `$${(args.itemCostCents / 100).toFixed(0)}`;
  await prisma.notification.create({
    data: {
      userId: args.travelerId,
      kind: "job_alert",
      title: `Job alert: ${dollars} delivery to ${args.destinationCity}`,
      body:
        `A shopper needs "${args.itemName}" delivered to ${args.destinationCity}. ` +
        `Match score ${Math.round(args.score)}. Open the app to accept or decline.`,
      data: {
        itemRequestId: args.itemRequestId,
        tripId: args.tripId,
        score: args.score,
        itemName: args.itemName,
        destinationCity: args.destinationCity,
        itemCostCents: args.itemCostCents,
      },
      status: "pending",
    },
  });
}
