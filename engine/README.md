# Screening engine

Deterministic Python that answers one question: given a screener definition and a
pile of candles, which symbols pass, and for the ones that don't — which gate
stopped them.

    echo '<job json>' | python3 engine/screener_engine.py    # → result json
    python3 engine/screener_engine.py --contract             # → wire contract

There is no model here, no network call and no clock read. The job carries its own
timestamp, so the same job always produces the same bytes. That is what makes a
screener reproducible and the whole thing testable as a pure function.

## Layout

| file                 | what it holds                                              |
| -------------------- | ---------------------------------------------------------- |
| `indicators.py`      | RSI / EMA / MACD / Bollinger — a port of `shared/indicators.ts` |
| `rollup.py`          | 4hr and 1week bars, derived from the feeds Gemini serves    |
| `patterns.py`        | the 20 candle patterns a screener may whitelist             |
| `screen.py`          | gate evaluation, fit scoring, ranking, the funnel           |
| `screener_engine.py` | the CLI — stdin job in, stdout result out                   |

The contract with the app lives in `shared/screener.ts`. Both sides stamp
`schemaVersion`, and the engine refuses a job whose version it does not implement
rather than guessing at a gate it might read wrong.

## Tests

    npm run test:engine        # or: python3 -m unittest discover -t . -s engine

Stdlib `unittest`, no dependencies — same rule as the rest of the Python here.

`tests/test_parity.py` is the one worth understanding. It recomputes the numbers
`shared/indicators.ts` produced from real candles and fails on any disagreement
past 1e-9. Without it the two implementations drift and the chart draws one RSI
while the screener filters on another. If you change the math on either side,
regenerate the fixture and let the diff show you what moved:

    npm run fixtures:parity
