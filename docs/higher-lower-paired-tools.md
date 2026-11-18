# Higher/Lower paired demo tools

Two independent surfaces use a common paired-order engine:

- **Higher / Lower Analysis**, `/platform#higher_lower`: its own editable settings, session P/L, pending contracts and history.
- **Higher / Lower Pair** in Free Bots opens `/platform#higher_lower_xml`. The hosted `server/bots/higher-lower-pair.xml` runs in the dedicated XML runner. Its `neto_higher_lower_pair` execution block invokes the scanner and paired-order engine; it does not use another analysis tool's running session. The XML runner supports importing and downloading this standalone bot format. Loading or importing never starts trades.

The XML block requires NetoAcademy's paired-order runtime. It is **not compatible with stock Deriv Bot/Blockly** without that runtime; the existing standard Builder remains limited to one open purchase. Existing protected digit bots' export restrictions are unchanged.

## Defaults and entry policy

USD demo accounts only, enforced server-side: $0.35 **per leg**, five ticks, fixed +1/-1 relative price barriers, $10 session loss limit, $5 profit target, ten pairs maximum. Duration is editable from five through ten ticks. There is no martingale or real-account switch.

Subscribe once to up to 50 open, non-suspended R_* and 1HZ*V markets that advertise compatible Higher and Lower contracts. Prefer new HIGHER/LOWER codes; use CALL/PUT only when advertised with compatible barrier/duration metadata. Initial subscriptions are paced; live ticks update rolling 101-price windows. No historical polling loop or per-tick REST account request is added.

Compute RMS tick movement over the newest 20 changes and preceding 80 changes. Entry requires recent RMS > 1.2 × baseline, recent RMS × sqrt(duration) > 1.25 price points, and latest absolute change >= 0.8 × recent RMS. Rank qualified markets by recent RMS. Require fresh, nonfuture prices and recheck the signal immediately before dispatch. Do not reuse the same entry tick after a pair on that market. This is a volatility-expansion rule, not a validated profitable strategy.

Request **two streaming proposals** (`subscribe: 1`), with barriers +1 and -1 and basis stake. Require distinct valid proposal IDs, current spot times, exact stake quotes and a payout from either individual leg greater than the combined quoted cost. Check balance for both stakes and reserve both against the remaining session loss budget. Forget quote streams after dispatch/preflight; no automatic buy replay. References: [Deriv proposal migration](https://developers.deriv.com/comparison/proposal/), [contracts discovery](https://developers.deriv.com/comparison/contracts-for/).

Purchases are issued in the same dispatch turn but are two independent broker requests. Entry ticks and expiry ticks can differ. Both legs can lose between the barriers; the quote payout check is not an expected-return calculation or profit guarantee. Compatibility and quote checks may prevent any trade; the bot never substitutes a different contract silently.

## Ownership, persistence and failure handling

Both tools share the existing account lock service with Builder/Analysis but use distinct lock modes and validated journal namespaces. They cannot trade the same account concurrently. Before buying, persist a protected group intent covering both legs and flush its journal; recheck authorization, terms, lease ownership, signal and quote freshness before dispatch. Verify account ownership and USD demo status on every API operation. Revocation or STOP while startup/preflight is awaiting prevents new orders.

Record each confirmed buy ID and subscribe to each contract. Deduplicate settlements, calculate the pair's net P/L once, and retain the group intent until both outcomes are terminal. Partial rejection stops further entries while retaining the purchased leg. Unknown purchase outcomes are never retried or discarded. Late receipts with the original pair nonce can establish missing IDs.

STOP prevents new entries and continues monitoring known open contracts; it does not automatically sell them. Use **Refresh contract status** after stopping/reconnecting to re-read known contract IDs. Restart/reload never starts automatically. An unknown ID that cannot be recovered from a late receipt remains blocked and requires operator investigation in Deriv Reports; no button clears an uncertain purchase. If a different process owns an unexpired lease, reconciliation cannot clear its intent. Confirmed terminal journals can reconcile after lease expiry. PostgreSQL should remain configured on Render; file preview mode needs persistent disk and does not support multi-instance execution.

Connection diagnostics feed the owner analytics, and XML/analysis have distinct source labels. All requests pass the existing HTTP rate/size/origin checks. XML import is size-bounded, rejects DTD/entity declarations and duplicate/invalid fields, and never evaluates JavaScript.

## Validation boundary

Automated tests use mocked provider quotes, buys and receipts; PostgreSQL CI exercises journal namespace and lease reconciliation. No authenticated live session or sample order was placed while implementing these tools. Broker acceptance, available symbols/quotes, live expiry behavior and demo account results still require an owner-controlled demo verification before considering real-account support.
