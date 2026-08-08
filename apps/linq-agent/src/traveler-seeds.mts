/**
 * Stable Linq beta travelers — same IDs used in shopper-flow ranking and DB seeds.
 * Emails are internal; wallets provisioned on first bids.accept.
 */
export const LINQ_TRAVELERS = [
  {
    id: "a1111111-1111-4111-8111-111111111111",
    email: "linq-ama@manebra.test",
    name: "Ama",
    trustScore: 165,
    avgRating: 4.9,
    totalDeliveries: 42,
    minFeeCents: 2500,
    daysUntilDep: 6,
  },
  {
    id: "a2222222-2222-4222-8222-222222222222",
    email: "linq-kofi@manebra.test",
    name: "Kofi",
    trustScore: 118,
    avgRating: 4.6,
    totalDeliveries: 9,
    minFeeCents: 1800,
    daysUntilDep: 11,
  },
  {
    id: "a3333333-3333-4333-8333-333333333333",
    email: "linq-nana@manebra.test",
    name: "Nana (new)",
    trustScore: 100,
    avgRating: null as number | null,
    totalDeliveries: 1,
    minFeeCents: 1200,
    daysUntilDep: 9,
  },
] as const;

export type LinqTravelerSeed = (typeof LINQ_TRAVELERS)[number];
