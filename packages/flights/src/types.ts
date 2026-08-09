export type CabinClass = "economy" | "premium_economy" | "business" | "first";

export type FlightOption = {
  offerId: string;
  airline: string;
  airlineCode?: string;
  flightNumber?: string;
  origin: string;
  destination: string;
  departAt: Date;
  arriveAt: Date;
  durationMinutes: number;
  stops: number;
  priceCents: number;
  currency: string;
  cabin: CabinClass;
  raw?: unknown;
};

export type FlightSearchQuery = {
  origin: string;
  destination: string;
  departDate: string | Date;
  arriveBy?: Date;
  cabin?: CabinClass;
  adults?: number;
  limit?: number;
};

export type BookFlightInput = {
  offerId: string;
  passengerName: string;
  paymentMethodId?: string | null;
  allowDemo?: boolean;
};

export type FlightBooking = {
  bookingRef: string;
  status: "confirmed" | "pending_payment" | "demo_confirmed";
  offer: FlightOption;
  passengerName: string;
  message: string;
};

export interface FlightProvider {
  readonly name: string;
  search(q: FlightSearchQuery): Promise<FlightOption[]>;
  book(input: BookFlightInput, offer: FlightOption): Promise<FlightBooking>;
}
