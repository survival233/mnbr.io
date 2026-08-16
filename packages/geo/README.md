# @manebra/geo

Owner: **marketplace**.

Resolve user text and stored trip cities to a metro (IATA + city + country). Same metro = match. Different city ≠ match. Nearby cities are not a match.

```ts
import { resolveMetro, sameMetro } from "@manebra/geo";
```
