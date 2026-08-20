/** IATA + city + country + metro. Same hub airport = one arrival city. */

export type AirportRow = {
  iata: string;
  city: string;
  country: string;
  metro: string;
};

export const AIRPORTS: readonly AirportRow[] = [
  { iata: "ACC", city: "Accra", country: "GH", metro: "accra" },
  { iata: "KMS", city: "Kumasi", country: "GH", metro: "kumasi" },
  { iata: "TML", city: "Tamale", country: "GH", metro: "tamale" },
  { iata: "LOS", city: "Lagos", country: "NG", metro: "lagos" },
  { iata: "ABV", city: "Abuja", country: "NG", metro: "abuja" },
  { iata: "NBO", city: "Nairobi", country: "KE", metro: "nairobi" },
  { iata: "JNB", city: "Johannesburg", country: "ZA", metro: "johannesburg" },
  { iata: "CPT", city: "Cape Town", country: "ZA", metro: "cape_town" },
  { iata: "ADD", city: "Addis Ababa", country: "ET", metro: "addis_ababa" },
  { iata: "CAI", city: "Cairo", country: "EG", metro: "cairo" },
  { iata: "JFK", city: "New York", country: "US", metro: "new_york" },
  { iata: "LGA", city: "New York", country: "US", metro: "new_york" },
  { iata: "EWR", city: "New York", country: "US", metro: "new_york" },
  { iata: "IAD", city: "Washington", country: "US", metro: "washington" },
  { iata: "DCA", city: "Washington", country: "US", metro: "washington" },
  { iata: "ATL", city: "Atlanta", country: "US", metro: "atlanta" },
  { iata: "ORD", city: "Chicago", country: "US", metro: "chicago" },
  { iata: "MDW", city: "Chicago", country: "US", metro: "chicago" },
  { iata: "IAH", city: "Houston", country: "US", metro: "houston" },
  { iata: "LAX", city: "Los Angeles", country: "US", metro: "los_angeles" },
  { iata: "DFW", city: "Dallas", country: "US", metro: "dallas" },
  { iata: "BOS", city: "Boston", country: "US", metro: "boston" },
  { iata: "SFO", city: "San Francisco", country: "US", metro: "san_francisco" },
  { iata: "MIA", city: "Miami", country: "US", metro: "miami" },
  { iata: "SEA", city: "Seattle", country: "US", metro: "seattle" },
  { iata: "LHR", city: "London", country: "GB", metro: "london" },
  { iata: "LGW", city: "London", country: "GB", metro: "london" },
  { iata: "STN", city: "London", country: "GB", metro: "london" },
  { iata: "LCY", city: "London", country: "GB", metro: "london" },
  { iata: "MAN", city: "Manchester", country: "GB", metro: "manchester" },
  { iata: "CDG", city: "Paris", country: "FR", metro: "paris" },
  { iata: "ORY", city: "Paris", country: "FR", metro: "paris" },
  { iata: "FRA", city: "Frankfurt", country: "DE", metro: "frankfurt" },
  { iata: "MUC", city: "Munich", country: "DE", metro: "munich" },
  { iata: "AMS", city: "Amsterdam", country: "NL", metro: "amsterdam" },
  { iata: "MAD", city: "Madrid", country: "ES", metro: "madrid" },
  { iata: "FCO", city: "Rome", country: "IT", metro: "rome" },
  { iata: "DXB", city: "Dubai", country: "AE", metro: "dubai" },
  { iata: "DOH", city: "Doha", country: "QA", metro: "doha" },
  { iata: "IST", city: "Istanbul", country: "TR", metro: "istanbul" },
  { iata: "BOM", city: "Mumbai", country: "IN", metro: "mumbai" },
  { iata: "DEL", city: "Delhi", country: "IN", metro: "delhi" },
  { iata: "SIN", city: "Singapore", country: "SG", metro: "singapore" },
  { iata: "HKG", city: "Hong Kong", country: "HK", metro: "hong_kong" },
  { iata: "NRT", city: "Tokyo", country: "JP", metro: "tokyo" },
  { iata: "HND", city: "Tokyo", country: "JP", metro: "tokyo" },
  { iata: "ICN", city: "Seoul", country: "KR", metro: "seoul" },
  { iata: "PEK", city: "Beijing", country: "CN", metro: "beijing" },
  { iata: "PVG", city: "Shanghai", country: "CN", metro: "shanghai" },
  { iata: "SYD", city: "Sydney", country: "AU", metro: "sydney" },
  { iata: "GRU", city: "São Paulo", country: "BR", metro: "sao_paulo" },
  { iata: "EZE", city: "Buenos Aires", country: "AR", metro: "buenos_aires" },
  { iata: "AEP", city: "Buenos Aires", country: "AR", metro: "buenos_aires" },
  { iata: "SJO", city: "San José", country: "CR", metro: "san_jose" },
  { iata: "YYZ", city: "Toronto", country: "CA", metro: "toronto" },
];

/**
 * Towns that share a hub airport's catchment. Not a country collapse:
 * Accra ≠ Kumasi. Add a town here when it is served by that hub.
 */
export const CATCHMENTS: Record<string, string> = {
  tema: "accra",
  madina: "accra",
  kasoa: "accra",
  legon: "accra",
  "east legon": "accra",
  spintex: "accra",
  "airport residential": "accra",
  brooklyn: "new_york",
  manhattan: "new_york",
  queens: "new_york",
  "east harlem": "new_york",
  escazu: "san_jose",
  "escazú": "san_jose",
  quilmes: "buenos_aires",
  avellaneda: "buenos_aires",
};

/** Extra names that are not IATA (airport names, common short forms). */
export const ALIASES: Record<string, string> = {
  kotoka: "accra",
  "kotoka international": "accra",
  nyc: "new_york",
  "new york city": "new_york",
  "washington dc": "washington",
  "washington d.c.": "washington",
  dulles: "washington",
  "o'hare": "chicago",
  ohare: "chicago",
  heathrow: "london",
  gatwick: "london",
  "charles de gaulle": "paris",
  "cape town": "cape_town",
  "addis ababa": "addis_ababa",
  "los angeles": "los_angeles",
  "san francisco": "san_francisco",
  "hong kong": "hong_kong",
  "sao paulo": "sao_paulo",
  "são paulo": "sao_paulo",
  "san jose": "san_jose",
  "san josé": "san_jose",
  "buenos aires": "buenos_aires",
};
