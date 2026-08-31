/** An open request is only for the traveler it was offered to — never a dest-wide claim. */
export function offerBelongsToTraveler(
  offer: { travelerId?: string | null },
  travelerKey: string,
): boolean {
  return Boolean(offer.travelerId) && offer.travelerId === travelerKey;
}
