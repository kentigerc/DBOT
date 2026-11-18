# Higher Lower Hedging

One hosted XML bot appears in Free Bots as **Higher Lower Hedging**. It loads into the existing Bot Builder and uses its normal Run/Stop controls, Summary and journal. There is no additional analysis tab, XML runner tab or feature stylesheet. Existing platform styling is unchanged.

The XML uses standard Blockly trade-definition, initialization, purchase-conditions and after-purchase roots. Its custom NetoAcademy paired-purchase block requires this application's runtime; it is not compatible with stock Deriv Bot without that block. Existing hosted-bot export restrictions remain unchanged. Loading the bot never starts trades.

## Settings and discovery

USD demo accounts only, enforced server-side: $0.35 per leg, five ticks, fixed +1/-1 relative barriers, $10 session stop loss, $5 profit target and ten pairs maximum. Duration accepts five through ten ticks. There is no martingale or real-account switch. Stake, duration and barrier come from normal Trade parameters; the paired block takes stop loss, profit target and maximum-pair inputs. Do not combine it with ordinary Purchase or Trade again blocks. The Summary balance check reserves both stakes.

Market search defaults to Automatic Volatility scan across supported open Volatility markets. Select Selected Trade parameters market to observe only the market in Trade parameters. It loads 101 recent ticks with a live subscription instead of waiting for 101 new ticks. Ready feeds are checked every 250ms. Contract compatibility is fetched on the first qualifying candidate and cached. The shared engine warms multiple feeds with four workers paced at eight subscription starts per second, and can check its first ready feed while others load. No per-tick REST account requests or historical polling are introduced. Faster discovery does not relax entry checks or guarantee immediate orders.

Entry requires recent 20-change RMS > 1.2 × preceding 80-change RMS, recent RMS × sqrt(duration) > 1.25 price points and latest absolute change >= 0.8 × recent RMS. Require fresh prices, recheck the signal before dispatch and do not reuse an entry tick. Prefer advertised HIGHER/LOWER codes; use CALL/PUT only with compatible advertised barrier/duration metadata. An incompatible selected market stops with an explanation.

Request two streaming proposals (`subscribe: 1`) with +1/-1 barriers. Require distinct current IDs, exact stakes and each leg's payout greater than combined cost. Verify balance and reserve both stakes against remaining loss budget. Forget quote streams after preflight/dispatch. This is not a profitability guarantee. Independent purchases may have different entry/expiry ticks; both can win or both can lose.

## Results and failure handling

The existing Summary shows each confirmed contract ID, actual purchase price, returned amount and P/L. Pair outcomes distinguish both won, both lost, mixed, refunds, rejected and unknown purchases. Missing values remain unconfirmed rather than being invented. The normal journal reports paired session status.

The server shares account locks with other trading tools and persists a protected paired intent before dispatch. Authorization, terms, lease ownership, quote freshness and signal are checked before purchasing. STOP during delayed startup cannot be overwritten; cancelled attempt IDs cannot restart later or stop a newer attempt. A verified owner-session STOP remains available during provider account-discovery throttling while still checking revocation.

STOP prevents entries and continues tracking known contracts; it does not sell them. Refresh XML contract status re-reads known IDs after stopping/reconnecting. Partial rejection stops further entries but retains purchased contracts. Uncertain purchases are never retried or discarded. Late receipts may recover missing IDs. Unknown IDs remain blocked for investigation in Deriv Reports. Settlement deduplication counts pair profit once. Reload never starts trading automatically.

The XML source uses its own journal namespace and analytics label. Legacy analysis journals remain available for reconciliation of earlier pending contracts, but no analysis interface is shipped. PostgreSQL should remain configured on Render; file storage requires a persistent disk and does not support multiple instances.

## Validation boundary

Regression tests use mocked provider discovery, quotes, purchases and settlements. CI validates server behavior with PostgreSQL, frontend tests and a production build. No authenticated broker session or sample order was placed during implementation; broker acceptance and actual demo results still need owner-controlled demo verification.

## Builder purchase validation

The paired-purchase block satisfies the Builder's mandatory purchase requirement for this bot. Do not add an ordinary Purchase block alongside it: mixed execution paths are rejected. Ordinary bots still require their standard Purchase block. Disabled or misplaced paired blocks, missing Trade parameters/options or Purchase conditions, and disabled mandatory blocks prevent Run. Regression tests load the hosted XML into Blockly and exercise the same required-block validator used by the Builder.
